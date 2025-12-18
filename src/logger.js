/**
 * Logging utility with configurable levels.
 * @module logger
 */

/** @enum {number} */
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

/**
 * Centralized logging with configurable levels.
 */
export class Logger {
  /**
   * @param {string} prefix - Log prefix
   * @param {number} [level] - Minimum log level
   */
  constructor(prefix, level = LogLevel.NONE) {
    this._prefix = `[${prefix}]`;
    this._level = level;
  }

  /**
   * Sets the log level.
   * @param {number} level
   */
  setLevel(level) {
    this._level = level;
  }

  /**
   * Logs debug message.
   * @param {...any} args
   */
  debug(...args) {
    if (this._level <= LogLevel.DEBUG) console.debug(this._prefix, ...args);
  }

  /**
   * Logs info message.
   * @param {...any} args
   */
  info(...args) {
    if (this._level <= LogLevel.INFO) console.info(this._prefix, ...args);
  }

  /**
   * Logs warning message.
   * @param {...any} args
   */
  warn(...args) {
    if (this._level <= LogLevel.WARN) console.warn(this._prefix, ...args);
  }

  /**
   * Logs error message.
   * @param {...any} args
   */
  error(...args) {
    if (this._level <= LogLevel.ERROR) console.error(this._prefix, ...args);
  }
}

/** Global logger instance */
export const logger = new Logger("KokoroTTS", LogLevel.DEBUG);
