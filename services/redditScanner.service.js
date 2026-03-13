"use strict";

async function fetchRedditPosts() {
  return {
    source: "reddit",
    text: "Tesla looks extremely bullish after earnings",
    symbols: ["TSLA"],
    mentions: ["Tesla"],
    score: 12,
    createdAt: Date.now(),
  };
}

module.exports = {
  fetchRedditPosts,
};
