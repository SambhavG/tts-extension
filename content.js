/**
 * Kokoro TTS Chrome Extension - Content Script Entry Point
 *
 * This file imports and initializes the modular TTS system.
 * Vite bundles all imports into a single distributable file.
 *
 * @module content
 */

import { logger } from "./src/logger.js";
import { handleMessage } from "./src/messageHandler.js";

/**
 * Initializes the message listener for Chrome extension communication.
 */
function initializeMessageListener() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only accept messages from our extension
    if (sender.id !== chrome.runtime.id) {
      logger.warn("Message from unknown sender rejected");
      sendResponse({ ok: false, error: "unauthorized" });
      return false;
    }

    handleMessage(msg)
      .then(sendResponse)
      .catch((err) => {
        logger.error("Message handler error:", err);
        sendResponse({ ok: false, error: err.message || "internal_error" });
      });

    return true; // Keep channel open for async response
  });
}

// Initialize on load
initializeMessageListener();
logger.info("Kokoro TTS content script loaded");
