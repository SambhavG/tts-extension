const api = chrome; // Firefox aliases chrome→browser; callbacks still work

async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function sendToActiveTab(message) {
  return activeTabId().then((id) => {
    if (!id) return Promise.reject(new Error("No active tab"));
    return new Promise((resolve) => {
      api.tabs.sendMessage(id, message, (response) => {
        // Handle chrome.runtime.lastError
        if (api.runtime.lastError) {
          resolve({ ok: false, error: api.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  });
}

const $status = document.getElementById("status");
const $voice = document.getElementById("voice");
const $speed = document.getElementById("speed");
const $readButton = document.getElementById("read-button");

async function ensureInjected() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;

  // Quick ping to see if content script is listening
  const ping = await new Promise((resolve) => {
    api.tabs.sendMessage(tab.id, { type: "kokoro:ping" }, (res) => {
      if (api.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
  if (ping?.ok) return true;

  // Try injecting CSS and JS if not present
  await api.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });

  const ping2 = await new Promise((resolve) => {
    api.tabs.sendMessage(tab.id, { type: "kokoro:ping" }, (res) => {
      if (api.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
  return !!ping2?.ok;
}

async function checkContentScriptAvailability() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;

  // Content script doesn't load on chrome://, edge://, or other extension pages
  const url = tab.url || "";
  return (
    !url.startsWith("chrome://") &&
    !url.startsWith("edge://") &&
    !url.startsWith("about:") &&
    !url.startsWith("moz-extension://") &&
    !url.startsWith("chrome-extension://")
  );
}

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
    const msg = res?.error || "TTS init failed";
    $voice.innerHTML = `<option value="">${msg}</option>`;
    return;
  }
  const voices = Array.isArray(res.voices) ? res.voices : [];
  $voice.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = (v[0] == "a" ? "🇺🇸" : "🇬🇧") + (v[1] == "f" ? "👩" : "👨") + v.substring(3);
    $voice.appendChild(opt);
  }
  // Load saved voice if any
  const desired = $voice.dataset.desiredVoice;
  const { kokoroVoice } = await api.storage.sync.get("kokoroVoice");
  const pick = desired || kokoroVoice;
  if (pick && voices.includes(pick)) $voice.value = pick;
}

async function initState() {
  const { kokoroSpeed = 1.0 } = await api.storage.sync.get(["kokoroSpeed"]);
  const { kokoroVoice = "af_heart" } = await api.storage.sync.get(["kokoroVoice"]);
  const speedRes = await sendToActiveTab({ type: "kokoro:setSpeed", speed: kokoroSpeed });
  const voiceRes = await sendToActiveTab({ type: "kokoro:setVoice", voice: kokoroVoice });
  initUIFromContentState();
}

async function initUIFromContentState() {
  const injected = await ensureInjected();
  if (!injected) return;
  const stateRes = await sendToActiveTab({ type: "kokoro:getState" });
  if (!stateRes?.ok) return;
  const { state, settings } = stateRes;
  $speed.value = Number(settings.speed).toFixed(2);
  $voice.value = settings.voice;
  if (state === "idle") {
    $readButton.textContent = "Read";
  } else if (state === "playing") {
    $readButton.textContent = "Pause";
  } else if (state === "paused") {
    $readButton.textContent = "Resume";
  }
}

$readButton.addEventListener("click", async () => {
  const injected = await ensureInjected();
  if (!injected) return;

  await sendToActiveTab({ type: "kokoro:playButtonPressed" });
  initUIFromContentState();
});

$voice.addEventListener("change", async () => {
  const v = $voice.value || "";
  await api.storage.sync.set({ kokoroVoice: v });
  await sendToActiveTab({ type: "kokoro:setVoice", voice: v });
  await sendToActiveTab({ type: "kokoro:clearCache" });
  await initUIFromContentState();
});

$speed.addEventListener("change", async () => {
  const injected = await ensureInjected();
  if (!injected) return;
  const speed = Number($speed.value);
  await api.storage.sync.set({ kokoroSpeed: speed });
  await sendToActiveTab({ type: "kokoro:setSpeed", speed });
  await initUIFromContentState();
});

async function checkModelStatus() {
  const injected = await ensureInjected();
  if (!injected) {
    $status.style.display = "none";
    return;
  }

  const res = await sendToActiveTab({ type: "kokoro:getModelStatus" });
  if (res?.loaded) {
    $status.style.display = "none";
  } else {
    $status.style.display = "flex";
    $status.innerHTML = `
      <span class="loading-text">Model is loading</span>
      <div class="sine-wave">
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
        <span class="wave-bar"></span>
      </div>
    `;
    // Check again in 500ms
    setTimeout(checkModelStatus, 500);
  }
}

(async function init() {
  await checkModelStatus();
  await initState();
  // await initUIFromContentState();
  await refreshVoices();
})();
