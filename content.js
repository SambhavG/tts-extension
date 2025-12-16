// TTS Engine functions (inlined from ttsEngine.js)
let initted = "not_started";
let webgpuUnsupported = !(typeof navigator !== "undefined" && navigator && navigator.gpu);
let webgpuProbePromise = null;
let autoScrollEnabled = true;

function probeWebGPU() {
  if (webgpuProbePromise) return webgpuProbePromise;
  webgpuProbePromise = (async () => {
    if (!(typeof navigator !== "undefined" && navigator && navigator.gpu)) {
      webgpuUnsupported = true;
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) webgpuUnsupported = true;
  })();
  return webgpuProbePromise;
}

// You can change this if you use a different model by default
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_SETTINGS = Object.freeze({ voice: "af_heart", speed: 1.0 });

// Maximum length for a sentence/chunk to send to the TTS model
// Sentences longer than this will be split at word boundaries
const SENTENCE_MAX_LENGTH = 350;

async function callBackground(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ scope: "kokoro-tts", type: message.type, payload: message.payload }, (response) => {
      resolve(response || {});
    });
  });
}

async function initTTS() {
  if (initted === "done") return;
  await probeWebGPU();
  if (webgpuUnsupported) return;
  initted = "initing";
  await callBackground({
    type: "init",
    payload: { modelId: MODEL_ID, dtype: "fp32", device: "webgpu" },
  });
  initted = "done";
}

async function listVoices() {
  await probeWebGPU();
  if (webgpuUnsupported) return [];
  await initTTS();
  const { voices } = await callBackground({ type: "voices" });
  return Array.isArray(voices) ? voices : [];
}

// Split paragraph text into individual sentences
function splitIntoSentences(text) {
  const sentences = (text || "")
    .split(/(?<=[\.\!?…])\s+(?=[A-Z0-9""(\[])|(?<=\n)\s*|(?<=—)\s*|(?<=--)\s*|\s*(?=\()|(?<=\))\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [text];
}

// Slice a sentence into smaller chunks if it exceeds SENTENCE_MAX_LENGTH
// Splits intelligently at word boundaries, preferring natural pause points
function sliceLongSentence(sentence, maxLength = SENTENCE_MAX_LENGTH) {
  if (!sentence || sentence.length <= maxLength) {
    return [sentence];
  }

  const chunks = [];
  let remaining = sentence;

  while (remaining.length > maxLength) {
    // Try to find natural pause points first (comma, semicolon, colon, dash)
    let splitPoint = -1;
    const pauseChars = [",", ";", ":", "—", "-"];
    for (const ch of pauseChars) {
      const idx = remaining.lastIndexOf(ch, maxLength);
      if (idx > maxLength * 0.4) {
        // Don't split too early
        splitPoint = idx + 1;
        break;
      }
    }

    // Fall back to last space before maxLength
    if (splitPoint <= 0) {
      splitPoint = remaining.lastIndexOf(" ", maxLength);
    }

    // If no space found before maxLength, look for first space after
    if (splitPoint <= 0) {
      splitPoint = remaining.indexOf(" ", 1);
    }

    // If still no space, force split at maxLength (edge case for very long words)
    if (splitPoint <= 0) {
      splitPoint = maxLength;
    }

    chunks.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

// Generate audio blob for a single sentence/chunk
async function generateSentenceBlob(text, voice = "af_heart") {
  await probeWebGPU();
  if (webgpuUnsupported) return null;
  await initTTS();
  const { audioWav } = await callBackground({
    type: "generateBatch",
    payload: { sentences: [text], voice },
  });
  let wavBuffer;
  if (audioWav instanceof ArrayBuffer) {
    wavBuffer = audioWav;
  } else if (Array.isArray(audioWav)) {
    wavBuffer = new Uint8Array(audioWav).buffer;
  } else if (audioWav && ArrayBuffer.isView(audioWav) && audioWav.buffer instanceof ArrayBuffer) {
    wavBuffer = audioWav.buffer;
  } else {
    wavBuffer = new ArrayBuffer(0);
  }
  return new Blob([wavBuffer], { type: "audio/wav" });
}

const api = chrome; // Firefox aliases chrome to browser

// --- Highlighter (text-range)
class Highlighter {
  constructor() {
    this.prevEl = null;
    this.prevWrapper = null;
  }
  clear() {
    if (this.prevEl) {
      this.prevEl.classList.remove("kokoro-tts-highlight");
      this.prevEl.classList.remove("kokoro-tts-pending");
      this.prevEl = null;
    }
    if (this.prevWrapper && this.prevWrapper.parentNode) {
      const wrapper = this.prevWrapper;
      while (wrapper.firstChild) {
        wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
      }
      wrapper.parentNode.removeChild(wrapper);
      this.prevWrapper = null;
    }
  }
  highlight(el, text) {
    console.log("Highlighting element, autoScrollEnabled:", autoScrollEnabled);
    if (!el) return;
    this.clear();
    if (text && typeof text === "string" && text.trim()) {
      const res = this.wrapTextRange(el, text, "kokoro-tts-highlight");
      if (res && res.wrapper) {
        this.prevWrapper = res.wrapper;
        if (autoScrollEnabled) {
          res.wrapper.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        }
        return;
      }
    }
    this.prevEl = el;
    el.classList.add("kokoro-tts-highlight");
    console.log("Highlighting element, autoScrollEnabled:", autoScrollEnabled);
    if (autoScrollEnabled) {
      console.log("Scrolling to highlighted element");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      console.log("Auto-scroll disabled, not scrolling");
    }
  }
  // Pending (orange) highlight while generation is in progress
  highlightPending(el, text) {
    if (!el) return;
    this.clear();
    if (text && typeof text === "string" && text.trim()) {
      const res = this.wrapTextRange(el, text, "kokoro-tts-pending");
      if (res && res.wrapper) {
        this.prevWrapper = res.wrapper;
        if (autoScrollEnabled) {
          res.wrapper.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        }
        return;
      }
    }
    this.prevEl = el;
    el.classList.add("kokoro-tts-pending");
    if (autoScrollEnabled) {
      console.log("Scrolling to pending element");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      console.log("Auto-scroll disabled, not scrolling");
    }
  }
  // Switch pending highlight to active (yellow)
  activate() {
    if (this.prevWrapper) {
      this.prevWrapper.classList.remove("kokoro-tts-pending");
      this.prevWrapper.classList.add("kokoro-tts-highlight");
      return;
    }
    if (this.prevEl) {
      this.prevEl.classList.remove("kokoro-tts-pending");
      this.prevEl.classList.add("kokoro-tts-highlight");
    }
  }
  wrapTextRange(rootEl, targetText, className = "kokoro-tts-highlight") {
    const tw = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    const map = [];
    let norm = "";
    let node;
    let prevWasSpace = false;
    while ((node = tw.nextNode())) {
      const s = node.nodeValue || "";
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        const isSpace = /\s/.test(ch);
        if (isSpace) {
          if (prevWasSpace) continue;
          norm += " ";
          map.push({ node, offset: i });
          prevWasSpace = true;
        } else {
          norm += ch;
          map.push({ node, offset: i });
          prevWasSpace = false;
        }
      }
    }
    const target = targetText.replace(/\s+/g, " ").trim();
    const startIdx = norm.indexOf(target);
    if (startIdx === -1) return null;
    const endIdx = startIdx + target.length - 1;
    const start = map[startIdx];
    const end = map[endIdx];
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    const span = document.createElement("span");
    span.className = className;
    const contents = range.extractContents();
    span.appendChild(contents);
    range.insertNode(span);
    return { wrapper: span };
  }
}

// --- Utilities to collect readable blocks
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "VIDEO", "AUDIO"]);
const SIMPLE_INLINE_TAGS = new Set([
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
const PREREAD_AHEAD = 5; // how many blocks ahead to pre-generate
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    style.opacity !== "0"
  );
}

function isReadableBlock(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (SKIP_TAGS.has(el.tagName)) return false;
  const name = el.tagName;
  if (["P", "LI", "BLOCKQUOTE"].includes(name)) return true;
  if (/^H[1-6]$/.test(name)) return true;
  // Fallback: divs that look like paragraphs
  if (name === "DIV") {
    const text = el.textContent?.trim() || "";
    return text.split(/\s+/).length >= 6;
  }
  return false;
}

function normalizeTextContent(el) {
  const text = el.innerText || el.textContent || "";
  return text.replace(/\s+/g, " ").trim();
}

function getCandidateTextMeta(el) {
  if (!(el instanceof HTMLElement)) return null;
  if (SKIP_TAGS.has(el.tagName)) return null;
  if (!isVisible(el)) return null;
  if (SIMPLE_INLINE_TAGS.has(el.tagName)) return null;
  const text = normalizeTextContent(el);
  if (text.length === 0) return null;
  return {
    el,
    text,
    isBlock: isReadableBlock(el),
  };
}

function isAncestorOf(a, b) {
  if (!a || !b) return false;
  return a !== b && a.contains(b);
}

function generateXPath(el) {
  if (!(el instanceof Element)) return "";
  const segments = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) index++;
      sib = sib.previousElementSibling;
    }
    segments.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }
  return `/${segments.join("/")}`;
}

function resolveXPath(xpath) {
  const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  return result.singleNodeValue;
}

function chooseRoot() {
  const article = document.querySelector("article");
  if (article && isVisible(article)) return article;
  const main = document.querySelector("main");
  if (main && isVisible(main)) return main;
  return document.body;
}

function collectTextContainers(root) {
  const metaList = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let node;
  while ((node = walker.nextNode())) {
    const meta = getCandidateTextMeta(node);
    if (!meta) continue;
    metaList.push(meta);
  }

  const blockMeta = metaList.filter((m) => m.isBlock);
  const pool = blockMeta.length ? blockMeta : metaList;

  const keep = pool.filter((meta, idx) => {
    for (let i = 0; i < pool.length; i++) {
      if (i === idx) continue;
      const other = pool[i];
      if (isAncestorOf(meta.el, other.el)) return false;
    }
    return true;
  });

  return keep.map((meta) => ({ xpath: generateXPath(meta.el), el: meta.el, text: meta.text }));
}

class KokoroReader {
  constructor() {
    this.queue = [];
    this.idx = -1;
    this.highlighter = new Highlighter();
    this.settings = { ...DEFAULT_SETTINGS };
    this.state = "idle"; // idle | playing | paused
    this.stateWaiters = [];
    this.generatedLRU = new Map(); // index -> true, Map order is LRU (oldest -> newest)
    this.audioContext = null;
    this.playback = this.createPlaybackState();
    this.forceWebAudio = false;
    this._stretchWindow = null;
    this._stretchWindowSize = 0;
    this.buildQueue();
  }

  createPlaybackState() {
    return {
      abortController: null,
      cleanup: null,
      mode: null,
      htmlAudio: null,
      webAudio: null,
    };
  }

  applyPlaybackContext(partial = {}) {
    this.playback = { ...this.playback, ...partial };
  }

  clearPlaybackContext({ stopSource = true } = {}) {
    const cleanup = this.currentPlaybackCleanup;
    if (typeof cleanup === "function") {
      cleanup(stopSource);
    }
    this.applyPlaybackContext({
      abortController: null,
      cleanup: null,
      mode: null,
      htmlAudio: null,
      webAudio: null,
    });
  }

  abortActivePlayback() {
    const controller = this.abortController;
    if (controller) {
      controller.abort();
      this.abortController = null;
    }
  }

  createAbortController() {
    const controller = new AbortController();
    this.abortController = controller;
    return controller;
  }

  beginPlaybackLoop(startIndex = 0) {
    const controller = this.createAbortController();
    this.loop(controller.signal, startIndex);
  }

  updateSettings(partial = {}) {
    this.settings = { ...this.settings, ...partial };
    return this.settings;
  }

  resetGenerationTracking() {
    this.generatedLRU.clear();
    if (!Array.isArray(this.queue)) return;
    for (const item of this.queue) {
      if (!item) continue;
      item.genStatus = "not_generated";
      item.genPromise = null;
      item.blob = null;
    }
  }

  get audio() {
    return this.playback.htmlAudio;
  }

  set audio(value) {
    this.playback.htmlAudio = value;
  }

  get currentPlaybackMode() {
    return this.playback.mode;
  }

  set currentPlaybackMode(value) {
    this.playback.mode = value;
  }

  get currentPlaybackCleanup() {
    return this.playback.cleanup;
  }

  set currentPlaybackCleanup(value) {
    this.playback.cleanup = value;
  }

  get webAudioState() {
    return this.playback.webAudio;
  }

  set webAudioState(value) {
    this.playback.webAudio = value;
  }

  get abortController() {
    return this.playback.abortController;
  }

  set abortController(value) {
    this.playback.abortController = value;
  }

  // State machine: centralized transition logic
  setState(newState) {
    const validTransitions = {
      idle: ["playing"],
      playing: ["paused", "idle", "playing"],
      paused: ["playing", "idle"],
    };
    const allowed = validTransitions[this.state];
    if (!allowed || !allowed.includes(newState)) {
      console.warn(`[KokoroReader] Invalid state transition: ${this.state} -> ${newState}`);
      return false;
    }
    this.state = newState;
    this.notifyStateWaiters();
    return true;
  }

  waitForState(predicate, signal) {
    if (typeof predicate !== "function") {
      return Promise.resolve();
    }
    if (predicate(this.state)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = {
        predicate,
        done: false,
        cleanup: null,
        resolve: () => {
          if (waiter.done) return;
          waiter.done = true;
          if (typeof waiter.cleanup === "function") {
            waiter.cleanup();
            waiter.cleanup = null;
          }
          resolve();
        },
      };

      if (signal && typeof signal.addEventListener === "function") {
        if (signal.aborted) {
          waiter.resolve();
          return;
        }
        const onAbort = () => {
          waiter.resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      this.stateWaiters.push(waiter);
    });
  }

  notifyStateWaiters() {
    if (!Array.isArray(this.stateWaiters) || this.stateWaiters.length === 0) {
      return;
    }
    const pending = [];
    for (const waiter of this.stateWaiters) {
      if (!waiter || waiter.done) {
        continue;
      }
      if (typeof waiter.predicate === "function" && waiter.predicate(this.state)) {
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.stateWaiters = pending;
  }

  // Ensure we're in a valid state for playback operations
  ensurePlaybackState() {
    if (this.state !== "playing" && this.state !== "paused") {
      console.warn(`[KokoroReader] ensurePlaybackState: not in playback state (${this.state})`);
      return false;
    }
    return true;
  }

  async buildQueue() {
    const sel = window.getSelection();
    const hasSelection = false;

    const root = hasSelection ? sel.getRangeAt(0).commonAncestorContainer : chooseRoot();
    const rootEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    const containers = collectTextContainers(rootEl || document.body);

    // Build queue at sentence level (with long sentence slicing)
    this.queue = [];
    for (const c of containers) {
      const sentences = splitIntoSentences(c.text);
      for (const sentence of sentences) {
        const chunks = sliceLongSentence(sentence);
        for (const chunk of chunks) {
          this.queue.push({
            xpath: c.xpath,
            el: c.el,
            text: chunk, // The sentence/chunk to read and highlight
            genStatus: "not_generated", // not_generated | generating | generated
            genPromise: null,
            blob: null,
          });
        }
      }
    }

    this.generatedLRU.clear();

    // Bind click/keyboard handlers to allow jumping to a specific block
    // Track elements we've already bound to avoid duplicates (multiple sentences per element)
    const boundElements = new Set();
    this.queue.forEach((item, i) => {
      const el = item.el && document.contains(item.el) ? item.el : resolveXPath(item.xpath);
      if (!el) return;
      if (el.dataset.kokoroClickableBound === "1" || boundElements.has(el)) return;
      boundElements.add(el);
      el.dataset.kokoroClickableBound = "1";
      el.classList.add("kokoro-tts-clickable");
      // Find the first queue index for this element
      const firstIdx = this.queue.findIndex((q) => q.el === el || q.xpath === item.xpath);
      el.addEventListener("click", () => {
        this.jumpTo(firstIdx >= 0 ? firstIdx : i);
      });
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    });
    this.idx = -1;
  }

  // Centralized generation respecting per-item state
  generateForIndex(index) {
    const item = this.queue[index];
    if (!item) return null;
    if (item.genStatus === "generated") {
      // Access bumps LRU priority
      this.bumpLRU(index);
      return Promise.resolve(item.blob);
    }
    if (item.genStatus === "generating" && item.genPromise) {
      return item.genPromise;
    }
    // Start generation for single sentence/chunk
    item.genStatus = "generating";
    const p = (async () => {
      const blob = await generateSentenceBlob(item.text, this.settings.voice);
      item.blob = blob;
      item.genStatus = "generated";
      // On generation completion, bump LRU and evict if needed
      this.bumpLRU(index);
      this.evictIfNeeded();
      return blob;
    })();
    item.genPromise = p;
    return p;
  }

  // LRU helpers: bump on access or generation, keep only 30 most recent generated items
  bumpLRU(index) {
    // Only track items that are actually generated
    const item = this.queue[index];
    if (!item || item.genStatus !== "generated") return;
    if (this.generatedLRU.has(index)) this.generatedLRU.delete(index);
    this.generatedLRU.set(index, true);
  }

  evictIfNeeded() {
    while (this.generatedLRU.size > 30) {
      const oldestKey = this.generatedLRU.keys().next().value;
      this.generatedLRU.delete(oldestKey);
      const it = this.queue[oldestKey];
      if (it) {
        it.blob = null;
        it.genPromise = null;
        it.genStatus = "not_generated";
      }
    }
  }

  async start(settings) {
    // Stop any ongoing playback first
    if (this.state === "playing" || this.state === "paused") {
      await this.stop();
    }

    this.updateSettings(settings);
    await probeWebGPU();
    if (webgpuUnsupported) {
      alert("WebGPU is not available in this browser/device.");
      return { ok: false };
    }
    await initTTS();
    await this.buildQueue();

    if (!this.queue.length) {
      alert("No readable text found on this page.");
      return { ok: false };
    }

    // Ensure we're in idle state before starting
    if (this.state !== "idle") {
      console.warn(`[KokoroReader] start: not in idle state (${this.state})`);
      return { ok: false };
    }

    if (!this.setState("playing")) {
      return { ok: false };
    }

    this.beginPlaybackLoop(0);
    return { ok: true };
  }

  async ensurePrefetch(startIndex) {
    for (let j = startIndex; j < Math.min(this.queue.length, startIndex + PREREAD_AHEAD); j++) {
      const item = this.queue[j];
      if (!item) continue;
      if (item.genStatus === "generated" || item.genStatus === "generating") continue;
      // Fire-and-forget generation kickoff; do not await here
      this.generateForIndex(j);
    }
  }

  async loop(signal, startIndex = 0) {
    for (let i = Math.max(0, startIndex); i < this.queue.length; i++) {
      if (signal.aborted) {
        break;
      }

      // Verify we're still in a valid playback state
      if (!this.ensurePlaybackState()) {
        break;
      }
      this.idx = i;
      const item = this.queue[i];

      // Highlight current text within the element
      const currentEl = item.el && document.contains(item.el) ? item.el : resolveXPath(item.xpath);
      this.highlighter.highlightPending(currentEl, item.text);

      // Generate or reuse TTS for current via stateful helper
      const blob = await this.generateForIndex(i);

      // Playback counts as access; bump priority and evict if needed
      this.bumpLRU(i);
      this.evictIfNeeded();

      if (signal.aborted) break;

      if (this.state === "paused") {
        await this.waitForState((state) => state !== "paused", signal);
      }

      if (signal.aborted) break;
      if (this.state !== "playing") break;

      // Activate highlight now that audio is ready
      this.highlighter.activate();

      // Play
      let playPromise = this.playBlob(blob, signal);
      // Pre-generate next items while current is playing
      // Kick off prefetch without awaiting it; only await playback
      this.ensurePrefetch(i + 1);
      await playPromise;

      if (signal.aborted) break;
    }

    // Only clear and reset if we completed naturally (not aborted)
    if (!signal.aborted) {
      this.clearPlaybackContext({ stopSource: false });
      this.highlighter.clear();
      this.setState("idle");
      this.abortController = null;
      this.idx = -1;
    }
  }

  async jumpTo(index) {
    if (!Array.isArray(this.queue) || index < 0 || index >= this.queue.length) {
      return { ok: false };
    }

    // Abort current playback if active
    this.abortActivePlayback();

    // Transition to playing state
    if (!this.setState("playing")) {
      return { ok: false };
    }

    this.beginPlaybackLoop(index);
    return { ok: true };
  }

  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return null;
    this.audioContext = new AudioContextCtor();
    return this.audioContext;
  }

  getStretchWindow(size) {
    if (this._stretchWindow && this._stretchWindowSize === size) {
      return this._stretchWindow;
    }
    const win = new Float32Array(size);
    const denom = size - 1 || 1;
    for (let i = 0; i < size; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
    }
    this._stretchWindow = win;
    this._stretchWindowSize = size;
    return win;
  }

  timeStretchPCM(input, tempo) {
    if (!input || input.length === 0) {
      return new Float32Array(0);
    }
    const clampedTempo = Math.max(0.1, Math.min(tempo, 4.0));
    if (Math.abs(clampedTempo - 1) < 0.01) {
      return input.slice();
    }
    const windowSize = 2048;
    const halfWindow = windowSize >> 1;
    const stepIn = halfWindow;
    const stepOut = Math.max(1, Math.round(halfWindow / clampedTempo));
    const estimated = Math.ceil(input.length / clampedTempo) + windowSize * 2;
    let output = new Float32Array(estimated);
    let weight = new Float32Array(estimated);
    const window = this.getStretchWindow(windowSize);

    let inPos = 0;
    let outPos = 0;

    while (inPos + windowSize <= input.length) {
      if (outPos + windowSize >= output.length) {
        const newLength = output.length + windowSize * 4;
        const newOutput = new Float32Array(newLength);
        newOutput.set(output);
        output = newOutput;
        const newWeight = new Float32Array(newLength);
        newWeight.set(weight);
        weight = newWeight;
      }
      for (let i = 0; i < windowSize; i++) {
        const outIndex = outPos + i;
        const sample = input[inPos + i] * window[i];
        output[outIndex] += sample;
        weight[outIndex] += window[i];
      }
      inPos += stepIn;
      outPos += stepOut;
    }

    const remaining = input.length - inPos;
    if (remaining > 0) {
      if (outPos + remaining >= output.length) {
        const newLength = output.length + windowSize * 4;
        const newOutput = new Float32Array(newLength);
        newOutput.set(output);
        output = newOutput;
        const newWeight = new Float32Array(newLength);
        newWeight.set(weight);
        weight = newWeight;
      }
      for (let i = 0; i < remaining; i++) {
        const outIndex = outPos + i;
        output[outIndex] += input[inPos + i];
        weight[outIndex] += 1;
      }
      outPos += remaining;
    }

    const limit = Math.min(output.length, outPos + windowSize);
    const result = new Float32Array(limit);
    for (let i = 0; i < limit; i++) {
      const w = weight[i];
      result[i] = w > 1e-5 ? output[i] / w : output[i];
    }
    return result;
  }

  async playBlob(blob, signal) {
    if (!this.forceWebAudio) {
      const result = await this.playWithHtmlAudio(blob, signal);
      if (result && result.success) {
        return;
      }
      this.forceWebAudio = true;
    }
    const played = await this.playWithWebAudio(blob, signal);
    if (!played) {
      console.warn("[KokoroReader] Unable to play audio via Web Audio API.");
    }
  }

  playWithHtmlAudio(blob, signal) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = document.createElement("audio");
      audio.src = url;
      audio.preload = "metadata";
      const rate = this.settings?.speed || 1.0;
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;

      let finished = false;
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        if (this.audio === audio) {
          this.audio = null;
        }
        if (this.currentPlaybackCleanup === cleanupPlayback) {
          this.currentPlaybackCleanup = null;
          this.currentPlaybackMode = null;
        }
        URL.revokeObjectURL(url);
      };

      const finalize = (result) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };

      const cleanupPlayback = () => {
        if (finished) return;
        audio.pause();
        cleanup();
      };

      const onEnded = () => finalize({ success: true });
      const onError = () => finalize({ success: false });
      const onAbort = () => {
        audio.pause();
        finalize({ success: true });
      };

      audio.addEventListener("ended", onEnded, { once: true });
      audio.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });

      this.audio = audio;
      this.currentPlaybackMode = "html";
      this.currentPlaybackCleanup = cleanupPlayback;

      const playResult = audio.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => onError());
      }
    });
  }

  async playWithWebAudio(blob, signal) {
    let ctx = this.ensureAudioContext();
    if (!ctx) {
      return false;
    }
    if (ctx.state === "closed") {
      this.audioContext = null;
      ctx = this.ensureAudioContext();
      if (!ctx) {
        return false;
      }
    }
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const arrayBuffer = await blob.arrayBuffer();
    const originalBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const tempo = Math.max(0.1, Math.min(this.settings?.speed || 1.0, 4.0));

    let processedBuffer = originalBuffer;
    if (Math.abs(tempo - 1) > 0.01) {
      const channelCount = originalBuffer.numberOfChannels;
      const stretchedChannels = [];
      let maxLength = 0;
      for (let ch = 0; ch < channelCount; ch++) {
        const channelData = originalBuffer.getChannelData(ch);
        const stretched = this.timeStretchPCM(channelData, tempo);
        stretchedChannels.push(stretched);
        if (stretched.length > maxLength) {
          maxLength = stretched.length;
        }
      }
      processedBuffer = ctx.createBuffer(channelCount, maxLength, originalBuffer.sampleRate);
      for (let ch = 0; ch < channelCount; ch++) {
        const target = processedBuffer.getChannelData(ch);
        const src = stretchedChannels[ch];
        target.set(src);
      }
    }

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = processedBuffer;
      source.playbackRate.value = 1.0;
      source.connect(ctx.destination);

      const state = {
        ctx,
        source,
        cleaned: false,
        onAbort: null,
      };

      let finished = false;
      const resolveOnce = () => {
        if (finished) return;
        finished = true;
        resolve(true);
      };

      const cleanup = (stopSource = true) => {
        if (state.cleaned) return;
        state.cleaned = true;
        if (state.onAbort) {
          signal.removeEventListener("abort", state.onAbort);
          state.onAbort = null;
        }
        source.onended = null;
        if (stopSource) {
          source.stop();
        }
        source.disconnect();
        this.webAudioState = null;
        if (this.currentPlaybackCleanup === cleanupWrapper) {
          this.currentPlaybackCleanup = null;
          this.currentPlaybackMode = null;
        }
      };

      const cleanupWrapper = (stopSource = true) => {
        cleanup(stopSource);
      };

      const onAbort = () => {
        cleanup();
        resolveOnce();
      };

      state.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });

      this.webAudioState = { ctx };
      this.currentPlaybackMode = "webaudio";
      this.currentPlaybackCleanup = cleanupWrapper;

      source.onended = () => {
        cleanup(false);
        resolveOnce();
      };

      source.start();
    });
  }

  async pauseWebAudio() {
    const state = this.webAudioState;
    if (!state || !state.ctx) return false;
    if (state.ctx.state === "suspended") return true;
    await state.ctx.suspend();
    return true;
  }

  async resumeWebAudio() {
    const state = this.webAudioState;
    if (!state || !state.ctx) return false;
    if (state.ctx.state === "running") return true;
    await state.ctx.resume();
    return true;
  }

  async pause() {
    if (this.state !== "playing") {
      return { ok: false };
    }

    if (!this.setState("paused")) {
      return { ok: false };
    }

    if (this.audio) {
      this.audio.pause();
    } else if (this.currentPlaybackMode === "webaudio") {
      await this.pauseWebAudio();
    }

    // native synthesis pause (best effort)
    if ("speechSynthesis" in window) {
      window.speechSynthesis.pause?.();
    }

    return { ok: true };
  }

  async resume() {
    if (this.state !== "paused") {
      return { ok: false };
    }

    if (!this.setState("playing")) {
      return { ok: false };
    }

    if (this.audio) {
      await this.audio.play();
    } else if (this.currentPlaybackMode === "webaudio") {
      await this.resumeWebAudio();
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.resume?.();
    }

    return { ok: true };
  }

  async stop() {
    this.abortActivePlayback();
    this.clearPlaybackContext();
    this.highlighter.clear();

    // Transition to idle
    this.setState("idle");
    this.idx = -1;

    return { ok: true };
  }

  async clearCache() {
    // Called when the user changes the voice (need to regen with new voice)
    await this.stop();
    this.resetGenerationTracking();
    return { ok: true };
  }
}

let reader = null;

function ensureReader() {
  if (!reader) {
    reader = new KokoroReader();
  }
  return reader;
}

// Messages from popup
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "kokoro:ping": {
        sendResponse({ ok: true });
        break;
      }
      case "kokoro:getState": {
        // Report current reader state, settings, and position
        const r = ensureReader();
        const idx = typeof r.idx === "number" ? r.idx : -1;
        const total = Array.isArray(r.queue) ? r.queue.length : 0;
        sendResponse({
          ok: true,
          state: r.state,
          settings: r.settings,
          index: idx,
          total: total,
        });
        break;
      }
      case "kokoro:getModelStatus": {
        await probeWebGPU();
        if (webgpuUnsupported) {
          sendResponse({ ok: true, loaded: false, webgpuUnsupported: true });
        } else if (initted !== "done") {
          const { loaded, downloadProgress } = await callBackground({ type: "status" });
          sendResponse({ ok: true, loaded, downloadProgress });
        } else {
          const { loaded, downloadProgress } = await callBackground({ type: "status" });
          sendResponse({ ok: true, loaded, downloadProgress });
        }
        break;
      }
      case "kokoro:listVoices": {
        await probeWebGPU();
        if (webgpuUnsupported) {
          sendResponse({ ok: false, error: "WebGPU not supported in this browser/device" });
        } else {
          const voices = await listVoices();
          sendResponse({ ok: true, voices });
        }
        break;
      }
      case "kokoro:playButtonPressed": {
        // Switch on reader state
        const r = ensureReader();
        let res;
        if (r.state === "idle") {
          res = await r.start(msg.settings || {});
        } else if (r.state === "playing") {
          res = await r.pause();
        } else if (r.state === "paused") {
          res = await r.resume();
        }
        sendResponse(res);
        break;
      }
      case "kokoro:setSpeed": {
        const r = ensureReader();
        const speed = Number(msg.speed) || 1.0;
        r.updateSettings({ speed });
        const currentAudio = r.audio;
        if (currentAudio) currentAudio.playbackRate = speed;
        sendResponse({ ok: true });
        break;
      }
      case "kokoro:setVoice": {
        const r = ensureReader();
        const voice = msg.voice || "af_heart";
        r.updateSettings({ voice });
        sendResponse({ ok: true });
        break;
      }
      case "kokoro:setAutoScroll": {
        autoScrollEnabled = Boolean(msg.autoScroll);
        console.log("Auto-scroll setting changed to:", autoScrollEnabled);
        sendResponse({ ok: true });
        break;
      }
      case "kokoro:clearCache": {
        const r = ensureReader();
        await r.clearCache();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown_message" });
    }
  })();
  // keep the message channel open for async response
  return true;
});

// Commands forwarded from background
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type !== "kokoro:executeCommand") return;
    const r = ensureReader();
    const command = msg?.command;
    if (command === "toggle-read") {
      if (r.state === "playing") await r.pause();
      else if (r.state === "paused") await r.resume();
      else await r.start({});
      sendResponse({ ok: true });
    } else if (command === "stop-read") {
      await r.stop();
      sendResponse({ ok: true });
    } else if (command === "jump-next") {
      const currentIdx = r.idx !== undefined ? r.idx : -1;
      const nextIdx = currentIdx + 1;
      if (nextIdx < r.queue.length) {
        await r.jumpTo(nextIdx);
      }
      sendResponse({ ok: true });
    } else if (command === "jump-previous") {
      const currentIdx = r.idx !== undefined ? r.idx : -1;
      const prevIdx = currentIdx - 1;
      if (prevIdx >= 0) {
        await r.jumpTo(prevIdx);
      }
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "unknown_command" });
    }
  })();
  return true;
});
