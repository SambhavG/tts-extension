const api = chrome;

// --- DOM references ---
const $ = (id) => document.getElementById(id);
const $voice = $("voice");
const $speed = $("speed");
const $readButton = $("read-button");
const $autoScroll = $("auto-scroll");
const $highlightColor = $("highlight-color");

// --- Tab communication ---
async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    api.tabs.sendMessage(tabId, message, (response) => {
      resolve(api.runtime.lastError ? { ok: false, error: api.runtime.lastError.message } : response);
    });
  });
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: "No active tab" };
  return sendToTab(tab.id, message);
}

// --- Content script injection ---
const RESTRICTED_PREFIXES = ["chrome://", "edge://", "about:", "moz-extension://", "chrome-extension://"];

function isRestrictedUrl(url) {
  return RESTRICTED_PREFIXES.some((prefix) => url?.startsWith(prefix));
}

function isPdfUrl(url) {
  if (!url) return false;
  try {
    const urlObj = new URL(url);
    const cleanPath = urlObj.pathname.toLowerCase();
    return (
      cleanPath.endsWith(".pdf") ||
      (urlObj.protocol === "chrome-extension:" && url.includes("pdf")) ||
      (urlObj.protocol === "file:" && cleanPath.endsWith(".pdf"))
    );
  } catch (e) {
    return url.toLowerCase().endsWith(".pdf");
  }
}

async function ensureInjected() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;

  const ping = await sendToTab(tab.id, { type: "kokoro:ping" });
  if (ping?.ok) {
    // Content script is already loaded, initialize click handlers
    await sendToTab(tab.id, { type: "kokoro:initializeClickHandlers" });
    return true;
  }

  await api.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });

  const ping2 = await sendToTab(tab.id, { type: "kokoro:ping" });
  if (ping2?.ok) {
    // Content script just loaded, initialize click handlers
    await sendToTab(tab.id, { type: "kokoro:initializeClickHandlers" });
  }
  return !!ping2?.ok;
}

async function checkContentScriptAvailability() {
  const tab = await getActiveTab();
  return tab && !isRestrictedUrl(tab.url);
}

// --- Voice management ---
async function refreshVoices() {
  const isAvailable = await checkContentScriptAvailability();
  if (!isAvailable) {
    $voice.innerHTML = '<option value="">Extension not available on this page</option>';
    return;
  }

  const injected = await ensureInjected();
  if (!injected) {
    $voice.innerHTML = '<option value="">Content script not loaded. Reload the page and try again.</option>';
    return;
  }

  const res = await sendToActiveTab({ type: "kokoro:listVoices" });
  if (!res?.ok) {
    const errorMsg =
      res?.error === "connection_lost" ? "Connection lost - please refresh the page" : res?.error || "TTS init failed";
    $voice.innerHTML = `<option value="">${errorMsg}</option>`;
    return;
  }

  const voices = Array.isArray(res.voices) ? res.voices : [];
  $voice.innerHTML = voices
    .map((v) => {
      const flag = v[0] === "a" ? "🇺🇸" : "🇬🇧";
      const gender = v[1] === "f" ? "👩" : "👨";
      return `<option value="${v}">${flag}${gender}${v.substring(3)}</option>`;
    })
    .join("");

  const { kokoroVoice } = await api.storage.sync.get("kokoroVoice");
  const pick = $voice.dataset.desiredVoice || kokoroVoice;
  if (pick && voices.includes(pick)) $voice.value = pick;
}

// --- Color utility functions ---
function isColorLight(hexColor) {
  // Remove # if present
  const hex = hexColor.replace("#", "");
  // Convert to RGB
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  // Calculate luminance using the formula for perceived brightness
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5; // Light if above 50% brightness
}

// --- UI state management ---
async function initState() {
  const stored = await api.storage.sync.get(["kokoroSpeed", "kokoroVoice", "kokoroAutoScroll", "kokoroHighlightColor"]);
  const speed = stored.kokoroSpeed ?? 1.0;
  const voice = stored.kokoroVoice ?? "af_heart";
  const autoScroll = stored.kokoroAutoScroll ?? true;
  const highlightColor = stored.kokoroHighlightColor ?? "#22a594";

  $autoScroll.checked = autoScroll;
  $highlightColor.value = highlightColor;

  const injected = await ensureInjected();
  if (!injected) return;

  await Promise.all([
    sendToActiveTab({ type: "kokoro:setSpeed", speed }),
    sendToActiveTab({ type: "kokoro:setVoice", voice }),
    sendToActiveTab({ type: "kokoro:setAutoScroll", autoScroll }),
    sendToActiveTab({ type: "kokoro:setHighlightColor", color: highlightColor }),
  ]);

  syncUIFromContent();
}

async function syncUIFromContent() {
  const injected = await ensureInjected();
  if (!injected) return;

  const res = await sendToActiveTab({ type: "kokoro:getState" });
  if (!res?.ok) return;

  $speed.value = Number(res.settings.speed).toFixed(2);
  $voice.value = res.settings.voice;
  if (res.settings.highlightColor) {
    $highlightColor.value = res.settings.highlightColor;
  }

  const labels = { idle: "Read", playing: "Pause", paused: "Resume" };
  let buttonText = labels[res.state] || "Read";

  // Show position indicator if we have a saved reading position
  if (res.state === "idle" && res.index >= 0 && res.total > 0) {
    buttonText = `Resume (${res.index + 1}/${res.total})`;
  }

  $readButton.textContent = buttonText;
}

// --- Event handlers ---
$readButton.addEventListener("click", async () => {
  if (!(await ensureInjected())) return;
  await sendToActiveTab({ type: "kokoro:playButtonPressed" });
  syncUIFromContent();
});

$voice.addEventListener("change", async () => {
  const voice = $voice.value || "";
  await api.storage.sync.set({ kokoroVoice: voice });
  await sendToActiveTab({ type: "kokoro:setVoice", voice });
  // Instead of clearing cache (which stops playback), regenerate current content
  await sendToActiveTab({ type: "kokoro:regenerateCurrent" });
  syncUIFromContent();
});

$speed.addEventListener("change", async () => {
  if (!(await ensureInjected())) return;
  const speed = Number($speed.value);
  await api.storage.sync.set({ kokoroSpeed: speed });
  await sendToActiveTab({ type: "kokoro:setSpeed", speed });
  syncUIFromContent();
});

$autoScroll.addEventListener("change", async () => {
  const autoScroll = $autoScroll.checked;
  await api.storage.sync.set({ kokoroAutoScroll: autoScroll });
  await sendToActiveTab({ type: "kokoro:setAutoScroll", autoScroll });
});

$highlightColor.addEventListener("change", async () => {
  const color = $highlightColor.value;
  await api.storage.sync.set({ kokoroHighlightColor: color });
  await sendToActiveTab({ type: "kokoro:setHighlightColor", color });
});

// --- Model status checking ---
/**
 * Initializes the popup UI, showing Resume button if state exists.
 * @returns {Promise<boolean>} True if initialization successful
 */
async function initializePopup() {
  const injected = await ensureInjected();
  if (!injected) return false;

  // Check if we have saved state
  const stateRes = await sendToActiveTab({ type: "kokoro:getState" });
  const hasSavedState = stateRes?.ok && stateRes.index >= 0 && stateRes.total > 0;

  if (hasSavedState) {
    // Show Resume button immediately
    await syncUIFromContent();
    // Start model loading in background (won't change UI)
    loadModelInBackground();
  } else {
    // No saved state - show loading progress until model loads
    loadModelWithProgress();
  }

  return true;
}

/**
 * Loads the model and shows progress in the UI.
 */
async function loadModelWithProgress() {
  try {
    // Trigger model initialization
    sendToActiveTab({ type: "kokoro:triggerModelInit" });

    // Poll for completion and show appropriate UI
    const pollForCompletion = async () => {
      const res = await sendToActiveTab({ type: "kokoro:getModelStatus" });

      if (res?.loaded) {
        // Model loaded successfully
        await syncUIFromContent();
        return;
      }

      if (res?.webgpuUnsupported) {
        $readButton.innerHTML =
          '<span class="error-text">WebGPU is not available - please enable graphics acceleration at chrome://settings/system</span>';
        return;
      }

      if (res?.cspError) {
        $readButton.innerHTML = '<span class="error-text">Failed to load, likely due to page\'s security policy</span>';
        return;
      }

      if (res?.downloadProgress) {
        $readButton.innerHTML = `
          <div class="download-progress">
            <span class="progress-text">Downloading TTS model...</span>
          </div>`;
        setTimeout(pollForCompletion, 200);
        return;
      }

      // Still initializing - show loading animation
      $readButton.innerHTML = `
        <div class="sine-wave">
          ${Array(8).fill('<span class="wave-bar"></span>').join("")}
        </div>`;
      setTimeout(pollForCompletion, 600);
    };

    pollForCompletion();
  } catch (error) {
    $readButton.innerHTML = '<span class="error-text">Failed to load TTS model</span>';
    console.error("Model loading failed:", error);
  }
}

/**
 * Loads the model in the background without blocking the UI (for when Resume is already shown).
 */
async function loadModelInBackground() {
  try {
    // Trigger model initialization
    sendToActiveTab({ type: "kokoro:triggerModelInit" });

    // Poll for completion but don't change UI since Resume is already shown
    const pollForCompletion = async () => {
      const res = await sendToActiveTab({ type: "kokoro:getModelStatus" });
      if (res?.loaded) {
        // Model loaded, update UI if needed
        await syncUIFromContent();
        return;
      }

      // Continue polling
      setTimeout(pollForCompletion, 1000);
    };

    pollForCompletion();
  } catch (error) {
    // Silently fail - the Resume button will still work
    console.warn("Background model loading failed:", error);
  }
}

// --- Initialize ---
(async function init() {
  const tab = await getActiveTab();
  if (tab && isPdfUrl(tab.url)) {
    const $main = document.querySelector("main");
    if ($main) {
      $main.innerHTML = `
        <div class="pdf-warning">
          <p>Extensions can't directly read PDFs. Instead, Ctrl/Cmd+A and paste into <a href="https://markdownlivepreview.com" target="_blank">markdownlivepreview.com</a></p>
        </div>
      `;
    }
    return;
  }

  const initialized = await initializePopup();
  if (!initialized) return;

  await initState();
  await refreshVoices();
})();
