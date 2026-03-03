/* global ZXing */

const statusEl = document.getElementById("status");

const screens = {
  scan: document.getElementById("screen-scan"),
  result: document.getElementById("screen-result"),
  search: document.getElementById("screen-search"),
  catalog: document.getElementById("screen-catalog"),
};

const tabs = {
  scan: document.getElementById("tab-scan"),
  search: document.getElementById("tab-search"),
  catalog: document.getElementById("tab-catalog"),
};

const videoEl = document.getElementById("video");

const btnPermission = document.getElementById("btn-permission");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");

const scannedValueEl = document.getElementById("scannedValue");
const btnSearch = document.getElementById("btn-search");
const btnScanAgain = document.getElementById("btn-scan-again");

const manualInput = document.getElementById("manualInput");
const btnManualSearch = document.getElementById("btn-manual-search");
const btnBack = document.getElementById("btn-back");

const resultsEl = document.getElementById("results");

const catalogListEl = document.getElementById("catalogList");
const btnClear = document.getElementById("btn-clear");

const STORAGE_KEY = "cd_catalog_simple_v1";

let activeScreen = "scan";
let lastScanned = "";
let scanning = false;

let stream = null;
let rafId = null;

// ZXing fallback (stream-based)
let zxingReader = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function showScreen(name) {
  if (activeScreen === "scan" && name !== "scan") {
    stopScan().catch(() => {});
  }

  activeScreen = name;

  Object.keys(screens).forEach((k) => {
    screens[k].classList.toggle("active", k === name);
  });

  tabs.scan.classList.toggle("active", name === "scan");
  tabs.search.classList.toggle("active", name === "search");
  tabs.catalog.classList.toggle("active", name === "catalog");

  if (name === "catalog") renderCatalog();
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getErrorMessage(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  return e.message || e.name || JSON.stringify(e);
}

async function requestPermission() {
  try {
    setStatus("Requesting camera permission…");
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    s.getTracks().forEach((t) => t.stop());
    setStatus("Camera permission granted");
  } catch (e) {
    setStatus("Permission failed: " + getErrorMessage(e));
    throw e;
  }
}

async function openRearCameraStream() {
  // IMPORTANT: we do NOT enumerate devices on Rabbit
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });

  videoEl.srcObject = stream;
  // On some WebViews you must call play() after user gesture
  try {
    await videoEl.play();
  } catch {
    // ignore
  }
}

function closeStream() {
  try {
    if (videoEl.srcObject && videoEl.srcObject.getTracks) {
      videoEl.srcObject.getTracks().forEach((t) => t.stop());
    }
  } catch {}
  videoEl.srcObject = null;

  try {
    if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
  } catch {}
  stream = null;
}

async function startScan() {
  if (scanning) return;
  scanning = true;
  btnStart.disabled = true;

  try {
    setStatus("Opening rear camera…");
    await openRearCameraStream();

    // Prefer native BarcodeDetector if available (often best on embedded Chromium)
    if ("BarcodeDetector" in window) {
      setStatus("Scanning (BarcodeDetector)…");
      await scanWithBarcodeDetector();
    } else {
      setStatus("Scanning (ZXing fallback)…");
      await scanWithZXingFromVideo();
    }
  } catch (e) {
    scanning = false;
    setStatus("Scan failed: " + getErrorMessage(e));
    alert("Scan failed:\n\n" + getErrorMessage(e));
  } finally {
    btnStart.disabled = false;
  }
}

async function stopScan() {
  scanning = false;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  // stop ZXing if used
  try {
    if (zxingReader) zxingReader.reset();
  } catch {}

  closeStream();
  setStatus("Stopped");
}

async function scanWithBarcodeDetector() {
  // Try common barcode formats; if unsupported, detector will still often work.
  let detector;
  try {
    detector = new BarcodeDetector({
      formats: [
        "ean_13",
        "ean_8",
        "upc_a",
        "upc_e",
        "code_128",
        "code_39",
        "itf",
        "qr_code",
      ],
    });
  } catch {
    detector = new BarcodeDetector();
  }

  // Use ImageCapture for best compatibility; fallback to canvas draw if needed
  const track = stream.getVideoTracks()[0];
  const imageCapture = track ? new ImageCapture(track) : null;

  async function tick() {
    if (!scanning) return;

    try {
      let bitmap = null;

      if (imageCapture && imageCapture.grabFrame) {
        bitmap = await imageCapture.grabFrame();
        const codes = await detector.detect(bitmap);
        if (codes && codes.length) {
          onDetected(codes[0].rawValue || codes[0].value || "");
          return;
        }
      } else {
        // Canvas fallback (less ideal)
        const canvas = document.createElement("canvas");
        canvas.width = videoEl.videoWidth || 640;
        canvas.height = videoEl.videoHeight || 480;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const img = await createImageBitmap(canvas);
        const codes = await detector.detect(img);
        if (codes && codes.length) {
          onDetected(codes[0].rawValue || codes[0].value || "");
          return;
        }
      }
    } catch {
      // ignore scan errors per-frame
    }

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);
}

async function scanWithZXingFromVideo() {
  if (!zxingReader) zxingReader = new ZXing.BrowserMultiFormatReader();

  // ZXing has a mode that reads directly from an existing <video> element
  // (no device enumeration). This is what we want for Rabbit.
  zxingReader.decodeFromVideoElementContinuously(videoEl, (result, err) => {
    if (!scanning) return;
    if (result) {
      onDetected(result.getText());
    }
    // ignore err
  });
}

function onDetected(text) {
  if (!text) return;
  lastScanned = text;
  scannedValueEl.textContent = text;
  setStatus("Scanned!");
  stopScan().catch(() => {});
  showScreen("result");
}

// ---- Catalog storage ----
function getCatalog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveCatalog(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function addToCatalog(item) {
  const list = getCatalog();
  const id = item.id || `${item.title}|${item.artist}|${item.year || ""}`;

  if (!list.some((x) => x._id === id)) {
    list.unshift({ ...item, _id: id, addedAt: Date.now() });
    saveCatalog(list);
  }
  renderCatalog();
}

function clearCatalog() {
  saveCatalog([]);
  renderCatalog();
}

function renderCatalog() {
  const list = getCatalog();
  catalogListEl.innerHTML = "";

  if (!list.length) {
    catalogListEl.innerHTML = `<div class="card"><div class="label">No CDs saved yet.</div></div>`;
    return;
  }

  list.forEach((it) => {
    const div = document.createElement("div");
    div.className = "catalog-item";
    div.innerHTML = `
      <div class="result-title">${escapeHtml(it.title)}</div>
      <div class="result-sub">${escapeHtml(it.artist)} ${it.year ? `• ${escapeHtml(it.year)}` : ""}</div>
    `;
    catalogListEl.appendChild(div);
  });
}

// ---- Search (placeholder) ----
async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
  const data = await resp.json();

  const docs = Array.isArray(data?.docs) ? data.docs.slice(0, 10) : [];
  return docs.map((d) => ({
    title: d.title || "Unknown Title",
    artist: (d.author_name && d.author_name[0]) || "Unknown Artist",
    year: d.first_publish_year || "",
    id: d.key || "",
  }));
}

function renderResults(items) {
  resultsEl.innerHTML = "";

  if (!items.length) {
    resultsEl.innerHTML = `<div class="card"><div class="label">No results.</div></div>`;
    return;
  }

  items.forEach((it) => {
    const row = document.createElement("div");
    row.className = "result-item";
    row.innerHTML = `
      <div>
        <div class="result-title">${escapeHtml(it.title)}</div>
        <div class="result-sub">${escapeHtml(it.artist)} ${it.year ? `• ${escapeHtml(it.year)}` : ""}</div>
      </div>
      <button class="btn primary small">Add</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      addToCatalog(it);
      row.querySelector("button").textContent = "Added";
      row.querySelector("button").disabled = true;
    });
    resultsEl.appendChild(row);
  });
}

// ---- UI wiring ----
tabs.scan.addEventListener("click", () => showScreen("scan"));
tabs.search.addEventListener("click", () => showScreen("search"));
tabs.catalog.addEventListener("click", () => showScreen("catalog"));

btnPermission.addEventListener("click", async () => {
  try {
    await requestPermission();
  } catch (e) {
    alert("Permission failed: " + getErrorMessage(e));
  }
});

btnStart.addEventListener("click", () => startScan());
btnStop.addEventListener("click", () => stopScan());

btnSearch.addEventListener("click", () => {
  manualInput.value = lastScanned || "";
  showScreen("search");
  manualInput.focus();
});

btnScanAgain.addEventListener("click", () => showScreen("scan"));
btnBack.addEventListener("click", () => showScreen("scan"));

btnManualSearch.addEventListener("click", async () => {
  try {
    setStatus("Searching…");
    resultsEl.innerHTML = "";
    const items = await search(manualInput.value);
    renderResults(items);
    setStatus(`Found ${items.length}`);
  } catch (e) {
    setStatus("Search failed: " + getErrorMessage(e));
    alert("Search failed: " + getErrorMessage(e));
  }
});

btnClear.addEventListener("click", () => {
  if (confirm("Clear your catalog?")) clearCatalog();
});

// Init
setStatus("Idle");
showScreen("scan");
renderCatalog();
