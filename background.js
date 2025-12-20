// Suppress ONNX Runtime warnings by intercepting console.warn
const originalWarn = console.warn;
console.warn = function (...args) {
  // Suppress specific ONNX Runtime warnings
  const message = args.join(" ");
  if (
    message.includes("onnxruntime") &&
    (message.includes("Some nodes were not assigned to the preferred execution providers") ||
      message.includes("Rerunning with verbose output on a non-minimal build will show node assignments") ||
      message.includes("VerifyEachNodeIsAssignedToAnEp"))
  ) {
    return; // Suppress these warnings
  }
  // Call original warn for other messages
  originalWarn.apply(console, args);
};

import { KokoroTTS } from "kokoro-js";
import anyAscii from "any-ascii";

const api = chrome;
const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let ttsInstance = null;
let initPromise = null;
let downloadProgress = { status: "idle", loaded: 0, total: 0 };

// --- Greek letter mapping ---
const GREEK_LETTER_NAMES = new Map([
  ["α", "alpha"],
  ["β", "beta"],
  ["γ", "gamma"],
  ["δ", "delta"],
  ["ε", "epsilon"],
  ["ζ", "zeta"],
  ["η", "eta"],
  ["θ", "theta"],
  ["ι", "iota"],
  ["κ", "kappa"],
  ["λ", "lambda"],
  ["μ", "mu"],
  ["ν", "nu"],
  ["ξ", "xi"],
  ["ο", "omicron"],
  ["π", "pi"],
  ["ρ", "rho"],
  ["σ", "sigma"],
  ["ς", "sigma"],
  ["τ", "tau"],
  ["υ", "upsilon"],
  ["φ", "phi"],
  ["χ", "chi"],
  ["ψ", "psi"],
  ["ω", "omega"],
  ["ϝ", "digamma"],
  ["ϛ", "stigma"],
  ["ϟ", "koppa"],
  ["ϡ", "sampi"],
  ["ϙ", "qoppa"],
  ["ϗ", "kai"],
  ["ϳ", "yot"],
]);

const GREEK_VARIANT_TO_BASE = new Map([
  ["ϐ", "β"],
  ["ϑ", "θ"],
  ["ϒ", "Υ"],
  ["ϓ", "Υ"],
  ["ϔ", "Υ"],
  ["ϕ", "φ"],
  ["ϖ", "π"],
  ["ϰ", "κ"],
  ["ϱ", "ρ"],
  ["ϲ", "σ"],
  ["ϵ", "ε"],
  ["϶", "ε"],
  ["ϴ", "Θ"],
  ["Ϲ", "Σ"],
  ["Ϻ", "Μ"],
  ["ϻ", "μ"],
  ["𝜓", "ψ"],
  ["𝜒", "χ"],
  ["𝜔", "ω"],
  ["𝜁", "ζ"],
  ["𝜂", "η"],
  ["𝜃", "θ"],
  ["𝜄", "ι"],
  ["𝜆", "λ"],
  ["𝜇", "μ"],
  ["𝜈", "ν"],
  ["𝜉", "ξ"],
  ["𝜊", "ο"],
  ["𝜋", "π"],
  ["𝜌", "ρ"],
  ["𝜍", "σ"],
  ["𝜎", "σ"],
  ["𝜏", "τ"],
  ["𝜐", "υ"],
  ["𝜑", "φ"],
]);

const GREEK_SCRIPT_REGEX = /\p{Script=Greek}/u;
const COMBINING_MARKS_REGEX = /\p{M}+/gu;

function toGreekBaseChar(char) {
  const stripped = char.normalize("NFKC").normalize("NFD").replace(COMBINING_MARKS_REGEX, "");
  return GREEK_VARIANT_TO_BASE.get(stripped) || stripped;
}

function mapGreekChar(char) {
  if (!GREEK_SCRIPT_REGEX.test(char)) return char;
  GREEK_SCRIPT_REGEX.lastIndex = 0;

  const base = toGreekBaseChar(char);
  const lower = base.toLowerCase();
  const name = GREEK_LETTER_NAMES.get(lower);
  if (!name) return char;

  const isUpper = base.toUpperCase() === base && base.toLowerCase() !== base;
  return isUpper ? name[0].toUpperCase() + name.slice(1) : name;
}

function replaceGreekLettersWithNames(text) {
  return Array.from(text).map(mapGreekChar).join("");
}

// --- Tab utilities ---
async function getActiveTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function sendCommandToActiveTab(command) {
  const tabId = await getActiveTabId();
  if (!tabId) return { ok: false, error: "no_active_tab" };

  return new Promise((resolve) => {
    api.tabs.sendMessage(tabId, { type: "kokoro:executeCommand", command }, (response) => {
      resolve(api.runtime.lastError ? { ok: false, error: api.runtime.lastError.message } : response);
    });
  });
}

// --- TTS initialization ---
async function initTTS(modelId, dtype, device) {
  if (ttsInstance) return ttsInstance;
  if (initPromise) return initPromise;

  downloadProgress = { status: "downloading", loaded: 0, total: 0 };

  initPromise = KokoroTTS.from_pretrained(modelId || DEFAULT_MODEL_ID, {
    dtype: dtype || "fp32",
    device: device || "webgpu",
    progress_callback: (progress) => {
      if (progress.status === "download") {
        downloadProgress = { status: "downloading", loaded: progress.loaded || 0, total: progress.total || 0 };
      } else if (progress.status === "done") {
        downloadProgress = { status: "idle", loaded: 0, total: 0 };
      }
    },
  })
    .then((instance) => {
      ttsInstance = instance;
      downloadProgress = { status: "idle", loaded: 0, total: 0 };
      return instance;
    })
    .catch((error) => {
      downloadProgress = { status: "idle", loaded: 0, total: 0 };
      throw error;
    });

  return initPromise;
}

// --- Audio encoding ---
function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function encodeWavPCM16(float32Audio, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
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
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);

  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < float32Audio.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Audio[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

function serializeArrayBuffer(buffer) {
  return Array.from(new Uint8Array(buffer));
}

// --- TTS generation ---
async function getVoices() {
  if (!ttsInstance) await initTTS();
  return Object.keys(ttsInstance.voices || {});
}

function cleanSentences(sentences) {
  const list = Array.isArray(sentences) ? sentences : [sentences];
  return list.map((s) => anyAscii(replaceGreekLettersWithNames(s)));
}

async function generateBatch(sentences, voice) {
  await initTTS();

  const cleaned = cleanSentences(sentences);
  const items = cleaned.length ? cleaned : [""];

  const results = await Promise.all(items.map((s) => ttsInstance.generate(s, { voice: voice || "af_heart" })));

  let sampleRate = 24000;
  let totalLength = 0;
  for (const raw of results) {
    if (raw?.sampling_rate) sampleRate = raw.sampling_rate;
    totalLength += raw.audio.length;
  }

  const joined = new Float32Array(totalLength);
  let offset = 0;
  for (const raw of results) {
    joined.set(raw.audio, offset);
    offset += raw.audio.length;
  }

  return encodeWavPCM16(joined, sampleRate);
}

// --- Message handling ---
api.commands.onCommand.addListener((command) => sendCommandToActiveTab(command));

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.scope !== "kokoro-tts") return;
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case "ping":
      return { ok: true };

    case "init":
      await initTTS(payload?.modelId, payload?.dtype, payload?.device);
      return { ok: true };

    case "status":
      return {
        ok: true,
        loaded: ttsInstance !== null,
        downloadProgress: downloadProgress.status === "downloading" ? downloadProgress : null,
      };

    case "voices":
      return { ok: true, voices: await getVoices() };

    case "generate": {
      const audioWav = await generateBatch([payload?.text], payload?.voice);
      return { ok: true, audioWav: serializeArrayBuffer(audioWav) };
    }

    case "generateBatch": {
      const audioWav = await generateBatch(payload?.sentences, payload?.voice);
      return { ok: true, audioWav: serializeArrayBuffer(audioWav) };
    }

    default:
      return { ok: false, error: "unknown_message_type" };
  }
}
