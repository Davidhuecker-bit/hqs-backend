const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

console.log('🚀 HQS Backend Starting...');

app.get('/', (req, res) => {
  res.json({
    service: 'hqs-backend',
    status: 'online',
    stage: 4,
    timestamp: new Date().toISOString(),
    message: 'Backend is running with mock data'
  });
});

app.get('/stage4', (req, res) => {
  console.log('📈 Stage4 endpoint called');
  
  // Realistische Mock-Daten
  const mockStocks = [
    {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      price: 182.63,
      change: 0.52,
      changePercent: 0.28,
      volume: '50.3M',
      marketCap: '2.85T',
      lastUpdated: new Date().toISOString()
    },
    {
      symbol: 'GOOGL',
      name: 'Alphabet Inc.',
      price: 140.25,
      change: 0.31,
      changePercent: 0.22,
      volume: '30.1M',
      marketCap: '1.75T',
      lastUpdated: new Date().toISOString()
    },
    {
      symbol: 'MSFT',
      name: 'Microsoft Corporation',
      price: 404.87,
      change: -0.21,
      changePercent: -0.05,
      volume: '25.8M',
      marketCap: '3.00T',
      lastUpdated: new Date().toISOString()
    }
  ];
  
  res.json({
    success: true,
    message: 'Real market data (mock - yahoo-finance2 v2 deprecated)',
    timestamp: new Date().toISOString(),
    stocks: mockStocks,
    metadata: {
      totalStocks: mockStocks.length,
      currency: 'USD',
      dataSource: 'mock',
      note: 'Yahoo Finance API v2 is deprecated. Consider upgrading to v3 or using alternative API.'
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/`);
  console.log(`✅ Stage4: http://localhost:${PORT}/stage4`);
});
