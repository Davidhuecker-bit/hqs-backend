  const express = require('express');
const cors = require('cors');

// App erstellen
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Debugging Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  next();
});

// Root Endpoint - Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'hqs-backend',
    version: '1.0.0',
    stage: 4,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/',
      stage4: '/stage4',
      docs: 'Coming soon'
    }
  });
});

// Stage4 Endpoint mit realistischen Mock-Daten
app.get('/stage4', (req, res) => {
  try {
    console.log('Stage4 endpoint aufgerufen');
    
    // Simuliere kurze Verarbeitungszeit
    const mockProcessingTime = Math.random() * 100 + 50; // 50-150ms
    
    // Realistische Mock-Daten für HQS Quant System
    const mockStocks = [
      {
        symbol: 'AAPL',
        company: 'Apple Inc.',
        price: 182.63,
        change: 0.52,
        changePercent: 0.28,
        volume: '50.3M',
        marketCap: '2.85T',
        sector: 'Technology',
        hqsScore: 8.7,
        riskLevel: 'low',
        lastUpdated: new Date().toISOString()
      },
      {
        symbol: 'GOOGL',
        company: 'Alphabet Inc.',
        price: 140.25,
        change: 0.31,
        changePercent: 0.22,
        volume: '30.1M',
        marketCap: '1.75T',
        sector: 'Technology',
        hqsScore: 8.2,
        riskLevel: 'medium',
        lastUpdated: new Date().toISOString()
      },
      {
        symbol: 'MSFT',
        company: 'Microsoft Corporation',
        price: 404.87,
        change: -0.21,
        changePercent: -0.05,
        volume: '25.8M',
        marketCap: '3.00T',
        sector: 'Technology',
        hqsScore: 9.1,
        riskLevel: 'low',
        lastUpdated: new Date().toISOString()
      },
      {
        symbol: 'AMZN',
        company: 'Amazon.com Inc.',
        price: 172.35,
        change: 1.25,
        changePercent: 0.73,
        volume: '45.2M',
        marketCap: '1.77T',
        sector: 'Consumer Cyclical',
        hqsScore: 7.8,
        riskLevel: 'medium',
        lastUpdated: new Date().toISOString()
      },
      {
        symbol: 'TSLA',
        company: 'Tesla Inc.',
        price: 185.90,
        change: -2.35,
        changePercent: -1.25,
        volume: '95.7M',
        marketCap: '592B',
        sector: 'Automotive',
        hqsScore: 6.5,
        riskLevel: 'high',
        lastUpdated: new Date().toISOString()
      }
    ];

    // Berechne aggregierte Statistiken
    const totalStocks = mockStocks.length;
    const averagePrice = mockStocks.reduce((sum, stock) => sum + stock.price, 0) / totalStocks;
    const averageScore = mockStocks.reduce((sum, stock) => sum + stock.hqsScore, 0) / totalStocks;
    
    const response = {
      success: true,
      message: 'Stage4 Quant-Daten erfolgreich geladen',
      timestamp: new Date().toISOString(),
      processingTime: `${mockProcessingTime.toFixed(2)}ms`,
      data: {
        stocks: mockStocks,
        metadata: {
          totalStocks: totalStocks,
          averagePrice: parseFloat(averagePrice.toFixed(2)),
          averageHqsScore: parseFloat(averageScore.toFixed(2)),
          currency: 'USD',
          dataSource: 'mock',
          note: 'Yahoo Finance API v2 ist veraltet. Mock-Daten werden verwendet.'
        },
        analytics: {
          bestPerformer: mockStocks.reduce((max, stock) => stock.hqsScore > max.hqsScore ? stock : max),
          worstPerformer: mockStocks.reduce((min, stock) => stock.hqsScore < min.hqsScore ? stock : min),
          riskDistribution: {
            low: mockStocks.filter(s => s.riskLevel === 'low').length,
            medium: mockStocks.filter(s => s.riskLevel === 'medium').length,
            high: mockStocks.filter(s => s.riskLevel === 'high').length
          }
        }
      }
    };

    // Simuliere Netzwerk-Latenz
    setTimeout(() => {
      res.json(response);
    }, mockProcessingTime);
    
  } catch (error) {
    console.error('Kritischer Fehler in /stage4:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: error.message,
      timestamp: new Date().toISOString(),
      fallbackData: {
        stocks: [
          { symbol: 'AAPL', price: 182.63, status: 'fallback' },
          { symbol: 'GOOGL', price: 140.25, status: 'fallback' }
        ]
      }
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Globaler Error Handler
app.use((err, req, res, next) => {
  console.error('Globaler Fehler:', err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// Server starten
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HQS Backend Server gestartet auf Port ${PORT}`);
  console.log(`✅ Health Check: http://localhost:${PORT}/`);
  console.log(`📊 Stage4 Endpoint: http://localhost:${PORT}/stage4`);
  console.log(`⏰ Serverzeit: ${new Date().toISOString()}`);
  console.log(`🌐 NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
});
