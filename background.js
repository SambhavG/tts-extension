import { KokoroTTS } from "kokoro-js";

const api = chrome;
const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let ttsInstance = null;
let initPromise = null;

async function getActiveTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function initTTS(modelId, dtype, device) {
  if (ttsInstance) return ttsInstance;
  if (!initPromise) {
    const resolvedModelId = modelId || DEFAULT_MODEL_ID;
    initPromise = KokoroTTS.from_pretrained(resolvedModelId, {
      dtype: dtype || "fp32",
      device: device || "webgpu",
    }).then((instance) => {
      ttsInstance = instance;
      return instance;
    });
  }
  return initPromise;
}

function encodeWavPCM16(float32Audio, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = float32Audio.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");

  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);

  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < float32Audio.length; i++) {
    let s = float32Audio[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, val, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function serializeArrayBuffer(buffer) {
  return Array.from(new Uint8Array(buffer));
}

async function getVoices() {
  if (!ttsInstance) await initTTS();
  return Object.keys(ttsInstance.voices || {});
}

async function generateAudio(text, voice) {
  await initTTS();
  const raw = await ttsInstance.generate(text, {
    voice: voice || "af_heart",
  });
  return encodeWavPCM16(raw.audio, raw.sampling_rate);
}

async function generateBatch(sentences, voice) {
  await initTTS();
  let items = sentences;
  if (!Array.isArray(items) || items.length === 0) {
    items = [""];
  }
  const pcmParts = [];
  let sampleRate = 24000;
  const results = await Promise.all(items.map((s) => ttsInstance.generate(s, { voice: voice || "af_heart" })));
  for (const raw of results) {
    if (raw?.sampling_rate) sampleRate = raw.sampling_rate;
    pcmParts.push(raw.audio);
  }
  const totalLength = pcmParts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Float32Array(totalLength);
  let offset = 0;
  for (const part of pcmParts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return encodeWavPCM16(joined, sampleRate);
}

async function sendCommandToActiveTab(command) {
  return getActiveTabId().then((tabId) => {
    if (!tabId) return { ok: false, error: "no_active_tab" };
    return new Promise((resolve) => {
      api.tabs.sendMessage(tabId, { type: "kokoro:executeCommand", command }, (response) => {
        if (api.runtime.lastError) {
          resolve({ ok: false, error: api.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  });
}

api.commands.onCommand.addListener(async (command) => {
  await sendCommandToActiveTab(command);
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log("Message received: ", message, _sender);
  if (message?.scope !== "kokoro-tts") return;

  (async () => {
    switch (message.type) {
      case "init": {
        await initTTS(message.payload?.modelId, message.payload?.dtype, message.payload?.device);
        sendResponse({ ok: true });
        break;
      }
      case "status": {
        sendResponse({ ok: true, loaded: ttsInstance !== null });
        break;
      }
      case "voices": {
        const voices = await getVoices();
        sendResponse({ ok: true, voices });
        break;
      }
      case "generate": {
        const audioWav = await generateAudio(message.payload?.text, message.payload?.voice);
        sendResponse({ ok: true, audioWav: serializeArrayBuffer(audioWav) });
        break;
      }
      case "generateBatch": {
        const audioWav = await generateBatch(message.payload?.sentences, message.payload?.voice);
        sendResponse({ ok: true, audioWav: serializeArrayBuffer(audioWav) });
        break;
      }
      default: {
        sendResponse({ ok: false, error: "unknown_message_type" });
        break;
      }
    }
  })();

  return true;
});
