import { KokoroTTS } from "kokoro-js";
// import { transliterate } from "transliteration";
import anyAscii from "any-ascii";

const api = chrome;
const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let ttsInstance = null;
let initPromise = null;

const GREEK_LETTER_NAMES = new Map(
  Object.entries({
    α: "alpha",
    β: "beta",
    γ: "gamma",
    δ: "delta",
    ε: "epsilon",
    ζ: "zeta",
    η: "eta",
    θ: "theta",
    ι: "iota",
    κ: "kappa",
    λ: "lambda",
    μ: "mu",
    ν: "nu",
    ξ: "xi",
    ο: "omicron",
    π: "pi",
    ρ: "rho",
    σ: "sigma",
    ς: "sigma",
    τ: "tau",
    υ: "upsilon",
    φ: "phi",
    χ: "chi",
    ψ: "psi",
    ω: "omega",
    ϝ: "digamma",
    ϛ: "stigma",
    ϟ: "koppa",
    ϡ: "sampi",
    ϙ: "qoppa",
    ϗ: "kai",
    ϳ: "yot",
  })
);

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

function capitalize(word) {
  if (!word) return word;
  return word[0].toUpperCase() + word.slice(1);
}

function toGreekBaseChar(char) {
  const nfkc = char.normalize("NFKC");
  const stripped = nfkc.normalize("NFD").replace(COMBINING_MARKS_REGEX, "");
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
  return isUpper ? capitalize(name) : name;
}

function replaceGreekLettersWithNames(text) {
  return Array.from(text).map(mapGreekChar).join("");
}

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

function cleanSentences(sentences) {
  if (typeof sentences === "string") {
    sentences = [sentences];
  }

  sentences = sentences.map((sentence) => replaceGreekLettersWithNames(sentence));
  console.log(sentences);
  sentences = sentences.map((sentence) => {
    return anyAscii(sentence);
  });

  // //sentence must be all ascii
  // sentences = sentences.map((sentence) => {
  //   return transliterate(sentence, "ascii");
  // });

  return sentences;
}

async function generateBatch(sentences, voice) {
  await initTTS();
  sentences = cleanSentences(sentences);
  console.log(sentences);
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
