// backend/routes/stock.js

const express = require("express");
const router = express.Router();
const { calculateFullScore } = require("../services/scoreEngine");

router.get("/:ticker", async (req, res) => {
  const { ticker } = req.params;

  const result = await calculateFullScore(ticker);

  res.json(result);
});

module.exports = router;
