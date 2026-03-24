/**
 * TTS Controller - orchestrates queue and state management.
 * @module ttsController
 */

import { logger } from "./logger.js";
import { DEFAULT_SETTINGS, PREREAD_AHEAD, LRU_MAX_SIZE } from "./constants.js";
import { initManager } from "./initManager.js";
import { DomManager } from "./domManager.js";
import { AudioEngine } from "./audioEngine.js";

/**
 * @typedef {import('./types.js').QueueItem} QueueItem
 * @typedef {import('./types.js').TtsSettings} TtsSettings
 * @typedef {import('./types.js').TtsState} TtsState
 * @typedef {import('./types.js').StateWaiter} StateWaiter
 */

/**
 * Main controller that orchestrates TTS functionality.
 */
export class TtsController {
  /**
   * Creates a new TTS controller.
   * @param {DomManager} domManager
   * @param {AudioEngine} audioEngine
   */
  constructor(domManager, audioEngine) {
    /** @type {DomManager} */
    this._dom = domManager;
    /** @type {AudioEngine} */
    this._audio = audioEngine;
    /** @type {QueueItem[]} */
    this._queue = [];
    /** @type {number} */
    this._idx = -1;
    /** @type {TtsSettings} */
    this._settings = { ...DEFAULT_SETTINGS };
    /** @type {TtsState} */
    this._state = "idle";
    /** @type {StateWaiter[]} */
    this._stateWaiters = [];
    /** @type {Map<number, boolean>} */
    this._generatedLRU = new Map();
    /** @type {AbortController|null} */
    this._abortController = null;
    /** @type {Promise<void>|null} */
    this._loopPromise = null;
    /** @type {Promise<void>|null} - Serializes stop/jump operations */
    this._operationQueue = Promise.resolve();
    /** @type {number} - Increments on each operation to detect stale completions */
    this._operationId = 0;
    /** @type {boolean} - Whether we've attempted to restore state for this page */
    this._stateRestored = false;
    /** @type {boolean} - Whether click-to-read mode is enabled */
    this._clickToReadEnabled = true;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Current playback state.
   * @returns {TtsState}
   */
  get state() {
    return this._state;
  }

  /**
   * Current settings (copy).
   * @returns {TtsSettings}
   */
  get settings() {
    return { ...this._settings };
  }

  /**
   * Current queue index.
   * @returns {number}
   */
  get currentIndex() {
    return this._idx;
  }

  /**
   * Total items in queue.
   * @returns {number}
   */
  get queueLength() {
    return this._queue.length;
  }

  /**
   * Starts TTS playback.
   * @param {Partial<TtsSettings>} [settings]
   * @param {number} [startIndex=0] - Index to start playback from
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async start(settings, startIndex = 0) {
    // Serialize with other operations
    const result = await this._enqueueOperation(() => this._doStart(settings, startIndex));
    return result;
  }

  /**
   * Initializes click handlers for interactive reading without starting playback.
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async initializeClickHandlers() {
    // Try to restore state on first initialization
    if (!this._stateRestored) {
      this._stateRestored = true;
      const restored = await this.restoreReadingState();
      if (restored) {
        logger.info("Successfully restored reading state");
      }
    }

    // Build queue if not already built (or rebuild if we restored state)
    if (!this._queue.length) {
      this._queue = this._dom.buildQueue();
    }

    if (!this._queue.length) {
      return { ok: false, error: "No readable text found on this page." };
    }

    // Bind click handlers (respects click-to-read toggle)
    this._dom.bindClickHandlers(this._queue, (idx) => {
      if (!this._clickToReadEnabled) return;
      if (this._state === "idle") {
        this.start({}, idx);
      } else {
        this.jumpTo(idx);
      }
    });

    return { ok: true };
  }

  /**
   * Internal start implementation.
   * @private
   * @param {Partial<TtsSettings>} [settings]
   * @param {number} [startIndex=0] - Index to start playback from
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async _doStart(settings, startIndex = 0) {
    // Stop any existing playback first
    if (this._state !== "idle") {
      this._audio.stopActiveAudio();
      if (this._abortController) {
        this._abortController.abort();
      }
      if (this._loopPromise) {
        await this._loopPromise;
        this._loopPromise = null;
      }
      this._cleanup();
    }

    Object.assign(this._settings, settings);

    const webgpuSupported = await initManager.probeWebGPU();
    if (!webgpuSupported) {
      return { ok: false, error: "WebGPU is not available in this browser/device." };
    }

    const initialized = await initManager.initTTS();
    if (!initialized) {
      return { ok: false, error: "Failed to initialize TTS engine." };
    }

    this._queue = this._dom.buildQueue();

    if (!this._queue.length) {
      return { ok: false, error: "No readable text found on this page." };
    }

    this._dom.bindClickHandlers(this._queue, (idx) => {
      if (!this._clickToReadEnabled) return;
      this.jumpTo(idx);
    });

    this._setState("playing");
    this._abortController = new AbortController();
    this._loopPromise = this._loop(this._abortController.signal, startIndex);

    return { ok: true };
  }

  /**
   * Pauses playback. Idempotent.
   * @returns {Promise<{ok: boolean}>}
   */
  async pause() {
    if (this._state !== "playing") return { ok: false };
    this._setState("paused");
    this._audio.pauseActiveAudio();
    return { ok: true };
  }

  /**
   * Resumes playback. Idempotent.
   * @returns {Promise<{ok: boolean}>}
   */
  async resume() {
    if (this._state !== "paused") return { ok: false };
    this._setState("playing");
    this._audio.resumeActiveAudio();
    return { ok: true };
  }

  /**
   * Stops playback and waits for cleanup.
   * @returns {Promise<{ok: boolean}>}
   */
  async stop() {
    // Serialize with other operations
    const result = await this._enqueueOperation(() => this._doStop());
    return result;
  }

  /**
   * Internal stop implementation.
   * @private
   * @returns {Promise<{ok: boolean}>}
   */
  async _doStop() {
    // Stop audio immediately for instant feedback
    this._audio.stopActiveAudio();

    if (this._abortController) {
      this._abortController.abort();
    }

    if (this._loopPromise) {
      await this._loopPromise;
      this._loopPromise = null;
    }

    this._cleanup();
    return { ok: true };
  }

  /**
   * Jumps to a specific queue index.
   * @param {number} index
   * @returns {Promise<{ok: boolean}>}
   */
  async jumpTo(index) {
    if (index < 0 || index >= this._queue.length) return { ok: false };

    // Serialize with other operations
    const result = await this._enqueueOperation(() => this._doJumpTo(index));
    return result;
  }

  /**
   * Internal jumpTo implementation.
   * @private
   * @param {number} index
   * @returns {Promise<{ok: boolean}>}
   */
  async _doJumpTo(index) {
    // Stop audio immediately for instant feedback
    this._audio.stopActiveAudio();

    if (this._abortController) {
      this._abortController.abort();
    }

    if (this._loopPromise) {
      await this._loopPromise;
      this._loopPromise = null;
    }

    // Clear any leftover state
    this._dom.clearHighlight();

    this._setState("playing");
    this._abortController = new AbortController();
    this._loopPromise = this._loop(this._abortController.signal, index);

    return { ok: true };
  }

  /**
   * Serializes operations to prevent race conditions.
   * @private
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  _enqueueOperation(operation) {
    const opId = ++this._operationId;

    this._operationQueue = this._operationQueue
      .catch(() => {}) // Ignore errors from previous operations
      .then(() => {
        // Check if this operation is still the latest
        if (opId !== this._operationId) {
          logger.debug("Operation superseded, skipping", opId);
          return { ok: false };
        }
        return operation();
      });

    return this._operationQueue;
  }

  /**
   * Sets playback speed.
   * @param {number} speed
   */
  setSpeed(speed) {
    this._settings.speed = Math.max(0.1, Math.min(Number(speed) || 1.0, 4.0));
    this._audio.setPlaybackRate(this._settings.speed);
    this._saveReadingState();
  }

  /**
   * Sets voice.
   * @param {string} voice
   */
  setVoice(voice) {
    const newVoice = voice || "af_heart";
    if (this._settings.voice !== newVoice) {
      this._settings.voice = newVoice;
      // Clear cache when voice changes to prevent old voice audio from being used
      this._resetGenerationTracking();
      this._saveReadingState();
    }
  }

  /**
   * Sets click-to-read mode.
   * @param {boolean} enabled
   */
  setClickToRead(enabled) {
    this._clickToReadEnabled = enabled;
    this._dom.setClickToRead(enabled);
  }

  /**
   * Sets the maximum chunk length for sentence slicing.
   * @param {number} length
   */
  setMaxChunkLength(length) {
    this._dom.setMaxChunkLength(length);
  }

  /**
   * Sets auto-scroll.
   * @param {boolean} enabled
   */
  setAutoScroll(enabled) {
    this._dom.setAutoScroll(enabled);
    this._saveReadingState();
  }

  /**
   * Sets highlight color.
   * @param {string} color
   */
  setHighlightColor(color) {
    this._settings.highlightColor = color;
    this._dom.setHighlightColor(color);
    this._saveReadingState();
  }

  /**
   * Clears generated audio cache.
   * @returns {Promise<{ok: boolean}>}
   */
  async clearCache() {
    await this.stop();
    this._resetGenerationTracking();
    return { ok: true };
  }

  /**
   * Regenerates the current sentence with the new voice settings.
   * Only works if currently playing or paused.
   * @returns {Promise<{ok: boolean}>}
   */
  async regenerateCurrent() {
    if (this._state === "idle" || this._idx < 0) {
      return { ok: false, error: "Not currently playing" };
    }

    // Clear the current sentence from cache so it gets regenerated with new voice
    const currentItem = this._queue[this._idx];
    if (currentItem) {
      currentItem.genStatus = "not_generated";
      currentItem.genPromise = null;
      currentItem.blob = null;
    }

    // If we were paused, stay paused. If playing, continue from current position
    if (this._state === "playing") {
      // Restart playback from the current index to regenerate the current sentence
      await this._doJumpTo(this._idx);
    }

    return { ok: true };
  }

  /**
   * Saves the current reading state to persistent storage.
   * @private
   */
  async _saveReadingState() {
    try {
      const pageUrl = window.location.href;
      const contentHash = this._dom._computeContentHash();

      const state = {
        url: pageUrl,
        contentHash: contentHash,
        index: this._idx,
        settings: { ...this._settings },
        queueLength: this._queue.length,
        timestamp: Date.now(),
      };

      // Only save if we have a meaningful state (not idle with no queue)
      if (this._queue.length > 0 && this._idx >= 0) {
        await chrome.storage.local.set({ [`tts_state_${pageUrl}`]: state });
        logger.debug("Saved reading state", { index: this._idx, queueLength: this._queue.length });
      }
    } catch (error) {
      logger.warn("Failed to save reading state:", error);
    }
  }

  /**
   * Restores reading state from persistent storage if content hasn't changed.
   * @returns {Promise<boolean>} True if state was restored
   */
  async restoreReadingState() {
    try {
      const pageUrl = window.location.href;
      const contentHash = this._dom._computeContentHash();

      const result = await chrome.storage.local.get([`tts_state_${pageUrl}`]);
      const savedState = result[`tts_state_${pageUrl}`];

      if (!savedState) {
        logger.debug("No saved state found");
        return false;
      }

      // Check if state is still valid
      if (savedState.url !== pageUrl || savedState.contentHash !== contentHash) {
        logger.debug("Saved state is stale (URL or content changed)");
        await this._clearSavedState();
        return false;
      }

      // Check if state is too old (24 hours)
      const age = Date.now() - savedState.timestamp;
      if (age > 24 * 60 * 60 * 1000) {
        logger.debug("Saved state is too old");
        await this._clearSavedState();
        return false;
      }

      // Restore settings
      Object.assign(this._settings, savedState.settings);

      // Build queue and try to restore position
      this._queue = this._dom.buildQueue();

      if (
        this._queue.length === savedState.queueLength &&
        savedState.index >= 0 &&
        savedState.index < this._queue.length
      ) {
        this._idx = savedState.index;
        logger.info(`Restored reading state: index ${this._idx} of ${this._queue.length} items`);
        return true;
      } else {
        logger.debug("Could not restore position - queue structure changed");
        await this._clearSavedState();
        return false;
      }
    } catch (error) {
      logger.warn("Failed to restore reading state:", error);
      return false;
    }
  }

  /**
   * Clears saved reading state for current page.
   * @private
   */
  async _clearSavedState() {
    try {
      const pageUrl = window.location.href;
      await chrome.storage.local.remove([`tts_state_${pageUrl}`]);
    } catch (error) {
      logger.warn("Failed to clear saved state:", error);
    }
  }

  /**
   * Disposes all resources.
   */
  dispose() {
    this._saveReadingState(); // Save state before disposing
    this.stop();
    this._audio.dispose();
    this._queue = [];
    this._generatedLRU.clear();
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /** @private */
  _setState(newState) {
    this._state = newState;
    this._flushStateWaiters();
    // Save state when playback state changes
    if (newState === "idle" || newState === "playing" || newState === "paused") {
      this._saveReadingState();
    }
  }

  /** @private */
  _flushStateWaiters() {
    this._stateWaiters = this._stateWaiters.filter((w) => {
      if (w.done || w.predicate(this._state)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  /**
   * Waits for state to match predicate.
   * @private
   * @param {(state: TtsState) => boolean} predicate
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  _waitForState(predicate, signal) {
    if (typeof predicate !== "function" || predicate(this._state)) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      /** @type {StateWaiter} */
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
      this._stateWaiters.push(waiter);
    });
  }

  /**
   * Gets occurrence index of item text within same element.
   * @private
   * @param {number} index
   * @returns {number}
   */
  _getOccurrenceIndex(index) {
    const item = this._queue[index];
    if (!item) return 0;
    let count = 0;
    for (let i = 0; i < index; i++) {
      const other = this._queue[i];
      if (other.xpath === item.xpath && other.text === item.text) {
        count++;
      }
    }
    return count;
  }

  /**
   * Generates audio for queue index.
   * @private
   * @param {number} index
   * @returns {Promise<Blob|null>}
   */
  _generateForIndex(index) {
    const item = this._queue[index];
    if (!item) return Promise.resolve(null);

    if (item.genStatus === "generated") {
      this._bumpLRU(index);
      return Promise.resolve(item.blob);
    }

    if (item.genStatus === "generating") return item.genPromise;

    item.genStatus = "generating";
    // Capture the voice at the start of generation to detect voice changes
    const generationVoice = this._settings.voice;
    item.genPromise = this._audio
      .generateSentenceBlob(item.text, generationVoice)
      .then((blob) => {
        // Only cache if the voice hasn't changed since generation started
        if (this._settings.voice === generationVoice) {
          item.blob = blob;
          item.genStatus = blob ? "generated" : "error";
          if (blob) {
            this._bumpLRU(index);
            this._evictIfNeeded();
          }
        } else {
          // Voice changed during generation, don't cache this result
          item.genStatus = "not_generated";
          item.blob = null;
          item.genPromise = null;
        }
        return blob;
      })
      .catch((err) => {
        logger.error("Generation failed for index", index, err);
        item.genStatus = "error";
        return null;
      });

    return item.genPromise;
  }

  /**
   * Bumps item to front of LRU.
   * @private
   * @param {number} index
   */
  _bumpLRU(index) {
    const item = this._queue[index];
    if (!item || item.genStatus !== "generated") return;
    this._generatedLRU.delete(index);
    this._generatedLRU.set(index, true);
  }

  /**
   * Evicts oldest items if LRU exceeds max size.
   * @private
   */
  _evictIfNeeded() {
    while (this._generatedLRU.size > LRU_MAX_SIZE) {
      const oldestKey = this._generatedLRU.keys().next().value;
      this._generatedLRU.delete(oldestKey);
      const it = this._queue[oldestKey];
      if (it) {
        it.blob = null;
        it.genPromise = null;
        it.genStatus = "not_generated";
      }
    }
  }

  /**
   * Prefetches upcoming items.
   * @private
   * @param {number} startIndex
   */
  _ensurePrefetch(startIndex) {
    if (this._state !== "playing") return;

    const end = Math.min(this._queue.length, startIndex + PREREAD_AHEAD);
    for (let j = startIndex; j < end; j++) {
      const item = this._queue[j];
      if (item?.genStatus === "not_generated") {
        this._generateForIndex(j);
      }
    }
  }

  /**
   * Resets all generation tracking.
   * @private
   */
  _resetGenerationTracking() {
    this._generatedLRU.clear();
    for (const item of this._queue) {
      if (!item) continue;
      item.genStatus = "not_generated";
      item.genPromise = null;
      item.blob = null;
    }
  }

  /**
   * Main playback loop.
   * @private
   * @param {AbortSignal} signal
   * @param {number} [startIndex=0]
   * @returns {Promise<void>}
   */
  async _loop(signal, startIndex = 0) {
    logger.debug("Starting playback loop from index", startIndex);

    for (let i = Math.max(0, startIndex); i < this._queue.length; i++) {
      if (signal.aborted) break;
      if (this._state !== "playing" && this._state !== "paused") break;

      this._idx = i;
      const item = this._queue[i];
      const el = this._dom.getElement(item);
      const occurrenceIndex = this._getOccurrenceIndex(i);

      this._dom.highlightPending(el, item.text, occurrenceIndex);

      const blob = await this._generateForIndex(i);

      if (signal.aborted) break;

      if (this._state === "paused") {
        await this._waitForState((s) => s !== "paused", signal);
      }

      if (signal.aborted || this._state !== "playing") break;

      this._dom.activateHighlight();
      this._ensurePrefetch(i + 1);

      await this._audio.playBlob(blob, signal, this._settings.speed);
    }

    if (!signal.aborted) {
      logger.debug("Playback loop completed naturally");
      this._cleanup(true);
    }
  }

  /**
   * Cleans up playback state.
   * @private
   * @param {boolean} [naturalCompletion=false] - Whether playback finished naturally (all items played)
   */
  _cleanup(naturalCompletion = false) {
    this._audio.stopActiveAudio();
    this._dom.clearHighlight();

    if (naturalCompletion) {
      // Playback finished all items — reset position so next press starts from beginning
      this._idx = -1;
      this._clearSavedState();
    } else {
      // Explicit stop — save position so user can resume later
      this._saveReadingState();
    }

    this._state = "idle";
    this._abortController = null;
    this._flushStateWaiters();
  }
}

/**
 * Creates a new TTS controller with default managers.
 * @returns {TtsController}
 */
export function createTtsController() {
  const domManager = new DomManager();
  const audioEngine = new AudioEngine();
  return new TtsController(domManager, audioEngine);
}
