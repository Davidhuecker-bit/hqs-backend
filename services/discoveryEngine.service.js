"use strict";

const { Pool } = require("pg");

const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized: false },
});

function calculateDiscoveryScore(row) {

 const hqs = Number(row.hqs_score || 0);
 const momentum = Number(row.momentum || 0);
 const relative = Number(row.relative || 0);
 const trend = Number(row.trend || 0);
 const volatility = Number(row.volatility || 0);

 let score =
   hqs * 0.5 +
   momentum * 15 +
   relative * 10 +
   trend * 20 -
   volatility * 5;

 return Number(score.toFixed(2));
}

function generateReason(row) {

 const reasons = [];

 if (row.momentum > 0.7) reasons.push("Momentum breakout");
 if (row.relative > 0.7) reasons.push("Market outperformance");
 if (row.trend > 0.6) reasons.push("Strong trend");

 if (!reasons.length) reasons.push("Improving fundamentals");

 return reasons.join(" + ");
}

async function discoverStocks(limit = 10) {

 const result = await pool.query(`
   SELECT
     symbol,
     hqs_score,
     momentum,
     relative,
     trend,
     volatility,
     regime
   FROM market_advanced_metrics
   ORDER BY trend DESC
   LIMIT 100
 `);

 const rows = result.rows || [];

 const discoveries = rows.map((row) => {

   const discoveryScore = calculateDiscoveryScore(row);

   return {
     symbol: row.symbol,
     regime: row.regime,
     hqsScore: Number(row.hqs_score || 0),
     discoveryScore,
     confidence: Math.min(100, Math.round(discoveryScore * 0.9)),
     reason: generateReason(row),
   };
 });

 discoveries.sort((a,b)=>b.discoveryScore-a.discoveryScore);

 return discoveries.slice(0,limit);
}

module.exports = {
 discoverStocks
};
