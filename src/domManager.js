/**
 * DOM management: text extraction, queue building, and highlighting.
 * @module domManager
 */

import { logger } from "./logger.js";
import { SKIP_TAGS, SIMPLE_INLINE_TAGS } from "./constants.js";
import { splitIntoSentences, sliceLongSentence } from "./textProcessing.js";

/**
 * @typedef {import('./types.js').QueueItem} QueueItem
 * @typedef {import('./types.js').TextContainer} TextContainer
 */

/**
 * Manages DOM operations: text extraction, queue building, and highlighting.
 * Uses WeakRef for element caching to prevent memory leaks.
 */
export class DomManager {
  constructor() {
    /** @type {HTMLElement|null} */
    this._prevEl = null;
    /** @type {HTMLElement|null} */
    this._prevWrapper = null;
    /** @type {boolean} */
    this._autoScrollEnabled = true;
    /** @type {string|null} */
    this._lastQueueHash = null;
    /** @type {QueueItem[]|null} */
    this._cachedQueue = null;
    /** @type {number} */
    this._lastHighlightTime = 0;
    /** Minimum ms between highlight updates */
    this._highlightThrottleMs = 16;
  }

  /**
   * Enables or disables auto-scrolling.
   * @param {boolean} enabled
   */
  setAutoScroll(enabled) {
    this._autoScrollEnabled = enabled;
  }

  // ---------------------------------------------------------------------------
  // Root Selection & Text Collection
  // ---------------------------------------------------------------------------

  /**
   * Chooses the best root element for text extraction.
   * @returns {HTMLElement}
   */
  chooseRoot() {
    const article = document.querySelector("article");
    if (article && this._isVisible(article)) return article;
    const main = document.querySelector("main");
    if (main && this._isVisible(main)) return main;
    return document.body;
  }

  /**
   * Collects text containers from the root element.
   * @param {HTMLElement} root
   * @returns {TextContainer[]}
   */
  collectTextContainers(root) {
    const metaList = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node;

    while ((node = walker.nextNode())) {
      const meta = this._getCandidateTextMeta(node);
      if (meta) metaList.push(meta);
    }

    const blockMeta = metaList.filter((m) => m.isBlock);
    const pool = blockMeta.length ? blockMeta : metaList;
    const keep = pool.filter((meta) => !pool.some((other) => other !== meta && this._isAncestorOf(meta.el, other.el)));

    return keep.map((meta) => ({
      xpath: this._generateXPath(meta.el),
      el: meta.el,
      text: meta.text,
    }));
  }

  /**
   * Computes a hash of the page content for cache invalidation.
   * @returns {string}
   * @private
   */
  _computeContentHash() {
    const root = this.chooseRoot();
    const text = root.textContent || "";
    return `${text.length}:${text.slice(0, 100)}:${text.slice(-100)}`;
  }

  /**
   * Builds the reading queue from page content.
   * Returns cached queue if DOM content unchanged.
   * @param {boolean} [forceRebuild=false]
   * @returns {QueueItem[]}
   */
  buildQueue(forceRebuild = false) {
    const currentHash = this._computeContentHash();

    if (!forceRebuild && this._lastQueueHash === currentHash && this._cachedQueue) {
      logger.debug("Reusing cached queue");
      return this._cachedQueue;
    }

    const root = this.chooseRoot();
    const containers = this.collectTextContainers(root);
    /** @type {QueueItem[]} */
    const queue = [];

    for (const c of containers) {
      for (const sentence of splitIntoSentences(c.text)) {
        for (const chunk of sliceLongSentence(sentence)) {
          queue.push({
            xpath: c.xpath,
            elRef: new WeakRef(c.el),
            text: chunk,
            genStatus: "not_generated",
            genPromise: null,
            blob: null,
          });
        }
      }
    }

    this._lastQueueHash = currentHash;
    this._cachedQueue = queue;
    logger.info(`Built queue with ${queue.length} items`);
    return queue;
  }

  /**
   * Gets element from queue item, resolving WeakRef or XPath.
   * @param {QueueItem} item
   * @returns {HTMLElement|null}
   */
  getElement(item) {
    const el = item.elRef?.deref();
    if (el && document.contains(el)) return el;
    return this.resolveXPath(item.xpath);
  }

  /**
   * Resolves an XPath to a DOM element.
   * @param {string} xpath
   * @returns {HTMLElement|null}
   */
  resolveXPath(xpath) {
    if (!xpath) return null;
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return /** @type {HTMLElement|null} */ (result.singleNodeValue);
  }

  // ---------------------------------------------------------------------------
  // Highlighting
  // ---------------------------------------------------------------------------

  /**
   * Clears the current highlight.
   */
  clearHighlight() {
    if (this._prevEl) {
      this._prevEl.classList.remove("kokoro-tts-highlight", "kokoro-tts-pending");
      this._prevEl = null;
    }

    if (!this._prevWrapper?.parentNode) {
      this._prevWrapper = null;
      return;
    }

    const wrapper = this._prevWrapper;
    const parent = wrapper.parentNode;

    while (wrapper.firstChild) {
      parent.insertBefore(wrapper.firstChild, wrapper);
    }
    parent.removeChild(wrapper);
    this._prevWrapper = null;
  }

  /**
   * Highlights an element or text range with throttling.
   * @param {HTMLElement|null} el - Element to highlight
   * @param {string} [text] - Specific text to highlight
   * @param {boolean} [pending=false] - Whether this is a pending highlight
   * @param {number} [occurrenceIndex=0] - Which occurrence of text to highlight
   */
  highlight(el, text, pending = false, occurrenceIndex = 0) {
    if (!el) return;

    const now = performance.now();
    if (now - this._lastHighlightTime < this._highlightThrottleMs) {
      return;
    }
    this._lastHighlightTime = now;

    this.clearHighlight();

    const className = pending ? "kokoro-tts-pending" : "kokoro-tts-highlight";

    if (text?.trim()) {
      const res = this._wrapTextRange(el, text, className, occurrenceIndex);
      if (res?.wrapper) {
        this._prevWrapper = res.wrapper;
        this._scrollIfEnabled(res.wrapper);
        return;
      }
    }

    this._prevEl = el;
    el.classList.add(className);
    this._scrollIfEnabled(el);
  }

  /**
   * Highlights element in pending state.
   * @param {HTMLElement|null} el
   * @param {string} [text]
   * @param {number} [occurrenceIndex=0]
   */
  highlightPending(el, text, occurrenceIndex = 0) {
    this.highlight(el, text, true, occurrenceIndex);
  }

  /**
   * Activates the current pending highlight.
   */
  activateHighlight() {
    const target = this._prevWrapper || this._prevEl;
    if (!target) return;
    target.classList.remove("kokoro-tts-pending");
    target.classList.add("kokoro-tts-highlight");
  }

  /**
   * Finds the queue index at a click position.
   * @param {HTMLElement} el
   * @param {number} clickX
   * @param {number} clickY
   * @param {QueueItem[]} queue
   * @returns {number}
   */
  findClickedIndex(el, clickX, clickY, queue) {
    const itemsForEl = [];
    queue.forEach((item, idx) => {
      const itemEl = this.getElement(item);
      if (itemEl === el) {
        itemsForEl.push({ idx, text: item.text });
      }
    });

    if (itemsForEl.length <= 1) return itemsForEl[0]?.idx ?? -1;

    let caretOffset = -1;
    let caretNode = null;

    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clickX, clickY);
      if (pos) {
        caretNode = pos.offsetNode;
        caretOffset = pos.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(clickX, clickY);
      if (range) {
        caretNode = range.startContainer;
        caretOffset = range.startOffset;
      }
    }

    if (!caretNode) return itemsForEl[0].idx;

    const { norm, map } = this._buildTextMap(el);

    let clickPosInNorm = -1;
    for (let i = 0; i < map.length; i++) {
      if (map[i].node === caretNode && map[i].offset >= caretOffset) {
        clickPosInNorm = i;
        break;
      }
      if (map[i].node === caretNode) {
        clickPosInNorm = i;
      }
    }

    if (clickPosInNorm === -1) return itemsForEl[0].idx;

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

  /**
   * Binds click handlers to queue elements.
   * @param {QueueItem[]} queue
   * @param {(index: number) => void} onClickCallback
   */
  bindClickHandlers(queue, onClickCallback) {
    const boundElements = new Set();

    queue.forEach((item) => {
      const el = this.getElement(item);
      if (!el || el.dataset.kokoroClickableBound === "1" || boundElements.has(el)) {
        return;
      }

      boundElements.add(el);
      el.dataset.kokoroClickableBound = "1";
      el.classList.add("kokoro-tts-clickable");

      el.addEventListener("click", (e) => {
        const idx = this.findClickedIndex(el, e.clientX, e.clientY, queue);
        if (idx >= 0) onClickCallback(idx);
      });

      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    });
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /** @private */
  _isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none" &&
      style.opacity !== "0" &&
      style.clipPath !== "inset(100%)"
    );
  }

  /** @private */
  _isReadableBlock(el) {
    if (!(el instanceof HTMLElement) || SKIP_TAGS.has(el.tagName)) return false;
    const name = el.tagName;
    if (["P", "LI", "BLOCKQUOTE"].includes(name) || /^H[1-6]$/.test(name)) return true;
    if (name !== "DIV") return false;
    const text = el.textContent?.trim() || "";
    return text.split(/\s+/).length >= 6;
  }

  /** @private */
  _normalizeTextContent(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** @private */
  _getCandidateTextMeta(el) {
    if (!(el instanceof HTMLElement) || SKIP_TAGS.has(el.tagName)) return null;
    if (!this._isVisible(el) || SIMPLE_INLINE_TAGS.has(el.tagName)) return null;
    const text = this._normalizeTextContent(el);
    if (!text.length) return null;
    return { el, text, isBlock: this._isReadableBlock(el) };
  }

  /** @private */
  _isAncestorOf(a, b) {
    return a && b && a !== b && a.contains(b);
  }

  /** @private */
  _generateXPath(el) {
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

  /** @private */
  _scrollIfEnabled(el) {
    if (!this._autoScrollEnabled) return;

    const rect = el.getBoundingClientRect();
    const viewHeight = window.innerHeight;
    const isInView = rect.top >= 0 && rect.bottom <= viewHeight;

    if (!isInView) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }

  /** @private */
  _buildTextMap(rootEl) {
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

  /** @private */
  _wrapTextRange(rootEl, targetText, className, occurrenceIndex = 0) {
    const { norm, map } = this._buildTextMap(rootEl);
    const target = targetText.replace(/\s+/g, " ").trim();

    if (!target || map.length === 0) return null;

    let startIdx = -1;
    let searchFrom = 0;
    for (let i = 0; i <= occurrenceIndex; i++) {
      startIdx = norm.indexOf(target, searchFrom);
      if (startIdx === -1) return null;
      searchFrom = startIdx + 1;
    }

    const endIdx = startIdx + target.length - 1;

    if (endIdx >= map.length) {
      logger.warn("Text range out of bounds");
      return null;
    }

    const range = document.createRange();
    range.setStart(map[startIdx].node, map[startIdx].offset);
    range.setEnd(map[endIdx].node, map[endIdx].offset + 1);

    const span = document.createElement("span");
    span.className = className;
    span.appendChild(range.extractContents());
    range.insertNode(span);
    return { wrapper: span };
  }
}
