/**
 * Shared constants for the TTS extension.
 * @module constants
 */

/** ONNX model identifier on HuggingFace */
export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Default TTS settings */
export const DEFAULT_SETTINGS = Object.freeze({
  voice: "af_heart",
  speed: 1.0,
  highlightColor: "#ffff00",
});

/** Maximum characters per sentence chunk */
export const SENTENCE_MAX_LENGTH = 350;

/** Number of sentences to prefetch ahead */
export const PREREAD_AHEAD = 5;

/** Maximum cached audio blobs in LRU */
export const LRU_MAX_SIZE = 30;

/** Chunk size for time-stretch processing (samples) */
export const STRETCH_CHUNK_SIZE = 16384;

/** Background message timeout in milliseconds */
export const MESSAGE_TIMEOUT_MS = 30000;

/** Extension message scope for validation */
export const MESSAGE_SCOPE = "kokoro-tts";

/** HTML tags to skip during text extraction */
export const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "VIDEO", "AUDIO"]);

/** Inline tags that don't create text blocks */
export const SIMPLE_INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "BUTTON",
  "CITE",
  "CODE",
  "DATA",
  "DEL",
  "DFN",
  "EM",
  "I",
  "INS",
  "KBD",
  "LABEL",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
  "WBR",
]);

/** Valid message types for validation */
export const VALID_MESSAGE_TYPES = [
  "kokoro:ping",
  "kokoro:getState",
  "kokoro:getModelStatus",
  "kokoro:triggerModelInit",
  "kokoro:listVoices",
  "kokoro:playButtonPressed",
  "kokoro:setSpeed",
  "kokoro:setVoice",
  "kokoro:setAutoScroll",
  "kokoro:setHighlightColor",
  "kokoro:regenerateCurrent",
  "kokoro:clearCache",
  "kokoro:initializeClickHandlers",
  "kokoro:executeCommand",
];
