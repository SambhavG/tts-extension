/**
 * Text processing utilities for sentence splitting and chunking.
 * @module textProcessing
 */

import { logger } from "./logger.js";
import { SENTENCE_MAX_LENGTH } from "./constants.js";

/** @type {Intl.Segmenter|null} */
let sentenceSegmenter = null;

/**
 * Gets or creates the sentence segmenter singleton.
 * @returns {Intl.Segmenter|null}
 */
function getSentenceSegmenter() {
  if (sentenceSegmenter) return sentenceSegmenter;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    sentenceSegmenter = new Intl.Segmenter(navigator.language || "en", {
      granularity: "sentence",
    });
  }
  return sentenceSegmenter;
}

/**
 * Splits text into sentences using native Intl.Segmenter API.
 * Falls back to regex for browsers without support.
 * @param {string} text - Text to split
 * @returns {string[]}
 */
export function splitIntoSentences(text) {
  const normalized = (text || "").trim();
  if (!normalized) return [];

  const segmenter = getSentenceSegmenter();
  if (segmenter) {
    const segments = [...segmenter.segment(normalized)].map((s) => s.segment.trim()).filter(Boolean);
    // Further split segments on em dashes to create pauses
    const finalSegments = [];
    for (const segment of segments) {
      finalSegments.push(...segment.split(/—|——/).map(s => s.trim()).filter(Boolean));
    }
    return finalSegments.length ? finalSegments : [normalized];
  }

  // Fallback for older browsers
  const sentences = normalized
    .split(/(?<=[.!?…—])\s+(?=[A-Z0-9""([])|(?<=\n)\s*|—|——/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.length ? sentences : [normalized];
}

/**
 * Finds optimal split point in text, preferring punctuation and word boundaries.
 * @param {string} text - Text to split
 * @param {number} maxLength - Maximum length before split
 * @returns {number}
 */
function findSplitPoint(text, maxLength) {
  // Try punctuation marks first
  for (const ch of [",", ";", ":", "—", "-"]) {
    const idx = text.lastIndexOf(ch, maxLength);
    if (idx > maxLength * 0.4) return idx + 1;
  }

  // Fall back to word boundary
  let splitPoint = text.lastIndexOf(" ", maxLength);
  if (splitPoint <= 0) splitPoint = text.indexOf(" ", 1);

  // Last resort: split at maxLength (may break word)
  if (splitPoint <= 0) {
    logger.warn("Splitting text mid-word at position", maxLength);
    splitPoint = maxLength;
  }

  return splitPoint;
}

/**
 * Slices a long sentence into smaller chunks at word boundaries.
 * @param {string} sentence - Sentence to slice
 * @param {number} [maxLength] - Maximum chunk length
 * @returns {string[]}
 */
export function sliceLongSentence(sentence, maxLength = SENTENCE_MAX_LENGTH) {
  if (!sentence || sentence.length <= maxLength) return [sentence];

  const chunks = [];
  let remaining = sentence;

  while (remaining.length > maxLength) {
    const splitPoint = findSplitPoint(remaining, maxLength);
    const chunk = remaining.slice(0, splitPoint).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
