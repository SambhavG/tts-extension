/**
 * JSDoc type definitions for the TTS extension.
 * @module types
 */

/**
 * @typedef {Object} QueueItem
 * @property {string} xpath - XPath to the DOM element
 * @property {WeakRef<HTMLElement>|null} elRef - WeakRef to DOM element (prevents memory leaks)
 * @property {string} text - Text content to read
 * @property {"not_generated"|"generating"|"generated"|"error"} genStatus - Generation status
 * @property {Promise<Blob|null>|null} genPromise - Pending generation promise
 * @property {Blob|null} blob - Generated audio blob
 */

/**
 * @typedef {Object} TtsSettings
 * @property {string} voice - Voice identifier
 * @property {number} speed - Playback speed (0.1 to 4.0)
 */

/**
 * @typedef {"idle"|"playing"|"paused"} TtsState
 */

/**
 * @typedef {Object} MessagePayload
 * @property {string} type - Message type identifier
 * @property {string} [scope] - Message scope for validation
 * @property {TtsSettings} [settings] - Optional settings
 * @property {string} [voice] - Voice identifier
 * @property {number} [speed] - Playback speed
 * @property {boolean} [autoScroll] - Auto-scroll toggle
 * @property {string} [command] - Command identifier
 */

/**
 * @typedef {Object} TextContainer
 * @property {string} xpath - XPath to element
 * @property {HTMLElement} el - DOM element
 * @property {string} text - Normalized text content
 */

/**
 * @typedef {Object} StateWaiter
 * @property {(state: TtsState) => boolean} predicate
 * @property {boolean} done
 * @property {() => void} resolve
 */

/**
 * @typedef {Object} ActiveAudioHtml
 * @property {"html"} type
 * @property {HTMLAudioElement} element
 * @property {string} url
 */

/**
 * @typedef {Object} ActiveAudioWebAudio
 * @property {"webaudio"} type
 * @property {AudioBufferSourceNode} source
 * @property {AudioContext} ctx
 */

/**
 * @typedef {ActiveAudioHtml|ActiveAudioWebAudio} ActiveAudio
 */

// Export empty object to make this a module
export {};

