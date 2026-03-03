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
const CAMERA_KEY = "cd_catalog_camera_device_id_v2";

let activeScreen = "scan";
let lastScanned = "";
let scanning = false;

let codeReader = null;
let selectedDeviceId = localStorage.getItem(CAMERA_KEY) || null;

// ---------- helpers ----------
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

// ---------- permission ----------
async function requestPermission() {
  // Do NOT close/open inside scan; this is just to trigger prompt + labels
  try {
    setStatus("Requesting camera permission…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    // stop immediately (we just wanted permission)
    stream.getTracks().forEach((t) => t.stop());
    setStatus("Camera permission granted");
  } catch (e) {
    setStatus("Permission failed: " + getErrorMessage(e));
    throw e;
  }
}

// ---------- camera picking (fallback path) ----------
function scoreLabel(label) {
  const l = (label || "").toLowerCase();
  let s = 0;
  if (l.includes("back")) s += 50;
  if (l.includes("rear")) s += 50;
  if (l.includes("environment")) s += 50;
  if (l.includes("front")) s -= 40;
  if (l.includes("user")) s -= 40;
  if (l.includes("self")) s -= 40;
  return s;
}

async function pickBestDeviceId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (!cams.length) return null;

  // prefer stored
  if (selectedDeviceId && cams.some((c) => c.deviceId === selectedDeviceId)) {
    return selectedDeviceId;
  }

  const sorted = cams
    .map((c) => ({ ...c, _score: scoreLabel(c.label) }))
    .sort((a, b) => b._score - a._score);

  return (sorted[0] || cams[cams.length - 1]).deviceId;
}

// ---------- scanner ----------
function ensureReader() {
  if (!codeReader) codeReader = new ZXing.BrowserMultiFormatReader();
}

async function startScan() {
  if (scanning) return;

  scanning = true;
  btnStart.disabled = true;

  try {
    ensureReader();

    setStatus("Starting rear camera…");

    // IMPORTANT: try constraints FIRST (works best on Rabbit / weird deviceId lists)
    // This avoids the “front flashes then shuts off” issue.
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    };

    await codeReader.decodeFromConstraints(
      constraints,
      videoEl,
      (result, err) => {
        if (!scanning) return;

        if (result) {
          const text = result.getText();
          lastScanned = text;
          scannedValueEl.textContent = text;
          setStatus("Scanned!");
          stopScan().catch(() => {});
          showScreen("result");
        }
        // ignore err while scanning
      }
    );

    // Note: the promise resolves when reset/stop is called.
    setStatus("Scanning…");
    return;
  } catch (e1) {
    // If constraints path fails, fallback to deviceId
    setStatus("Rear constraint failed, trying deviceId…");

    try {
      ensureReader();

      selectedDeviceId = await pickBestDeviceId();
      if (!selectedDeviceId) throw new Error("No camera devices found");

      localStorage.setItem(CAMERA_KEY, selectedDeviceId);

      await codeReader.decodeFromVideoDevice(
        selectedDeviceId,
        videoEl,
        (result, err) => {
          if (!scanning) return;

          if (result) {
            const text = result.getText();
            lastScanned = text;
            scannedValueEl.textContent = text;
            setStatus("Scanned!");
            stopScan().catch(() => {});
            showScreen("result");
          }
        }
      );

      setStatus("Scanning…");
      return;
    } catch (e2) {
      scanning = false;
      const msg = `Scan failed: ${getErrorMessage(e2)}`;
      setStatus(msg);
      alert(
        msg +
          "\n\nIf it says camera blocked: fully close the Rabbit app and reopen.\nIf it uses the wrong camera: hit Permission again, then Scan."
      );
    }
  } finally {
    btnStart.disabled = false;
  }
}

async function stopScan() {
  scanning = false;

  try {
    if (codeReader) codeReader.reset();
  } catch {}

  try {
    const stream = videoEl.srcObject;
    if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  } catch {}

  setStatus("Stopped");
}

// ---------- Catalog ----------
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
      <div class="result-sub">${escapeHtml(it.artist)} ${
      it.year ? `• ${escapeHtml(it.year)}` : ""
    }</div>
    `;
    catalogListEl.appendChild(div);
  });
}

// ---------- Search (placeholder) ----------
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
        <div class="result-sub">${escapeHtml(it.artist)} ${
      it.year ? `• ${escapeHtml(it.year)}` : ""
    }</div>
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

// ---------- UI wiring ----------
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
