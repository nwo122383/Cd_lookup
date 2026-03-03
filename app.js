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
const cameraInfoEl = document.getElementById("cameraInfo");

const btnPermission = document.getElementById("btn-permission");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");

const scannedValueEl = document.getElementById("scannedValue");
const btnSearch = document.getElementById("btn-search");
const btnAddScanned = document.getElementById("btn-add-scanned");
const btnScanAgain = document.getElementById("btn-scan-again");

const manualInput = document.getElementById("manualInput");
const btnManualSearch = document.getElementById("btn-manual-search");
const btnBack = document.getElementById("btn-back");

const resultsEl = document.getElementById("results");

const catalogListEl = document.getElementById("catalogList");
const btnClear = document.getElementById("btn-clear");

const STORAGE_KEY = "cd_catalog_simple_v1";
const REAR_CAMERA_LABEL_RE = /(back|rear|environment|world|outward|main)/i;
const FRONT_CAMERA_LABEL_RE = /(front|user|selfie|face|inward)/i;

let activeScreen = "scan";
let lastScanned = "";
let scanning = false;

let stream = null;
let rafId = null;

// ZXing fallback (stream-based)
let zxingReader = null;
let activeCameraSummary = "Camera idle";

function setStatus(text) {
  statusEl.textContent = text;
}

function setCameraInfo(text) {
  activeCameraSummary = text;
  cameraInfoEl.textContent = text;
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

function stopMediaStream(mediaStream) {
  try {
    if (mediaStream && mediaStream.getTracks) {
      mediaStream.getTracks().forEach((track) => track.stop());
    }
  } catch {}
}

function normalizeBarcode(text) {
  return String(text || "").replace(/[^\d]/g, "");
}

function isBarcodeValue(text) {
  return /^\d{8,14}$/.test(normalizeBarcode(text));
}

function getTrackSummary(track, fallbackLabel = "") {
  const settings = track?.getSettings ? track.getSettings() : {};
  return {
    label: track?.label || fallbackLabel || "Unnamed camera",
    facingMode: settings?.facingMode || "",
    deviceId: settings?.deviceId || "",
  };
}

function isLikelyRearCamera(summary) {
  return (
    summary.facingMode === "environment" ||
    REAR_CAMERA_LABEL_RE.test(summary.label || "")
  );
}

function isLikelyFrontCamera(summary) {
  return (
    summary.facingMode === "user" ||
    FRONT_CAMERA_LABEL_RE.test(summary.label || "")
  );
}

function formatCameraSummary(summary) {
  const parts = [];

  if (summary?.label) parts.push(summary.label);
  if (summary?.facingMode) parts.push(`mode: ${summary.facingMode}`);

  return parts.length ? `Camera: ${parts.join(" • ")}` : "Camera opened";
}

async function listVideoInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  } catch {
    return [];
  }
}

function pickPreferredVideoInput(devices) {
  if (!devices.length) return null;

  const rearDevice = devices.find((device) =>
    REAR_CAMERA_LABEL_RE.test(device.label || ""),
  );
  if (rearDevice) return rearDevice;

  const nonFrontDevice = devices.find(
    (device) => !FRONT_CAMERA_LABEL_RE.test(device.label || ""),
  );
  return nonFrontDevice || devices[0];
}

function buildCameraAttempts(preferredDeviceId) {
  const baseVideo = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };

  return [
    {
      label: "rear facing camera",
      constraints: {
        video: { ...baseVideo, facingMode: { exact: "environment" } },
        audio: false,
      },
    },
    preferredDeviceId
      ? {
          label: "preferred rear camera device",
          constraints: {
            video: { ...baseVideo, deviceId: { exact: preferredDeviceId } },
            audio: false,
          },
        }
      : null,
    {
      label: "camera with environment preference",
      constraints: {
        video: { ...baseVideo, facingMode: { ideal: "environment" } },
        audio: false,
      },
    },
    {
      label: "default camera",
      constraints: {
        video: baseVideo,
        audio: false,
      },
    },
  ].filter(Boolean);
}

async function tryApplyRearFacing(track) {
  const capabilities = track?.getCapabilities ? track.getCapabilities() : null;
  const facingModes = Array.isArray(capabilities?.facingMode)
    ? capabilities.facingMode
    : [];

  if (!facingModes.includes("environment")) return;

  try {
    await track.applyConstraints({ facingMode: { exact: "environment" } });
  } catch {
    try {
      await track.applyConstraints({ facingMode: "environment" });
    } catch {}
  }
}

async function acquireRearCameraStream() {
  const devices = await listVideoInputs();
  const preferredDevice = pickPreferredVideoInput(devices);
  const attempts = buildCameraAttempts(preferredDevice?.deviceId || "");
  let lastError = null;

  for (const attempt of attempts) {
    let candidateStream = null;

    try {
      candidateStream = await navigator.mediaDevices.getUserMedia(
        attempt.constraints,
      );

      const track = candidateStream.getVideoTracks()[0];
      if (!track) {
        throw new Error("No video track returned");
      }

      await tryApplyRearFacing(track);

      const summary = getTrackSummary(track, attempt.label);
      const ambiguousButAcceptable =
        devices.length <= 1 && !isLikelyFrontCamera(summary);

      if (
        isLikelyFrontCamera(summary) &&
        !isLikelyRearCamera(summary) &&
        devices.length > 1
      ) {
        throw new Error(`Opened front-facing camera: ${summary.label}`);
      }

      if (isLikelyRearCamera(summary) || ambiguousButAcceptable) {
        return { stream: candidateStream, summary };
      }

      if (devices.length <= 1) {
        return { stream: candidateStream, summary };
      }

      throw new Error(`Camera orientation ambiguous: ${summary.label}`);
    } catch (error) {
      lastError = error;
      stopMediaStream(candidateStream);
    }
  }

  throw lastError || new Error("Unable to open the camera");
}

async function requestPermission() {
  let permissionStream = null;

  try {
    setStatus("Requesting camera permission…");
    const acquired = await acquireRearCameraStream();
    permissionStream = acquired.stream;
    setCameraInfo(formatCameraSummary(acquired.summary));
    setStatus("Camera permission granted");
  } catch (e) {
    setStatus("Permission failed: " + getErrorMessage(e));
    throw e;
  } finally {
    stopMediaStream(permissionStream);
  }
}

async function openRearCameraStream() {
  const acquired = await acquireRearCameraStream();
  stream = acquired.stream;
  setCameraInfo(formatCameraSummary(acquired.summary));

  videoEl.srcObject = stream;
  // On some WebViews you must call play() after user gesture
  try {
    await videoEl.play();
  } catch {
    // ignore
  }
}

function closeStream() {
  stopMediaStream(videoEl.srcObject);
  videoEl.srcObject = null;
  stopMediaStream(stream);
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
function makeCatalogId(item) {
  return (
    item.id ||
    item.barcode ||
    `${item.title}|${item.artist}|${item.year || ""}|${item.format || ""}`
  );
}

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
  const id = makeCatalogId(item);

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
      <div class="result-meta">${it.barcode ? `Barcode ${escapeHtml(it.barcode)}` : "Saved locally on this device"}</div>
    `;
    catalogListEl.appendChild(div);
  });
}

function mapMusicBrainzRelease(release) {
  const artist = Array.isArray(release?.["artist-credit"])
    ? release["artist-credit"]
        .map((part) => part.name || part.artist?.name || "")
        .join("")
    : "Unknown Artist";
  const media = Array.isArray(release?.media) ? release.media[0] : null;

  return {
    title: release?.title || "Unknown Title",
    artist,
    year: release?.date ? String(release.date).slice(0, 4) : "",
    id: release?.id || "",
    barcode: release?.barcode || "",
    format: media?.format || "",
    country: release?.country || "",
  };
}

// ---- Search ----
async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const barcode = normalizeBarcode(q);
  const searchTerm = isBarcodeValue(barcode) ? `barcode:${barcode}` : q;
  const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(searchTerm)}&fmt=json&limit=10`;
  const resp = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`Search failed (${resp.status})`);
  const data = await resp.json();

  const releases = Array.isArray(data?.releases) ? data.releases.slice(0, 10) : [];
  return releases.map(mapMusicBrainzRelease);
}

function renderResults(items) {
  resultsEl.innerHTML = "";
  const catalog = getCatalog();

  if (!items.length) {
    resultsEl.innerHTML = `<div class="card"><div class="label">No results.</div></div>`;
    return;
  }

  items.forEach((it) => {
    const alreadySaved = catalog.some((entry) => entry._id === makeCatalogId(it));
    const row = document.createElement("div");
    row.className = "result-item";
    row.innerHTML = `
      <div>
        <div class="result-title">${escapeHtml(it.title)}</div>
        <div class="result-sub">${escapeHtml(it.artist)} ${it.year ? `• ${escapeHtml(it.year)}` : ""}</div>
        <div class="result-meta">${[it.format, it.country, it.barcode].filter(Boolean).map(escapeHtml).join(" • ") || "MusicBrainz release"}</div>
      </div>
      <button class="btn primary small"${alreadySaved ? " disabled" : ""}>${alreadySaved ? "Added" : "Add"}</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      addToCatalog(it);
      row.querySelector("button").textContent = "Added";
      row.querySelector("button").disabled = true;
    });
    resultsEl.appendChild(row);
  });
}

async function runSearch(query) {
  const value = String(query || "").trim();
  if (!value) return;

  setStatus("Searching…");
  resultsEl.innerHTML = "";
  const items = await search(value);
  renderResults(items);
  setStatus(`Found ${items.length}`);
}

function addScannedBarcodeToCatalog() {
  if (!lastScanned) return;

  const barcode = normalizeBarcode(lastScanned) || lastScanned;
  addToCatalog({
    title: `Barcode ${barcode}`,
    artist: "Unidentified CD",
    year: "",
    barcode,
    id: `barcode:${barcode}`,
    format: "CD",
  });
  setStatus("Saved to library");
  showScreen("catalog");
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

btnSearch.addEventListener("click", async () => {
  manualInput.value = normalizeBarcode(lastScanned) || lastScanned || "";
  showScreen("search");
  manualInput.focus();
  if (manualInput.value) {
    try {
      await runSearch(manualInput.value);
    } catch (e) {
      setStatus("Search failed: " + getErrorMessage(e));
      alert("Search failed: " + getErrorMessage(e));
    }
  }
});

btnAddScanned.addEventListener("click", () => addScannedBarcodeToCatalog());
btnScanAgain.addEventListener("click", () => showScreen("scan"));
btnBack.addEventListener("click", () => showScreen("scan"));

btnManualSearch.addEventListener("click", async () => {
  try {
    await runSearch(manualInput.value);
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
setCameraInfo(activeCameraSummary);
showScreen("scan");
renderCatalog();
