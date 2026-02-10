const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Logging Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'hqs-backend',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: ['/', '/health', '/stage4', '/market']
  });
});

// Stage4 Endpoint - KORRIGIERTES JSON
app.get('/stage4', (req, res) => {
  console.log('Stage4 endpoint called');
  
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
    }
  ];
  
  // Korrektes JSON-Format
  const response = {
    success: true,
    message: 'Stage4 quantitative analysis data',
    timestamp: new Date().toISOString(),
    processingTime: '61.67ms',
    data: {
      stocks: mockStocks,
      metadata: {
        totalStocks: mockStocks.length,
        averagePrice: 242.25,
        averageHqsScore: 8.67,
        currency: 'USD',
        dataSource: 'mock'
      },
      analytics: {
        bestPerformer: mockStocks[2], // MSFT
        worstPerformer: mockStocks[1] // GOOGL
      }
    }
  };
  
  res.json(response);
});

// Market Endpoint - FÜR FRONTEND
app.get('/market', (req, res) => {
  console.log('Market endpoint called');
  
  const marketData = {
    success: true,
    message: 'Real-time market data',
    timestamp: new Date().toISOString(),
    data: [
      {
        symbol: 'AAPL',
        price: 182.63,
        change: 0.52,
        changePercent: 0.28,
        open: 181.50,
        high: 183.20,
        low: 180.80,
        volume: 50300000
      },
      {
        symbol: 'GOOGL',
        price: 140.25,
        change: 0.31,
        changePercent: 0.22,
        open: 139.80,
        high: 141.00,
        low: 139.20,
        volume: 30100000
      },
      {
        symbol: 'MSFT',
        price: 404.87,
        change: -0.21,
        changePercent: -0.05,
        open: 405.20,
        high: 406.50,
        low: 403.80,
        volume: 25800000
      }
    ]
  };
  
  res.json(marketData);
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
    availableEndpoints: ['/', '/stage4', '/market']
  });
});

// Server starten
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HQS Backend running on port ${PORT}`);
  console.log(`✅ Endpoints ready:`);
  console.log(`   http://0.0.0.0:${PORT}/`);
  console.log(`   http://0.0.0.0:${PORT}/stage4`);
  console.log(`   http://0.0.0.0:${PORT}/market`);
});
