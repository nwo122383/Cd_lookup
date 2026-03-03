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
let codeReader = null;
let mediaStream = null;
let scanning = false;
let selectedDeviceId = null;

// ---- UI helpers ----
function setStatus(text) {
  statusEl.textContent = text;
}

function showScreen(name) {
  // Critical: stop camera/scanner whenever leaving Scan screen
  if (activeScreen === "scan" && name !== "scan") {
    stopScan().catch(() => {});
  }

  activeScreen = name;

  Object.keys(screens).forEach((k) => {
    screens[k].classList.toggle("active", k === name);
  });

  // Tab state
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

// ---- Camera / Scanner ----
async function requestPermission() {
  try {
    setStatus("Requesting camera…");
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    // Immediately stop — we only want to trigger permission prompt cleanly
    s.getTracks().forEach((t) => t.stop());
    setStatus("Camera permission granted");
  } catch (e) {
    setStatus("Camera permission failed");
    alert(`Camera permission failed: ${e?.message || e}`);
    throw e;
  }
}

async function pickBestDeviceId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (!cams.length) return null;

  // Prefer "back/rear/environment" if labels exist
  const preferred = cams.find((d) => /back|rear|environment/i.test(d.label || ""));
  return (preferred || cams[cams.length - 1]).deviceId;
}

async function startScan() {
  if (scanning) return;

  try {
    setStatus("Starting scanner…");

    // ZXing reader
    if (!codeReader) {
      codeReader = new ZXing.BrowserMultiFormatReader();
    }

    if (!selectedDeviceId) {
      selectedDeviceId = await pickBestDeviceId();
    }
    if (!selectedDeviceId) throw new Error("No camera device found.");

    scanning = true;

    // decodeFromVideoDevice manages getUserMedia internally
    await codeReader.decodeFromVideoDevice(selectedDeviceId, videoEl, (result, err) => {
      if (!scanning) return;

      if (result) {
        const text = result.getText();
        lastScanned = text;
        scannedValueEl.textContent = text;
        setStatus("Scanned!");
        // Stop immediately to avoid duplicate triggers
        stopScan().catch(() => {});
        showScreen("result");
      }
      // ignore err; it’s continuous while scanning
    });

    setStatus("Scanning…");
  } catch (e) {
    scanning = false;
    setStatus("Scanner error");
    alert(
      `Could not start scanner:\n\n${e?.message || e}\n\nIf it says "camera blocked", fully close the app and reopen it.`
    );
  }
}

async function stopScan() {
  scanning = false;

  try {
    if (codeReader) {
      // Reset stops decoding and releases the camera stream
      codeReader.reset();
    }
  } catch {}

  // Also stop any lingering stream on the video element (belt + suspenders)
  try {
    const stream = videoEl.srcObject;
    if (stream && stream.getTracks) {
      stream.getTracks().forEach((t) => t.stop());
    }
    videoEl.srcObject = null;
  } catch {}

  setStatus("Stopped");
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

// ---- Search (simple demo) ----
// NOTE: OpenLibrary is a placeholder data source; for real CD metadata
// we should switch to Discogs API (best) or MusicBrainz release search.
async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  // lightweight endpoint (no API key)
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

// ---- Wire up UI ----
tabs.scan.addEventListener("click", () => showScreen("scan"));
tabs.search.addEventListener("click", () => showScreen("search"));
tabs.catalog.addEventListener("click", () => showScreen("catalog"));

btnPermission.addEventListener("click", () => requestPermission());
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
    setStatus("Search failed");
    alert(`Search failed: ${e?.message || e}`);
  }
});

btnClear.addEventListener("click", () => {
  if (confirm("Clear your catalog?")) clearCatalog();
});

// ---- Init ----
setStatus("Idle");
showScreen("scan");
renderCatalog();
