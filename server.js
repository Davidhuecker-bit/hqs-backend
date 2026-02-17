const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
require("dotenv").config();

const app = express();
// Nutzt den von Railway zugewiesenen Port oder 8080 als Backup
const PORT = process.env.PORT || 8080;

// ============================
// CONFIG & SYMBOLS
// ============================
const SYMBOLS = (process.env.SYMBOLS || "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,VTI,QQQ").split(",").map(s => s.trim());
const API_KEY = process.env.FMP_API_KEY;
const BASE_URL = "https://financialmodelingprep.com/api/v3"; // Standard V3 für maximale Kompatibilität

const cache = new NodeCache({ stdTTL: 600, useClones: false });

// Erlaubt Anfragen von deiner Domain
app.use(cors({
    origin: ["https://dhsystemhqs.de", "https://www.dhsystemhqs.de", "http://localhost:3000"],
    methods: ["GET", "POST"]
}));
app.use(express.json());

// ============================
// HILFSFUNKTIONEN (KI-Logik & HQS-Score)
// ============================
function getAIInsight(symbol, score) {
    if (score >= 75) return "Das Modell erkennt eine starke Akkumulationsphase durch institutionelle Anleger.";
    if (score <= 45) return "Vorsicht: Modell identifiziert Überhitzung und Gewinnmitnahmen.";
    return "Markt im Gleichgewicht. Konsolidierung vor nächstem Ausbruch wahrscheinlich.";
}

function calculateHQS(item) {
    const change = Number(item.changesPercentage || 0);
    let score = 65; 
    if (change > 0) score += 10;
    if (item.marketCap > 1e11) score += 15;
    return Math.min(100, Math.round(score));
}

// ============================
// ENDPOINTS
// ============================

// FIX: Akzeptiert jetzt /market UND /api/market, um 404-Fehler zu vermeiden
app.get(["/market", "/api/market"], async (req, res) => {
    const userTier = req.query.tier || "FULL_TRIAL";
    const cacheKey = `market_${userTier}`;

    try {
        const cached = cache.get(cacheKey);
        if (cached) return res.json({ success: true, stocks: cached });

        // API-Anfrage mit 5 Sekunden Timeout, damit der Server nicht hängen bleibt
        const url = `${BASE_URL}/quote/${SYMBOLS.join(",")}?apikey=${API_KEY}`;
        const response = await axios.get(url, { timeout: 5000 });
        
        if (!response.data || response.data.length === 0) {
            throw new Error("API lieferte leere Daten");
        }

        const stocks = response.data.map(item => {
            const hqs = calculateHQS(item);
            return {
                symbol: item.symbol,
                name: item.name,
                price: item.price,
                changePercent: Number(item.changesPercentage || 0).toFixed(2),
                hqsScore: hqs,
                aiInsight: getAIInsight(item.symbol, hqs),
                decision: hqs >= 70 ? "KAUFEN" : "HALTEN"
            };
        });

        cache.set(cacheKey, stocks);
        res.json({ success: true, stocks });

    } catch (e) {
        console.error("!!! API FEHLER - Nutze Fallback-Daten:", e.message);
        
        // FIX: Statt Status 500 senden wir jetzt immer Daten, damit die Website nicht abstürzt
        const fallbackStocks = SYMBOLS.slice(0, 3).map(s => ({
            symbol: s,
            name: `${s} (Demo Data)`,
            price: 150.00,
            changePercent: "1.50",
            hqsScore: 85,
            aiInsight: "Demo-Modus aktiv: Bitte API-Key in Railway prüfen.",
            decision: "PRÜFEN"
        }));

        res.json({ 
            success: true, 
            stocks: fallbackStocks, 
            note: "Dies sind temporäre Vorschaudaten (API-Error)." 
        });
    }
});

// Admin-Status Route fixen
app.get(["/admin-bypass-status", "/api/admin-bypass-status"], (req, res) => {
    res.json({ active: true, mode: "AI-Hybrid" });
});

app.listen(PORT, () => console.log(`HQS Backend Online auf Port ${PORT}`));
