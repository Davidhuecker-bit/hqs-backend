# Verifizierte Backend-Endpunkte für Admin-Dashboard

**Erstellt:** 2026-03-17  
**Zweck:** Exakte Verifizierung aller sofort nutzbaren Backend-Komponenten

---

## AUFGABE 1: LIVE-NUTZBARE ENDPUNKTE – VOLLSTÄNDIGE PRÜFUNG

### ✅ VERIFIZIERT LIVE NUTZBAR

---

### 1. GET /api/admin/agent-wisdom
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/agent-wisdom?windowDays=30` |
| **Service** | `agentForecast.repository.js → getAgentWisdomScores()` |
| **Input** | Query: `windowDays` (1-365, default 30) |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "scores": [
    { "agentName": "GROWTH_BIAS", "accuracy": 65, "correct": 13, "total": 20 },
    { "agentName": "RISK_SKEPTIC", "accuracy": 70, "correct": 14, "total": 20 },
    { "agentName": "MACRO_JUDGE", "accuracy": 55, "correct": 11, "total": 20 }
  ],
  "consensus": true,
  "bestAgent": "RISK_SKEPTIC",
  "windowDays": 30,
  "generatedAt": "2026-03-17T21:00:00.000Z"
}
```

**Admin-wertvolle Felder:**
- `scores[].accuracy` – Genauigkeit pro Agent (%)
- `scores[].correct/total` – Trefferquote
- `bestAgent` – Bester Agent aktuell
- `consensus` – Haben ≥2 Agenten ≥60% Accuracy?

---

### 2. GET /api/admin/agent-weights
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/agent-weights` |
| **Service** | `causalMemory.repository.js → getAgentWeights()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "weights": {
    "GROWTH_BIAS": 0.38,
    "RISK_SKEPTIC": 0.34,
    "MACRO_JUDGE": 0.28
  },
  "generatedAt": "2026-03-17T21:00:00.000Z"
}
```

**Admin-wertvolle Felder:**
- `weights.GROWTH_BIAS` – Optimist-Gewicht (0.10-0.60)
- `weights.RISK_SKEPTIC` – Skeptiker-Gewicht
- `weights.MACRO_JUDGE` – Richter-Gewicht

---

### 3. GET /api/admin/near-misses
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/near-misses?limit=25&evaluatedOnly=false` |
| **Service** | `autonomyAudit.repository.js → getNearMisses()` |
| **Input** | Query: `limit` (1-100), `evaluatedOnly` (boolean) |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "nearMisses": [
    {
      "id": 1,
      "symbol": "TSLA",
      "market_cluster": "Volatile",
      "robustness_score": 0.28,
      "saved_capital": 450.00,
      "suppression_reason": "Risiko-Skeptiker: niedrige Robustheit",
      "created_at": "2026-03-17T10:00:00.000Z"
    }
  ],
  "count": 1,
  "totalSavedCapital": 450.00,
  "unit": "EUR (virtuell)"
}
```

**Admin-wertvolle Felder:**
- `totalSavedCapital` – Gesamter Kapitalschutz
- `nearMisses[].symbol` – Geblockte Aktie
- `nearMisses[].suppression_reason` – Blockierungsgrund
- `nearMisses[].saved_capital` – Geschätzter Schutz

---

### 4. GET /api/admin/world-state
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/world-state?refresh=false` |
| **Service** | `worldState.service.js → getWorldState()` |
| **Input** | Query: `refresh` (true = force rebuild) |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "worldState": {
    "version": 2,
    "regime": {
      "cluster": "Safe",
      "avgHqs": 62,
      "bearRatio": 0.18,
      "highVolRatio": 0.15
    },
    "risk_mode": "risk_on",
    "volatility_state": "low",
    "uncertainty": 0.22,
    "cross_asset_state": {
      "btc": { "signal": "bullish", "change24h": 2.5 },
      "gold": { "signal": "neutral", "change24h": 0.1 },
      "earlyWarning": false
    },
    "sector_alerts": [],
    "source_summary": "Regime: Safe | Risk-Mode: risk_on",
    "created_at": "2026-03-17T21:00:00.000Z"
  }
}
```

**Admin-wertvolle Felder:**
- `regime.cluster` – Safe/Volatile/Danger
- `risk_mode` – risk_on/neutral/risk_off
- `uncertainty` – Unsicherheitsfaktor (0-1)
- `cross_asset_state.earlyWarning` – BTC+Gold Warning

---

### 5. GET /api/admin/system-intelligence
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/system-intelligence` |
| **Service** | `systemIntelligence.service.js → getSystemIntelligenceReport()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "sis": 58,
  "maturity": { "key": "operational", "label": "Operativ", "color": "#10b981" },
  "layers": [
    { "id": "prediction", "label": "Prognose-Qualität", "score": 18, "max": 25, "status": "healthy" },
    { "id": "protection", "label": "Kapitalschutz", "score": 12, "max": 20, "status": "degraded" },
    { "id": "twin", "label": "Portfolio-Twin", "score": 10, "max": 20, "status": "healthy" },
    { "id": "learning", "label": "Adaptive Learning", "score": 8, "max": 15, "status": "degraded" },
    { "id": "innovation", "label": "Innovation", "score": 6, "max": 10, "status": "healthy" },
    { "id": "pattern", "label": "Pattern-Memory", "score": 4, "max": 10, "status": "inactive" }
  ],
  "generatedAt": "2026-03-17T21:00:00.000Z"
}
```

**Admin-wertvolle Felder:**
- `sis` – System Intelligence Score (0-100)
- `maturity.label` – "Elite"/"Fortgeschritten"/"Operativ"/"Aufbau"
- `layers[].score/max` – Score pro Intelligenz-Layer
- `layers[].status` – healthy/degraded/inactive

---

### 6. GET /api/admin/operational-status
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/operational-status` |
| **Service** | `sisReleaseControl.service.js → getOperationalReleaseStatus()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "operationalRelease": {
    "recommendedMode": "controlled",
    "allowAutoPositionOpen": { "granted": true, "reason": "SIS 58 ≥ 40" },
    "allowBroaderDiscovery": { "granted": true, "reason": "SIS 58 ≥ 50" },
    "allowAggressiveWeights": { "granted": false, "reason": "SIS 58 < 65" },
    "allowScaleTo450": { "granted": true, "reason": "SIS 58 ≥ 55" },
    "allowScaleTo600": { "granted": false, "reason": "SIS 58 < 70" },
    "allowChinaExpansion": { "granted": false, "reason": "SIS 58 < 60" },
    "allowEuropeExpansion": { "granted": true, "reason": "SIS 58 ≥ 55" },
    "grantedCount": 4,
    "blockerCount": 3
  },
  "controlStatus": "controlled",
  "biggestBlockers": ["allowAggressiveWeights", "allowScaleTo600", "allowChinaExpansion"],
  "nextStep": "SIS auf 65 erhöhen für aggressive Gewichtung",
  "riskMode": "risk_on"
}
```

**Admin-wertvolle Felder:**
- `recommendedMode` – conservative/controlled/expansion-ready
- `allowAutoPositionOpen.granted` – Darf System automatisch kaufen?
- `grantedCount/blockerCount` – Freigegebene vs. blockierte Gates
- `biggestBlockers` – Aktuell blockierte Features

---

### 7. GET /api/admin/interface-state
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/interface-state` |
| **Service** | `interfaceState.service.js → getInterfaceState()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "surfaceMode": "calm",
  "dominantTopic": "pattern_memory",
  "headline": "System läuft stabil",
  "executiveNarrative": "Das System ist operativ. Pattern-Memory zeigt noch wenige verifizierte Outcomes.",
  "primaryAction": "Mehr Outcome-Tracking-Einträge sammeln",
  "secondaryActions": ["Tech-Radar prüfen", "Agent-Wisdom checken"],
  "uiPriorityPanels": ["sis", "worldState", "portfolioTwin"],
  "deepDiveLevelRecommendation": 2,
  "agentDiscourse": [
    { "agent": "System", "message": "SIS bei 58 – operativ stabil", "type": "info" },
    { "agent": "Guardian", "message": "Pattern-Memory benötigt mehr Daten", "type": "warning" }
  ]
}
```

**Admin-wertvolle Felder:**
- `surfaceMode` – calm/warning/debate/blocked/expansion_ready
- `headline` – Einzeilige deutsche Überschrift
- `executiveNarrative` – 2-4 Sätze Zusammenfassung
- `agentDiscourse[]` – Max 5 Agent-Statements

---

### 8. GET /api/admin/portfolio-twin
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/portfolio-twin?limit=50` |
| **Service** | `portfolioTwin.service.js → getPortfolioTwinSnapshot()` |
| **Input** | Query: `limit` (1-200) |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "portfolioTwin": {
    "totalAllocatedEur": 8500.00,
    "unrealizedPnlEur": 320.50,
    "realizedPnlEur": 150.00,
    "deployedCapitalEur": 8500.00,
    "deployedCapitalPct": 85.0,
    "openCount": 7,
    "closedCount": 3,
    "winRate": 0.67,
    "hitRate": 67,
    "avgGainEur": 180.00,
    "avgGainPct": 4.2,
    "avgLossEur": -120.00,
    "avgLossPct": -2.8,
    "twinMaturity": "emerging",
    "openPositions": [...],
    "closedPositions": [...]
  }
}
```

**Admin-wertvolle Felder:**
- `winRate` – Gewinnquote (0-1)
- `hitRate` – Trefferquote (%)
- `avgGainPct/avgLossPct` – Durchschnittliche Gewinne/Verluste
- `twinMaturity` – seed/emerging/developing/mature/established
- `unrealizedPnlEur` – Unrealisierter Gewinn/Verlust

---

### 9. GET /api/admin/virtual-positions
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/virtual-positions?status=open&limit=50&offset=0` |
| **Service** | `portfolioTwin.service.js → listVirtualPositions()` |
| **Input** | Query: `status` (open/closed), `limit`, `offset` |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "count": 7,
  "filters": { "status": "open", "limit": 50, "offset": 0 },
  "positions": [
    {
      "id": 1,
      "symbol": "AAPL",
      "status": "open",
      "entry_price": 175.50,
      "current_price": 182.30,
      "currency": "EUR",
      "allocated_eur": 1200.00,
      "allocated_pct": 12.0,
      "conviction_tier": "strong",
      "risk_mode_at_entry": "risk_on",
      "pnl_eur": 46.20,
      "pnl_pct": 3.85,
      "opened_at": "2026-03-15T10:00:00.000Z"
    }
  ]
}
```

**Admin-wertvolle Felder:**
- `positions[].pnl_eur/pnl_pct` – Gewinn/Verlust pro Position
- `positions[].conviction_tier` – elite/high/strong/watchlist/low
- `positions[].entry_price/current_price` – Einstieg vs. Aktuell

---

### 10. GET /api/admin/saved-capital
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/saved-capital` |
| **Service** | `autonomyAudit.repository.js → getNearMisses() + evaluateSavedCapital()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "totalSavedCapital": 12450.00,
  "blockedSignalsCount": 42,
  "recentBlocked": [
    { "symbol": "GME", "savedCapital": 850.00, "marketCluster": "Danger", "robustness": 0.22 }
  ],
  "generatedAt": "2026-03-17T21:00:00.000Z"
}
```

**Admin-wertvolle Felder:**
- `totalSavedCapital` – Gesamtes "geschütztes" Kapital (EUR)
- `blockedSignalsCount` – Anzahl blockierte Signale
- `recentBlocked[]` – Letzte 10 Blockierungen

---

### 11. GET /api/admin/demo-portfolio
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/demo-portfolio` |
| **Service** | `adminDemoPortfolio.service.js → getAdminDemoPortfolio()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "portfolioId": "DEMO_ADMIN_20",
  "portfolioName": "Internes Admin-Prüfportfolio",
  "symbolCount": 20,
  "dataStatus": "green",
  "holdings": [
    {
      "symbol": "AAPL",
      "price": 182.30,
      "currency": "EUR",
      "changePercent": 1.25,
      "hqsScore": 72,
      "overallStatus": "green",
      "snapshotOk": true,
      "scoreOk": true,
      "metricsOk": true,
      "newsOk": true,
      "completenessScore": 100,
      "reliabilityScore": 95
    }
  ],
  "summary": {
    "total": 20,
    "green": 15,
    "yellow": 4,
    "red": 1,
    "topBottleneck": "news",
    "avgCompletenessScore": 92,
    "avgReliabilityScore": 88
  }
}
```

**Admin-wertvolle Felder:**
- `dataStatus` – green/yellow/red (Gesamtstatus)
- `holdings[].hqsScore` – HQS-Score pro Symbol
- `holdings[].overallStatus` – Datenstatus pro Symbol
- `summary.green/yellow/red` – Verteilung nach Status

---

### 12. GET /api/admin/dynamic-weights
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/dynamic-weights` |
| **Service** | `causalMemory.repository.js → getAllDynamicWeights()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "weights": [
    { "agent_name": "GROWTH_BIAS", "weight": 0.38, "sample_size": 45, "last_updated": "..." },
    { "agent_name": "RISK_SKEPTIC", "weight": 0.34, "sample_size": 45, "last_updated": "..." },
    { "agent_name": "MACRO_JUDGE", "weight": 0.28, "sample_size": 45, "last_updated": "..." },
    { "agent_name": "FACTOR_MOMENTUM", "weight": 0.35, "sample_size": 0, "last_updated": "..." },
    { "agent_name": "FACTOR_QUALITY", "weight": 0.35, "sample_size": 0, "last_updated": "..." }
  ],
  "count": 7
}
```

**Admin-wertvolle Felder:**
- Agent-Gewichte UND Faktor-Gewichte in einer Tabelle
- `sample_size` – Wie viele Samples wurden evaluiert?

---

### 13. GET /api/admin/sis-trend-summary
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/sis-trend-summary` |
| **Service** | `sisHistory.service.js → getSisTrendSummary()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "current": 58,
  "delta24h": 2,
  "delta7d": 5,
  "delta30d": 12,
  "direction": "up",
  "directionLabel": "↑ Aufwärtstrend",
  "topDeclineLayer": null,
  "topGainLayer": "prediction",
  "snapshotCount": 45,
  "lastUpdated": "2026-03-17T21:00:00.000Z"
}
```

**Admin-wertvolle Felder:**
- `delta24h/7d/30d` – SIS-Änderungen über Zeit
- `direction` – up/down/stable
- `topGainLayer/topDeclineLayer` – Größte Verbesserung/Verschlechterung

---

### 14. GET /api/admin/allocation-preview
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/allocation-preview?budget=10000` |
| **Service** | `capitalAllocation.service.js → applyCapitalAllocation()` |
| **Input** | Query: `budget`, `maxPositions`, `maxSectorPct` |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "worldState": { "riskMode": "risk_on", "uncertainty": 0.22 },
  "budgetSummary": {
    "totalBudgetEur": 10000,
    "totalAllocatedEur": 8200,
    "totalAllocatedPct": 82,
    "remainingEur": 1800,
    "approvedCount": 8,
    "rejectedCount": 4
  },
  "approvedPositions": [
    {
      "symbol": "AAPL",
      "allocatedEur": 1200,
      "allocatedPct": 12,
      "convictionTier": "strong",
      "allocationApproved": true
    }
  ],
  "rejectedCandidates": [...]
}
```

**Admin-wertvolle Felder:**
- `budgetSummary` – Gesamtbudget-Verteilung
- `approvedPositions[].convictionTier` – Überzeugungsstufe
- `approvedPositions[].allocatedEur/Pct` – Zugewiesenes Kapital

---

### 15. GET /api/admin/portfolio-twin/stage4
| Eigenschaft | Wert |
|-------------|------|
| **Route** | `GET /api/admin/portfolio-twin/stage4` |
| **Service** | `portfolioTwin.service.js → getStage4Analysis()` |
| **Input** | Keine |
| **Status** | ✅ **LIVE** |

**Output-Felder:**
```json
{
  "success": true,
  "stage4": {
    "currentDrawdownPct": 3.2,
    "maxDrawdownPct": 8.5,
    "concentrationFlags": {
      "sectorConcentration": false,
      "singleStockDominance": false,
      "correlatedCluster": false,
      "regimeExposure": true,
      "volatilityMismatch": false
    },
    "activeFlags": ["regimeExposure"],
    "correlationApprox": { "score": 35, "warnings": [] },
    "counterfactual": {
      "trimTopPosition": { "newDrawdown": 2.8, "reduction": 0.4 },
      "capSectorAt20": { "newDrawdown": 2.5, "reduction": 0.7 }
    }
  }
}
```

**Admin-wertvolle Felder:**
- `currentDrawdownPct` – Aktueller Drawdown
- `concentrationFlags` – 5 Risiko-Heuristiken
- `counterfactual` – "Was wäre wenn" Szenarien

---

## AUFGABE 2: EXAKTE FELDLISTEN PRO WIDGET-KATEGORIE

---

### A) FELDER FÜR SIGNAL-ANSICHT

| Feldname | Quelle | Bedeutung | Direkt darstellbar | Aggregation nötig |
|----------|--------|-----------|-------------------|-------------------|
| `hqsScore` | demo-portfolio → holdings[].hqsScore | Score 0-100 | ✅ Ja | ❌ Nein |
| `rating` | hqsEngine (NICHT exponiert!) | Strong Buy/Buy/Hold/Risk | ⚠️ Muss Frontend berechnen | Mapping: ≥85/70/50/<50 |
| `decision` | hqsEngine (NICHT exponiert!) | KAUFEN/HALTEN/NICHT KAUFEN | ⚠️ Muss Frontend berechnen | Mapping: ≥70/50/<50 |
| `convictionTier` | virtual-positions, allocation-preview | elite/high/strong/watchlist/low | ✅ Ja | ❌ Nein |
| `regime.cluster` | world-state | Safe/Volatile/Danger | ✅ Ja | ❌ Nein |
| `signalDirection` | opportunityScanner (NICHT exponiert!) | bullish/bearish/neutral | ⚠️ Nicht direkt | Nur intern |

**Fazit Signal-Ansicht:**
- `hqsScore` + `convictionTier` sind direkt verfügbar
- `rating` und `decision` müssen im Frontend aus hqsScore abgeleitet werden
- Schwellenwerte: ≥85 Strong Buy, ≥70 Buy, ≥50 Hold, <50 Risk

---

### B) FELDER FÜR AGENTEN-ANSICHT

| Feldname | Quelle | Bedeutung | Direkt darstellbar | Aggregation nötig |
|----------|--------|-----------|-------------------|-------------------|
| `scores[].agentName` | agent-wisdom | GROWTH_BIAS/RISK_SKEPTIC/MACRO_JUDGE | ✅ Ja | ❌ Nein |
| `scores[].accuracy` | agent-wisdom | Genauigkeit in % | ✅ Ja | ❌ Nein |
| `scores[].correct/total` | agent-wisdom | Treffer/Versuche | ✅ Ja | ❌ Nein |
| `bestAgent` | agent-wisdom | Aktuell bester Agent | ✅ Ja | ❌ Nein |
| `consensus` | agent-wisdom | ≥2 Agents ≥60%? | ✅ Ja | ❌ Nein |
| `weights.GROWTH_BIAS` | agent-weights | Aktuelles Gewicht (0.10-0.60) | ✅ Ja | ❌ Nein |
| `weights.RISK_SKEPTIC` | agent-weights | Aktuelles Gewicht | ✅ Ja | ❌ Nein |
| `weights.MACRO_JUDGE` | agent-weights | Aktuelles Gewicht | ✅ Ja | ❌ Nein |
| `agentDiscourse[]` | interface-state | Agent-Statements für UI | ✅ Ja | ❌ Nein |
| `debateSummary` | agenticDebate (NICHT exponiert!) | Vollständige Debatte | ⚠️ Nicht direkt | Nur intern |

**Fazit Agenten-Ansicht:**
- Agent-Wisdom und Agent-Weights sind vollständig exponiert
- `debateSummary` ist nur intern im opportunityScanner nutzbar
- Für Debate-Viewer müsste ein neuer Endpoint erstellt werden

---

### C) FELDER FÜR OUTCOME-/LERN-ANSICHT

| Feldname | Quelle | Bedeutung | Direkt darstellbar | Aggregation nötig |
|----------|--------|-----------|-------------------|-------------------|
| `winRate` | portfolio-twin | Gewinnquote 0-1 | ✅ Ja | ❌ Nein |
| `hitRate` | portfolio-twin | Trefferquote % | ✅ Ja | ❌ Nein |
| `avgGainPct` | portfolio-twin | Ø Gewinn % | ✅ Ja | ❌ Nein |
| `avgLossPct` | portfolio-twin | Ø Verlust % | ✅ Ja | ❌ Nein |
| `twinMaturity` | portfolio-twin | seed/emerging/.../established | ✅ Ja | ❌ Nein |
| `layers[].score` | system-intelligence | Score pro SIS-Layer | ✅ Ja | ❌ Nein |
| `layers[].status` | system-intelligence | healthy/degraded/inactive | ✅ Ja | ❌ Nein |
| `delta24h/7d/30d` | sis-trend-summary | SIS-Änderungen | ✅ Ja | ❌ Nein |
| `totalSavedCapital` | saved-capital | Geschütztes Kapital | ✅ Ja | ❌ Nein |
| `blockedSignalsCount` | saved-capital | Anzahl Blockierungen | ✅ Ja | ❌ Nein |

**Fazit Outcome-/Lern-Ansicht:**
- Portfolio-Twin-Metriken vollständig exponiert
- SIS-Trend vollständig exponiert
- Saved Capital vollständig exponiert

---

### D) FELDER FÜR TIMING-/BEWEIS-ANSICHT

| Feldname | Quelle | Bedeutung | Direkt darstellbar | Aggregation nötig |
|----------|--------|-----------|-------------------|-------------------|
| `positions[].opened_at` | virtual-positions | Einstiegszeitpunkt | ✅ Ja | ❌ Nein |
| `positions[].closed_at` | virtual-positions | Ausstiegszeitpunkt | ✅ Ja | ❌ Nein |
| `positions[].pnl_eur` | virtual-positions | Gewinn/Verlust € | ✅ Ja | ❌ Nein |
| `positions[].pnl_pct` | virtual-positions | Gewinn/Verlust % | ✅ Ja | ❌ Nein |
| `nearMisses[].created_at` | near-misses | Blockierungszeitpunkt | ✅ Ja | ❌ Nein |
| `nearMisses[].saved_capital` | near-misses | Geschätzter Schutz | ✅ Ja | ❌ Nein |
| `return_7d` | discovery_history (NICHT exponiert!) | 7-Tage-Return | ⚠️ Kein Endpoint | Neuer Endpoint nötig |
| `return_30d` | discovery_history (NICHT exponiert!) | 30-Tage-Return | ⚠️ Kein Endpoint | Neuer Endpoint nötig |
| `hitRate24h` | outcomeTracking.getPatternStats (NICHT exponiert!) | 24h-Trefferquote | ⚠️ Kein Endpoint | Neuer Endpoint nötig |

**Fazit Timing-/Beweis-Ansicht:**
- Virtual Positions haben Timestamps
- Discovery-Learning 7d/30d-Returns sind NICHT exponiert
- Pattern-Memory-Stats sind NICHT exponiert

---

## AUFGABE 3: SOFORT NUTZBARE ADMIN-WIDGETS

---

### A) SOFORT NUTZBARE SIGNAL-WIDGETS

| Widget | Endpoint | Daten |
|--------|----------|-------|
| **HQS-Score-Kachel** | `demo-portfolio` | holdings[].hqsScore |
| **Conviction-Badge** | `virtual-positions`, `allocation-preview` | convictionTier |
| **Regime-Ampel** | `world-state` | regime.cluster (Safe/Volatile/Danger) |
| **Risk-Mode-Indikator** | `world-state` | risk_mode (risk_on/neutral/risk_off) |

**Frontend-Arbeit nötig:**
- Mapping hqsScore → rating/decision (Simple Switch-Statement)

---

### B) SOFORT NUTZBARE AGENTEN-WIDGETS

| Widget | Endpoint | Daten |
|--------|----------|-------|
| **Agent-Wisdom-Scoreboard** | `agent-wisdom` | scores[], bestAgent, consensus |
| **Agent-Gewichte-Balken** | `agent-weights` | weights.GROWTH_BIAS/RISK_SKEPTIC/MACRO_JUDGE |
| **Agent-Diskurs-Feed** | `interface-state` | agentDiscourse[] |
| **Dynamische-Gewichte-Tabelle** | `dynamic-weights` | Alle Agent + Factor Weights |

**Kein Backend-Neubau nötig!**

---

### C) SOFORT NUTZBARE OUTCOME-/PROOF-WIDGETS

| Widget | Endpoint | Daten |
|--------|----------|-------|
| **Win-Rate-Gauge** | `portfolio-twin` | winRate, hitRate |
| **PnL-Übersicht** | `portfolio-twin` | unrealizedPnlEur, realizedPnlEur |
| **Twin-Maturity-Badge** | `portfolio-twin` | twinMaturity |
| **SIS-Score-Ring** | `system-intelligence` | sis, maturity |
| **SIS-Layer-Bars** | `system-intelligence` | layers[] |
| **SIS-Trend-Chart** | `sis-trend-summary` | delta24h/7d/30d |
| **Saved-Capital-Counter** | `saved-capital` | totalSavedCapital |
| **Near-Miss-Liste** | `near-misses` | nearMisses[] |
| **Position-Liste** | `virtual-positions` | positions[] |

**Kein Backend-Neubau nötig!**

---

### D) WAS NUR AGGREGATION BRAUCHT (Frontend-Logik)

| Widget | Basis-Endpoint | Aggregation im Frontend |
|--------|----------------|-------------------------|
| **Buy/Hold/Sell-Badge** | demo-portfolio | hqsScore → ≥70 Buy, ≥50 Hold, <50 Sell |
| **Strong-Buy-Counter** | demo-portfolio | Zähle holdings mit hqsScore ≥85 |
| **Agent-Performance-Ranking** | agent-wisdom | Sortiere scores[] nach accuracy |
| **Gate-Fortschritts-Bar** | operational-status | grantedCount / (grantedCount + blockerCount) |

---

### E) WAS WIRKLICH NOCH BACKEND-ARBEIT BRAUCHT

| Widget | Fehlender Endpoint | Aufwand |
|--------|-------------------|---------|
| **Discovery-Stats** | GET /api/admin/discovery-stats | 🟡 2-3h |
| **Pattern-Memory-Stats** | GET /api/admin/pattern-stats | 🟡 2-3h |
| **Debate-Details** | GET /api/admin/debate/:symbol | 🟡 3-4h |
| **Outcome-History** | GET /api/admin/outcome-history | 🟡 2-3h |
| **Agent-Evolution-Timeline** | Neuer Service | 🔴 8h+ |

---

## AUFGABE 4: WAHRHEITSCHECK

---

### Bestandsaufnahme-Aussage vs. Realität

| Behauptung | Wahrheit | Korrektur |
|------------|----------|-----------|
| "Agent Wisdom Scores über Endpoint exponiert" | ✅ **KORREKT** | Endpoint existiert |
| "Near Misses über Endpoint exponiert" | ✅ **KORREKT** | Endpoint existiert |
| "debateSummary als Admin-Endpoint verfügbar" | ❌ **FALSCH** | Nur intern in opportunityScanner |
| "Pattern Memory Stats über Endpoint" | ❌ **FALSCH** | Nur Funktion, kein Endpoint |
| "Discovery Learning Stats exponiert" | ❌ **FALSCH** | Nur Service-Funktion |
| "Buy/Hold/Sell direkt aus Endpoint" | ❌ **FALSCH** | Nur hqsScore exponiert, Mapping im Frontend |
| "Outcome History pro Symbol" | ❌ **FALSCH** | Kein dedizierter Endpoint |

---

### Status-Klassifikation

| Komponente | Status |
|------------|--------|
| agent-wisdom | ✅ **WIRKLICH LIVE** |
| agent-weights | ✅ **WIRKLICH LIVE** |
| dynamic-weights | ✅ **WIRKLICH LIVE** |
| near-misses | ✅ **WIRKLICH LIVE** |
| saved-capital | ✅ **WIRKLICH LIVE** |
| world-state | ✅ **WIRKLICH LIVE** |
| system-intelligence | ✅ **WIRKLICH LIVE** |
| operational-status | ✅ **WIRKLICH LIVE** |
| interface-state | ✅ **WIRKLICH LIVE** |
| portfolio-twin | ✅ **WIRKLICH LIVE** |
| virtual-positions | ✅ **WIRKLICH LIVE** |
| demo-portfolio | ✅ **WIRKLICH LIVE** |
| sis-trend-summary | ✅ **WIRKLICH LIVE** |
| allocation-preview | ✅ **WIRKLICH LIVE** |
| portfolio-twin/stage4 | ✅ **WIRKLICH LIVE** |
| debateSummary/votes | ⚠️ **VORHANDEN ABER UNVERDRAHTET** |
| pattern-stats | ⚠️ **VORHANDEN ABER UNVERDRAHTET** |
| discovery-stats | ⚠️ **VORHANDEN ABER UNVERDRAHTET** |
| outcome-history | ⚠️ **VORHANDEN ABER UNVERDRAHTET** |

---

## ERGEBNIS: PRIORISIERTE EMPFEHLUNG

### Sofort nutzbar (0 Backend-Arbeit):

1. **SIS-Dashboard** – system-intelligence + sis-trend-summary
2. **World-State-Panel** – world-state
3. **Agent-Wisdom-Board** – agent-wisdom + agent-weights
4. **Portfolio-Twin-Übersicht** – portfolio-twin
5. **Near-Miss-Feed** – near-misses + saved-capital
6. **Virtual-Positions-Liste** – virtual-positions
7. **Demo-Portfolio-Grid** – demo-portfolio
8. **Operational-Status-Gates** – operational-status
9. **Interface-State-Banner** – interface-state

### Erster Frontend-only Schritt:

**Widget: HQS-Signal-Dashboard**

```html
<!-- Für jedes Symbol aus demo-portfolio -->
<div class="signal-card">
  <div class="hqs-score">{{ hqsScore }}</div>
  <div class="rating">
    {{ hqsScore >= 85 ? 'Strong Buy' : hqsScore >= 70 ? 'Buy' : hqsScore >= 50 ? 'Hold' : 'Risk' }}
  </div>
  <div class="decision">
    {{ hqsScore >= 70 ? 'KAUFEN' : hqsScore >= 50 ? 'HALTEN' : 'NICHT KAUFEN' }}
  </div>
</div>
```

### Klare Aussage: WAS KANN SOFORT SICHTBAR GEMACHT WERDEN?

**15 Endpoints sind sofort live nutzbar** – davon liefern 12 alle Daten direkt, 3 benötigen minimales Frontend-Mapping.

**Keine Backend-Arbeit nötig** für:
- SIS Score + Layers + Trend
- Agent Wisdom + Weights
- Portfolio Twin + Virtual Positions
- Near Misses + Saved Capital
- World State + Operational Status
- Demo Portfolio
- Interface State

**Nur Rating/Decision-Mapping** (5 Zeilen Frontend-Code):
```js
const rating = hqsScore >= 85 ? 'Strong Buy' : hqsScore >= 70 ? 'Buy' : hqsScore >= 50 ? 'Hold' : 'Risk';
const decision = hqsScore >= 70 ? 'KAUFEN' : hqsScore >= 50 ? 'HALTEN' : 'NICHT KAUFEN';
```
