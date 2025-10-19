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

const $voice = document.getElementById("voice");
const $speed = document.getElementById("speed");
const $speedOut = document.getElementById("speedOut");
const $selectionOnly = document.getElementById("selectionOnly");
const $start = document.getElementById("start");
const $pause = document.getElementById("pause");
const $resume = document.getElementById("resume");
const $stop = document.getElementById("stop");

function updateSpeedOut() {
  $speedOut.textContent = `${Number($speed.value).toFixed(2)}×`;
}

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
    $start.disabled = true;
    return;
  }

  // Ensure content script is injected and listening
  const injected = await ensureInjected();
  if (!injected) {
    $voice.innerHTML = '<option value="">Content script not loaded. Reload the page and try again.</option>';
    $start.disabled = true;
    return;
  }

  const res = await sendToActiveTab({ type: "kokoro:listVoices" });
  if (!res?.ok) {
    const msg = res?.error || "TTS init failed";
    $voice.innerHTML = `<option value="">${msg}</option>`;
    $start.disabled = true;
    return;
  }
  const voices = Array.isArray(res.voices) ? res.voices : [];
  $voice.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    $voice.appendChild(opt);
  }
  // Load saved voice if any
  const { kokoroVoice } = await api.storage.sync.get("kokoroVoice");
  if (kokoroVoice && voices.includes(kokoroVoice)) $voice.value = kokoroVoice;
  $start.disabled = false;
}

async function initUIFromStorage() {
  const { kokoroSpeed = 1.0, kokoroSelectionOnly = false } = await api.storage.sync.get([
    "kokoroSpeed",
    "kokoroSelectionOnly",
  ]);
  $speed.value = kokoroSpeed;
  updateSpeedOut();
  $selectionOnly.checked = kokoroSelectionOnly;
}

$start.addEventListener("click", async () => {
  const settings = {
    voice: $voice.value || "af_heart",
    speed: Number($speed.value),
    selectionOnly: $selectionOnly.checked,
  };
  await api.storage.sync.set({
    kokoroVoice: settings.voice,
    kokoroSpeed: settings.speed,
    kokoroSelectionOnly: settings.selectionOnly,
  });
  const injected = await ensureInjected();
  if (!injected) return;
  const res = await sendToActiveTab({ type: "kokoro:start", settings });
  if (res?.ok) {
    $pause.disabled = false;
    $stop.disabled = false;
    $start.disabled = true;
    $resume.disabled = true;
  } else {
    alert("Failed to start reading: " + (res?.error || "Content script not available"));
  }
});

$pause.addEventListener("click", async () => {
  const injected = await ensureInjected();
  if (!injected) return;
  const res = await sendToActiveTab({ type: "kokoro:pause" });
  if (res?.ok) {
    $pause.disabled = true;
    $resume.disabled = false;
  } else {
    alert("Failed to pause: " + (res?.error || "Content script not available"));
  }
});

$resume.addEventListener("click", async () => {
  const injected = await ensureInjected();
  if (!injected) return;
  const res = await sendToActiveTab({ type: "kokoro:resume" });
  if (res?.ok) {
    $pause.disabled = false;
    $resume.disabled = true;
  } else {
    alert("Failed to resume: " + (res?.error || "Content script not available"));
  }
});

$stop.addEventListener("click", async () => {
  const injected = await ensureInjected();
  if (!injected) return;
  const res = await sendToActiveTab({ type: "kokoro:stop" });
  if (res?.ok) {
    $start.disabled = false;
    $pause.disabled = true;
    $resume.disabled = true;
    $stop.disabled = true;
  } else {
    alert("Failed to stop: " + (res?.error || "Content script not available"));
  }
});

$speed.addEventListener("input", updateSpeedOut);

(async function init() {
  await initUIFromStorage();
  await refreshVoices();
})();
