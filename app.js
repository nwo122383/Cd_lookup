/* global ZXingBrowser */

const UI = {
  statusPill: document.getElementById("statusPill"),
  btnStartScan: document.getElementById("btnStartScan"),
  btnStopScan: document.getElementById("btnStopScan"),
  btnTorch: document.getElementById("btnTorch"),
  btnZoomIn: document.getElementById("btnZoomIn"),
  btnZoomOut: document.getElementById("btnZoomOut"),
  zoomLabel: document.getElementById("zoomLabel"),

  video: document.getElementById("video"),
  scanOverlay: document.getElementById("scanOverlay"),

  manualBarcode: document.getElementById("manualBarcode"),
  btnLookup: document.getElementById("btnLookup"),

  haveBadge: document.getElementById("haveBadge"),
  barcodeText: document.getElementById("barcodeText"),
  metaTitle: document.getElementById("metaTitle"),
  metaArtist: document.getElementById("metaArtist"),
  metaYear: document.getElementById("metaYear"),

  btnAdd: document.getElementById("btnAdd"),
  btnRemove: document.getElementById("btnRemove"),

  btnLibrary: document.getElementById("btnLibrary"),
  btnBack: document.getElementById("btnBack"),
  libraryView: document.getElementById("libraryView"),
  libraryList: document.getElementById("libraryList"),
  libraryCount: document.getElementById("libraryCount"),

  btnExport: document.getElementById("btnExport"),
  fileImport: document.getElementById("fileImport"),
};

const STORAGE_KEY = "cd_catalog_v1";
const MB_APP_UA = "r1-cd-catalog/0.2 (standalone)";

let state = {
  catalogByBarcode: {}, // barcode -> item
  lastScan: null,
};

let scanner = null;
let scannerActive = false;

// Track-level controls
let mediaStream = null;
let activeTrack = null;
let torchOn = false;
let zoomCaps = null; // {min,max,step,current}
let lastDecodeAt = 0;

const Storage = {
  async getItem(key) {
    try {
      if (window.creationStorage?.plain?.getItem) {
        return await window.creationStorage.plain.getItem(key);
      }
    } catch (_) {}
    return localStorage.getItem(key);
  },
  async setItem(key, value) {
    try {
      if (window.creationStorage?.plain?.setItem) {
        await window.creationStorage.plain.setItem(key, value);
        return;
      }
    } catch (_) {}
    localStorage.setItem(key, value);
  },
};

function setStatus(text, tone = "normal") {
  UI.statusPill.textContent = text;
  UI.statusPill.style.background = "rgba(255,255,255,0.10)";
  if (tone === "ok") UI.statusPill.style.background = "rgba(34,197,94,0.22)";
  if (tone === "bad") UI.statusPill.style.background = "rgba(239,68,68,0.20)";
  if (tone === "warn") UI.statusPill.style.background = "rgba(245,158,11,0.20)";
}

function setHaveBadge(kind) {
  UI.haveBadge.className = "badge";
  if (kind === "have") {
    UI.haveBadge.textContent = "✅";
    UI.haveBadge.classList.add("ok");
  } else if (kind === "dont") {
    UI.haveBadge.textContent = "❌";
    UI.haveBadge.classList.add("bad");
  } else {
    UI.haveBadge.textContent = "—";
    UI.haveBadge.classList.add("warn");
  }
}

function normalizeBarcode(raw) {
  return String(raw || "").replace(/[^0-9]/g, "").trim();
}

function pickBestRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;

  const scored = releases.map((r) => {
    const score = Number(r.score || 0);
    const statusBoost = r.status === "Official" ? 15 : 0;
    const dateBoost = r.date ? 2 : 0;
    return { r, rank: score + statusBoost + dateBoost };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored[0].r;
}

function extractArtist(release) {
  if (Array.isArray(release["artist-credit"]) && release["artist-credit"].length > 0) {
    return release["artist-credit"]
      .map((ac) => ac.name || ac.artist?.name)
      .filter(Boolean)
      .join("");
  }
  return "Unknown Artist";
}

function uiSetMeta(item) {
  UI.barcodeText.textContent = item?.barcode ? item.barcode : "No code yet";
  UI.metaTitle.textContent = item?.title || "—";
  UI.metaArtist.textContent = item?.artist || "—";
  UI.metaYear.textContent = item?.date ? `Year: ${item.date}` : "—";
}

function updateActionsForBarcode(barcode) {
  const haveIt = !!state.catalogByBarcode[barcode];
  if (!barcode) {
    UI.btnAdd.disabled = true;
    UI.btnRemove.disabled = true;
    setHaveBadge("unknown");
    return;
  }
  setHaveBadge(haveIt ? "have" : "dont");
  UI.btnAdd.disabled = haveIt;
  UI.btnRemove.disabled = !haveIt;
}

async function saveState() {
  await Storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function loadState() {
  const raw = await Storage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") state = parsed;
  } catch (_) {}
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLibrary() {
  const items = Object.values(state.catalogByBarcode);

  items.sort((a, b) => {
    const aa = (a.artist || "").toLowerCase();
    const ba = (b.artist || "").toLowerCase();
    if (aa < ba) return -1;
    if (aa > ba) return 1;
    return (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase());
  });

  UI.libraryCount.textContent = `${items.length} items`;
  UI.libraryList.innerHTML = "";

  for (const it of items) {
    const div = document.createElement("div");
    div.className = "libItem";
    div.innerHTML = `
      <div class="libTop">
        <div class="libTitle">${escapeHtml(it.title || "Unknown Title")}</div>
        <div class="dim">${escapeHtml(it.date || "")}</div>
      </div>
      <div class="libArtist">${escapeHtml(it.artist || "Unknown Artist")}</div>
      <div class="dim"># ${escapeHtml(it.barcode || "")}</div>
    `;
    UI.libraryList.appendChild(div);
  }
}

function showLibrary(show) {
  UI.libraryView.style.display = show ? "block" : "none";
  UI.btnBack.style.display = show ? "inline-flex" : "none";
  UI.btnLibrary.style.display = show ? "none" : "inline-flex";
  if (show) renderLibrary();
}

/**
 * Camera “enhancements”:
 * - request higher resolution
 * - attempt continuous focus (supported on some devices)
 * - attempt torch + zoom via applyConstraints
 */
async function initTrackControls(stream) {
  mediaStream = stream;
  activeTrack = stream.getVideoTracks()[0] || null;
  torchOn = false;
  zoomCaps = null;

  UI.btnTorch.disabled = true;
  UI.btnZoomIn.disabled = true;
  UI.btnZoomOut.disabled = true;
  UI.zoomLabel.textContent = "Zoom: —";

  if (!activeTrack) return;

  const caps = activeTrack.getCapabilities ? activeTrack.getCapabilities() : null;
  const settings = activeTrack.getSettings ? activeTrack.getSettings() : null;

  // Torch support
  if (caps && typeof caps.torch !== "undefined") {
    UI.btnTorch.disabled = false;
  }

  // Zoom support
  if (caps && caps.zoom) {
    const min = caps.zoom.min ?? 1;
    const max = caps.zoom.max ?? 1;
    const step = caps.zoom.step ?? 0.1;
    const current = settings?.zoom ?? min;
    zoomCaps = { min, max, step, current };
    UI.btnZoomIn.disabled = false;
    UI.btnZoomOut.disabled = false;
    UI.zoomLabel.textContent = `Zoom: ${current.toFixed(1)}x`;
  }

  // Try to set continuous focus if supported
  try {
    if (caps && caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      await activeTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
  } catch (_) {
    // ignore
  }
}

async function setTorch(enabled) {
  if (!activeTrack) return;
  try {
    await activeTrack.applyConstraints({ advanced: [{ torch: !!enabled }] });
    torchOn = !!enabled;
    UI.btnTorch.textContent = torchOn ? "Torch On" : "Torch";
  } catch (e) {
    // Some devices report torch but fail applyConstraints
    console.error(e);
    setStatus("Torch not supported", "warn");
    UI.btnTorch.disabled = true;
  }
}

async function setZoom(newZoom) {
  if (!activeTrack || !zoomCaps) return;
  const z = Math.min(zoomCaps.max, Math.max(zoomCaps.min, newZoom));
  try {
    await activeTrack.applyConstraints({ advanced: [{ zoom: z }] });
    zoomCaps.current = z;
    UI.zoomLabel.textContent = `Zoom: ${z.toFixed(1)}x`;
  } catch (e) {
    console.error(e);
    setStatus("Zoom not supported", "warn");
    UI.btnZoomIn.disabled = true;
    UI.btnZoomOut.disabled = true;
    UI.zoomLabel.textContent = "Zoom: —";
  }
}

async function lookupBarcode(barcode) {
  barcode = normalizeBarcode(barcode);
  if (!barcode) {
    setStatus("Enter a code", "warn");
    return;
  }

  updateActionsForBarcode(barcode);

  if (state.catalogByBarcode[barcode]) {
    const owned = state.catalogByBarcode[barcode];
    state.lastScan = { ...owned };
    uiSetMeta(state.lastScan);
    setStatus("Already in library", "ok");
    return;
  }

  setStatus("Looking up…", "normal");
  UI.scanOverlay.style.display = "none";

  const url =
    "https://musicbrainz.org/ws/2/release/?fmt=json&limit=10&query=" +
    encodeURIComponent(`barcode:${barcode}`);

  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": MB_APP_UA },
    });
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);

    const data = await res.json();
    const best = pickBestRelease(data.releases);

    if (!best) {
      state.lastScan = { barcode, title: "Not found", artist: "—", date: "", mbid: "", source: "manual" };
      uiSetMeta(state.lastScan);
      setStatus("Not found (tap Add anyway)", "warn");
      UI.btnAdd.disabled = false;
      return;
    }

    const item = {
      barcode,
      title: best.title || "Unknown Title",
      artist: extractArtist(best),
      date: best.date ? String(best.date).slice(0, 4) : "",
      mbid: best.id || "",
      source: "musicbrainz",
      addedAt: new Date().toISOString(),
    };

    state.lastScan = item;
    uiSetMeta(item);
    updateActionsForBarcode(barcode);
    setStatus("Found", "ok");
  } catch (err) {
    console.error(err);
    state.lastScan = { barcode, title: "Lookup failed", artist: "—", date: "", mbid: "", source: "manual" };
    uiSetMeta(state.lastScan);
    updateActionsForBarcode(barcode);
    setStatus("Lookup failed", "bad");
  }
}

async function startScan() {
  if (scannerActive) return;
  if (!window.ZXingBrowser) {
    setStatus("Scanner lib missing", "bad");
    return;
  }

  scannerActive = true;
  UI.btnStartScan.disabled = true;
  UI.btnStopScan.disabled = false;
  UI.scanOverlay.style.display = "flex";
  setStatus("Opening camera…", "normal");

  try {
    // Restrict formats: makes decoding faster and more stable on weak cameras.
    const hints = new Map();
    hints.set(
      ZXingBrowser.DecodeHintType.POSSIBLE_FORMATS,
      [
        ZXingBrowser.BarcodeFormat.EAN_13,
        ZXingBrowser.BarcodeFormat.UPC_A,
        ZXingBrowser.BarcodeFormat.EAN_8,
      ]
    );
    // Try-harder can help at the cost of CPU (ok for tiny preview)
    hints.set(ZXingBrowser.DecodeHintType.TRY_HARDER, true);

    scanner = new ZXingBrowser.BrowserMultiFormatReader(hints);

    // Aggressive constraints: ask for more pixels + prefer back camera.
    // Some devices ignore this, but it helps when supported.
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        // Some browsers accept focusMode here; others only via applyConstraints
        // focusMode: "continuous"
      },
    };

    await scanner.decodeFromConstraints(constraints, UI.video, async (result, err) => {
      // Throttle decodes a bit so we don't hammer the CPU
      const now = Date.now();
      if (now - lastDecodeAt < 150) return;

      if (result) {
        lastDecodeAt = now;
        const text = result.getText ? result.getText() : String(result);
        const code = normalizeBarcode(text);

        // Many UPC-A barcodes can be returned as EAN-13 with leading 0
        const normalized = code.length === 13 && code.startsWith("0") ? code.slice(1) : code;

        if (normalized && normalized.length >= 8) {
          stopScan();
          UI.manualBarcode.value = normalized;
          lookupBarcode(normalized);
        }
      }
    });

    // After stream is attached, grab the underlying MediaStream from the video element
    // (ZXing sets video.srcObject internally)
    const stream = UI.video.srcObject;
    if (stream && stream.getVideoTracks && stream.getVideoTracks().length) {
      await initTrackControls(stream);
    }

    setStatus("Scanning…", "normal");
  } catch (e) {
    console.error(e);
    setStatus("Camera blocked", "bad");
    UI.scanOverlay.style.display = "none";
    UI.btnStartScan.disabled = false;
    UI.btnStopScan.disabled = true;
    scannerActive = false;
  }
}

function stopScan() {
  if (!scannerActive) return;

  try { scanner?.reset?.(); } catch (_) {}
  scanner = null;
  scannerActive = false;

  try {
    if (mediaStream && mediaStream.getTracks) {
      mediaStream.getTracks().forEach((t) => t.stop());
    }
  } catch (_) {}

  try {
    const stream = UI.video.srcObject;
    if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    UI.video.srcObject = null;
  } catch (_) {}

  mediaStream = null;
  activeTrack = null;
  torchOn = false;
  zoomCaps = null;

  UI.btnTorch.disabled = true;
  UI.btnZoomIn.disabled = true;
  UI.btnZoomOut.disabled = true;
  UI.zoomLabel.textContent = "Zoom: —";
  UI.btnTorch.textContent = "Torch";

  UI.btnStartScan.disabled = false;
  UI.btnStopScan.disabled = true;
  UI.scanOverlay.style.display = "none";
  setStatus("Ready", "normal");
}

async function addLastScan() {
  const item = state.lastScan;
  const barcode = normalizeBarcode(item?.barcode);
  if (!barcode) return;

  state.catalogByBarcode[barcode] = { ...item, barcode, addedAt: new Date().toISOString() };
  await saveState();
  updateActionsForBarcode(barcode);
  setStatus("Added", "ok");
}

async function removeLastScan() {
  const barcode = normalizeBarcode(state.lastScan?.barcode);
  if (!barcode) return;

  delete state.catalogByBarcode[barcode];
  await saveState();
  updateActionsForBarcode(barcode);
  setStatus("Removed", "ok");
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cd-catalog.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importJsonFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Bad JSON");
  if (!parsed.catalogByBarcode || typeof parsed.catalogByBarcode !== "object") throw new Error("Missing catalogByBarcode");

  state = parsed;
  await saveState();
  setStatus("Imported", "ok");
  renderLibrary();
}

function wireUI() {
  UI.btnStartScan.addEventListener("click", startScan);
  UI.btnStopScan.addEventListener("click", stopScan);

  UI.btnTorch.addEventListener("click", async () => {
    await setTorch(!torchOn);
  });

  UI.btnZoomIn.addEventListener("click", async () => {
    if (!zoomCaps) return;
    await setZoom(zoomCaps.current + zoomCaps.step);
  });

  UI.btnZoomOut.addEventListener("click", async () => {
    if (!zoomCaps) return;
    await setZoom(zoomCaps.current - zoomCaps.step);
  });

  UI.btnLookup.addEventListener("click", () => lookupBarcode(UI.manualBarcode.value));
  UI.manualBarcode.addEventListener("keydown", (e) => {
    if (e.key === "Enter") lookupBarcode(UI.manualBarcode.value);
  });

  UI.btnAdd.addEventListener("click", addLastScan);
  UI.btnRemove.addEventListener("click", removeLastScan);

  UI.btnLibrary.addEventListener("click", () => showLibrary(true));
  UI.btnBack.addEventListener("click", () => showLibrary(false));

  UI.btnExport.addEventListener("click", exportJson);
  UI.fileImport.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importJsonFile(file);
    } catch (err) {
      console.error(err);
      setStatus("Import failed", "bad");
    } finally {
      e.target.value = "";
    }
  });
}

(async function init() {
  await loadState();
  wireUI();

  if (state.lastScan?.barcode) {
    uiSetMeta(state.lastScan);
    updateActionsForBarcode(state.lastScan.barcode);
  } else {
    setHaveBadge("unknown");
  }

  setStatus("Ready", "normal");
})();
