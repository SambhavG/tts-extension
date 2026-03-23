/**
 * DOM management: text extraction, queue building, and highlighting.
 * @module domManager
 */

import { logger } from "./logger.js";
import { DEFAULT_SETTINGS, SKIP_TAGS, BLOCK_TAGS } from "./constants.js";
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
    /** @type {string} */
    this._highlightColor = DEFAULT_SETTINGS.highlightColor;
    /** @type {string|null} */
    this._lastQueueHash = null;
    /** @type {QueueItem[]|null} */
    this._cachedQueue = null;
    /** @type {number} */
    this._lastHighlightTime = 0;
    /** Minimum ms between highlight updates */
    this._highlightThrottleMs = 16;
    /** @type {boolean} */
    this._clickToReadEnabled = true;

    // Initialize default highlight styles
    this._updateHighlightStyles();
  }

  /**
   * Enables or disables auto-scrolling.
   * @param {boolean} enabled
   */
  setAutoScroll(enabled) {
    this._autoScrollEnabled = enabled;
  }

  /**
   * Sets the highlight color.
   * @param {string} color
   */
  setHighlightColor(color) {
    this._highlightColor = color;
    this._updateHighlightStyles();
  }

  /**
   * Updates the dynamic highlight styles.
   * @private
   */
  _updateHighlightStyles() {
    // Remove existing style element if it exists
    const existingStyle = document.getElementById("kokoro-dynamic-styles");
    if (existingStyle) {
      existingStyle.remove();
    }

    // Create new style element with dynamic colors
    const style = document.createElement("style");
    style.id = "kokoro-dynamic-styles";

    // Calculate text color based on background color brightness
    const isLight = this._isColorLight(this._highlightColor);
    const textColor = isLight ? "black" : "white";
    const pendingBgColor = this._lightenColor(this._highlightColor, 0.1);
    const pendingTextColor = this._isColorLight(pendingBgColor) ? "black" : "white";

    style.textContent = `
      .kokoro-tts-highlight {
        color: ${textColor} !important;
        background-color: ${this._hexToRgba(this._highlightColor, 0.9)} !important;
        outline: 2px solid ${this._hexToRgba(this._highlightColor, 0.9)};
      }
      .kokoro-tts-pending {
        color: ${pendingTextColor} !important;
        background-color: ${this._hexToRgba(pendingBgColor, 0.9)} !important;
        outline: 2px dashed ${this._hexToRgba(pendingBgColor, 0.9)};
      }
    `;

    document.head.appendChild(style);
  }

  /**
   * Checks if a color is light.
   * @private
   * @param {string} hexColor
   * @returns {boolean}
   */
  _isColorLight(hexColor) {
    const hex = hexColor.replace("#", "");
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5;
  }

  /**
   * Lightens a color by a given percentage.
   * @private
   * @param {string} hexColor
   * @param {number} percent
   * @returns {string}
   */
  _lightenColor(hexColor, percent) {
    const hex = hexColor.replace("#", "");
    const r = Math.min(255, parseInt(hex.substr(0, 2), 16) + Math.round(255 * percent));
    const g = Math.min(255, parseInt(hex.substr(2, 2), 16) + Math.round(255 * percent));
    const b = Math.min(255, parseInt(hex.substr(4, 2), 16) + Math.round(255 * percent));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  /**
   * Converts hex color to rgba string.
   * @private
   * @param {string} hexColor
   * @param {number} alpha
   * @returns {string}
   */
  _hexToRgba(hexColor, alpha) {
    const hex = hexColor.replace("#", "");
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
   * Collects text containers from the root element using recursive block
   * decomposition.  When a block element contains a mix of direct text /
   * inline children AND child block elements, the direct text is emitted as
   * its own container so it is not lost when we recurse into the child
   * blocks.
   *
   * @param {HTMLElement} root
   * @returns {TextContainer[]}
   */
  collectTextContainers(root) {
    /** @type {TextContainer[]} */
    const containers = [];
    this._collectBlocks(root, containers);
    return containers;
  }

  /**
   * Enables or disables click-to-read mode.
   * Toggles the visual clickable cursor on already-bound elements.
   * @param {boolean} enabled
   */
  setClickToRead(enabled) {
    this._clickToReadEnabled = enabled;
    const boundEls = document.querySelectorAll('[data-kokoro-clickable-bound="1"]');
    boundEls.forEach((el) => {
      if (enabled) {
        el.classList.add("kokoro-tts-clickable");
      } else {
        el.classList.remove("kokoro-tts-clickable");
      }
    });
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

    // If content hash changed, clear any saved reading state
    if (this._lastQueueHash && this._lastQueueHash !== currentHash) {
      logger.debug("Content changed, clearing saved state");
      try {
        // Clear saved state for this page since content changed
        chrome.storage.local.remove([`tts_state_${window.location.href}`]);
      } catch (error) {
        logger.warn("Failed to clear saved state on content change:", error);
      }
    }

    const root = this.chooseRoot();
    const containers = this.collectTextContainers(root);
    /** @type {QueueItem[]} */
    const queue = [];

    for (const c of containers) {
      for (const sentence of splitIntoSentences(c.text)) {
        // Skip sentences that contain no letters or digits (like "...")
        // Uses Unicode-aware check to support non-Latin scripts
        if (!/[\p{L}\p{N}]/u.test(sentence)) {
          continue;
        }
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
   * Respects the current click-to-read toggle state.
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
      if (this._clickToReadEnabled) {
        el.classList.add("kokoro-tts-clickable");
      }

      el.addEventListener("click", (e) => {
        if (!this._clickToReadEnabled) return;
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
  _normalizeTextContent(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  /**
   * Recursively collects text containers from a block-level element.
   *
   * For leaf blocks (no child blocks): the full textContent becomes one
   * container.
   *
   * For mixed-content blocks (direct text/inline + child blocks): each
   * contiguous run of direct text / inline children becomes its own
   * container, and child blocks are recursed into separately.  This
   * ensures e.g. `<div>Direct text<p>Para</p></div>` produces two
   * containers: one for "Direct text" and one for "Para".
   *
   * @private
   * @param {HTMLElement} el
   * @param {TextContainer[]} containers
   */
  _collectBlocks(el, containers) {
    if (!(el instanceof HTMLElement)) return;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!this._isVisible(el)) return;

    // Identify direct child block elements
    const childBlocks = [];
    for (const child of el.children) {
      if (
        child instanceof HTMLElement &&
        BLOCK_TAGS.has(child.tagName) &&
        !SKIP_TAGS.has(child.tagName)
      ) {
        childBlocks.push(child);
      }
    }

    if (childBlocks.length === 0) {
      // Leaf block (only inline content) — emit full text as one container
      const text = this._normalizeTextContent(el);
      if (text) {
        containers.push({ xpath: this._generateXPath(el), el, text });
      }
      return;
    }

    // Mixed content — walk childNodes to split text at block boundaries
    /** @type {string[]} */
    let runTexts = [];

    const flushRun = () => {
      const runText = runTexts.join("").replace(/\s+/g, " ").trim();
      if (runText) {
        containers.push({ xpath: this._generateXPath(el), el, text: runText });
      }
      runTexts = [];
    };

    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent || "";
        if (t) runTexts.push(t);
      } else if (child.nodeType === Node.ELEMENT_NODE && child instanceof HTMLElement) {
        if (SKIP_TAGS.has(child.tagName)) continue;
        if (!this._isVisible(child)) continue;

        if (BLOCK_TAGS.has(child.tagName)) {
          // Block boundary — flush current inline text run, then recurse
          flushRun();
          this._collectBlocks(child, containers);
        } else {
          // Inline element — include its text in the current run
          const t = child.textContent || "";
          if (t.trim()) runTexts.push(t);
        }
      }
    }

    // Flush any remaining inline text after the last block child
    flushRun();
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

    // Always scroll to center the highlighted element when auto-scroll is enabled
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
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
      searchFrom = startIdx + target.length;
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
