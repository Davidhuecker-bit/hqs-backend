"use strict";

const DEFAULT_SOURCE = "unknown";
const DEFAULT_MAX_TEXT_LENGTH = 10000;
const DEFAULT_MAX_ITEMS = 25;
const SYMBOL_PATTERN = /(?:^|[^A-Z0-9])\$?([A-Z]{2,5})(?=$|[^A-Z])/g;
const HANDLE_PATTERN = /(?:^|[^\w])@([A-Za-z0-9_]{2,30})/g;
const PROPER_NOUN_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

function normalizeText(value, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  return text.slice(0, maxLength);
}

function uniqueStrings(values = [], maxItems = DEFAULT_MAX_ITEMS) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = normalizeText(value, 255);
    if (!text) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(text);

    if (result.length >= maxItems) break;
  }

  return result;
}

function normalizeSource(value) {
  const source = String(value || "")
    .trim()
    .toLowerCase();
  return source || DEFAULT_SOURCE;
}

function normalizeScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

function normalizeCreatedAt(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function extractSymbols(text = "") {
  const matches = [];
  const content = normalizeText(text);

  for (const match of content.matchAll(SYMBOL_PATTERN)) {
    matches.push(String(match[1] || "").toUpperCase());
  }

  return uniqueStrings(matches).map((symbol) => symbol.toUpperCase());
}

function extractMentions(text = "") {
  const content = normalizeText(text);
  const mentions = [];

  for (const match of content.matchAll(HANDLE_PATTERN)) {
    mentions.push(match[1]);
  }

  for (const match of content.matchAll(PROPER_NOUN_PATTERN)) {
    mentions.push(match[1]);
  }

  return uniqueStrings(mentions);
}

function normalizeSocialPost(rawPost = {}) {
  const text = normalizeText(rawPost?.text ?? rawPost?.body ?? rawPost?.title);
  const rawSymbols = Array.isArray(rawPost?.symbols) ? rawPost.symbols : [];
  const rawMentions = Array.isArray(rawPost?.mentions) ? rawPost.mentions : [];

  return {
    source: normalizeSource(rawPost?.source),
    text,
    symbols: uniqueStrings(
      [...rawSymbols, ...extractSymbols(text)].map((symbol) =>
        String(symbol || "").toUpperCase()
      )
    ).map((symbol) => symbol.toUpperCase()),
    mentions: uniqueStrings([...rawMentions, ...extractMentions(text)]),
    score: normalizeScore(rawPost?.score),
    createdAt: normalizeCreatedAt(rawPost?.createdAt),
  };
}

module.exports = {
  normalizeSocialPost,
  extractSymbols,
  extractMentions,
};
