/**
 * Message handling and validation for Chrome extension communication.
 * @module messageHandler
 */

import { logger } from "./logger.js";
import { VALID_MESSAGE_TYPES } from "./constants.js";
import { initManager, callBackground } from "./initManager.js";
import { TtsController, createTtsController } from "./ttsController.js";

/**
 * @typedef {import('./types.js').MessagePayload} MessagePayload
 */

/** @type {TtsController|null} */
let controller = null;

/**
 * Gets or creates the TTS controller instance.
 * @returns {TtsController}
 */
export function getController() {
  if (!controller) {
    controller = createTtsController();
  }
  return controller;
}

/**
 * Destroys the controller instance.
 */
export function destroyController() {
  if (controller) {
    controller.dispose();
    controller = null;
  }
}

/**
 * Validates that a message is from a trusted source.
 * @param {MessagePayload} msg
 * @returns {boolean}
 */
export function isValidMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (typeof msg.type !== "string") return false;
  return VALID_MESSAGE_TYPES.includes(msg.type);
}

/**
 * Lists available voices from the TTS engine.
 * @returns {Promise<string[]>}
 */
async function listVoices() {
  const initialized = await initManager.initTTS();
  if (!initialized) return [];
  const response = await callBackground("voices");
  return Array.isArray(response?.voices) ? response.voices : [];
}

/**
 * Handles incoming messages from the extension.
 * @param {MessagePayload} msg
 * @returns {Promise<Object>}
 */
export async function handleMessage(msg) {
  if (!isValidMessage(msg)) {
    logger.warn("Invalid message received:", msg?.type);
    return { ok: false, error: "invalid_message" };
  }

  if (msg.type === "kokoro:executeCommand") {
    return handleCommand(msg.command);
  }

  const ctrl = getController();

  switch (msg.type) {
    case "kokoro:ping":
      return { ok: true };

    case "kokoro:getState":
      return {
        ok: true,
        state: ctrl.state,
        settings: ctrl.settings,
        index: ctrl.currentIndex,
        total: ctrl.queueLength,
      };

    case "kokoro:getModelStatus": {
      const webgpuSupported = await initManager.probeWebGPU();
      if (!webgpuSupported) {
        return { ok: true, loaded: false, webgpuUnsupported: true };
      }
      const status = await callBackground("status").catch(() => ({}));
      return {
        ok: true,
        loaded: status.loaded || false,
        downloadProgress: status.downloadProgress,
      };
    }

    case "kokoro:triggerModelInit": {
      // Fire-and-forget initialization trigger
      // This starts the model loading process in the background without waiting
      initManager.initTTS().catch(() => {});
      return { ok: true };
    }

    case "kokoro:listVoices": {
      const webgpuSupported = await initManager.probeWebGPU();
      if (!webgpuSupported) {
        return { ok: false, error: "WebGPU not supported in this browser/device" };
      }
      const voices = await listVoices().catch(() => []);
      return { ok: true, voices };
    }

    case "kokoro:playButtonPressed": {
      if (ctrl.state === "idle") {
        return ctrl.start(msg.settings || {});
      }
      if (ctrl.state === "playing") return ctrl.pause();
      if (ctrl.state === "paused") return ctrl.resume();
      return { ok: false };
    }

    case "kokoro:setSpeed":
      ctrl.setSpeed(msg.speed);
      return { ok: true };

    case "kokoro:setVoice":
      ctrl.setVoice(msg.voice);
      return { ok: true };

    case "kokoro:setAutoScroll":
      ctrl.setAutoScroll(Boolean(msg.autoScroll));
      return { ok: true };

    case "kokoro:setHighlightColor":
      ctrl.setHighlightColor(msg.color);
      return { ok: true };

    case "kokoro:regenerateCurrent":
      return ctrl.regenerateCurrent();

    case "kokoro:clearCache":
      return ctrl.clearCache();

    case "kokoro:initializeClickHandlers":
      return ctrl.initializeClickHandlers();

    default:
      return { ok: false, error: "unknown_message" };
  }
}

/**
 * Handles keyboard command messages.
 * @param {string} command
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function handleCommand(command) {
  const ctrl = getController();

  switch (command) {
    case "toggle-read":
      if (ctrl.state === "playing") return ctrl.pause();
      if (ctrl.state === "paused") return ctrl.resume();
      return ctrl.start({});

    case "stop-read":
      return ctrl.stop();

    case "jump-next": {
      if (ctrl.queueLength === 0) {
        return { ok: false, error: "Queue is empty" };
      }
      const nextIdx = ctrl.currentIndex + 1;
      if (nextIdx >= ctrl.queueLength) {
        return { ok: true };
      }
      return ctrl.jumpTo(nextIdx);
    }

    case "jump-previous": {
      if (ctrl.queueLength === 0) {
        return { ok: false, error: "Queue is empty" };
      }
      const prevIdx = ctrl.currentIndex - 1;
      if (prevIdx < 0) {
        return { ok: true };
      }
      return ctrl.jumpTo(prevIdx);
    }

    default:
      return { ok: false, error: "unknown_command" };
  }
}
