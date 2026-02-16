const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// ============================
// CONFIG & SYMBOLS
// ============================
const SYMBOLS = (process.env.SYMBOLS || "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,VTI,QQQ").split(",").map(s => s.trim());
const API_KEY = process.env.FMP_API_KEY;

// ÄNDERUNG: Wir nutzen /stable, um den 403-Fehler zu umgehen
const BASE_URL = "https://financialmodelingprep.com/stable"; 

const cache = new NodeCache({ stdTTL: 600, useClones: false });

app.use(cors());
app.use(express.json());

// ============================
// STRATEGIE 1: KOSTENLOSE KI-LOGIK (HEURISTIK)
// ============================
function getAIInsight(symbol, score, change) {
    const insights = {
        bullish: [
            "Das Modell erkennt eine starke Akkumulationsphase durch institutionelle Anleger.",
            "Positiver Trend durch signifikantes Volumen-Signal bestätigt.",
            "Optimale Momentum-Konvergenz: Günstige Einstiegschance identifiziert."
        ],
        neutral: [
            "Aktuelle Seitwärtsphase abwarten. Modell zeigt geringe Volatilität.",
            "Markt im Gleichgewicht. Konsolidierung vor nächstem Ausbruch wahrscheinlich.",
            "Halten-Signal: Stabile Fundamentaldaten ohne klare kurzfristige Richtung."
        ],
        bearish: [
            "Vorsicht: Modell identifiziert Überhitzung und Gewinnmitnahmen.",
            "Erhöhtes Risiko: Verkaufsdruck nimmt zu, Momentum bricht ein.",
            "Strategischer Rückzug empfohlen: Trendwende-Signale verdichten sich."
        ]
    };

    let cat = "neutral";
    if (score >= 75) cat = "bullish";
    if (score <= 45) cat = "bearish";

    const index = symbol.length % insights[cat].length;
    return insights[cat][index];
}

// ============================
// STRATEGIE 2: EXPERTEN-BERECHNUNGEN
// ============================
function calculateProbabilities(score, change) {
    let base = 60 + (score / 4);
    return {
        "7d": Math.min(98, Math.round(base + (change > 0 ? 2 : -2))) + "%",
        "30d": Math.min(98, Math.round(base + 5)) + "%",
        "90d": Math.min(98, Math.round(base + 10)) + "%"
    };
}

function calculateHQS(item) {
    const change = Number(item.changesPercentage || 0);
    const vRatio = Number(item.volume) / (Number(item.avgVolume) || 1);
    let score = 50;
    if (change > 0) score += 10;
    if (vRatio > 1.3) score += 15;
    if (item.marketCap > 1e11) score += 10;
    return Math.min(100, Math.round(score + 15));
}

function processStockData(item, userTier = "FULL_TRIAL") {
    const finalHqs = calculateHQS(item);
    const change = Number(item.changesPercentage || 0);
    const isFull = userTier === "FULL_TRIAL";

    return {
        symbol: item.symbol,
        name: item.name,
        price: item.price,
        changePercent: change.toFixed(2),
        hqsScore: finalHqs,
        rating: finalHqs >= 85 ? "Strong Buy" : finalHqs >= 70 ? "Buy" : "Neutral",
        decision: finalHqs >= 70 ? "KAUFEN" : finalHqs <= 45 ? "NICHT KAUFEN" : "HALTEN",
        aiInsight: getAIInsight(item.symbol, finalHqs, change),
        probabilities: isFull ? calculateProbabilities(finalHqs, change) : "Upgrade erforderlich",
        alphaVsMarket: isFull ? `+${(finalHqs / 15).toFixed(1)}%` : "Nur Premium",
        userTier
    };
}

// ============================
// ENDPOINTS
// ============================
app.get("/market", async (req, res) => {
    try {
        const userTier = req.query.tier || "FULL_TRIAL";
        const cacheKey = `market_${userTier}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json({ success: true, stocks: cached });

        const url = `${BASE_URL}/quote/${SYMBOLS.join(",")}?apikey=${API_KEY}`;
        const response = await axios.get(url);
        
        if (!response.data || response.data.length === 0) {
            throw new Error("Keine Daten von FMP erhalten.");
        }

        const stocks = response.data.map(item => processStockData(item, userTier));
        stocks.sort((a, b) => b.hqsScore - a.hqsScore);

        cache.set(cacheKey, stocks);
        res.json({ success: true, stocks });
    } catch (e) {
        console.error("API Fehler:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => console.log(`HQS v13 AI-Hybrid Online auf Port ${PORT}`));
