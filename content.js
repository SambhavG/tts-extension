// TTS Engine functions
let initted = "not_started";
let webgpuUnsupported = !navigator?.gpu;
let webgpuProbePromise = null;
let autoScrollEnabled = true;

async function probeWebGPU() {
  if (webgpuProbePromise) return webgpuProbePromise;
  webgpuProbePromise = (async () => {
    if (!navigator?.gpu) {
      webgpuUnsupported = true;
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) webgpuUnsupported = true;
  })();
  return webgpuProbePromise;
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_SETTINGS = Object.freeze({ voice: "af_heart", speed: 1.0 });
const SENTENCE_MAX_LENGTH = 350;
const PREREAD_AHEAD = 5;
const LRU_MAX_SIZE = 30;

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

// --- Background communication ---
function callBackground(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ scope: "kokoro-tts", type, payload }, (response) => resolve(response || {}));
  });
}

async function initTTS() {
  if (initted === "done") return;
  await probeWebGPU();
  if (webgpuUnsupported) return;
  initted = "initing";
  await callBackground("init", { modelId: MODEL_ID, dtype: "fp32", device: "webgpu" });
  initted = "done";
}

async function listVoices() {
  await probeWebGPU();
  if (webgpuUnsupported) return [];
  await initTTS();
  const { voices } = await callBackground("voices");
  return Array.isArray(voices) ? voices : [];
}

// --- Text processing ---
function splitIntoSentences(text) {
  const sentences = (text || "")
    .split(/(?<=[\.\!?…])\s+(?=[A-Z0-9""(\[])|(?<=\n)\s*|(?<=—)\s*|(?<=--)\s*|\s*(?=\()|(?<=\))\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [text];
}

function sliceLongSentence(sentence, maxLength = SENTENCE_MAX_LENGTH) {
  if (!sentence || sentence.length <= maxLength) return [sentence];

  const chunks = [];
  let remaining = sentence;

  while (remaining.length > maxLength) {
    const splitPoint = findSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function findSplitPoint(text, maxLength) {
  for (const ch of [",", ";", ":", "—", "-"]) {
    const idx = text.lastIndexOf(ch, maxLength);
    if (idx > maxLength * 0.4) return idx + 1;
  }
  let splitPoint = text.lastIndexOf(" ", maxLength);
  if (splitPoint <= 0) splitPoint = text.indexOf(" ", 1);
  if (splitPoint <= 0) splitPoint = maxLength;
  return splitPoint;
}

async function generateSentenceBlob(text, voice = "af_heart") {
  await probeWebGPU();
  if (webgpuUnsupported) return null;
  await initTTS();

  const { audioWav } = await callBackground("generateBatch", { sentences: [text], voice });
  const wavBuffer = toArrayBuffer(audioWav);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) return data.buffer;
  return new ArrayBuffer(0);
}

// --- DOM utilities ---
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
  if (!(el instanceof HTMLElement) || SKIP_TAGS.has(el.tagName)) return false;
  const name = el.tagName;
  if (["P", "LI", "BLOCKQUOTE"].includes(name) || /^H[1-6]$/.test(name)) return true;
  if (name !== "DIV") return false;
  const text = el.textContent?.trim() || "";
  return text.split(/\s+/).length >= 6;
}

function normalizeTextContent(el) {
  return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
}

function getCandidateTextMeta(el) {
  if (!(el instanceof HTMLElement) || SKIP_TAGS.has(el.tagName)) return null;
  if (!isVisible(el) || SIMPLE_INLINE_TAGS.has(el.tagName)) return null;
  const text = normalizeTextContent(el);
  if (!text.length) return null;
  return { el, text, isBlock: isReadableBlock(el) };
}

function isAncestorOf(a, b) {
  return a && b && a !== b && a.contains(b);
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
    if (meta) metaList.push(meta);
  }

  const blockMeta = metaList.filter((m) => m.isBlock);
  const pool = blockMeta.length ? blockMeta : metaList;
  const keep = pool.filter((meta) => !pool.some((other) => other !== meta && isAncestorOf(meta.el, other.el)));
  return keep.map((meta) => ({ xpath: generateXPath(meta.el), el: meta.el, text: meta.text }));
}

// --- Highlighter ---
class Highlighter {
  constructor() {
    this.prevEl = null;
    this.prevWrapper = null;
  }

  clear() {
    if (this.prevEl) {
      this.prevEl.classList.remove("kokoro-tts-highlight", "kokoro-tts-pending");
      this.prevEl = null;
    }
    if (!this.prevWrapper?.parentNode) return;

    const wrapper = this.prevWrapper;
    while (wrapper.firstChild) {
      wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
    }
    wrapper.parentNode.removeChild(wrapper);
    this.prevWrapper = null;
  }

  highlight(el, text, pending = false, occurrenceIndex = 0) {
    if (!el) return;
    this.clear();

    const className = pending ? "kokoro-tts-pending" : "kokoro-tts-highlight";

    if (text?.trim()) {
      const res = this.wrapTextRange(el, text, className, occurrenceIndex);
      if (res?.wrapper) {
        this.prevWrapper = res.wrapper;
        this.scrollIfEnabled(res.wrapper);
        return;
      }
    }

    this.prevEl = el;
    el.classList.add(className);
    this.scrollIfEnabled(el);
  }

  highlightPending(el, text, occurrenceIndex = 0) {
    this.highlight(el, text, true, occurrenceIndex);
  }

  activate() {
    const target = this.prevWrapper || this.prevEl;
    if (!target) return;
    target.classList.remove("kokoro-tts-pending");
    target.classList.add("kokoro-tts-highlight");
  }

  scrollIfEnabled(el) {
    if (autoScrollEnabled) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }

  // Build normalized text and character map for an element
  buildTextMap(rootEl) {
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
        if (isSpace && prevWasSpace) continue;
        norm += isSpace ? " " : ch;
        map.push({ node, offset: i });
        prevWasSpace = isSpace;
      }
    }
    return { norm, map };
  }

  wrapTextRange(rootEl, targetText, className, occurrenceIndex = 0) {
    const { norm, map } = this.buildTextMap(rootEl);
    const target = targetText.replace(/\s+/g, " ").trim();

    // Find the Nth occurrence
    let startIdx = -1;
    let searchFrom = 0;
    for (let i = 0; i <= occurrenceIndex; i++) {
      startIdx = norm.indexOf(target, searchFrom);
      if (startIdx === -1) return null;
      searchFrom = startIdx + 1;
    }

    const endIdx = startIdx + target.length - 1;
    const range = document.createRange();
    range.setStart(map[startIdx].node, map[startIdx].offset);
    range.setEnd(map[endIdx].node, map[endIdx].offset + 1);

    const span = document.createElement("span");
    span.className = className;
    span.appendChild(range.extractContents());
    range.insertNode(span);
    return { wrapper: span };
  }

  // Find which queue index corresponds to a click position within an element
  findClickedIndex(el, clickX, clickY, queue) {
    // Get items for this element
    const itemsForEl = [];
    queue.forEach((item, idx) => {
      if (item.el === el || resolveXPath(item.xpath) === el) {
        itemsForEl.push({ idx, text: item.text });
      }
    });

    if (itemsForEl.length <= 1) return itemsForEl[0]?.idx ?? -1;

    // Use caretRangeFromPoint to find where the click landed
    const range = document.caretRangeFromPoint?.(clickX, clickY);
    if (!range) return itemsForEl[0].idx;

    // Get the text offset at click point
    const { norm, map } = this.buildTextMap(el);
    const clickNode = range.startContainer;
    const clickOffset = range.startOffset;

    // Find position in normalized text
    let clickPosInNorm = -1;
    for (let i = 0; i < map.length; i++) {
      if (map[i].node === clickNode && map[i].offset >= clickOffset) {
        clickPosInNorm = i;
        break;
      }
      if (map[i].node === clickNode) {
        clickPosInNorm = i;
      }
    }

    if (clickPosInNorm === -1) return itemsForEl[0].idx;

    // Find which sentence contains this position
    for (let i = 0; i < itemsForEl.length; i++) {
      const text = itemsForEl[i].text.replace(/\s+/g, " ").trim();
      // Find Nth occurrence of this text
      let searchFrom = 0;
      for (let occ = 0; occ <= i; occ++) {
        const idx = norm.indexOf(text, searchFrom);
        if (idx === -1) break;
        if (occ === i) {
          const endIdx = idx + text.length;
          if (clickPosInNorm >= idx && clickPosInNorm < endIdx) {
            return itemsForEl[i].idx;
          }
        }
        searchFrom = idx + 1;
      }
    }

    // Find closest sentence by position
    let bestIdx = itemsForEl[0].idx;
    let bestDist = Infinity;
    let searchFrom = 0;

    for (let i = 0; i < itemsForEl.length; i++) {
      const text = itemsForEl[i].text.replace(/\s+/g, " ").trim();
      const idx = norm.indexOf(text, searchFrom);
      if (idx === -1) continue;

      const midpoint = idx + text.length / 2;
      const dist = Math.abs(clickPosInNorm - midpoint);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = itemsForEl[i].idx;
      }
      searchFrom = idx + 1;
    }

    return bestIdx;
  }
}

// --- KokoroReader ---
class KokoroReader {
  constructor() {
    this.queue = [];
    this.idx = -1;
    this.highlighter = new Highlighter();
    this.settings = { ...DEFAULT_SETTINGS };
    this.state = "idle";
    this.stateWaiters = [];
    this.generatedLRU = new Map();
    this.audioContext = null;
    this.abortController = null;
    this.activeAudio = null;
    this.forceWebAudio = false;
    this._stretchWindow = null;
    this._stretchWindowSize = 0;
    this.buildQueue();
  }

  // --- State management ---
  setState(newState) {
    this.state = newState;
    this.flushStateWaiters();
  }

  flushStateWaiters() {
    this.stateWaiters = this.stateWaiters.filter((w) => {
      if (w.done || w.predicate(this.state)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  waitForState(predicate, signal) {
    if (typeof predicate !== "function" || predicate(this.state)) return Promise.resolve();

    return new Promise((resolve) => {
      const waiter = {
        predicate,
        done: false,
        resolve: () => {
          waiter.done = true;
          resolve();
        },
      };
      if (signal?.aborted) {
        waiter.resolve();
        return;
      }
      signal?.addEventListener?.("abort", waiter.resolve, { once: true });
      this.stateWaiters.push(waiter);
    });
  }

  // --- Queue building ---
  getOccurrenceIndex(index) {
    const item = this.queue[index];
    if (!item) return 0;
    let count = 0;
    for (let i = 0; i < index; i++) {
      const other = this.queue[i];
      if ((other.el === item.el || other.xpath === item.xpath) && other.text === item.text) {
        count++;
      }
    }
    return count;
  }

  async buildQueue() {
    const root = chooseRoot();
    const rootEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    const containers = collectTextContainers(rootEl || document.body);

    this.queue = [];
    for (const c of containers) {
      for (const sentence of splitIntoSentences(c.text)) {
        for (const chunk of sliceLongSentence(sentence)) {
          this.queue.push({
            xpath: c.xpath,
            el: c.el,
            text: chunk,
            genStatus: "not_generated",
            genPromise: null,
            blob: null,
          });
        }
      }
    }

    this.generatedLRU.clear();
    this.bindClickHandlers();
    this.idx = -1;
  }

  bindClickHandlers() {
    const boundElements = new Set();
    this.queue.forEach((item, i) => {
      const el = item.el && document.contains(item.el) ? item.el : resolveXPath(item.xpath);
      if (!el || el.dataset.kokoroClickableBound === "1" || boundElements.has(el)) return;

      boundElements.add(el);
      el.dataset.kokoroClickableBound = "1";
      el.classList.add("kokoro-tts-clickable");

      el.addEventListener("click", (e) => {
        const idx = this.highlighter.findClickedIndex(el, e.clientX, e.clientY, this.queue);
        if (idx >= 0) this.jumpTo(idx);
      });

      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    });
  }

  // --- Generation & LRU cache ---
  generateForIndex(index) {
    const item = this.queue[index];
    if (!item) return null;

    if (item.genStatus === "generated") {
      this.bumpLRU(index);
      return Promise.resolve(item.blob);
    }

    if (item.genStatus === "generating") return item.genPromise;

    item.genStatus = "generating";
    item.genPromise = generateSentenceBlob(item.text, this.settings.voice).then((blob) => {
      item.blob = blob;
      item.genStatus = "generated";
      this.bumpLRU(index);
      this.evictIfNeeded();
      return blob;
    });
    return item.genPromise;
  }

  bumpLRU(index) {
    const item = this.queue[index];
    if (!item || item.genStatus !== "generated") return;
    this.generatedLRU.delete(index);
    this.generatedLRU.set(index, true);
  }

  evictIfNeeded() {
    while (this.generatedLRU.size > LRU_MAX_SIZE) {
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

  ensurePrefetch(startIndex) {
    const end = Math.min(this.queue.length, startIndex + PREREAD_AHEAD);
    for (let j = startIndex; j < end; j++) {
      const item = this.queue[j];
      if (item?.genStatus === "not_generated") this.generateForIndex(j);
    }
  }

  resetGenerationTracking() {
    this.generatedLRU.clear();
    for (const item of this.queue) {
      if (!item) continue;
      item.genStatus = "not_generated";
      item.genPromise = null;
      item.blob = null;
    }
  }

  // --- Main playback ---
  async start(settings) {
    if (this.state !== "idle") await this.stop();

    Object.assign(this.settings, settings);
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

    this.setState("playing");
    this.abortController = new AbortController();
    this.loop(this.abortController.signal, 0);
    return { ok: true };
  }

  async loop(signal, startIndex = 0) {
    for (let i = Math.max(0, startIndex); i < this.queue.length; i++) {
      if (signal.aborted || (this.state !== "playing" && this.state !== "paused")) break;

      this.idx = i;
      const item = this.queue[i];
      const el = item.el && document.contains(item.el) ? item.el : resolveXPath(item.xpath);
      const occurrenceIndex = this.getOccurrenceIndex(i);

      this.highlighter.highlightPending(el, item.text, occurrenceIndex);
      const blob = await this.generateForIndex(i);
      this.bumpLRU(i);
      this.evictIfNeeded();

      if (signal.aborted) break;
      if (this.state === "paused") await this.waitForState((s) => s !== "paused", signal);
      if (signal.aborted || this.state !== "playing") break;

      this.highlighter.activate();
      this.ensurePrefetch(i + 1);
      await this.playBlob(blob, signal);
    }

    if (signal.aborted) return;
    this.cleanup();
  }

  cleanup() {
    this.stopActiveAudio();
    this.highlighter.clear();
    this.state = "idle";
    this.abortController = null;
    this.idx = -1;
  }

  async jumpTo(index) {
    if (index < 0 || index >= this.queue.length) return { ok: false };
    this.abortController?.abort();
    this.setState("playing");
    this.abortController = new AbortController();
    this.loop(this.abortController.signal, index);
    return { ok: true };
  }

  async pause() {
    if (this.state !== "playing") return { ok: false };
    this.setState("paused");
    this.pauseActiveAudio();
    return { ok: true };
  }

  async resume() {
    if (this.state !== "paused") return { ok: false };
    this.setState("playing");
    this.resumeActiveAudio();
    return { ok: true };
  }

  async stop() {
    this.abortController?.abort();
    this.cleanup();
    return { ok: true };
  }

  async clearCache() {
    await this.stop();
    this.resetGenerationTracking();
    return { ok: true };
  }

  // --- Audio playback ---
  stopActiveAudio() {
    if (!this.activeAudio) return;
    if (this.activeAudio.type === "html") {
      this.activeAudio.element.pause();
      URL.revokeObjectURL(this.activeAudio.element.src);
    } else if (this.activeAudio.type === "webaudio") {
      this.activeAudio.source.stop();
      this.activeAudio.source.disconnect();
    }
    this.activeAudio = null;
  }

  pauseActiveAudio() {
    if (!this.activeAudio) return;
    if (this.activeAudio.type === "html") {
      this.activeAudio.element.pause();
    } else if (this.activeAudio.type === "webaudio") {
      this.activeAudio.ctx?.suspend();
    }
    window.speechSynthesis?.pause?.();
  }

  resumeActiveAudio() {
    if (!this.activeAudio) return;
    if (this.activeAudio.type === "html") {
      this.activeAudio.element.play();
    } else if (this.activeAudio.type === "webaudio") {
      this.activeAudio.ctx?.resume();
    }
    window.speechSynthesis?.resume?.();
  }

  async playBlob(blob, signal) {
    if (!this.forceWebAudio) {
      const result = await this.playWithHtmlAudio(blob, signal);
      if (result.success) return;
      this.forceWebAudio = true;
    }
    await this.playWithWebAudio(blob, signal);
  }

  playWithHtmlAudio(blob, signal) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = document.createElement("audio");
      audio.src = url;
      audio.preload = "metadata";
      audio.playbackRate = this.settings.speed || 1.0;

      const done = (success) => {
        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        URL.revokeObjectURL(url);
        if (this.activeAudio?.element === audio) this.activeAudio = null;
        resolve({ success });
      };

      const onEnd = () => done(true);
      const onError = () => done(false);
      const onAbort = () => {
        audio.pause();
        done(true);
      };

      audio.addEventListener("ended", onEnd, { once: true });
      audio.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });

      this.activeAudio = { type: "html", element: audio };
      audio.play()?.catch?.(onError);
    });
  }

  async playWithWebAudio(blob, signal) {
    let ctx = this.ensureAudioContext();
    if (!ctx) return false;

    if (ctx.state === "closed") {
      this.audioContext = null;
      ctx = this.ensureAudioContext();
      if (!ctx) return false;
    }
    if (ctx.state === "suspended") await ctx.resume();

    const arrayBuffer = await blob.arrayBuffer();
    const originalBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const processedBuffer = this.processAudioBuffer(ctx, originalBuffer);

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = processedBuffer;
      source.playbackRate.value = 1.0;
      source.connect(ctx.destination);

      const done = () => {
        signal.removeEventListener("abort", onAbort);
        source.onended = null;
        source.disconnect();
        if (this.activeAudio?.source === source) this.activeAudio = null;
        resolve(true);
      };

      const onAbort = () => {
        source.stop();
        done();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      this.activeAudio = { type: "webaudio", source, ctx };

      source.onended = done;
      source.start();
    });
  }

  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    this.audioContext = new Ctor();
    return this.audioContext;
  }

  processAudioBuffer(ctx, originalBuffer) {
    const tempo = Math.max(0.1, Math.min(this.settings.speed || 1.0, 4.0));
    if (Math.abs(tempo - 1) <= 0.01) return originalBuffer;

    const channelCount = originalBuffer.numberOfChannels;
    const stretchedChannels = [];
    let maxLength = 0;

    for (let ch = 0; ch < channelCount; ch++) {
      const stretched = this.timeStretchPCM(originalBuffer.getChannelData(ch), tempo);
      stretchedChannels.push(stretched);
      maxLength = Math.max(maxLength, stretched.length);
    }

    const processedBuffer = ctx.createBuffer(channelCount, maxLength, originalBuffer.sampleRate);
    for (let ch = 0; ch < channelCount; ch++) {
      processedBuffer.getChannelData(ch).set(stretchedChannels[ch]);
    }
    return processedBuffer;
  }

  getStretchWindow(size) {
    if (this._stretchWindow && this._stretchWindowSize === size) return this._stretchWindow;
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
    if (!input?.length) return new Float32Array(0);

    const clampedTempo = Math.max(0.1, Math.min(tempo, 4.0));
    if (Math.abs(clampedTempo - 1) < 0.01) return input.slice();

    const windowSize = 2048;
    const halfWindow = windowSize >> 1;
    const stepIn = halfWindow;
    const stepOut = Math.max(1, Math.round(halfWindow / clampedTempo));
    const window = this.getStretchWindow(windowSize);

    let output = new Float32Array(Math.ceil(input.length / clampedTempo) + windowSize * 2);
    let weight = new Float32Array(output.length);
    let inPos = 0,
      outPos = 0;

    while (inPos + windowSize <= input.length) {
      if (outPos + windowSize >= output.length) {
        output = this.growArray(output, windowSize * 4);
        weight = this.growArray(weight, windowSize * 4);
      }
      for (let i = 0; i < windowSize; i++) {
        output[outPos + i] += input[inPos + i] * window[i];
        weight[outPos + i] += window[i];
      }
      inPos += stepIn;
      outPos += stepOut;
    }

    const remaining = input.length - inPos;
    if (remaining > 0) {
      if (outPos + remaining >= output.length) {
        output = this.growArray(output, windowSize * 4);
        weight = this.growArray(weight, windowSize * 4);
      }
      for (let i = 0; i < remaining; i++) {
        output[outPos + i] += input[inPos + i];
        weight[outPos + i] += 1;
      }
      outPos += remaining;
    }

    const result = new Float32Array(Math.min(output.length, outPos + windowSize));
    for (let i = 0; i < result.length; i++) {
      result[i] = weight[i] > 1e-5 ? output[i] / weight[i] : output[i];
    }
    return result;
  }

  growArray(arr, extra) {
    const newArr = new Float32Array(arr.length + extra);
    newArr.set(arr);
    return newArr;
  }
}

// --- Singleton reader instance ---
let reader = null;
const ensureReader = () => reader || (reader = new KokoroReader());

// --- Message handlers ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse);
  return true;
});

async function handleMessage(msg) {
  if (msg?.type === "kokoro:executeCommand") return handleCommand(msg.command);

  const r = ensureReader();

  switch (msg?.type) {
    case "kokoro:ping":
      return { ok: true };

    case "kokoro:getState":
      return {
        ok: true,
        state: r.state,
        settings: r.settings,
        index: r.idx ?? -1,
        total: r.queue?.length ?? 0,
      };

    case "kokoro:getModelStatus": {
      await probeWebGPU();
      if (webgpuUnsupported) return { ok: true, loaded: false, webgpuUnsupported: true };
      const { loaded, downloadProgress } = await callBackground("status");
      return { ok: true, loaded, downloadProgress };
    }

    case "kokoro:listVoices": {
      await probeWebGPU();
      if (webgpuUnsupported) return { ok: false, error: "WebGPU not supported in this browser/device" };
      return { ok: true, voices: await listVoices() };
    }

    case "kokoro:playButtonPressed":
      if (r.state === "idle") return r.start(msg.settings || {});
      if (r.state === "playing") return r.pause();
      if (r.state === "paused") return r.resume();
      return { ok: false };

    case "kokoro:setSpeed": {
      const speed = Number(msg.speed) || 1.0;
      r.settings.speed = speed;
      if (r.activeAudio?.type === "html") r.activeAudio.element.playbackRate = speed;
      return { ok: true };
    }

    case "kokoro:setVoice":
      r.settings.voice = msg.voice || "af_heart";
      return { ok: true };

    case "kokoro:setAutoScroll":
      autoScrollEnabled = Boolean(msg.autoScroll);
      return { ok: true };

    case "kokoro:clearCache":
      return r.clearCache();

    default:
      return { ok: false, error: "unknown_message" };
  }
}

async function handleCommand(command) {
  const r = ensureReader();

  switch (command) {
    case "toggle-read":
      if (r.state === "playing") return r.pause();
      if (r.state === "paused") return r.resume();
      return r.start({});

    case "stop-read":
      return r.stop();

    case "jump-next": {
      const nextIdx = (r.idx ?? -1) + 1;
      if (nextIdx < r.queue.length) return r.jumpTo(nextIdx);
      return { ok: true };
    }

    case "jump-previous": {
      const prevIdx = (r.idx ?? -1) - 1;
      if (prevIdx >= 0) return r.jumpTo(prevIdx);
      return { ok: true };
    }

    default:
      return { ok: false, error: "unknown_command" };
  }
}
