{
  "success": true,
  "generatedAt": "2026-03-29T20:00:00.000Z",
  "summary": {
    "totalPositions": 6,
    "readyCount": 4,
    "buildingCount": 1,
    "partialCount": 1,
    "failedCount": 0
  },
  "positions": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "quantity": 10,
      "avgCost": 165.4,
      "currentPrice": 182.1,
      "positionValue": 1821,
      "pnlAbs": 167,
      "pnlPct": 10.1,

      "status": "ready",
      "message": null,

      "score": {
        "hqsScore": 78,
        "rating": "Buy",
        "decision": "HALTEN"
      },

      "context": {
        "portfolioFit": "owned",
        "portfolioContextLabel": "Bereits im Portfolio – Aufstockung prüfen",
        "concentrationRisk": "medium",
        "diversificationBenefit": false
      },

      "news": {
        "summary": {
          "count": 2,
          "topHeadline": "Apple expands AI features",
          "dominantEventType": "product"
        },
        "items": [
          {
            "title": "Apple expands AI features",
            "source": "Reuters",
            "publishedAt": "2026-03-29T12:00:00.000Z",
            "direction": "bullish",
            "relevanceScore": 82
          }
        ]
      }
    },
    {
      "symbol": "XYZ",
      "name": null,
      "quantity": 15,
      "avgCost": 21.3,
      "currentPrice": null,
      "positionValue": null,
      "pnlAbs": null,
      "pnlPct": null,

      "status": "building",
      "message": "Diese Aktie wird gerade aufgebaut.",

      "score": null,
      "context": null,
      "news": {
        "summary": { "count": 0 },
        "items": []
      }
    }
  ]
}
