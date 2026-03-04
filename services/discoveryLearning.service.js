"use strict";

const { Pool } = require("pg");

const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized:false }
});

async function saveDiscovery(symbol,score,price){

 await pool.query(`
 INSERT INTO discovery_history
 (symbol,discovery_score,price_at_discovery)
 VALUES ($1,$2,$3)
 `,
 [symbol,score,price]);

}

async function evaluateDiscoveries(){

 const rows = await pool.query(`
 SELECT *
 FROM discovery_history
 WHERE checked = FALSE
 AND created_at < NOW() - INTERVAL '7 days'
 LIMIT 50
 `);

 for(const row of rows.rows){

  try{

   const priceNow = await getCurrentPrice(row.symbol);

   const return7d =
    ((priceNow-row.price_at_discovery)/row.price_at_discovery)*100;

   await pool.query(`
    UPDATE discovery_history
    SET
     return_7d=$1,
     checked=TRUE
    WHERE id=$2
   `,[return7d,row.id]);

  }catch(e){
   console.log(e);
  }

 }

}

async function getCurrentPrice(symbol){

 const res = await pool.query(`
 SELECT price
 FROM market_snapshots
 WHERE symbol=$1
 ORDER BY created_at DESC
 LIMIT 1
 `,[symbol]);

 if(!res.rows.length) return null;

 return Number(res.rows[0].price);
}

module.exports={
 saveDiscovery,
 evaluateDiscoveries
};
