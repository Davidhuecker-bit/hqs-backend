# Backend-Bestandsaufnahme: Signal-, Agenten- und Outcome-Logik

**Erstellt:** 2026-03-17  
**Repository:** hqs-backend  
**Zweck:** Kartierung aller bestehenden Implementierungen für Buy/Sell/Hold, Agenten/Guardian/Konsens, Timing/Outcome/Learning

---

## A) BEREITS VORHANDENE SIGNAL-LOGIK

### 1. HQS Engine (`hqsEngine.js`)
| Datei | Funktion | Was sie liefert | Nutzbarkeit |
|-------|----------|-----------------|-------------|
| `hqsEngine.js` | `buildHQSResponse()` | **hqsScore (0-100)**, rating, decision | ✅ **LIVE** |
| | | `rating`: "Strong Buy" / "Buy" / "Hold" / "Risk" | Schwellenwerte: ≥85 Strong Buy, ≥70 Buy, ≥50 Hold, <50 Risk |
| | | `decision`: "KAUFEN" / "HALTEN" / "NICHT KAUFEN" | ≥70 KAUFEN, ≥50 HALTEN, <50 NICHT KAUFEN |
| | | `regime`: expansion/bull/neutral/bear/crash | Aus Marktdurchschnitt abgeleitet |
| | | `breakdown`: momentum, quality, stability, relative | Faktor-Scores (0-100) |

**Schwellenwerte bereits definiert:**
- Score ≥ 85 → Strong Buy
- Score ≥ 70 → Buy / KAUFEN
- Score ≥ 50 → Hold / HALTEN
- Score < 50 → Risk / NICHT KAUFEN

### 2. Agentic Debate Service (`services/agenticDebate.service.js`)
| Datei | Funktion | Was sie liefert | Nutzbarkeit |
|-------|----------|-----------------|-------------|
| `agenticDebate.service.js` | `runAgenticDebate()` | **approved (boolean)**, approvalCount, weightedApproval, votes, debateSummary | ✅ **LIVE** |
| | `runGrowthBias()` | Optimist-Agent: vote, forecastDirection, reason | ✅ **LIVE** |
| | `runRiskSkeptic()` | Skeptiker-Agent: vote, forecastDirection, reason | ✅ **LIVE** |
| | `runMacroJudge()` | Richter-Agent: vote, forecastDirection, reason | ✅ **LIVE** |

**Konsens-Regel:** Signal nur freigegeben wenn weightedApproval > 0.5 (≥2 von 3 Agenten zustimmen)

**Definierte Schwellen für GROWTH_BIAS:**
- GROWTH_MIN_MOMENTUM = 0.45
- GROWTH_MIN_OPP_SCORE = 35

**Definierte Schwellen für RISK_SKEPTIC:**
- RISK_MAX_VOLATILITY = 0.70
- RISK_MIN_ROBUSTNESS = 0.35
- RISK_MIN_BUZZ = 25

**Definierte Schwellen für MACRO_JUDGE:**
- MACRO_EARLYWARNING_MIN_CONVICTION = 72
- MACRO_DANGER_MIN_CONVICTION = 75
- MACRO_VOLATILE_MIN_CONVICTION = 58

### 3. Opportunity Scanner (`services/opportunityScanner.service.js`)
| Datei | Funktion | Was sie liefert | Nutzbarkeit |
|-------|----------|-----------------|-------------|
| `opportunityScanner.service.js` | `buildSignalContext()` | signalDirection, signalStrength, signalConfidence, buzzScore, trendScore | ✅ **LIVE** |
| | | `signalDirection`: "bullish" / "bearish" / "neutral" | Aus signalDirectionScore abgeleitet |
| | | `signalStrength` (0-100), `signalConfidence` (0-100) | Kombiniert aus Trend, Sentiment, Buzz |

**Guardian Protocol Schwellen:**
- GUARDIAN_THRESHOLD_SAFE = 0.35
- GUARDIAN_THRESHOLD_VOLATILE = 0.50
- GUARDIAN_THRESHOLD_DANGER = 0.65

### 4. Capital Allocation Service (`services/capitalAllocation.service.js`)
| Datei | Funktion | Was sie liefert | Nutzbarkeit |
|-------|----------|-----------------|-------------|
| `capitalAllocation.service.js` | `calculatePositionSize()` | allocatedPct, allocatedEur, convictionTier | ✅ **LIVE** |
| | `applyCapitalAllocation()` | Vollständige Budget-Allokation mit Sektorlimits | ✅ **LIVE** |
| | `getConvictionTier()` | elite/high/strong/watchlist/low | ✅ **LIVE** |

**Conviction Tiers mit Base-Sizes:**
- elite: 8.0% (conviction ≥ 90)
- high: 6.0% (conviction ≥ 80)
- strong: 4.0% (conviction ≥ 65)
- watchlist: 2.5% (conviction ≥ 50)
- low: 1.5% (conviction < 50)

**Regime Multipliers:**
- risk_on: 1.00
- neutral: 0.75
- risk_off: 0.40

### 5. Regime Detection (`services/regimeDetection.service.js`)
| Datei | Funktion | Was sie liefert | Nutzbarkeit |
|-------|----------|-----------------|-------------|
| `regimeDetection.service.js` | `classifyMarketRegime()` | cluster: "Safe" / "Volatile" / "Danger" | ✅ **LIVE** |
| | | avgHqs, bearRatio, highVolRatio | ✅ **LIVE** |

**Cluster-Schwellen:**
- Safe: avgHqs ≥ 55, bearRatio ≤ 0.25, highVolRatio ≤ 0.20
- Volatile: avgHqs ≥ 38, bearRatio ≤ 0.50, highVolRatio ≤ 0.45
- Danger: alles andere

---

## B) BEREITS VORHANDENE AGENTEN-/GUARDIAN-LOGIK

### 1. Agentenstruktur (vollständig implementiert)
| Agent | Rolle | Datei | Status |
|-------|-------|-------|--------|
| **GROWTH_BIAS** | Momentum-Optimist | `agenticDebate.service.js` | ✅ **LIVE** |
| **RISK_SKEPTIC** | Risiko-Pessimist | `agenticDebate.service.js` | ✅ **LIVE** |
| **MACRO_JUDGE** | Makro-Regime-Richter | `agenticDebate.service.js` | ✅ **LIVE** |

### 2. Guardian Service (`services/guardianService.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `analyzeStockWithGuardian()` | OpenAI-basierte Analyse: Bewertung, Risiko-Level, Begründung, Handlungsempfehlung | ⚠️ **VORBEREITET** (nutzt GPT-4o-mini) |

**Hinweis:** Der Guardian Service ruft direkt OpenAI auf – ein separater AI-Analyse-Pfad neben der regel-basierten agenticDebate.

### 3. Konsens-Logik
| Mechanismus | Datei | Status |
|-------------|-------|--------|
| 2-von-3 Konsens | `agenticDebate.service.js` | ✅ **LIVE** |
| Weighted Approval (mit dynamicWeights) | `agenticDebate.service.js` | ✅ **LIVE** |
| metaRationale (historischer Kontext) | `causalMemory.repository.js` | ✅ **LIVE** |
| patternContext (Muster-Memory) | `outcomeTracking.repository.js` | ✅ **LIVE** |

### 4. Causal Memory (`services/causalMemory.repository.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `getAgentWeights()` | Dynamische Gewichte pro Agent (GROWTH_BIAS, RISK_SKEPTIC, MACRO_JUDGE) | ✅ **LIVE** |
| `adjustAgentWeights()` | Passt Gewichte basierend auf 48h-Forecast-Accuracy an | ✅ **LIVE** |
| `buildMetaRationale()` | Deutscher Satz über vergangene Fehler für dieses Symbol | ✅ **LIVE** |

**Lernparameter:**
- LEARN_STEP = 0.05
- WEIGHT_MIN = 0.10
- WEIGHT_MAX = 0.60
- REVIEW_WINDOW_HOURS = 6

### 5. Agent Forecasts (`services/agentForecast.repository.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `logAgentForecasts()` | Speichert Prognosen aller 3 Agenten mit forecastDirection | ✅ **LIVE** |
| `verifyAgentForecasts()` | Prüft nach 24h ob Prognose korrekt war | ✅ **LIVE** |
| `getAgentWisdomScores()` | Accuracy pro Agent (scores, consensus, bestAgent) | ✅ **LIVE** |

**Tabelle:** `agent_forecasts` mit:
- forecast_dir (bullish/bearish/neutral)
- entry_price, exit_price
- was_correct (boolean)
- verified_at

---

## C) BEREITS VORHANDENE TIMING-/OUTCOME-/LERNLOGIK

### 1. Outcome Tracking (`services/outcomeTracking.repository.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `createOutcomeTrackingEntry()` | Speichert Prognose mit Horizont (1-365 Tage) | ✅ **LIVE** |
| `getDueOutcomePredictions()` | Fällige Prognosen für Evaluation | ✅ **LIVE** |
| `completeOutcomePrediction()` | Markiert als evaluiert mit actualReturn | ✅ **LIVE** |
| `buildStructuredPatternSignature()` | Machine-readable Pattern-Key für Muster-Memory | ✅ **LIVE** |
| `getPatternStats()` | Aggregierte Statistiken pro Pattern | ✅ **LIVE** |
| `verifyPerformance()` | 24h/7d Performance-Fenster füllen | ✅ **LIVE** |

**Pattern-Signature Dimensionen:**
- regime, volatility, trend, sentiment, news, buzz, signal, robustness, hqs, conviction
- Jede Dimension in Bändern (z.B. vol: low|mid|high|extreme)

### 2. Discovery Learning (`services/discoveryLearning.service.js` + `.repository.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `saveDiscovery()` | Speichert Discovery mit Preis | ✅ **LIVE** |
| `evaluateDiscoveries()` | Evaluiert 7d + 30d Returns | ✅ **LIVE** |
| `getPendingDiscoveries7d()` / `30d()` | Pending Evaluations | ✅ **LIVE** |
| `updateDiscoveryResult7d()` / `30d()` | Schreibt return_7d / return_30d | ✅ **LIVE** |

### 3. Forward Learning (`services/forwardLearning.service.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `runForwardLearning()` | Berechnet 1d/3d Forward-Returns für factor_history | ✅ **LIVE** |

### 4. Forecast Verification Job (`jobs/forecastVerification.job.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `runForecastVerificationJob()` | Prüft 24h-Agent-Forecasts + 7d-Outcome-Window | ✅ **LIVE** (täglich scheduled) |

### 5. Learning Engine (`engines/learningEngine.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `evaluateLearning()` | error, confidence, performanceScore, impacts, newWeights | ✅ **LIVE** |

**Performance-Klassifikation:**
- return > 0.20 → score = 1
- return > 0.10 → score = 0.7
- return > 0.03 → score = 0.4
- return > -0.03 → score = 0
- return > -0.10 → score = -0.5
- else → score = -1

### 6. Market Memory Engine (`engines/marketMemoryEngine.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `buildSetupSignature()` | Einzigartiger Key für wiederkehrende Setups | ✅ **LIVE** |
| `calculateSuccessRate()` | Historische Erfolgsquote für Setup | ✅ **LIVE** |
| `evaluateMarketMemory()` | Memory-Updates nach Outcome | ✅ **LIVE** |

### 7. Meta Learning Engine (`engines/metaLearningEngine.js`)
| Funktion | Was sie liefert | Nutzbarkeit |
|----------|-----------------|-------------|
| `buildContextKey()` | Kontext-Schlüssel (regime+riskMode+strategy+narrative) | ✅ **LIVE** |
| `evaluateMetaLearning()` | Engine-Gewichts-Updates pro Kontext | ✅ **LIVE** |

---

## D) BEREITS VORHANDENE TABELLEN FÜR BEWEIS-/LERNSYSTEM

| Tabelle | Zweck | Reifegrad | Späterer Nutzen |
|---------|-------|-----------|-----------------|
| **agent_forecasts** | Agent-Prognosen mit 24h-Verifikation | ✅ **AKTIV** | Agent-Wisdom, Gewichts-Kalibrierung |
| **agents** | Agent-Metadaten + wisdom_score | ✅ **AKTIV** | Agent-Ranking |
| **dynamic_weights** | Adaptive Agenten- und Faktor-Gewichte | ✅ **AKTIV** | Causal Memory, Selbst-Kalibrierung |
| **outcome_tracking** | Prognosen mit Entry/Exit, Pattern-Key, Performance-Windows | ✅ **AKTIV** | Beweis-Audit, Pattern-Memory |
| **discovery_history** | Discovery-Preis-Tracking mit 7d/30d Returns | ✅ **AKTIV** | Discovery-Learning |
| **factor_history** | Score-Snapshots mit forward_return_1d/3d | ✅ **AKTIV** | Forward-Learning |
| **virtual_positions** | Virtuelle Positionen mit PnL | ✅ **AKTIV** | Portfolio-Twin |
| **autonomy_audit** | Immutable Audit-Records aller autonomen Entscheidungen | ✅ **AKTIV** | Compliance, Nachvollziehbarkeit |
| **guardian_near_miss** | Blocked Signals mit saved_capital | ✅ **AKTIV** | Capital Protection Score |
| **tech_radar_entries** | Innovation-Awareness | ✅ **AKTIV** | SIS Innovation Layer |
| **learning_runtime_state** | Persistierte Memory-Stores (market_memory, meta_learning) | ✅ **AKTIV** | Engine-State-Persistence |
| **sis_history** | SIS-Snapshots über Zeit | ✅ **AKTIV** | Trend-Analyse |
| **weight_history** | Gewichts-Historie | ✅ **AKTIV** | Gewichts-Evolution |

---

## E) SCHNELL NUTZBARE ADMIN-BAUSTEINE

### Sofort im Admin sichtbar machbar (ohne Neubau):

| Baustein | Endpoint | Was anzeigbar |
|----------|----------|---------------|
| **Agent Wisdom Scores** | `GET /api/admin/agent-wisdom` | Accuracy pro Agent, Konsens, bester Agent |
| **Agent Weights** | `GET /api/admin/agent-weights` | Aktuelle dynamische Gewichte |
| **Near Misses** | `GET /api/admin/near-misses` | Blocked Signals + saved_capital |
| **SIS Report** | `GET /api/admin/sis-report` | System Intelligence Score (0-100) mit 6 Layern |
| **Operational Status** | `GET /api/admin/operational-status` | Release-Gates (autoOpen, scale450, scale600, etc.) |
| **Interface State** | `GET /api/admin/interface-state` | surfaceMode, dominantTopic, headline, agentDiscourse |
| **World State** | `GET /api/admin/world-state` | regime, riskMode, uncertainty, sectorAlerts |
| **Portfolio Twin** | `GET /api/admin/portfolio-twin/snapshot` | winRate, avgGain/Loss, deployedCapital, twinMaturity |
| **Virtual Positions** | `GET /api/admin/virtual-positions` | Offene/geschlossene Positionen mit PnL |
| **Recommendations** | `GET /api/admin/recommendations` | System-/Trust-/Scaling-Summary |

### Mit wenig Aufwand anschließbar:

| Baustein | Was fehlt | Aufwand |
|----------|-----------|---------|
| **Buy/Hold/Sell Decision Dashboard** | Frontend-Widget für hqsScore → decision Mapping | 🟢 Klein (1-2h) |
| **Agent Debate Viewer** | Frontend-Widget für debateSummary + votes | 🟢 Klein (1-2h) |
| **Conviction Tier Visualisierung** | Frontend-Badge für elite/high/strong/watchlist/low | 🟢 Klein (1h) |
| **Pattern Memory Stats** | Frontend-Widget für patternStats (hitRate24h, hitRate7d) | 🟢 Klein (1-2h) |
| **Outcome History pro Symbol** | GET /api/admin/outcome-history/:symbol Endpoint | 🟡 Mittel (2-4h) |

---

## F) ECHTE LÜCKEN

### Was wirklich noch fehlt:

| Lücke | Beschreibung | Priorität |
|-------|--------------|-----------|
| **Wochen-/Monats-/Jahres-Aggregation** | Kein automatischer Report für performance_7d/30d/365d über alle Prognosen | 🔴 Hoch |
| **Timing Quality Labels** | Noch keine Felder für "too_early", "too_late", "perfect_timing" | 🟡 Mittel |
| **Loss Avoided / Profit Missed Berechnung** | Nicht systematisch für blocked signals berechnet | 🟡 Mittel |
| **Admin-sichtbare Reason Summary** | debateSummary existiert, aber nicht als dedizierter Admin-Endpoint | 🟢 Niedrig |
| **Historical Pattern Confidence Trend** | patternConfidence existiert, aber kein Trend-Tracking | 🟡 Mittel |

### Was nur verbessert/verdrahtet werden muss:

| Thema | Status | Nächster Schritt |
|-------|--------|------------------|
| **Agent Forecast → Admin** | ✅ Endpoint existiert | Frontend-Widget erstellen |
| **Outcome Tracking → Admin** | ⚠️ Nur via Portfolio-Snapshot sichtbar | Eigenen Endpoint für Symbol-History |
| **Pattern Memory → Admin** | ⚠️ Intern genutzt, nicht exponiert | GET /api/admin/pattern-stats/:patternKey |
| **Discovery Learning Stats** | ⚠️ Keine Admin-Sicht auf 7d/30d Hit-Rates | GET /api/admin/discovery-stats |
| **Dynamic Weights History** | ⚠️ Nur aktueller Stand sichtbar | weight_history-Endpoint erweitern |

### Was komplett neu gebaut werden müsste:

| Feature | Begründung |
|---------|------------|
| **Structured Trade Journal** | Für echte Performance-Analyse über Zeiträume |
| **Counterfactual Analysis Dashboard** | "Was wäre wenn" für blocked signals |
| **Agent Evolution Timeline** | Wie haben sich die 3 Agenten über Zeit entwickelt |
| **Regime Transition Alerts** | Benachrichtigung bei cluster-Wechsel |

---

## PRIORISIERTE EMPFEHLUNG FÜR DEN NÄCHSTEN BACKEND-SCHRITT

### Phase 1: Sofort (ohne Code-Änderungen)
1. **Frontend-Widgets** für existierende Endpoints erstellen:
   - Agent Wisdom Scores (`/api/admin/agent-wisdom`)
   - Near Misses (`/api/admin/near-misses`)
   - SIS Report (`/api/admin/sis-report`)
   - Operational Status (`/api/admin/operational-status`)

### Phase 2: Schnell verdrahten (1-4h Backend)
1. **GET /api/admin/outcome-stats** - Aggregierte Statistiken
   ```js
   {
     total: N,
     evaluated: N,
     correctPredictions: N,
     avgReturn: X%,
     hitRate7d: X%,
     hitRate30d: X%
   }
   ```

2. **GET /api/admin/discovery-stats** - Discovery-Learning-Metriken
   ```js
   {
     totalDiscoveries: N,
     evaluated7d: N,
     evaluated30d: N,
     avgReturn7d: X%,
     avgReturn30d: X%
   }
   ```

3. **GET /api/admin/pattern-stats** - Pattern-Memory-Summary
   ```js
   {
     uniquePatterns: N,
     mostFrequent: [...],
     bestPerforming: [...],
     worstPerforming: [...]
   }
   ```

### Phase 3: Mittelfristig (4-8h Backend)
1. **Wochen-Aggregation Service** für periodische Reports
2. **Timing Quality Felder** in outcome_tracking
3. **Loss Avoided Berechnung** für guardian_near_miss

---

## BETROFFENE DATEIEN / SERVICES / TABELLEN

### Kern-Dateien für Signal-Logik:
- `hqsEngine.js`
- `services/agenticDebate.service.js`
- `services/opportunityScanner.service.js`
- `services/capitalAllocation.service.js`
- `services/regimeDetection.service.js`

### Kern-Dateien für Agenten-Logik:
- `services/agentForecast.repository.js`
- `services/causalMemory.repository.js`
- `services/guardianService.js`

### Kern-Dateien für Outcome-/Lernlogik:
- `services/outcomeTracking.repository.js`
- `services/discoveryLearning.service.js`
- `services/forwardLearning.service.js`
- `engines/learningEngine.js`
- `engines/marketMemoryEngine.js`
- `engines/metaLearningEngine.js`
- `jobs/forecastVerification.job.js`

### Admin-Schnittstellen:
- `routes/admin.routes.js`
- `services/systemIntelligence.service.js`
- `services/sisReleaseControl.service.js`
- `services/interfaceState.service.js`

---

## ZUSAMMENFASSUNG

Das Backend hat bereits eine **sehr vollständige Infrastruktur** für:

1. **Signal-Entscheidungen**: Buy/Hold/Sell via hqsScore → rating/decision
2. **Agenten-Konsens**: 3 Agenten mit gewichteter Abstimmung
3. **Timing-Tracking**: 24h/7d Verifikation für Forecasts und Outcomes
4. **Lern-Feedback-Loop**: Automatische Gewichts-Anpassung basierend auf Accuracy
5. **Pattern-Memory**: Strukturierte Muster-Erkennung mit Hit-Rates

**Was fehlt ist primär die Admin-Sichtbarkeit** – die Logik existiert, aber nicht alle relevanten Daten sind über Admin-Endpoints exponiert.

Der nächste sinnvolle Schritt ist **Frontend-only**: Widgets für die existierenden Endpoints bauen, ohne Backend-Änderungen.
