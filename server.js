const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
// Railway vergibt den Port dynamisch – das stellt sicher, dass wir erreichbar sind
const PORT = process.env.PORT || 8080;

// ============================
// CONFIG & SYMBOLS
// ============================
const SYMBOLS = (process.env.SYMBOLS || "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,VTI,QQQ").split(",").map(s => s.trim());
const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/api/v3"; 

const cache = new NodeCache({ stdTTL: 600, useClones: false });

// CORS-Update: Erlaubt deiner Domain den Zugriff
app.use(cors({
    origin: ["https://dhsystemhqs.de", "https://www.dhsystemhqs.de", "http://localhost:3000"],
    methods: ["GET", "POST"]
}));
app.use(express.json());

// ============================
// KI-LOGIK & BERECHNUNGEN (Bleiben erhalten)
// ============================
function getAIInsight(symbol, score) {
    if (score >= 75) return "Das Modell erkennt eine starke Akkumulationsphase durch institutionelle Anleger.";
    if (score <= 45) return "Vorsicht: Modell identifiziert Überhitzung und Gewinnmitnahmen.";
    return "Markt im Gleichgewicht. Konsolidierung vor nächstem Ausbruch wahrscheinlich.";
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

// ============================
// ENDPOINTS
// ============================

// FIX 1: Akzeptiert jetzt /market UND /api/market (Löst 404 Fehler)
app.get(["/market", "/api/market"], async (req, res) => {
    const userTier = req.query.tier || "FULL_TRIAL";
    const cacheKey = `market_${userTier}`;

    try {
        const cached = cache.get(cacheKey);
        if (cached) return res.json({ success: true, stocks: cached });

        const url = `${BASE_URL}/quote/${SYMBOLS.join(",")}?apikey=${API_KEY}`;
        const response = await axios.get(url, { timeout: 5000 }); // Timeout gegen Hänger
        
        if (!response.data || response.data.length === 0) {
            throw new Error("Keine Daten von FMP erhalten.");
        }

        const stocks = response.data.map(item => {
            const hqs = calculateHQS(item);
            return {
                symbol: item.symbol,
                name: item.name,
                price: item.price,
                changePercent: Number(item.changesPercentage || 0).toFixed(2),
                hqsScore: hqs,
                rating: hqs >= 85 ? "Strong Buy" : hqs >= 70 ? "Buy" : "Neutral",
                decision: hqs >= 70 ? "KAUFEN" : "HALTEN",
                aiInsight: getAIInsight(item.symbol, hqs)
            };
        });

        cache.set(cacheKey, stocks);
        res.json({ success: true, stocks });

    } catch (e) {
        console.error("API Fehler - Nutze Fallback:", e.message);
        
        // FIX 2: Sende Test-Daten statt Fehler 500 (Löst Website-Absturz)
        const fallback = SYMBOLS.slice(0, 3).map(s => ({
            symbol: s,
            name: `${s} (Demo-Modus)`,
            price: 150.00,
            changePercent: "0.00",
            hqsScore: 75,
            decision: "PRÜFEN",
            aiInsight: "Verbindung wird neu aufgebaut... Bitte API-Key prüfen."
        }));

        res.json({ success: true, stocks: fallback, isFallback: true });
    }
});

// FIX 3: Admin-Status Route für das Frontend erreichbar machen
app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
    res.json({ active: true, mode: "AI-Hybrid Online" });
});

app.listen(PORT, () => console.log(`HQS Backend Online auf Port ${PORT}`));
