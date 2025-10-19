// TTS Engine functions (inlined from ttsEngine.js)
let worker = null;
let nextMsgId = 1;
const pending = new Map();
let initted = false;

// You can change this if you use a different model by default
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

function ensureWorker() {
  if (worker) return worker;
  // Bootstrap a same-origin blob module that imports the extension worker module
  const workerUrl = chrome.runtime.getURL("ttsWorker.js");
  const bootstrap = `import('${workerUrl}');`;
  const blob = new Blob([bootstrap], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  worker = new Worker(url, { type: "module" });
  worker.addEventListener("message", (e) => {
    const data = e.data || {};
    const { id, ok } = data;
    if (typeof id !== "number") return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(data);
  });
  return worker;
}

function callWorker(message) {
  ensureWorker();
  return new Promise((resolve, reject) => {
    const id = nextMsgId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...message });
  });
}

async function initTTS() {
  if (initted) return;
  await callWorker({
    type: "init",
    payload: { modelId: MODEL_ID, dtype: "fp32", device: "webgpu" },
  });
  initted = true;
}

async function listVoices() {
  await initTTS();
  const { voices } = await callWorker({ type: "voices" });
  return Array.isArray(voices) ? voices : [];
}

async function generateParagraphBlob(text, voice = "af_heart", speed = 1.0) {
  await initTTS();
  console.log("generateParagraphBlob");
  const { audioWav } = await callWorker({
    type: "generate",
    payload: { text, voice, speed },
  });
  console.log("audioWav", audioWav);
  return new Blob([audioWav], { type: "audio/wav" });
}

const api = chrome; // Firefox aliases chrome to browser

// --- Highlighter (element-level, robust & fast)
class Highlighter {
  constructor() {
    this.prev = null;
  }
  highlight(el) {
    if (!el) return;
    this.clear();
    this.prev = el;
    el.classList.add("kokoro-tts-highlight");
    // ensure it's visible
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  clear() {
    if (this.prev) {
      this.prev.classList.remove("kokoro-tts-highlight");
      this.prev = null;
    }
  }
}

// --- Utilities to collect readable blocks
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "VIDEO", "AUDIO"]);
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

function chooseRoot() {
  const article = document.querySelector("article");
  if (article && isVisible(article)) return article;
  const main = document.querySelector("main");
  if (main && isVisible(main)) return main;
  return document.body;
}

function collectBlocks(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!(node instanceof HTMLElement)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
      if (isReadableBlock(node)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  const out = [];
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent?.replace(/\s+/g, " ").trim() || "";
    if (text.length >= 20) out.push({ el: n, text });
  }
  return out;
}

function splitToChunks(text, target = 220) {
  // Prefer sentence-ish boundaries, else chunk by length
  const sentences = text
    .split(/(?<=[\.\!\?…])\s+(?=[A-Z0-9“"(\[])|(?<=\n)\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let buf = "";
  for (const s of sentences.length ? sentences : [text]) {
    if ((buf + " " + s).trim().length > target && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else {
      buf = (buf + " " + s).trim();
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// --- Reader
class KokoroReader {
  constructor() {
    this.queue = [];
    this.idx = -1;
    this.audio = null;
    this.highlighter = new Highlighter();
    this.settings = { voice: "af_heart", speed: 1.0, selectionOnly: false };
    this.state = "idle"; // idle | playing | paused
    this.abortController = null;
  }

  async buildQueue() {
    const sel = window.getSelection();
    const hasSelection =
      this.settings.selectionOnly && sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim().length > 0;

    const root = hasSelection ? sel.getRangeAt(0).commonAncestorContainer : chooseRoot();
    const rootEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    const blocks = collectBlocks(rootEl || document.body);

    const items = [];
    for (const b of blocks) {
      const chunks = splitToChunks(b.text, 220);
      for (const c of chunks) items.push({ el: b.el, text: c });
    }
    this.queue = items;
    this.idx = -1;
  }

  async start(settings) {
    if (this.state === "playing" || this.state === "paused") {
      // restart with new settings
      await this.stop();
    }
    this.settings = { ...this.settings, ...settings };
    await initTTS();
    await this.buildQueue();
    if (!this.queue.length) {
      alert("No readable text found on this page.");
      return { ok: false };
    }
    this.state = "playing";
    this.abortController = new AbortController();
    this.loop(this.abortController.signal);
    return { ok: true };
  }

  async loop(signal) {
    for (let i = 0; i < this.queue.length; i++) {
      if (signal.aborted) break;
      this.idx = i;
      const item = this.queue[i];

      // Highlight current element
      this.highlighter.highlight(item.el);

      // Generate TTS
      let blob;
      blob = await generateParagraphBlob(item.text, this.settings.voice, this.settings.speed);

      if (signal.aborted) break;

      // Play
      const url = URL.createObjectURL(blob);
      await this.playUrl(url, signal);

      if (signal.aborted) break;
    }

    this.highlighter.clear();
    this.state = "idle";
    this.idx = -1;
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

  nativeSpeak(text, signal) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.settings.speed || 1.0;
      u.onend = resolve;
      window.speechSynthesis.speak(u);
      signal.addEventListener(
        "abort",
        () => {
          window.speechSynthesis.cancel();
          resolve();
        },
        { once: true }
      );
    });
  }

  async pause() {
    if (this.state !== "playing") return { ok: false };
    this.state = "paused";
    if (this.audio) this.audio.pause();
    // native synthesis pause (best effort)
    if ("speechSynthesis" in window) window.speechSynthesis.pause?.();
    return { ok: true };
  }

  async resume() {
    if (this.state !== "paused") return { ok: false };
    this.state = "playing";
    if (this.audio) await this.audio.play();
    if ("speechSynthesis" in window) window.speechSynthesis.resume?.();
    return { ok: true };
  }

  async stop() {
    if (this.abortController) this.abortController.abort();
    this.abortController = null;
    if (this.audio) {
      this.audio.pause();
      URL.revokeObjectURL(this.audio.src);
      this.audio = null;
    }
    this.highlighter.clear();
    this.state = "idle";
    this.idx = -1;
    return { ok: true };
  }
}

const reader = new KokoroReader();

// Messages from popup
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "kokoro:ping": {
        sendResponse({ ok: true });
        break;
      }
      case "kokoro:listVoices": {
        const voices = await listVoices();
        sendResponse({ ok: true, voices });
        break;
      }
      case "kokoro:start": {
        const res = await reader.start(msg.settings || {});
        sendResponse(res);
        break;
      }
      case "kokoro:pause": {
        const res = await reader.pause();
        sendResponse(res);
        break;
      }
      case "kokoro:resume": {
        const res = await reader.resume();
        sendResponse(res);
        break;
      }
      case "kokoro:stop": {
        const res = await reader.stop();
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown_message" });
    }
  })();
  // keep the message channel open for async response
  return true;
});

// Keyboard shortcuts
api.commands?.onCommand?.addListener(async (command) => {
  if (command === "toggle-read") {
    if (reader.state === "playing") await reader.pause();
    else if (reader.state === "paused") await reader.resume();
    else await reader.start({});
  } else if (command === "stop-read") {
    await reader.stop();
  }
});
