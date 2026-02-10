import express from "express";
import cors from "cors";
import yahooFinance from "yahoo-finance2";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// ✅ Railway Health
app.get("/", (_, res) => res.send("HQS Backend OK"));
app.get("/ping", (_, res) => res.json({ status: "pong" }));

// Universe
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];

// Strategy weights
const STRATEGIES = {
  defensiv: { momentum: 0.2, valuation: 0.4, risk: 0.4 },
  balanced: { momentum: 0.33, valuation: 0.33, risk: 0.34 },
  aggressiv: { momentum: 0.5, valuation: 0.3, risk: 0.2 }
};

function toNumber(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

async function scoreUniverse(style = "balanced") {
  const weights = STRATEGIES[style] || STRATEGIES.balanced;
  const results = [];

  for (const symbol of SYMBOLS) {
    try {
      const quote = await yahooFinance.quote(symbol);

      // 1y history
      const hist = await yahooFinance.historical(symbol, {
        period1: new Date(Date.now() - 370 * 24 * 60 * 60 * 1000) // ~370 Tage
      });

      if (!quote || !Array.isArray(hist) || hist.length < 60) continue;

      const closes = hist
        .map(d => toNumber(d.close))
        .filter(v => Number.isFinite(v));

      if (closes.length < 60) continue;

      const priceNow = toNumber(quote.regularMarketPrice);
      const priceThen = closes[0];

      if (!priceNow || !priceThen) continue;

      // Momentum (1y approx)
      const momentum = (priceNow - priceThen) / priceThen;

      // Simple “risk”: mean absolute deviation over last 30 closes
      const last30 = closes.slice(-30);
      const avgAbsDev =
        last30.reduce((acc, p) => acc + Math.abs(p - priceNow), 0) /
        last30.length /
        priceNow;

      // Simple “valuation proxy”
      const pe = toNumber(quote.trailingPE, 30);
      const valuation = 1 / pe;

      const score =
        momentum * weights.momentum +
        valuation * weights.valuation -
        avgAbsDev * weights.risk;

      results.push({
        symbol,
        score: Number((score * 100).toFixed(2)),
        meta: {
          price: Number(priceNow.toFixed(2)),
          momentum_1y_pct: Number((momentum * 100).toFixed(2)),
          pe: Number(pe.toFixed(2)),
          risk_proxy: Number((avgAbsDev * 100).toFixed(2))
        }
      });
    } catch (e) {
      console.error("Symbol error:", symbol, e.message);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ✅ Frontend-Route: IMMER JSON
app.get("/market", async (_, res) => {
  const data = await scoreUniverse("balanced");
  res.json(data);
});

// ✅ Stage4 Route (mit style param)
app.get("/stage4", async (req, res) => {
  const style = String(req.query.style || "balanced");
  const data = await scoreUniverse(style);
  res.json({ style, count: data.length, data });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ HQS Backend läuft auf Port ${PORT}`);
});
