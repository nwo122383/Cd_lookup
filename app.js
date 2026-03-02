/* global ZXingBrowser */

const UI = {
  statusPill: document.getElementById("statusPill"),
  btnStartScan: document.getElementById("btnStartScan"),
  btnStopScan: document.getElementById("btnStopScan"),
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
const MB_APP_UA = "r1-cd-catalog/0.1 (standalone)";

let state = {
  catalogByBarcode: {}, // barcode -> item
  lastScan: null,       // { barcode, title, artist, date, mbid, source }
};

let scanner = null;
let scannerActive = false;

/**
 * Storage abstraction:
 * - Prefer r1 creationStorage if available
 * - Fallback to localStorage for normal browsers
 */
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
  UI.statusPill.style.borderColor = "rgba(255,255,255,0.10)";
  UI.statusPill.style.background = "rgba(255,255,255,0.10)";
  if (tone === "ok") UI.statusPill.style.background = "rgba(34,197,94,0.22)";
  if (tone === "bad") UI.statusPill.style.background = "rgba(239,68,68,0.20)";
  if (tone === "warn") UI.statusPill.style.background = "rgba(245,158,11,0.20)";
}

function setHaveBadge(kind) {
  // kind: "have" | "dont" | "unknown"
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
  if (!raw) return "";
  return String(raw).replace(/[^0-9]/g, "").trim();
}

function pickBestRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;

  // Prefer CD releases, official status, higher score.
  // MusicBrainz search includes ext:score-like `score`.
  const scored = releases.map(r => {
    const score = Number(r.score || 0);
    const statusBoost = (r.status === "Official") ? 15 : 0;
    const formatBoost = (r["medium-list"] || r.media || []).some(m => (m.format || "").toLowerCase().includes("cd")) ? 10 : 0;
    const countryBoost = r.country ? 2 : 0;
    const dateBoost = r.date ? 2 : 0;
    return { r, rank: score + statusBoost + formatBoost + countryBoost + dateBoost };
  });

  scored.sort((a,b) => b.rank - a.rank);
  return scored[0].r;
}

function extractArtist(release) {
  // MusicBrainz release search includes artist-credit array
  if (Array.isArray(release["artist-credit"]) && release["artist-credit"].length > 0) {
    // join credited names
    return release["artist-credit"].map(ac => ac.name || ac.artist?.name).filter(Boolean).join("");
  }
  // fallback fields sometimes present
  return release.artist || release.artistname || "Unknown Artist";
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
  const payload = JSON.stringify(state);
  await Storage.setItem(STORAGE_KEY, payload);
}

async function loadState() {
  const raw = await Storage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") state = parsed;
  } catch (_) {}
}

function renderLibrary() {
  const items = Object.values(state.catalogByBarcode);

  // Sort by artist then title
  items.sort((a,b) => {
    const aa = (a.artist || "").toLowerCase();
    const ba = (b.artist || "").toLowerCase();
    if (aa < ba) return -1;
    if (aa > ba) return 1;
    const at = (a.title || "").toLowerCase();
    const bt = (b.title || "").toLowerCase();
    return at.localeCompare(bt);
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

function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function lookupBarcode(barcode) {
  barcode = normalizeBarcode(barcode);
  if (!barcode) {
    setStatus("Enter a code", "warn");
    return;
  }

  // Update “have” indicator immediately
  updateActionsForBarcode(barcode);

  // If already owned, show stored metadata immediately
  if (state.catalogByBarcode[barcode]) {
    const owned = state.catalogByBarcode[barcode];
    state.lastScan = { ...owned };
    uiSetMeta(state.lastScan);
    setStatus("Already in library", "ok");
    return;
  }

  setStatus("Looking up…", "normal");
  UI.scanOverlay.style.display = "none";

  // MusicBrainz Release search by barcode
  // docs: /ws/2/release?query=barcode:XXXXXXXX&fmt=json 5
  const url =
    "https://musicbrainz.org/ws/2/release/?fmt=json&limit=10&query=" +
    encodeURIComponent(`barcode:${barcode}`);

  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": MB_APP_UA,
      },
    });

    if (!res.ok) {
      throw new Error(`MusicBrainz HTTP ${res.status}`);
    }

    const data = await res.json();
    const best = pickBestRelease(data.releases);

    if (!best) {
      state.lastScan = { barcode, title: "Not found", artist: "—", date: "", mbid: "", source: "manual" };
      uiSetMeta(state.lastScan);
      setStatus("Not found (manual add?)", "warn");
      UI.btnAdd.disabled = false; // allow adding a placeholder if you want
      return;
    }

    const item = {
      barcode,
      title: best.title || "Unknown Title",
      artist: extractArtist(best),
      date: best.date ? String(best.date).slice(0,4) : "",
      mbid: best.id || "",
      source: "musicbrainz",
      addedAt: new Date().toISOString(),
    };

    state.lastScan = item;
    uiSetMeta(item);
    updateActionsForBarcode(barcode);
    setStatus("Found metadata", "ok");
  } catch (err) {
    // Could be network/CORS/device restrictions
    state.lastScan = { barcode, title: "Lookup failed", artist: "—", date: "", mbid: "", source: "manual" };
    uiSetMeta(state.lastScan);
    updateActionsForBarcode(barcode);
    setStatus("Lookup failed", "bad");
    console.error(err);
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
  setStatus("Camera…", "normal");

  try {
    // Multi-format reader (UPC/EAN/Code128 etc.)
    scanner = new ZXingBrowser.BrowserMultiFormatReader();

    // Try environment/back camera first (if available)
    const constraints = { video: { facingMode: "environment" }, audio: false };

    await scanner.decodeFromConstraints(constraints, UI.video, (result, err) => {
      if (result) {
        const text = result.getText ? result.getText() : String(result);
        const code = normalizeBarcode(text);

        if (code) {
          // Stop after one successful scan
          stopScan();
          UI.manualBarcode.value = code;
          lookupBarcode(code);
        }
      }
      // ignore NotFoundException spam; it just means “no barcode in frame”
    });

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
  try {
    scanner?.reset?.();
  } catch (_) {}
  scanner = null;
  scannerActive = false;

  // Stop video tracks if possible
  try {
    const stream = UI.video.srcObject;
    if (stream && stream.getTracks) {
      stream.getTracks().forEach(t => t.stop());
    }
    UI.video.srcObject = null;
  } catch (_) {}

  UI.btnStartScan.disabled = false;
  UI.btnStopScan.disabled = true;
  UI.scanOverlay.style.display = "none";
  setStatus("Ready", "normal");
}

async function addLastScan() {
  const item = state.lastScan;
  if (!item?.barcode) return;

  const barcode = normalizeBarcode(item.barcode);
  if (!barcode) return;

  // If “Not found”, let user at least store it; they can edit later in a future version.
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

function showLibrary(show) {
  UI.libraryView.style.display = show ? "block" : "none";
  UI.btnBack.style.display = show ? "inline-flex" : "none";
  UI.btnLibrary.style.display = show ? "none" : "inline-flex";
  if (show) renderLibrary();
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

  // Restore last view quickly
  if (state.lastScan?.barcode) {
    uiSetMeta(state.lastScan);
    updateActionsForBarcode(state.lastScan.barcode);
  } else {
    setHaveBadge("unknown");
  }

  setStatus("Ready", "normal");
})();
