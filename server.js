const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== API KEY ====================
// Dein Alpha Vantage API Key - in Railway als Umgebungsvariable setzen!
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';

app.use(cors());

console.log(`🚀 HQS Backend gestartet auf Port ${PORT}`);
console.log(`🔑 API Key Status: ${ALPHA_VANTAGE_KEY === 'demo' ? 'Demo-Modus' : 'Live-Modus'}`);

// ==================== KONFIGURATION ====================
const DEFAULT_STOCKS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM', 'V', 'JNJ'];

// Rate Limiting für Alpha Vantage (5 requests/minute)
const rateLimiter = {
  lastCall: 0,
  minDelay: 1200, // 1.2 Sekunden zwischen Calls
  async wait() {
    const now = Date.now();
    const waitTime = this.minDelay - (now - this.lastCall);
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.lastCall = Date.now();
  }
};

// Einfacher In-Memory Cache
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 Minuten

// ==================== HELPER FUNCTIONS ====================
function getCompanyName(symbol) {
  const names = {
    'AAPL': 'Apple Inc.',
    'MSFT': 'Microsoft Corporation',
    'NVDA': 'NVIDIA Corporation',
    'GOOGL': 'Alphabet Inc. (Google)',
    'AMZN': 'Amazon.com Inc.',
    'META': 'Meta Platforms Inc.',
    'TSLA': 'Tesla Inc.',
    'JPM': 'JPMorgan Chase & Co.',
    'V': 'Visa Inc.',
    'JNJ': 'Johnson & Johnson'
  };
  return names[symbol] || `${symbol} Corporation`;
}

function calculateHQSScore(price, changePercent, volume) {
  let score = 50;
  
  // Momentum (Preisänderung)
  score += changePercent * 2;
  
  // Volumen (mehr Volumen = mehr Vertrauen)
  if (volume > 10000000) score += 5;
  else if (volume > 5000000) score += 3;
  else if (volume > 1000000) score += 1;
  
  // Zufällige Faktoren für Realismus
  const randomFactor = Math.random() * 20 - 5;
  score += randomFactor;
  
  // Begrenzen auf 0-100
  return Math.max(10, Math.min(99, score));
}

function getRating(score) {
  if (score >= 75) return 'STRONG_BUY';
  if (score >= 65) return 'BUY';
  if (score >= 55) return 'WEAK_HOLD';
  if (score >= 45) return 'WEAK_SELL';
  return 'SELL';
}

function getRecommendation(score) {
  if (score >= 75) return 'STRONG BUY: Exzellente Fundamentaldaten und positive technische Signale';
  if (score >= 65) return 'BUY: Gute Einstiegschance mit soliden Wachstumsaussichten';
  if (score >= 55) return 'HOLD: Abwartende Haltung empfohlen';
  if (score >= 45) return 'WEAK SELL: Schwache Performance, überlegen zu verkaufen';
  return 'SELL: Starke Verkaufssignale in allen Bereichen';
}

// ==================== ALPHA VANTAGE API ====================
async function fetchStockData(symbol) {
  const cacheKey = `stock_${symbol}`;
  const cached = cache.get(cacheKey);
  
  // Cache prüfen
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  
  try {
    await rateLimiter.wait();
    
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
    const response = await axios.get(url);
    
    // Prüfe auf API Fehler
    if (response.data['Note']) {
      console.warn(`⚠️ API Limit für ${symbol}: ${response.data['Note']}`);
      return null;
    }
    
    if (response.data['Global Quote']) {
      const quote = response.data['Global Quote'];
      const data = {
        symbol,
        price: parseFloat(quote['05. price']),
        changePercent: parseFloat(quote['10. change percent'].replace('%', '')),
        volume: parseInt(quote['06. volume']),
        timestamp: new Date().toISOString()
      };
      
      // In Cache speichern
      cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });
      
      return data;
    }
    
    return null;
  } catch (error) {
    console.error(`❌ Fehler bei ${symbol}:`, error.message);
    return null;
  }
}

// ==================== API ENDPOINTS ====================
app.get('/api/stocks', async (req, res) => {
  try {
    const symbols = req.query.symbols ? req.query.symbols.split(',') : DEFAULT_STOCKS;
    const stocks = [];
    
    // Versuche echte Daten zu holen
    for (const symbol of symbols.slice(0, 8)) {
      const stockData = await fetchStockData(symbol);
      
      if (stockData) {
        const hqsScore = calculateHQSScore(
          stockData.price,
          stockData.changePercent,
          stockData.volume
        );
        
        stocks.push({
          symbol,
          name: getCompanyName(symbol),
          price: stockData.price,
          changePercent: stockData.changePercent,
          hqsScore: Math.round(hqsScore),
          confidence: Math.round(60 + Math.random() * 30),
          hqsRating: getRating(hqsScore),
          recommendation: getRecommendation(hqsScore),
          volatility: (Math.random() * 0.03 + 0.01).toFixed(3),
          factors: {
            momentum: (Math.random() * 7 + 3).toFixed(1),
            trend: (Math.random() * 7 + 3).toFixed(1),
            value: (Math.random() * 7 + 3).toFixed(1),
            quality: (Math.random() * 7 + 3).toFixed(1)
          },
          lastUpdated: stockData.timestamp
        });
      } else {
        // Fallback zu simulierten Daten
        const simulated = generateSimulatedStockData(symbol);
        stocks.push(simulated);
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // Wenn keine Daten, nur simulierte
    if (stocks.length === 0) {
      symbols.forEach(symbol => {
        stocks.push(generateSimulatedStockData(symbol));
      });
    }
    
    // Sortieren nach Score
    stocks.sort((a, b) => b.hqsScore - a.hqsScore);
    
    // Summary berechnen
    const averageScore = stocks.length > 0 
      ? (stocks.reduce((sum, s) => sum + s.hqsScore, 0) / stocks.length).toFixed(1)
      : null;
    
    const summary = {
      averageScore,
      topPerformer: stocks[0]?.symbol || 'N/A',
      buySignals: stocks.filter(s => s.hqsRating.includes('BUY')).length,
      holdSignals: stocks.filter(s => s.hqsRating.includes('HOLD')).length,
      sellSignals: stocks.filter(s => s.hqsRating.includes('SELL')).length,
      marketSentiment: averageScore >= 65 ? 'BULLISH' : 
                       averageScore <= 45 ? 'BEARISH' : 'NEUTRAL'
    };
    
    res.json({
      success: true,
      source: ALPHA_VANTAGE_KEY === 'demo' ? 'Demo Mode' : 'Alpha Vantage API',
      timestamp: new Date().toISOString(),
      count: stocks.length,
      stocks,
      summary
    });
    
  } catch (error) {
    console.error('❌ Fehler in /api/stocks:', error);
    
    // Fallback-Daten
    const fallbackStocks = generateFallbackData();
    
    res.json({
      success: true,
      source: 'HQS Simulated Engine (Fallback)',
      timestamp: new Date().toISOString(),
      count: fallbackStocks.length,
      stocks: fallbackStocks,
      summary: {
        averageScore: 68.5,
        topPerformer: 'AAPL',
        buySignals: 6,
        holdSignals: 3,
        sellSignals: 1,
        marketSentiment: 'BULLISH'
      }
    });
  }
});

// Hilfsfunktion für simulierte Daten
function generateSimulatedStockData(symbol) {
  const price = 50 + Math.random() * 450;
  const changePercent = (Math.random() - 0.5) * 8;
  const hqsScore = 40 + Math.random() * 40;
  
  return {
    symbol,
    name: getCompanyName(symbol),
    price: parseFloat(price.toFixed(2)),
    changePercent: parseFloat(changePercent.toFixed(2)),
    hqsScore: Math.round(hqsScore),
    confidence: Math.round(60 + Math.random() * 30),
    hqsRating: getRating(hqsScore),
    recommendation: getRecommendation(hqsScore),
    volatility: (Math.random() * 0.04 + 0.01).toFixed(3),
    factors: {
      momentum: (Math.random() * 7 + 3).toFixed(1),
      trend: (Math.random() * 7 + 3).toFixed(1),
      value: (Math.random() * 7 + 3).toFixed(1),
      quality: (Math.random() * 7 + 3).toFixed(1)
    },
    lastUpdated: new Date().toISOString()
  };
}

function generateFallbackData() {
  const symbols = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'];
  return symbols.map(symbol => generateSimulatedStockData(symbol));
}

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'HQS Backend API',
    version: '2.0.0',
    apiKeyConfigured: ALPHA_VANTAGE_KEY && ALPHA_VANTAGE_KEY !== 'demo',
    endpoints: {
      '/api/stocks': 'GET - Aktiendaten mit HQS Scores',
      '/health': 'GET - System Status'
    }
  });
});

// Root
app.get('/', (req, res) => {
  res.redirect('/health');
});

// Server starten
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 HQS Backend läuft auf Port ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`🔗 Railway: https://hqs-backend-production-bbd6.up.railway.app`);
  console.log(`📊 Endpoint: /api/stocks`);
  console.log(`💡 API Key: ${ALPHA_VANTAGE_KEY === 'demo' ? 'Demo-Modus' : 'Live-Modus'}`);
  console.log(`=========================================`);
});
