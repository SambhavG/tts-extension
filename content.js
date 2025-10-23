// TTS Engine functions (inlined from ttsEngine.js)
let worker = null;
let workerReady = null;
let nextMsgId = 1;
const pending = new Map();
let initted = "not_started";

// You can change this if you use a different model by default
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

function ensureWorker() {
  if (worker) return worker;
  const workerUrl = chrome.runtime.getURL("ttsWorker.js");
  const bootstrap = `import('${workerUrl}').then(() => self.postMessage({ type: 'ready' }));`;
  const blob = new Blob([bootstrap], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  worker = new Worker(url, { type: "module" });
  worker.onerror = (e) => {
    console.error("[ensureWorker] unable to create worker, likely due to page's CSP restrictions", e);
    return null;
  };
  let resolveReady;
  workerReady = new Promise((r) => (resolveReady = r));
  worker.addEventListener("message", (e) => {
    const data = e.data || {};
    if (data && data.type === "ready") {
      resolveReady?.();
      return;
    }
    const { id, ok } = data;
    if (typeof id !== "number") return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(data);
  });
  return worker;
}

async function callWorker(message) {
  ensureWorker();
  if (workerReady) await workerReady;
  return new Promise((resolve, reject) => {
    const id = nextMsgId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}

async function initTTS() {
  if (initted === "done") return;
  initted = "initing";
  await callWorker({
    type: "init",
    payload: { modelId: MODEL_ID, dtype: "fp32", device: "webgpu" },
  });
  initted = "done";
}

async function listVoices() {
  await initTTS();
  const { voices } = await callWorker({ type: "voices" });
  return Array.isArray(voices) ? voices : [];
}

async function generateParagraphBlob(text, voice = "af_heart") {
  await initTTS();
  // Split on sentence boundaries so we stay under the model's max capacity
  const sentences = (text || "")
    .split(/(?<=[\.!\?…])\s+(?=[A-Z0-9“"(\[])|(?<=\n)\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const { audioWav } = await callWorker({
    type: "generateBatch",
    payload: { sentences: sentences.length ? sentences : [text], voice },
  });
  return new Blob([audioWav], { type: "audio/wav" });
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
    if (!el) return;
    this.clear();
    if (text && typeof text === "string" && text.trim()) {
      const res = this.wrapTextRange(el, text, "kokoro-tts-highlight");
      if (res && res.wrapper) {
        this.prevWrapper = res.wrapper;
        res.wrapper.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        return;
      }
    }
    this.prevEl = el;
    el.classList.add("kokoro-tts-highlight");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  // Pending (orange) highlight while generation is in progress
  highlightPending(el, text) {
    if (!el) return;
    this.clear();
    if (text && typeof text === "string" && text.trim()) {
      const res = this.wrapTextRange(el, text, "kokoro-tts-pending");
      if (res && res.wrapper) {
        this.prevWrapper = res.wrapper;
        res.wrapper.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        return;
      }
    }
    this.prevEl = el;
    el.classList.add("kokoro-tts-pending");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
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
  "B",
  "I",
  "EM",
  "STRONG",
  "U",
  "SMALL",
  "SUB",
  "SUP",
  "CODE",
  "KBD",
  "SAMP",
  "MARK",
  "LABEL",
  "BUTTON",
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

function isCandidateTextContainer(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (!isVisible(el)) return false;
  if (SKIP_TAGS.has(el.tagName)) return false;
  if (SIMPLE_INLINE_TAGS.has(el.tagName)) return false;
  const norm = normalizeTextContent(el);
  if (norm.length === 0) return false;
  return true;
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
  const all = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (!(n instanceof HTMLElement)) continue;
    if (!isCandidateTextContainer(n)) continue;
    all.push(n);
  }
  const set = new Set(all);
  const lowest = all.filter((el) => {
    for (const other of set) {
      if (other !== el && isAncestorOf(el, other)) return false;
    }
    return true;
  });
  return lowest.map((el) => ({ xpath: generateXPath(el), el, text: normalizeTextContent(el) }));
}

class KokoroReader {
  constructor() {
    console.log("[KokoroReader] constructor");
    this.queue = [];
    this.idx = -1;
    this.audio = null;
    this.highlighter = new Highlighter();
    this.settings = { voice: "af_heart", speed: 1.0 };
    this.state = "idle"; // idle | playing | paused
    this.abortController = null;
    this.audioCache = new Map();
    this.buildQueue();
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
    return true;
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
    this.queue = containers.map((c) => ({
      xpath: c.xpath,
      el: c.el,
      text: c.text,
      genStatus: "not_generated", // not_generated | generating | generated
      genPromise: null,
      blob: null,
    }));
    // Bind click/keyboard handlers to allow jumping to a specific block
    this.queue.forEach((item, i) => {
      const el = item.el && document.contains(item.el) ? item.el : resolveXPath(item.xpath);
      if (!el) return;
      if (el.dataset.kokoroClickableBound === "1") return;
      el.dataset.kokoroClickableBound = "1";
      el.classList.add("kokoro-tts-clickable");
      el.addEventListener("click", () => {
        this.jumpTo(i);
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
      return Promise.resolve(item.blob);
    }
    if (item.genStatus === "generating" && item.genPromise) {
      return item.genPromise;
    }
    // Start generation
    item.genStatus = "generating";
    const p = (async () => {
      const blob = await generateParagraphBlob(item.text, this.settings.voice);
      item.blob = blob;
      item.genStatus = "generated";
      return blob;
    })();
    item.genPromise = p;
    return p;
  }

  async start(settings) {
    // Stop any ongoing playback first
    if (this.state === "playing" || this.state === "paused") {
      await this.stop();
    }

    this.settings = { ...this.settings, ...settings };
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

    this.abortController = new AbortController();
    this.loop(this.abortController.signal, 0);
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
    console.log("[loop] starting loop from index", startIndex);

    for (let i = Math.max(0, startIndex); i < this.queue.length; i++) {
      if (signal.aborted) {
        console.log("[loop] signal aborted at index", i);
        break;
      }

      // Verify we're still in a valid playback state
      if (!this.ensurePlaybackState()) {
        console.log("[loop] invalid state, exiting");
        break;
      }
      console.log("[loop] Reading ", i);
      this.idx = i;
      const item = this.queue[i];

      // Highlight current text within the element
      const currentEl = item.el && document.contains(item.el) ? item.el : resolveXPath(item.xpath);
      this.highlighter.highlightPending(currentEl, item.text);

      // Generate or reuse TTS for current via stateful helper
      const blob = await this.generateForIndex(i);

      if (signal.aborted) break;

      // Activate highlight now that audio is ready
      this.highlighter.activate();

      // Play
      const url = URL.createObjectURL(blob);
      let playPromise = this.playUrl(url, signal);
      // Pre-generate next items while current is playing
      // Kick off prefetch without awaiting it; only await playback
      this.ensurePrefetch(i + 1);
      await playPromise;

      if (signal.aborted) break;

      // Cleanup cache outside the useful window
      // const toDelete = [];
      // for (const [k] of this.audioCache) {
      //   if (k < i || k > i + PREREAD_AHEAD) toDelete.push(k);
      // }
      // for (const k of toDelete) this.audioCache.delete(k);
    }

    // Only clear and reset if we completed naturally (not aborted)
    if (!signal.aborted) {
      this.highlighter.clear();
      this.setState("idle");
      this.idx = -1;
    }
  }

  async jumpTo(index) {
    console.log("[jumpTo] jumping to index", index);
    if (!Array.isArray(this.queue) || index < 0 || index >= this.queue.length) {
      return { ok: false };
    }

    // Abort current playback if active
    if (this.abortController) {
      this.abortController.abort();
    }

    // Transition to playing state
    if (!this.setState("playing")) {
      return { ok: false };
    }

    this.abortController = new AbortController();
    this.loop(this.abortController.signal, index);
    return { ok: true };
  }

  playUrl(url, signal) {
    return new Promise((resolve, reject) => {
      // Clean up previous element if any
      if (this.audio) {
        this.audio.pause();
        URL.revokeObjectURL(this.audio.src);
      }
      const audio = document.createElement("audio");
      audio.src = url;
      audio.preload = "metadata";
      const rate = this.settings?.speed || 1.0;
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
      audio.addEventListener("ended", resolve, { once: true });

      // Pause handling
      const onAbort = () => {
        audio.pause();
        resolve(); // treat abort as clean resolve to unwind loop
      };
      signal.addEventListener("abort", onAbort, { once: true });

      this.audio = audio;
      audio.play();
    });
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
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.resume?.();
    }

    return { ok: true };
  }

  async stop() {
    // Abort current playback
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Clean up audio
    if (this.audio) {
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
      this.audio = null;
    }

    // Clear highlighting
    this.highlighter.clear();

    // Transition to idle
    this.setState("idle");
    this.idx = -1;

    return { ok: true };
  }

  async clearCache() {
    // Called when the user changes the voice (need to regen with new voice)
    await this.stop();
    this.audioCache.clear();
    // Reset generation state for all items
    if (Array.isArray(this.queue)) {
      for (const item of this.queue) {
        if (!item) continue;
        item.genStatus = "not_generated";
        item.genPromise = null;
        item.blob = null;
      }
    }
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
        if (!worker || initted !== "done") {
          sendResponse({ ok: true, loaded: false });
        } else {
          const { loaded } = await callWorker({ type: "status" });
          sendResponse({ ok: true, loaded });
        }
        break;
      }
      case "kokoro:listVoices": {
        const voices = await listVoices();
        sendResponse({ ok: true, voices });
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
        r.settings.speed = speed;
        if (r.audio) r.audio.playbackRate = speed;
        sendResponse({ ok: true });
        break;
      }
      case "kokoro:setVoice": {
        const r = ensureReader();
        const voice = msg.voice || "af_heart";
        r.settings.voice = voice;
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
