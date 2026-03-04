"use strict";

const express = require("express");
const router = express.Router();

const { discoverStocks } = require("../services/discoveryEngine.service");

router.get("/", async (req,res)=>{

 try{

  const limit = Number(req.query.limit || 10);

  const stocks = await discoverStocks(limit);

  return res.json({
   success:true,
   count:stocks.length,
   discoveries:stocks
  });

 }catch(err){

  return res.status(500).json({
   success:false,
   message:err.message
  });

 }

});

module.exports = router;
