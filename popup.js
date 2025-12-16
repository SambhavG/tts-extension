const api = chrome;

// --- DOM references ---
const $ = (id) => document.getElementById(id);
const $voice = $("voice");
const $speed = $("speed");
const $readButton = $("read-button");
const $autoScroll = $("auto-scroll");

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

async function ensureInjected() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;

  const ping = await sendToTab(tab.id, { type: "kokoro:ping" });
  if (ping?.ok) return true;

  await api.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });

  const ping2 = await sendToTab(tab.id, { type: "kokoro:ping" });
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
    $voice.innerHTML = `<option value="">${res?.error || "TTS init failed"}</option>`;
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

// --- UI state management ---
async function initState() {
  const stored = await api.storage.sync.get(["kokoroSpeed", "kokoroVoice", "kokoroAutoScroll"]);
  const speed = stored.kokoroSpeed ?? 1.0;
  const voice = stored.kokoroVoice ?? "af_heart";
  const autoScroll = stored.kokoroAutoScroll ?? true;

  $autoScroll.checked = autoScroll;

  const injected = await ensureInjected();
  if (!injected) return;

  await Promise.all([
    sendToActiveTab({ type: "kokoro:setSpeed", speed }),
    sendToActiveTab({ type: "kokoro:setVoice", voice }),
    sendToActiveTab({ type: "kokoro:setAutoScroll", autoScroll }),
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

  const labels = { idle: "Read", playing: "Pause", paused: "Resume" };
  $readButton.textContent = labels[res.state] || "Read";
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
  await sendToActiveTab({ type: "kokoro:clearCache" });
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

// --- Model status checking ---
async function checkModelStatus() {
  const injected = await ensureInjected();
  if (!injected) return;

  const res = await sendToActiveTab({ type: "kokoro:getModelStatus" });

  if (res?.loaded) {
    $readButton.innerHTML = '<span class="read-text">read</span>';
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
    const { loaded, total } = res.downloadProgress;
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    $readButton.innerHTML = `
      <div class="download-progress">
        <div class="progress-bar-container">
          <div class="progress-bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="progress-text">${pct}%</span>
      </div>`;
    setTimeout(checkModelStatus, 200);
    return;
  }

  $readButton.innerHTML = `
    <div class="sine-wave">
      ${Array(12).fill('<span class="wave-bar"></span>').join("")}
    </div>`;
  setTimeout(checkModelStatus, 600);
}

// --- Initialize ---
(async function init() {
  await checkModelStatus();
  await initState();
  await refreshVoices();
})();
