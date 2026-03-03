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
const CAMERA_KEY = "cd_catalog_camera_device_id_v1";

let activeScreen = "scan";
let lastScanned = "";
let scanning = false;

let codeReader = null;
let selectedDeviceId = localStorage.getItem(CAMERA_KEY) || null;

// ---- UI helpers ----
function setStatus(text) {
  statusEl.textContent = text;
}

function showScreen(name) {
  // Stop camera/scanner whenever leaving Scan screen
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

// ---- Camera selection ----
function scoreCameraLabel(label) {
  const l = (label || "").toLowerCase();

  // Hard prefer rear/back/environment
  let score = 0;
  if (l.includes("back")) score += 50;
  if (l.includes("rear")) score += 50;
  if (l.includes("environment")) score += 50;

  // Penalize front/user/selfie
  if (l.includes("front")) score -= 40;
  if (l.includes("user")) score -= 40;
  if (l.includes("self")) score -= 40;

  // Some devices label "camera 0/1" — leave score low but not negative
  return score;
}

async function requestPermissionEnvironment() {
  // This does two things:
  // 1) prompts permission
  // 2) enables device labels in enumerateDevices()
  setStatus("Requesting camera…");

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });

  // Attach to video so we can confirm it’s actually live
  videoEl.srcObject = stream;
  try {
    await videoEl.play();
  } catch {
    // ignore; some webviews still show video without play()
  }

  // Leave it running briefly so labels populate reliably
  await new Promise((r) => setTimeout(r, 250));

  // Stop stream right away; scanning will open its own stream
  stream.getTracks().forEach((t) => t.stop());
  videoEl.srcObject = null;

  setStatus("Camera permission granted");
}

async function pickBestCameraId() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (!cams.length) return null;

  // If we already have one stored, prefer it if it still exists
  if (selectedDeviceId && cams.some((c) => c.deviceId === selectedDeviceId)) {
    return selectedDeviceId;
  }

  // Score by label
  const sorted = cams
    .map((c) => ({ ...c, _score: scoreCameraLabel(c.label) }))
    .sort((a, b) => b._score - a._score);

  // Best-scoring (rear) first; otherwise fallback to last camera
  const chosen = sorted[0]?._score > -999 ? sorted[0] : cams[cams.length - 1];
  return chosen.deviceId;
}

// ---- Scanner ----
async function startScan() {
  if (scanning) return;

  try {
    setStatus("Starting…");
    btnStart.disabled = true;

    // Ensure permission + labels
    await requestPermissionEnvironment();

    // Pick rear camera
    selectedDeviceId = await pickBestCameraId();
    if (!selectedDeviceId) throw new Error("No camera device found.");

    localStorage.setItem(CAMERA_KEY, selectedDeviceId);

    if (!codeReader) {
      codeReader = new ZXing.BrowserMultiFormatReader();
    }

    scanning = true;
    setStatus("Scanning…");

    // IMPORTANT: decodeFromVideoDevice will open the stream itself.
    // Using the selectedDeviceId (rear) prevents the “front then flip” behavior.
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
        // ignore err; it happens constantly while scanning
      }
    );
  } catch (e) {
    scanning = false;
    setStatus("Camera failed");
    alert(
      `Could not start camera/scanner:\n\n${e?.message || e}\n\nIf it says camera blocked, fully close the app and reopen it.`
    );
  } finally {
    btnStart.disabled = false;
  }
}

async function stopScan() {
  scanning = false;

  try {
    if (codeReader) codeReader.reset();
  } catch {}

  // Belt + suspenders: stop any tracks attached to video
  try {
    const stream = videoEl.srcObject;
    if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
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

// ---- Wire up UI ----
tabs.scan.addEventListener("click", () => showScreen("scan"));
tabs.search.addEventListener("click", () => showScreen("search"));
tabs.catalog.addEventListener("click", () => showScreen("catalog"));

btnPermission.addEventListener("click", async () => {
  try {
    await requestPermissionEnvironment();
  } catch (e) {
    setStatus("Permission failed");
    alert(`Permission failed: ${e?.message || e}`);
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
    setStatus("Search failed");
    alert(`Search failed: ${e?.message || e}`);
  }
});

btnClear.addEventListener("click", () => {
  if (confirm("Clear your catalog?")) clearCatalog();
});

// Init
setStatus("Idle");
showScreen("scan");
renderCatalog();
