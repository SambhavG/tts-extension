// TTS Worker implementation using kokoro-js
// This is adapted from the TypeScript version for use in the extension

let ttsInstance = null;
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

async function initTTS(modelId, dtype, device) {
  if (ttsInstance) return ttsInstance;

  // Import module relative to worker script URL (works in worker context without chrome API)
  const { KokoroTTS } = await import(new URL("./vendor/kokoro-js.mjs", import.meta.url));

  // Initialize the TTS instance
  console.log("Awaiting KokoroTTS.from_pretrained");
  ttsInstance = await KokoroTTS.from_pretrained(modelId, {
    dtype: dtype || "fp32",
    device: device || "webgpu",
  });
  console.log("KokoroTTS.from_pretrained", ttsInstance);
  return ttsInstance;
}

// Encode mono Float32 PCM data to a 16-bit PCM WAV ArrayBuffer
function encodeWavPCM16(float32Audio, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = float32Audio.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");

  // fmt  chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < float32Audio.length; i++) {
    let s = float32Audio[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // Convert to 16-bit signed int
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

async function getVoices() {
  // Return available voices from kokoro-js
  return Object.keys(ttsInstance.voices || {});
}

async function generateAudio(text, voice) {
  // Generate audio using kokoro-js
  const raw = await ttsInstance.generate(text, {
    voice: voice || "af_heart",
  });
  const audioWav = encodeWavPCM16(raw.audio, raw.sampling_rate);
  return audioWav;
}

self.addEventListener("message", async (e) => {
  const { id, type, payload } = e.data;

  if (type === "init") {
    await initTTS(payload.modelId, payload.dtype, payload.device);
    self.postMessage({ id, ok: true });
  } else if (type === "voices") {
    const voices = await getVoices();
    self.postMessage({ id, ok: true, voices });
  } else if (type === "generate") {
    const audioWav = await generateAudio(payload.text, payload.voice, payload.speed);
    self.postMessage({ id, ok: true, audioWav });
  }
});
