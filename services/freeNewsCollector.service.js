"use strict";

const axios = require("axios");

let logger = null;
try {
  logger = require("../utils/logger");
} catch (_) {
  logger = console;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeText(value, maxLength = 5000) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  return text.slice(0, maxLength);
}

function decodeHtmlEntities(value) {
  const text = String(value || "");

  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeDateToIso(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function extractTag(block, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(regex);
  if (!match) return null;
  return decodeHtmlEntities(match[1]);
}

function parseRssItems(xml) {
  const text = String(xml || "");
  const itemMatches = text.match(/<item[\s\S]*?<\/item>/gi) || [];
  const entryMatches = text.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const blocks = itemMatches.length ? itemMatches : entryMatches;

  return blocks.map((block) => {
    const title = extractTag(block, "title");
    const linkTag = extractTag(block, "link");
    const description =
      extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "content");
    const pubDate =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated");
    const guid = extractTag(block, "guid") || extractTag(block, "id");
    const source = extractTag(block, "source");

    let url = null;

    const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (hrefMatch?.[1]) {
      url = decodeHtmlEntities(hrefMatch[1]);
    } else if (linkTag) {
      url = decodeHtmlEntities(linkTag);
    } else if (guid && /^https?:\/\//i.test(guid)) {
      url = decodeHtmlEntities(guid);
    }

    return {
      title: normalizeText(stripHtml(title), 500),
      url: normalizeText(url, 2000),
      description: normalizeText(stripHtml(description), 4000),
      publishedAt: safeDateToIso(pubDate),
      source: normalizeText(stripHtml(source), 255),
      rawBlock: block,
    };
  });
}

function buildSearchTermsForSymbol(symbol, entity = null) {
  const terms = new Set();
  const normalizedSymbol = normalizeSymbol(symbol);
  if (normalizedSymbol) terms.add(normalizedSymbol);

  const companyName = normalizeText(entity?.companyName || entity?.company_name, 255);
  if (companyName) terms.add(companyName);

  const aliases = Array.isArray(entity?.aliases) ? entity.aliases : [];
  for (const alias of aliases) {
    const cleaned = normalizeText(alias, 255);
    if (cleaned && cleaned.length >= 2) terms.add(cleaned);
  }

  return [...terms].slice(0, 6);
}

function buildGoogleNewsRssUrls(symbol, entity = null) {
  const terms = buildSearchTermsForSymbol(symbol, entity);
  const urls = [];

  for (const term of terms) {
    const query = encodeURIComponent(`"${term}" stock OR shares OR earnings OR guidance`);
    urls.push({
      url: `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`,
      sourceName: "Google News RSS",
      sourceType: "rss",
      symbol: normalizeSymbol(symbol),
      queryTerm: term,
    });
  }

  return urls;
}

async function fetchRssFeed(feedUrl, timeout = 20000) {
  const response = await axios.get(feedUrl, {
    timeout,
    responseType: "text",
    headers: {
      "User-Agent": "Mozilla/5.0 HQS-News-Collector/1.0",
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
  });

  return String(response?.data || "");
}

function scoreItemForSymbol(item, symbol, entity = null) {
  const haystack = [
    item?.title,
    item?.description,
    item?.source,
    entity?.companyName,
    ...(Array.isArray(entity?.aliases) ? entity.aliases : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let score = 0;

  const normalizedSymbol = normalizeSymbol(symbol).toLowerCase();
  if (normalizedSymbol && haystack.includes(normalizedSymbol)) score += 3;

  const companyName = String(entity?.companyName || "").trim().toLowerCase();
  if (companyName && haystack.includes(companyName)) score += 5;

  for (const alias of Array.isArray(entity?.aliases) ? entity.aliases : []) {
    const a = String(alias || "").trim().toLowerCase();
    if (a && haystack.includes(a)) {
      score += 2;
    }
  }

  return score;
}

function dedupeNewsItems(items = []) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    const key = [
      normalizeSymbol(item?.symbol),
      String(item?.url || "").trim().toLowerCase(),
      String(item?.title || "").trim().toLowerCase(),
    ].join("|");

    if (!key.replace(/\|/g, "").trim()) continue;
    if (seen.has(key)) continue;

    seen.add(key);
    output.push(item);
  }

  return output;
}

async function collectFreeNewsForSymbol(symbol, entity = null, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return [];

  const maxFeeds = Math.max(1, Math.min(Number(options.maxFeedsPerSymbol) || 3, 10));
  const maxItems = Math.max(1, Math.min(Number(options.maxItemsPerSymbol) || 10, 50));
  const minScore = Math.max(0, Math.min(Number(options.minMatchScore) || 2, 20));

  const feeds = buildGoogleNewsRssUrls(normalizedSymbol, entity).slice(0, maxFeeds);
  const collected = [];

  for (const feed of feeds) {
    try {
      const xml = await fetchRssFeed(feed.url, options.timeoutMs || 20000);
      const items = parseRssItems(xml);

      for (const item of items) {
        const score = scoreItemForSymbol(item, normalizedSymbol, entity);

        if (score < minScore) continue;
        if (!item.title || !item.url) continue;

        collected.push({
          symbol: normalizedSymbol,
          title: item.title,
          url: item.url,
          source: item.source || feed.sourceName,
          publishedAt: item.publishedAt,
          summaryRaw: item.description,
          sourceType: feed.sourceType,
          entityHint: {
            symbol: normalizedSymbol,
            companyName: entity?.companyName || null,
            sector: entity?.sector || null,
            industry: entity?.industry || null,
            queryTerm: feed.queryTerm,
            matchScore: score,
          },
          rawPayload: {
            feedUrl: feed.url,
            queryTerm: feed.queryTerm,
            rawBlock: item.rawBlock,
          },
        });
      }
    } catch (error) {
      if (logger?.warn) {
        logger.warn("free news feed fetch failed", {
          symbol: normalizedSymbol,
          feedUrl: feed.url,
          message: error.message,
        });
      }
    }
  }

  const deduped = dedupeNewsItems(collected)
    .sort((a, b) => {
      const ad = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bd = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bd - ad;
    })
    .slice(0, maxItems);

  if (logger?.info) {
    logger.info("free news collected for symbol", {
      symbol: normalizedSymbol,
      items: deduped.length,
    });
  }

  return deduped;
}

async function collectFreeNewsForSymbols(symbols = [], entityMapBySymbol = {}, options = {}) {
  const normalizedSymbols = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
  const allItems = [];

  for (const symbol of normalizedSymbols) {
    const entity = entityMapBySymbol?.[symbol] || null;
    const items = await collectFreeNewsForSymbol(symbol, entity, options);
    allItems.push(...items);
  }

  const deduped = dedupeNewsItems(allItems);

  if (logger?.info) {
    logger.info("free news collection batch completed", {
      symbols: normalizedSymbols.length,
      items: deduped.length,
    });
  }

  return deduped;
}

module.exports = {
  collectFreeNewsForSymbol,
  collectFreeNewsForSymbols,
};
