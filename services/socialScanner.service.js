"use strict";

const { fetchRedditPosts } = require("./redditScanner.service");
const { normalizeSocialPost } = require("./socialNormalizer.service");

function toPostList(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

async function collectSocialSignals() {
  const scannerResults = await Promise.all([fetchRedditPosts()]);

  return scannerResults
    .flatMap((result) => toPostList(result))
    .map((post) => normalizeSocialPost(post))
    .filter((post) => post.text);
}

module.exports = {
  collectSocialSignals,
};
