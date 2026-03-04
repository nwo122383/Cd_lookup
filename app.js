/* global ZXing */

const STORAGE_KEY = "cd_library_r1_v2";
const SCROLL_STEP = 56;
const BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
];

const state = {
  scanning: false,
  stream: null,
  rafId: null,
  zxingReader: null,
  cameraMode: "environment",
  cameraLabel: "Camera idle",
  status: "Ready",
  statusDetail: "Rabbit creation mode will use creationStorage when available.",
  lastBarcode: "",
  matches: [],
  selectedReleaseId: "",
  library: [],
  busy: false,
  permissionPrimed: false,
};

const el = {
  status: document.getElementById("status"),
  statusDetail: document.getElementById("statusDetail"),
  video: document.getElementById("video"),
  scroll: document.getElementById("appScroll"),
  cameraLabel: document.getElementById("cameraLabel"),
  runtimeLabel: document.getElementById("runtimeLabel"),
  btnStart: document.getElementById("btn-start"),
  btnStop: document.getElementById("btn-stop"),
  btnFlip: document.getElementById("btn-flip"),
  btnRescan: document.getElementById("btn-rescan"),
  btnAdd: document.getElementById("btn-add"),
  btnLookup: document.getElementById("btn-lookup"),
  manualBarcode: document.getElementById("manualBarcode"),
  currentBarcode: document.getElementById("currentBarcode"),
  matchBanner: document.getElementById("matchBanner"),
  selectedCard: document.getElementById("selectedCard"),
  releaseChoices: document.getElementById("releaseChoices"),
  libraryCount: document.getElementById("libraryCount"),
  libraryList: document.getElementById("libraryList"),
  btnClear: document.getElementById("btn-clear"),
};

function setStatus(text, detail = state.statusDetail) {
  state.status = text;
  state.statusDetail = detail;
  el.status.textContent = text;
  el.statusDetail.textContent = detail;
}

function setCameraLabel(text) {
  state.cameraLabel = text;
  el.cameraLabel.textContent = text;
}

function isCreationStorageAvailable() {
  return Boolean(window.creationStorage?.plain);
}

function getRuntimeLabel() {
  if (isCreationStorageAvailable()) return "Rabbit creation storage active";
  return "Browser fallback storage active";
}

function encodeBase64(text) {
  if (window.TextEncoder) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((value) => {
      binary += String.fromCharCode(value);
    });
    return btoa(binary);
  }

  return btoa(unescape(encodeURIComponent(text)));
}

function decodeBase64(text) {
  const binary = atob(text);

  if (window.TextDecoder) {
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  return decodeURIComponent(escape(binary));
}

const storage = {
  async loadLibrary() {
    if (isCreationStorageAvailable()) {
      const raw = await window.creationStorage.plain.getItem(STORAGE_KEY);
      if (!raw) return [];
      return parseStoredLibrary(raw);
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return parseStoredLibrary(raw);
  },

  async saveLibrary(list) {
    const payload = encodeBase64(JSON.stringify(list));

    if (isCreationStorageAvailable()) {
      await window.creationStorage.plain.setItem(STORAGE_KEY, payload);
      return;
    }

    localStorage.setItem(STORAGE_KEY, payload);
  },

  async clearLibrary() {
    if (isCreationStorageAvailable()) {
      await window.creationStorage.plain.removeItem(STORAGE_KEY);
      return;
    }

    localStorage.removeItem(STORAGE_KEY);
  },
};

function parseStoredLibrary(raw) {
  try {
    const decoded = decodeBase64(raw);
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  return error.message || error.name || JSON.stringify(error);
}

function normalizeBarcode(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\-_:;,.!?'"()&/]+/g, " ")
    .trim();
}

function buildAlbumKey(item) {
  return `${normalizeText(item.artist)}|${normalizeText(item.title)}`;
}

function buildLibraryKey(item) {
  return item.releaseId || `${item.barcode || ""}|${buildAlbumKey(item)}|${item.year || ""}`;
}

function createDraftReleaseFromBarcode(barcode) {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return null;

  return {
    releaseId: `barcode:${normalized}`,
    releaseGroupId: "",
    title: `Barcode ${normalized}`,
    artist: "Unidentified CD",
    year: "",
    barcode: normalized,
    country: "",
    format: "CD",
    label: "",
    addedAt: 0,
  };
}

function findBarcodeOwnershipEntry(barcode) {
  const normalized = normalizeBarcode(barcode);
  if (!normalized) return null;

  return (
    state.library.find((item) => normalizeBarcode(item.barcode) === normalized) || null
  );
}

function stopMediaStream(stream) {
  try {
    if (stream?.getTracks) {
      stream.getTracks().forEach((track) => track.stop());
    }
  } catch {}
}

function mapArtistCredit(artistCredit) {
  if (!Array.isArray(artistCredit)) return "Unknown Artist";

  return artistCredit
    .map((part) => `${part.name || part.artist?.name || ""}${part.joinphrase || ""}`)
    .join("")
    .trim() || "Unknown Artist";
}

function mapRelease(release) {
  const primaryMedium = Array.isArray(release.media) ? release.media[0] : null;
  const releaseGroup = release["release-group"] || release.release_group || {};

  return {
    releaseId: release.id || "",
    releaseGroupId: releaseGroup.id || "",
    title: release.title || "Unknown Title",
    artist: mapArtistCredit(release["artist-credit"]),
    year: release.date ? String(release.date).slice(0, 4) : "",
    barcode: release.barcode || "",
    country: release.country || "",
    format: primaryMedium?.format || "",
    label: release["label-info"]?.[0]?.label?.name || "",
    addedAt: 0,
  };
}

function getSelectedMatch() {
  return state.matches.find((item) => item.releaseId === state.selectedReleaseId) || null;
}

function findOwnership(match) {
  if (!match) return { exact: null, version: null };

  const exact =
    state.library.find((item) => {
      if (item.releaseId && match.releaseId && item.releaseId === match.releaseId) {
        return true;
      }

      return normalizeBarcode(item.barcode) &&
        normalizeBarcode(item.barcode) === normalizeBarcode(match.barcode);
    }) || null;

  if (exact) {
    return { exact, version: exact };
  }

  const version =
    state.library.find((item) => {
      if (item.releaseGroupId && match.releaseGroupId) {
        return item.releaseGroupId === match.releaseGroupId;
      }

      return buildAlbumKey(item) === buildAlbumKey(match);
    }) || null;

  return { exact: null, version };
}

function ownershipMessage(match) {
  if (!match) {
    if (state.lastBarcode) {
      const existing = findBarcodeOwnershipEntry(state.lastBarcode);

      if (existing) {
        return {
          tone: "owned",
          title: "You already saved this barcode.",
          detail: `${existing.artist} - ${existing.title}`,
        };
      }

      return {
        tone: "version",
        title: "No MusicBrainz match yet.",
        detail: "You can still save the barcode-only entry to your library.",
      };
    }

    return {
      tone: "idle",
      title: "Scan a barcode to look up a CD.",
      detail: "Matches and ownership checks will appear here.",
    };
  }

  const ownership = findOwnership(match);

  if (ownership.exact) {
    return {
      tone: "owned",
      title: "You own this exact release.",
      detail: `${match.artist} - ${match.title}${match.year ? ` (${match.year})` : ""}`,
    };
  }

  if (ownership.version) {
    return {
      tone: "version",
      title: "You own another version of this album.",
      detail: `${ownership.version.artist} - ${ownership.version.title}${ownership.version.year ? ` (${ownership.version.year})` : ""}`,
    };
  }

  return {
    tone: "new",
    title: "This CD is not in your library yet.",
    detail: "You can add the selected release below.",
  };
}

function formatReleaseMeta(item) {
  return [item.year, item.country, item.format, item.label].filter(Boolean).join(" • ");
}

function renderSelectedRelease() {
  const selected = getSelectedMatch();
  const ownership = ownershipMessage(selected);

  el.currentBarcode.textContent = state.lastBarcode || "No barcode scanned yet";

  el.matchBanner.className = `match-banner tone-${ownership.tone}`;
  el.matchBanner.innerHTML = `
    <div class="banner-title">${escapeHtml(ownership.title)}</div>
    <div class="banner-detail">${escapeHtml(ownership.detail)}</div>
  `;

  if (!selected) {
    const draft = createDraftReleaseFromBarcode(state.lastBarcode);

    if (draft) {
      const existing = findBarcodeOwnershipEntry(draft.barcode);
      el.selectedCard.innerHTML = `
        <div class="selected-title">${escapeHtml(draft.title)}</div>
        <div class="selected-subtitle">${escapeHtml(draft.artist)}</div>
        <div class="selected-meta">No MusicBrainz release matched this barcode.</div>
        <div class="selected-barcode">Barcode ${escapeHtml(draft.barcode)}</div>
      `;
      el.btnAdd.disabled = Boolean(existing);
      el.btnAdd.textContent = existing ? "Already Owned" : "Save Barcode Only";
    } else {
      el.selectedCard.innerHTML = `
        <div class="empty-card">
          Use Scan to read a barcode, or type a UPC below for a manual lookup.
        </div>
      `;
      el.btnAdd.disabled = true;
      el.btnAdd.textContent = "Add to Library";
    }

    return;
  }

  const meta = formatReleaseMeta(selected);
  el.selectedCard.innerHTML = `
    <div class="selected-title">${escapeHtml(selected.title)}</div>
    <div class="selected-subtitle">${escapeHtml(selected.artist)}</div>
    <div class="selected-meta">${escapeHtml(meta || "MusicBrainz release")}</div>
    <div class="selected-barcode">Barcode ${escapeHtml(selected.barcode || state.lastBarcode)}</div>
  `;

  el.btnAdd.disabled = Boolean(findOwnership(selected).exact);
  el.btnAdd.textContent = findOwnership(selected).exact ? "Already Owned" : "Add to Library";
}

function renderReleaseChoices() {
  if (!state.matches.length) {
    el.releaseChoices.innerHTML = `
      <div class="empty-card compact">
        No release choices yet.
      </div>
    `;
    return;
  }

  el.releaseChoices.innerHTML = "";

  state.matches.forEach((match) => {
    const ownership = findOwnership(match);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `choice ${match.releaseId === state.selectedReleaseId ? "selected" : ""}`;
    button.innerHTML = `
      <div class="choice-title">${escapeHtml(match.title)}</div>
      <div class="choice-subtitle">${escapeHtml(match.artist)}</div>
      <div class="choice-meta">${escapeHtml(formatReleaseMeta(match) || "Release metadata unavailable")}</div>
      <div class="choice-tag ${ownership.exact ? "owned" : ownership.version ? "version" : "new"}">
        ${ownership.exact ? "Owned" : ownership.version ? "Own another version" : "New"}
      </div>
    `;
    button.addEventListener("click", () => {
      state.selectedReleaseId = match.releaseId;
      renderSelectedRelease();
      renderReleaseChoices();
    });
    el.releaseChoices.appendChild(button);
  });
}

function renderLibrary() {
  el.libraryCount.textContent = `${state.library.length}`;
  el.libraryList.innerHTML = "";

  if (!state.library.length) {
    el.libraryList.innerHTML = `
      <div class="empty-card">
        Your library is empty. Scan a CD and add it here.
      </div>
    `;
    return;
  }

  state.library.forEach((item) => {
    const row = document.createElement("div");
    row.className = "library-item";
    row.innerHTML = `
      <div class="library-copy">
        <div class="library-title">${escapeHtml(item.title)}</div>
        <div class="library-subtitle">${escapeHtml(item.artist)}</div>
        <div class="library-meta">${escapeHtml(formatReleaseMeta(item) || `Barcode ${item.barcode || "unknown"}`)}</div>
        <div class="library-barcode">Barcode ${escapeHtml(item.barcode || "unknown")}</div>
      </div>
      <button class="ghost danger" type="button">Remove</button>
    `;

    row.querySelector("button").addEventListener("click", async () => {
      const targetKey = buildLibraryKey(item);
      state.library = state.library.filter((entry) => buildLibraryKey(entry) !== targetKey);
      await storage.saveLibrary(state.library);
      renderLibrary();
      renderSelectedRelease();
      renderReleaseChoices();
      setStatus("Removed from library", `${item.artist} - ${item.title}`);
    });

    el.libraryList.appendChild(row);
  });
}

function renderAll() {
  el.runtimeLabel.textContent = getRuntimeLabel();
  setCameraLabel(state.cameraLabel);
  renderSelectedRelease();
  renderReleaseChoices();
  renderLibrary();
}

async function readVideoDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput");
  } catch {
    return [];
  }
}

function buildCameraAttempts(mode, preferredDeviceId) {
  const base = {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 24, max: 30 },
  };

  return [
    {
      label: `${mode} exact`,
      constraints: { video: { ...base, facingMode: { exact: mode } }, audio: false },
    },
    preferredDeviceId
      ? {
          label: `${mode} device`,
          constraints: { video: { ...base, deviceId: { exact: preferredDeviceId } }, audio: false },
        }
      : null,
    {
      label: `${mode} ideal`,
      constraints: { video: { ...base, facingMode: { ideal: mode } }, audio: false },
    },
    {
      label: "default camera",
      constraints: { video: base, audio: false },
    },
  ].filter(Boolean);
}

function pickPreferredDevice(devices, mode) {
  const target = mode === "environment" ? /(back|rear|environment|world|main)/i : /(front|user|face|selfie)/i;
  return devices.find((device) => target.test(device.label || "")) || null;
}

async function openCameraStream(mode = state.cameraMode) {
  const devices = state.permissionPrimed ? await readVideoDevices() : [];
  const preferredDevice = state.permissionPrimed ? pickPreferredDevice(devices, mode) : null;
  const attempts = buildCameraAttempts(mode, preferredDevice?.deviceId || "");
  let lastError = null;

  for (const attempt of attempts) {
    let candidateStream = null;

    try {
      candidateStream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
      const track = candidateStream.getVideoTracks()[0];
      const settings = track?.getSettings ? track.getSettings() : {};
      const label = track?.label || attempt.label;
      const facing = settings?.facingMode ? ` (${settings.facingMode})` : "";

      setCameraLabel(`Camera ${mode}: ${label}${facing}`);
      return candidateStream;
    } catch (error) {
      lastError = error;
      stopMediaStream(candidateStream);
    }
  }

  throw lastError || new Error("Unable to open the camera");
}

async function primeCameraPermission() {
  if (state.permissionPrimed) return;

  let tempStream = null;

  try {
    tempStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    state.permissionPrimed = true;
  } catch (error) {
    throw new Error(`Camera permission failed: ${getErrorMessage(error)}`);
  } finally {
    stopMediaStream(tempStream);
  }
}

async function stopScan() {
  state.scanning = false;

  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  try {
    state.zxingReader?.reset();
  } catch {}

  stopMediaStream(el.video.srcObject);
  el.video.srcObject = null;
  stopMediaStream(state.stream);
  state.stream = null;
  el.btnStop.disabled = true;
}

async function startScan() {
  if (state.scanning || state.busy) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera API unavailable", "Rabbit creations use standard web camera APIs. This browser does not expose them.");
    return;
  }

  state.scanning = true;
  el.btnStop.disabled = false;
  setStatus("Opening camera", `Trying ${state.cameraMode} mode first.`);

  try {
    await primeCameraPermission();
    state.stream = await openCameraStream(state.cameraMode);
    el.video.srcObject = state.stream;
    await el.video.play().catch(() => {});

    if (typeof ZXing !== "undefined" && ZXing?.BrowserMultiFormatReader) {
      setStatus("Scanning barcode", "ZXing fallback active.");
      await scanWithZXing();
    } else if ("BarcodeDetector" in window) {
      setStatus("Scanning barcode", "BarcodeDetector active.");
      await scanWithBarcodeDetector();
    } else {
      throw new Error("No barcode scanner is available in this runtime");
    }
  } catch (error) {
    state.scanning = false;
    el.btnStop.disabled = true;
    setStatus("Scan failed", getErrorMessage(error));
  }
}

async function scanWithBarcodeDetector() {
  if (!("BarcodeDetector" in window)) {
    throw new Error("BarcodeDetector is unavailable");
  }

  let detector;

  try {
    detector = new BarcodeDetector({ formats: BARCODE_FORMATS });
  } catch {
    detector = new BarcodeDetector();
  }

  async function tick() {
    if (!state.scanning) return;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = el.video.videoWidth || 640;
      canvas.height = el.video.videoHeight || 480;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas context unavailable");
      }

      context.drawImage(el.video, 0, 0, canvas.width, canvas.height);
      const bitmap = await createImageBitmap(canvas);
      const codes = await detector.detect(bitmap);

      if (codes.length) {
        const firstValue = codes[0].rawValue || codes[0].value || "";
        await onBarcodeDetected(firstValue);
        return;
      }
    } catch {}

    state.rafId = requestAnimationFrame(tick);
  }

  state.rafId = requestAnimationFrame(tick);
}

async function scanWithZXing() {
  if (!state.zxingReader) {
    state.zxingReader = new ZXing.BrowserMultiFormatReader();
  }

  state.zxingReader.decodeFromVideoElementContinuously(el.video, (result) => {
    if (!state.scanning || !result) return;
    onBarcodeDetected(result.getText()).catch((error) => {
      setStatus("Scan callback failed", getErrorMessage(error));
    });
  });
}

async function onBarcodeDetected(value) {
  const barcode = normalizeBarcode(value);
  if (!barcode || barcode === state.lastBarcode) return;

  state.lastBarcode = barcode;
  el.manualBarcode.value = barcode;
  await stopScan();
  await lookupBarcode(barcode);
}

async function lookupBarcode(rawValue) {
  const barcode = normalizeBarcode(rawValue);
  if (!barcode) {
    setStatus("Enter a barcode", "UPC/EAN values should be 8 to 14 digits.");
    return;
  }

  state.busy = true;
  state.lastBarcode = barcode;
  el.manualBarcode.value = barcode;
  setStatus("Looking up CD", `Searching MusicBrainz for barcode ${barcode}.`);

  try {
    const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(`barcode:${barcode}`)}&fmt=json&limit=8`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`MusicBrainz returned ${response.status}`);
    }

    const payload = await response.json();
    const releases = Array.isArray(payload.releases) ? payload.releases.map(mapRelease) : [];

    state.matches = releases;
    state.selectedReleaseId = releases[0]?.releaseId || "";
    renderSelectedRelease();
    renderReleaseChoices();

    if (!releases.length) {
      setStatus("No match found", "You can keep the barcode and try again later.");
      return;
    }

    const selected = getSelectedMatch();
    const ownership = findOwnership(selected);

    if (ownership.exact) {
      setStatus("Already owned", "This exact release is already in your library.");
    } else if (ownership.version) {
      setStatus("Version already owned", "You have another version of this album.");
    } else {
      setStatus("Match found", `${releases.length} release${releases.length === 1 ? "" : "s"} found.`);
    }

    el.scroll.scrollTo({ top: el.scroll.scrollHeight / 3, behavior: "smooth" });
  } catch (error) {
    state.matches = [];
    state.selectedReleaseId = "";
    renderSelectedRelease();
    renderReleaseChoices();
    setStatus("Lookup failed", getErrorMessage(error));
  } finally {
    state.busy = false;
  }
}

async function addSelectedToLibrary() {
  const selected = getSelectedMatch() || createDraftReleaseFromBarcode(state.lastBarcode);
  if (!selected) {
    setStatus("No release selected", "Scan or look up a barcode first.");
    return;
  }

  const previousOwnership = getSelectedMatch()
    ? findOwnership(selected)
    : { exact: findBarcodeOwnershipEntry(selected.barcode), version: null };

  if (previousOwnership.exact) {
    setStatus("Already owned", "This exact release is already in your library.");
    return;
  }

  const entry = {
    ...selected,
    addedAt: Date.now(),
  };

  state.library = [entry, ...state.library];
  await storage.saveLibrary(state.library);
  renderLibrary();
  renderSelectedRelease();
  renderReleaseChoices();

  if (previousOwnership.version) {
    setStatus("Version added", "You now own multiple versions of this album.");
  } else {
    setStatus("Added to library", `${selected.artist} - ${selected.title}`);
  }
}

async function clearLibrary() {
  state.library = [];
  await storage.clearLibrary();
  renderLibrary();
  renderSelectedRelease();
  renderReleaseChoices();
  setStatus("Library cleared", "All stored CDs were removed from this app.");
}

async function flipCamera() {
  state.cameraMode = state.cameraMode === "environment" ? "user" : "environment";
  const detail = state.cameraMode === "environment"
    ? "Trying rear-facing constraints."
    : "Trying front-facing constraints.";

  setStatus("Camera mode changed", detail);

  if (state.scanning) {
    await stopScan();
    await startScan();
  } else {
    setCameraLabel(`Camera preference: ${state.cameraMode}`);
  }
}

function handleScrollWheel(direction) {
  const delta = direction === "down" ? SCROLL_STEP : -SCROLL_STEP;
  el.scroll.scrollBy({ top: delta, behavior: "smooth" });
}

function isEditableTarget(target) {
  return target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
}

function attachHardwareEvents() {
  window.addEventListener("sideClick", () => {
    if (state.scanning) {
      stopScan().then(() => {
        setStatus("Scan stopped", "Side button pressed.");
      });
      return;
    }

    if (getSelectedMatch() && !findOwnership(getSelectedMatch()).exact) {
      addSelectedToLibrary();
      return;
    }

    startScan();
  });

  window.addEventListener("longPressStart", () => {
    flipCamera();
  });

  window.addEventListener("scrollUp", () => {
    if (isEditableTarget(document.activeElement)) return;
    handleScrollWheel("up");
  });

  window.addEventListener("scrollDown", () => {
    if (isEditableTarget(document.activeElement)) return;
    handleScrollWheel("down");
  });
}

function bindEvents() {
  el.btnStart.addEventListener("click", () => startScan());
  el.btnStop.addEventListener("click", () => {
    stopScan().then(() => {
      setStatus("Scan stopped", "Camera released.");
    });
  });
  el.btnFlip.addEventListener("click", () => flipCamera());
  el.btnRescan.addEventListener("click", () => {
    state.matches = [];
    state.selectedReleaseId = "";
    state.lastBarcode = "";
    renderSelectedRelease();
    renderReleaseChoices();
    startScan();
  });
  el.btnLookup.addEventListener("click", () => lookupBarcode(el.manualBarcode.value));
  el.btnAdd.addEventListener("click", () => addSelectedToLibrary());
  el.btnClear.addEventListener("click", () => {
    if (confirm("Clear the entire CD library stored in this app?")) {
      clearLibrary();
    }
  });
  el.manualBarcode.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      lookupBarcode(el.manualBarcode.value);
    }
  });
}

async function init() {
  state.library = await storage.loadLibrary();
  el.runtimeLabel.textContent = getRuntimeLabel();
  setCameraLabel(`Camera preference: ${state.cameraMode}`);
  setStatus("Ready", "Scan a CD barcode. Side button starts scanning; long-press flips camera.");
  renderAll();
  bindEvents();
  attachHardwareEvents();
}

init().catch((error) => {
  setStatus("Startup failed", getErrorMessage(error));
});
