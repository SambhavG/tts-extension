/**
 * Initialization and background communication manager.
 * @module initManager
 */

import { logger } from "./logger.js";
import { MODEL_ID, MESSAGE_SCOPE, MESSAGE_TIMEOUT_MS } from "./constants.js";

/**
 * Sends a message to the background script with timeout and error handling.
 * @param {string} type - Message type
 * @param {Object} [payload] - Message payload
 * @param {number} [timeout] - Timeout in ms
 * @returns {Promise<Object>}
 */
export function callBackground(type, payload, timeout = MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Background message timeout: ${type}`));
    }, timeout);

    chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, payload }, (response) => {
      clearTimeout(timeoutId);

      if (chrome.runtime.lastError) {
        logger.error("Background message error:", chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (response?.error) {
        reject(new Error(response.error));
        return;
      }

      resolve(response || {});
    });
  });
}

/**
 * Manages WebGPU and TTS initialization with proper synchronization.
 * Uses promise-based locking to prevent race conditions.
 */
export class InitializationManager {
  constructor() {
    /** @type {Promise<boolean>|null} */
    this._webgpuProbePromise = null;
    /** @type {Promise<boolean>|null} */
    this._ttsInitPromise = null;
    /** @type {boolean} */
    this._webgpuUnsupported = !navigator?.gpu;
    /** @type {boolean} */
    this._initFailed = false;
  }

  /**
   * Probes WebGPU availability. Thread-safe via promise caching.
   * @returns {Promise<boolean>} True if WebGPU is supported
   */
  probeWebGPU() {
    if (this._webgpuProbePromise) return this._webgpuProbePromise;

    this._webgpuProbePromise = (async () => {
      if (!navigator?.gpu) {
        this._webgpuUnsupported = true;
        logger.info("WebGPU not available: navigator.gpu is undefined");
        return false;
      }

      const adapter = await navigator.gpu.requestAdapter();
      this._webgpuUnsupported = !adapter;

      if (!adapter) {
        logger.info("WebGPU not available: no adapter found");
      }

      return !this._webgpuUnsupported;
    })();

    return this._webgpuProbePromise;
  }

  /**
   * Initializes TTS engine. Thread-safe via promise caching.
   * @returns {Promise<boolean>} True if initialization succeeded
   */
  initTTS() {
    if (this._initFailed) return Promise.resolve(false);
    if (this._ttsInitPromise) return this._ttsInitPromise;

    this._ttsInitPromise = (async () => {
      const webgpuSupported = await this.probeWebGPU();
      if (!webgpuSupported) return false;

      await callBackground("init", {
        modelId: MODEL_ID,
        dtype: "fp32",
        device: "webgpu",
      });

      logger.info("TTS engine initialized");
      return true;
    })().catch((err) => {
      logger.error("TTS initialization failed:", err);
      this._initFailed = true;
      this._ttsInitPromise = null; // Allow retry
      return false;
    });

    return this._ttsInitPromise;
  }

  /**
   * Resets initialization state to allow retry.
   */
  reset() {
    this._ttsInitPromise = null;
    this._initFailed = false;
  }

  /**
   * Whether WebGPU is unsupported.
   * @returns {boolean}
   */
  get isWebGPUUnsupported() {
    return this._webgpuUnsupported;
  }
}

/** Global initialization manager instance */
export const initManager = new InitializationManager();

