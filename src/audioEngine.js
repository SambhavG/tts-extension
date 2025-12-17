/**
 * Audio generation, processing, and playback engine.
 * @module audioEngine
 */

import { logger } from "./logger.js";
import { STRETCH_CHUNK_SIZE } from "./constants.js";
import { initManager, callBackground } from "./initManager.js";

/**
 * @typedef {import('./types.js').ActiveAudio} ActiveAudio
 */

/**
 * Manages audio generation, processing, and playback.
 */
export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this._audioContext = null;
    /** @type {ActiveAudio|null} */
    this._activeAudio = null;
    /** @type {boolean} */
    this._forceWebAudio = false;
    /** @type {Float32Array|null} */
    this._stretchWindow = null;
    /** @type {number} */
    this._stretchWindowSize = 0;
    /** @type {Float32Array|null} */
    this._stretchOutputBuffer = null;
    /** @type {Float32Array|null} */
    this._stretchWeightBuffer = null;
    /** @type {boolean} */
    this._isPaused = false;
  }

  /**
   * Generates audio blob for a sentence.
   * @param {string} text - Text to synthesize
   * @param {string} [voice="af_heart"] - Voice identifier
   * @returns {Promise<Blob|null>}
   */
  async generateSentenceBlob(text, voice = "af_heart") {
    const initialized = await initManager.initTTS();
    if (!initialized) return null;

    const response = await callBackground("generateBatch", {
      sentences: [text],
      voice,
    });

    if (!response?.audioWav) {
      logger.warn("No audio data received from background");
      return null;
    }

    const wavBuffer = this._toArrayBuffer(response.audioWav);
    if (wavBuffer.byteLength === 0) {
      logger.warn("Empty audio buffer received");
      return null;
    }

    return new Blob([wavBuffer], { type: "audio/wav" });
  }

  /**
   * Plays an audio blob.
   * @param {Blob|null} blob - Audio blob to play
   * @param {AbortSignal} signal - Abort signal
   * @param {number} speed - Playback speed
   * @returns {Promise<boolean>}
   */
  async playBlob(blob, signal, speed) {
    if (!blob) {
      logger.warn("Attempted to play null blob, skipping");
      return true;
    }

    // Always stop any existing playback before starting new
    // This is a safeguard against race conditions
    this.stopActiveAudio();

    this._isPaused = false;

    if (!this._forceWebAudio) {
      const result = await this._playWithHtmlAudio(blob, signal, speed);
      if (result.success) return true;
      logger.info("HTML Audio failed, falling back to WebAudio");
      this._forceWebAudio = true;
    }

    return this._playWithWebAudio(blob, signal, speed);
  }

  /**
   * Stops the currently playing audio.
   */
  stopActiveAudio() {
    if (!this._activeAudio) return;

    if (this._activeAudio.type === "html") {
      this._activeAudio.element.pause();
      this._revokeUrl(this._activeAudio.url);
    } else if (this._activeAudio.type === "webaudio") {
      this._activeAudio.source.stop();
      this._activeAudio.source.disconnect();
    }

    this._activeAudio = null;
    this._isPaused = false;
  }

  /**
   * Pauses the currently playing audio. Idempotent.
   * @returns {boolean} True if audio was paused
   */
  pauseActiveAudio() {
    if (!this._activeAudio || this._isPaused) return false;

    this._isPaused = true;

    if (this._activeAudio.type === "html") {
      this._activeAudio.element.pause();
    } else if (this._activeAudio.type === "webaudio") {
      this._activeAudio.ctx?.suspend();
    }

    return true;
  }

  /**
   * Resumes the paused audio. Idempotent.
   * @returns {boolean} True if audio was resumed
   */
  resumeActiveAudio() {
    if (!this._activeAudio || !this._isPaused) return false;

    this._isPaused = false;

    if (this._activeAudio.type === "html") {
      this._activeAudio.element.play();
    } else if (this._activeAudio.type === "webaudio") {
      this._activeAudio.ctx?.resume();
    }

    return true;
  }

  /**
   * Updates the playback rate for HTML audio.
   * @param {number} speed
   */
  setPlaybackRate(speed) {
    if (this._activeAudio?.type === "html") {
      this._activeAudio.element.playbackRate = speed;
    }
  }

  /**
   * Releases all resources.
   */
  dispose() {
    this.stopActiveAudio();
    if (this._audioContext && this._audioContext.state !== "closed") {
      this._audioContext.close();
    }
    this._audioContext = null;
    this._stretchOutputBuffer = null;
    this._stretchWeightBuffer = null;
    this._stretchWindow = null;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /** @private */
  _revokeUrl(url) {
    if (url) {
      URL.revokeObjectURL(url);
    }
  }

  /** @private */
  _toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    if (Array.isArray(data)) return new Uint8Array(data).buffer;
    if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) {
      return data.buffer;
    }
    return new ArrayBuffer(0);
  }

  /** @private */
  _ensureAudioContext() {
    if (this._audioContext && this._audioContext.state !== "closed") {
      return this._audioContext;
    }

    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;

    this._audioContext = new Ctor();
    return this._audioContext;
  }

  /** @private */
  _playWithHtmlAudio(blob, signal, speed) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = document.createElement("audio");
      audio.src = url;
      audio.preload = "metadata";
      audio.playbackRate = speed || 1.0;

      let resolved = false;

      const done = (success) => {
        if (resolved) return;
        resolved = true;

        audio.removeEventListener("ended", onEnd);
        audio.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);

        this._revokeUrl(url);

        if (this._activeAudio?.type === "html" && this._activeAudio.element === audio) {
          this._activeAudio = null;
        }

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

      this._activeAudio = { type: "html", element: audio, url };

      audio.play()?.catch?.(() => {
        if (!resolved) onError();
      });
    });
  }

  /** @private */
  async _playWithWebAudio(blob, signal, speed) {
    let ctx = this._ensureAudioContext();
    if (!ctx) return false;

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const arrayBuffer = await blob.arrayBuffer();
    const originalBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const processedBuffer = this._processAudioBuffer(ctx, originalBuffer, speed);

    return new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = processedBuffer;
      source.playbackRate.value = 1.0;
      source.connect(ctx.destination);

      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;

        signal.removeEventListener("abort", onAbort);
        source.onended = null;
        source.disconnect();

        if (this._activeAudio?.type === "webaudio" && this._activeAudio.source === source) {
          this._activeAudio = null;
        }

        resolve(true);
      };

      const onAbort = () => {
        source.stop();
        done();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      this._activeAudio = { type: "webaudio", source, ctx };

      source.onended = done;
      source.start();
    });
  }

  /** @private */
  _processAudioBuffer(ctx, originalBuffer, speed) {
    const tempo = Math.max(0.1, Math.min(speed || 1.0, 4.0));
    if (Math.abs(tempo - 1) <= 0.01) return originalBuffer;

    const channelCount = originalBuffer.numberOfChannels;
    const stretchedChannels = [];
    let maxLength = 0;

    for (let ch = 0; ch < channelCount; ch++) {
      const stretched = this._timeStretchPCM(originalBuffer.getChannelData(ch), tempo);
      stretchedChannels.push(stretched);
      maxLength = Math.max(maxLength, stretched.length);
    }

    const processedBuffer = ctx.createBuffer(channelCount, maxLength, originalBuffer.sampleRate);
    for (let ch = 0; ch < channelCount; ch++) {
      processedBuffer.getChannelData(ch).set(stretchedChannels[ch]);
    }
    return processedBuffer;
  }

  /** @private */
  _getStretchWindow(size) {
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

  /** @private */
  _ensureStretchBuffers(requiredSize) {
    if (this._stretchOutputBuffer && this._stretchOutputBuffer.length >= requiredSize) {
      this._stretchOutputBuffer.fill(0);
      this._stretchWeightBuffer.fill(0);
      return;
    }
    const allocSize = Math.ceil(requiredSize * 1.2);
    this._stretchOutputBuffer = new Float32Array(allocSize);
    this._stretchWeightBuffer = new Float32Array(allocSize);
  }

  /**
   * Optimized time-stretch with pre-allocated buffers and NaN protection.
   * @private
   * @param {Float32Array} input
   * @param {number} tempo
   * @returns {Float32Array}
   */
  _timeStretchPCM(input, tempo) {
    if (!input?.length) return new Float32Array(0);

    const clampedTempo = Math.max(0.1, Math.min(tempo, 4.0));
    if (Math.abs(clampedTempo - 1) < 0.01) return input.slice();

    const windowSize = 2048;
    const halfWindow = windowSize >> 1;
    const stepIn = halfWindow;
    const stepOut = Math.max(1, Math.round(halfWindow / clampedTempo));
    const window = this._getStretchWindow(windowSize);

    const numWindows = Math.ceil((input.length - windowSize) / stepIn) + 1;
    const estimatedOutputSize = numWindows * stepOut + windowSize * 2;

    this._ensureStretchBuffers(estimatedOutputSize);
    const output = this._stretchOutputBuffer;
    const weight = this._stretchWeightBuffer;

    let inPos = 0;
    let outPos = 0;

    while (inPos + windowSize <= input.length) {
      const chunkEnd = Math.min(inPos + STRETCH_CHUNK_SIZE, input.length);

      while (inPos + windowSize <= chunkEnd && inPos + windowSize <= input.length) {
        for (let i = 0; i < windowSize; i++) {
          output[outPos + i] += input[inPos + i] * window[i];
          weight[outPos + i] += window[i];
        }
        inPos += stepIn;
        outPos += stepOut;
      }
    }

    const remaining = input.length - inPos;
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) {
        output[outPos + i] += input[inPos + i];
        weight[outPos + i] += 1;
      }
      outPos += remaining;
    }

    const resultLength = Math.min(output.length, outPos + windowSize);
    const result = new Float32Array(resultLength);
    const minWeight = 1e-5;

    for (let i = 0; i < resultLength; i++) {
      if (weight[i] > minWeight) {
        const val = output[i] / weight[i];
        result[i] = Number.isFinite(val) ? val : 0;
      } else {
        result[i] = 0;
      }
    }

    return result;
  }
}

