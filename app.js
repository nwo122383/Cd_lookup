/* global ZXingBrowser */

const UI = {
  statusPill: document.getElementById("statusPill"),
  btnStartScan: document.getElementById("btnStartScan"),
  btnStopScan: document.getElementById("btnStopScan"),
  btnSnap: document.getElementById("btnSnap"),

  video: document.getElementById("video"),
  scanOverlay: document.getElementById("scanOverlay"),
  snapCanvas: document.getElementById("snapCanvas"),

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
const MB_APP_UA = "r1-cd-catalog/0.3 (snap-decode)";

let state = {
  catalogByBarcode: {},
  lastScan: null,
};

let mediaStream = null;
let videoTrack = null;

// ZXing: use reader + restrict formats (faster)
let reader = null;

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
  const code = String(raw || "").replace(/[^0-9]/g, "").trim();
  // Normalize UPC-A encoded as EAN-13 leading 0
  if (code.length === 13 && code.startsWith("0")) return code.slice(1);
  return code;
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
    return release["artist-credit"].map((ac) => ac.name || ac.artist?.name).filter(Boolean).join("");
  }
  return "Unknown Artist";
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
  const url =
    "https://musicbrainz.org/ws/2/release/?fmt=json&limit=10&query=" +
    encodeURIComponent(`barcode:${barcode}`);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": MB_APP_UA },
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

async function openCamera() {
  // Minimal constraints for max compatibility
  const constraints = { video: true, audio: false };

  // Stop any previous stream
  stopCamera();

  setStatus("Opening camera…", "normal");
  UI.scanOverlay.style.display = "flex";
  UI.scanOverlay.textContent = "Fill frame with barcode • tap Snap";

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    UI.video.srcObject = mediaStream;
    await UI.video.play();

    videoTrack = mediaStream.getVideoTracks()[0] || null;

    UI.btnStartScan.disabled = true;
    UI.btnStopScan.disabled = false;
    UI.btnSnap.disabled = false;

    setStatus("Camera ready", "ok");
  } catch (e) {
    console.error(e);
    setStatus("Camera blocked", "bad");
    UI.btnStartScan.disabled = false;
    UI.btnStopScan.disabled = true;
    UI.btnSnap.disabled = true;
  }
}

function stopCamera() {
  try {
    if (mediaStream && mediaStream.getTracks) {
      mediaStream.getTracks().forEach((t) => t.stop());
    }
  } catch (_) {}

  mediaStream = null;
  videoTrack = null;

  try {
    UI.video.pause();
    UI.video.srcObject = null;
  } catch (_) {}

  UI.btnStartScan.disabled = false;
  UI.btnStopScan.disabled = true;
  UI.btnSnap.disabled = true;
}

async function snapAndDecode() {
  if (!mediaStream) {
    setStatus("Open camera first", "warn");
    return;
  }

  // Draw current frame to canvas
  const canvas = UI.snapCanvas;
  const ctx = canvas.getContext("2d");

  const vw = UI.video.videoWidth || 640;
  const vh = UI.video.videoHeight || 480;

  // Use actual video dimensions for max detail
  canvas.width = vw;
  canvas.height = vh;

  ctx.drawImage(UI.video, 0, 0, vw, vh);

  setStatus("Decoding…", "normal");

  try {
    if (!reader) {
      const hints = new Map();
      hints.set(
        ZXingBrowser.DecodeHintType.POSSIBLE_FORMATS,
        [ZXingBrowser.BarcodeFormat.EAN_13, ZXingBrowser.BarcodeFormat.UPC_A, ZXingBrowser.BarcodeFormat.EAN_8]
      );
      hints.set(ZXingBrowser.DecodeHintType.TRY_HARDER, true);
      reader = new ZXingBrowser.BrowserMultiFormatReader(hints);
    }

    const result = await reader.decodeFromCanvas(canvas);
    const text = result.getText ? result.getText() : String(result);
    const code = normalizeBarcode(text);

    if (!code) {
      setStatus("No barcode found", "warn");
      return;
    }

    UI.manualBarcode.value = code;
    setStatus("Scanned!", "ok");
    await lookupBarcode(code);
  } catch (e) {
    // decodeFromCanvas throws when not found
    setStatus("No barcode found", "warn");
  }
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
  UI.btnStartScan.addEventListener("click", openCamera);
  UI.btnStopScan.addEventListener("click", () => {
    stopCamera();
    setStatus("Ready", "normal");
  });
  UI.btnSnap.addEventListener("click", snapAndDecode);

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
