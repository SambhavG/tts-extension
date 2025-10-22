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
const $readButton = document.getElementById("read-button");
// const $start = document.getElementById("start");
// const $pause = document.getElementById("pause");
// const $resume = document.getElementById("resume");
// const $stop = document.getElementById("stop");

// function updateSpeedOut() {
//   if ($speedOut && $speed) {
//     $speedOut.textContent = `${Number($speed.value).toFixed(2)}×`;
//   }
// }

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
  const desired = $voice.dataset.desiredVoice;
  const { kokoroVoice } = await api.storage.sync.get("kokoroVoice");
  const pick = desired || kokoroVoice;
  if (pick && voices.includes(pick)) $voice.value = pick;
  // Do not override transport button states here; they are set by content state
}

async function initUIFromStorage() {
  const { kokoroSpeed = 1.0 } = await api.storage.sync.get(["kokoroSpeed"]);
  $speed.value = kokoroSpeed;
}

async function initUIFromContentState() {
  const injected = await ensureInjected();
  if (!injected) return;
  const stateRes = await sendToActiveTab({ type: "kokoro:getState" });
  if (!stateRes?.ok) return;
  const { state, settings } = stateRes;
  $speed.value = settings.speed;
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
});

const speedCallback = async () => {
  const injected = await ensureInjected();
  if (!injected) return;
  const speed = Number($speed.value);
  await api.storage.sync.set({ kokoroSpeed: speed });
  await sendToActiveTab({ type: "kokoro:setSpeed", speed });
};
// $speed.addEventListener("input", speedCallback);

$speed.addEventListener("change", speedCallback);

(async function init() {
  await initUIFromStorage();
  await initUIFromContentState();
  await refreshVoices();
})();
