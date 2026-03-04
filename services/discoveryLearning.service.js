"use strict";

const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized:false }
});

async function saveDiscovery(symbol,score,price){

 try{

  await pool.query(`
  INSERT INTO discovery_history
  (symbol,discovery_score,price_at_discovery)
  VALUES ($1,$2,$3)
  `,
  [symbol,score,price]);

 }catch(e){

  logger.warn("saveDiscovery failed",{
   symbol,
   message:e.message
  });

 }

}

async function evaluateDiscoveries(){

 const rows = await pool.query(`
 SELECT *
 FROM discovery_history
 WHERE checked = FALSE
 AND created_at < NOW() - INTERVAL '7 days'
 LIMIT 50
 `);

 let processed = 0;

 for(const row of rows.rows){

  try{

   const priceNow = await getCurrentPrice(row.symbol);

   if(!priceNow) continue;

   const priceThen = Number(row.price_at_discovery);

   if(!priceThen || priceThen <= 0) continue;

   const return7d =
   ((priceNow-priceThen)/priceThen)*100;

   await pool.query(`
   UPDATE discovery_history
   SET
   return_7d=$1,
   checked=TRUE
   WHERE id=$2
   `,
   [return7d,row.id]);

   processed++;

  }catch(e){

   logger.warn("evaluateDiscoveries failed",{
    id:row.id,
    symbol:row.symbol,
    message:e.message
   });

  }

 }

 logger.info("Discovery evaluation finished",{
  processed
 });

}

async function getCurrentPrice(symbol){

 const res = await pool.query(`
 SELECT price
 FROM market_snapshots
 WHERE symbol=$1
 ORDER BY created_at DESC
 LIMIT 1
 `,
 [symbol]);

 if(!res.rows.length) return null;

 const price = Number(res.rows[0].price);

 return Number.isFinite(price) ? price : null;

}

module.exports={
 saveDiscovery,
 evaluateDiscoveries
};
