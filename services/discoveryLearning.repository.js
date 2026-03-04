"use strict";

const { Pool } = require("pg");

const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: { rejectUnauthorized:false }
});

async function initDiscoveryTable(){

 await pool.query(`
 CREATE TABLE IF NOT EXISTS discovery_history (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  discovery_score NUMERIC,
  price_at_discovery NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  checked BOOLEAN DEFAULT FALSE,
  return_7d NUMERIC,
  return_30d NUMERIC
 )
 `);

}

async function saveDiscovery(symbol,score,price){

 await pool.query(`
 INSERT INTO discovery_history
 (symbol,discovery_score,price_at_discovery)
 VALUES ($1,$2,$3)
 `,
 [symbol,score,price]);

}

async function getPendingDiscoveries(){

 const res = await pool.query(`
 SELECT *
 FROM discovery_history
 WHERE checked = FALSE
 AND created_at < NOW() - INTERVAL '7 days'
 LIMIT 50
 `);

 return res.rows;

}

async function updateDiscoveryResult(id,return7d){

 await pool.query(`
 UPDATE discovery_history
 SET
 return_7d=$1,
 checked=TRUE
 WHERE id=$2
 `,
 [return7d,id]);

}

module.exports={
 initDiscoveryTable,
 saveDiscovery,
 getPendingDiscoveries,
 updateDiscoveryResult
};
