# Architektur-Bestandsaufnahme: 5 Zukunftsbausteine

> Erstellt: 2026-03-15 | Scope: vollständiges Backend-System | Modus: reine Bestandsaufnahme

---

## 1. Executive Summary Tabelle

| Idee | Status | Produktionsreif? | Zentrale Dateien | Kurzbegründung |
|------|--------|-----------------|-----------------|----------------|
| **A) Policy-/Capital-Allocation-Schicht** | teilweise | nein | `portfolioOptimizer.js`, `portfolioHqs.service.js`, `guardianService.js` | Score-gewichtete %-Zuteilung und Blockade-Mechanismus vorhanden, aber keine Kapitalmengen, kein Risiko-Budget, keine übergeordnete Priorisierungslogik |
| **B) Persistentes World Model** | indirekt | nein | `regimeDetection.service.js`, `interMarketCorrelation.service.js`, `sectorCoherence.service.js`, `admin_snapshots` | Mehrere Markt-Zustands-Fragmente existieren isoliert; kein einheitliches, dauerhaft gespeichertes globales Zustandsmodell |
| **C) Decision Memory** | teilweise | teilweise | `outcomeTracking.repository.js`, `autonomy_audit`, `guardian_near_miss`, `causalMemory.repository.js` | Outcomes + Debate-Zusammenfassung werden gespeichert; strukturierte verworfene Alternativen, Gegenargumente und symbolübergreifendes Lerngedächtnis fehlen |
| **D) Portfolio Twin / Capital Twin** | indirekt | nein | `monteCarloEngine.js`, `syntheticStressTest.service.js`, `portfolioHqs.service.js`, `backtestEngine.js` | Simulation auf Einzelsignal-Ebene vorhanden; kein Portfolio-Gesamtzwilling, keine Alternativszenarien auf Portfolio-Ebene |
| **E) Self-Critique / Sanktionen für Agenten** | teilweise | teilweise | `causalMemory.repository.js`, `dynamic_weights`, `agentForecast.repository.js`, `sectorCoherence.service.js` | Gewichtsanpassung per Accuracy (±5 %) aktiv; kein Regime-spezifisches Gewicht, kein „Timeout", kein echter Sanktionsmechanismus |

---

## 2. Detaillierte Analyse pro Idee

---

### A) Policy-/Capital-Allocation-Schicht über dem Ranking

**Status:** teilweise vorhanden – aber nur als Einzelsignal-Bewertung, nicht als übergeordnete Kapital-/Risikosteuerung

#### Was bereits existiert

| Komponente | Datei | Typ |
|------------|-------|-----|
| Score-gewichtete %-Zuteilung | `services/portfolioOptimizer.js` | Produktiv (via `server.js:551`) |
| Portfolio-Risikobewertung (riskLevel, exposure, rebalancing) | `services/portfolioHqs.service.js` | Produktiv (via `server.js:549`) |
| Guardian Protocol: Signalblockade bei Unterschreitung von Robustheitsschwellen | `services/opportunityScanner.service.js:924ff` | Produktiv |
| Regime-abhängige Guardian-Schwellen (Safe/Volatile/Danger) | `services/regimeDetection.service.js` + `ENV: GUARDIAN_THRESHOLD_*` | Produktiv |
| Sektor-bedingte Schwellenverschärfung (-15 %) | `services/sectorCoherence.service.js:getSharpenedThresholds()` | Produktiv |
| Near-Miss Virtual Capital Protector (EUR-Schätzung geblockte Signale) | `services/autonomyAudit.repository.js:evaluateSavedCapital()` | Produktiv |
| Rebalancing-Empfehlungen (Gewicht erhöhen / reduzieren / halten) | `services/portfolioHqs.service.js:rebalancing` | Produktiv |

> ⚠️ **Hinweis:** Das System hat zwei unabhängige Gewichts-Systeme. Die hier relevanten Allokations-Gewichte (`portfolioOptimizer`) sind **nicht** dasselbe wie die Agenten-Gewichte (`dynamic_weights` in `causalMemory`). Siehe Überschneidungs-Risiko Abschnitt 3.

#### Was nur ähnlich aussieht, aber nicht dasselbe ist

- `portfolioOptimizer.js` berechnet nur statische %-Gewichte aus dem aktuellen HQS-Score – **keine** Kapitalmengen (EUR/USD), kein Risiko-Budget, keine Positionsgrößenlogik.
- Der Guardian blockiert oder lässt Signale durch, entscheidet aber **nicht**, wie viel Kapital in ein Positionssignal fließt.
- Die `rebalancing`-Liste in `portfolioHqs.service.js` gibt Richtungsempfehlungen (Gewicht erhöhen/reduzieren), löst aber keine Kapitalentscheidungen aus.
- `evaluateSavedCapital()` ist eine **fiktive** EUR-Schätzung für blockierte Signale (VIRTUAL_POSITION_EUR = 1000), kein reales Kapitalmanagement.

#### Produktive Pfade

`POST /api/portfolio` → `server.js:543` → `calculatePortfolioHQS()` → `optimizePortfolio()`: liefert %-Allokation pro Symbol basierend auf HQS-Score.

#### Wo genau die Lücke noch ist

- **Fehlend:** Kapitalmengen-Logik (wieviel EUR pro Signal / Position)
- **Fehlend:** Risiko-Budget-Steuerung (Stopp bei X % Portfolio-Verlust)
- **Fehlend:** Signal-Priorisierungsregel bei konkurrierenden Signalen (wenn 5 Signale gleichzeitig kommen, welches bekommt Vorrang?)
- **Fehlend:** Freigabe-/Blockade-Logik oberhalb von `finalConviction` (Conviction ist Input zum Guardian, aber kein eigenständiges Kapitalfreigabe-Gate)
- **Fehlend:** Risikobudget-Deckelung pro Sektor/Regime

---

### B) Persistentes World Model / globaler Markt-Zustand

**Status:** indirekt vorhanden – mehrere Fragmente, aber kein einheitliches, persistentes Weltmodell

#### Was bereits existiert

| Komponente | Datei | Persistenz | Produktiv? |
|------------|-------|------------|------------|
| Regime-Klassifikation (Safe/Volatile/Danger) | `services/regimeDetection.service.js:classifyMarketRegime()` | Nein – fresh query bei jedem Aufruf | Ja (via `opportunityScanner:1152`) |
| Cross-Asset Frühwarnung (BTC/Gold) | `services/interMarketCorrelation.service.js` | In-Memory, 5 min TTL | Ja |
| Sektor-Spannungsindikator (Leader-Fall-Tracking) | `services/sectorCoherence.service.js` | In-Memory, 4h TTL | Ja |
| Narrativ-Erkennung | `engines/narrativeEngine.js` | Nein – per-call | Ja (via `marketService.js:924`) |
| Globale Marktintelligenz (Regime, Sector Leadership, Capital Flow Bias) | `engines/globalMarketIntelligence.js` | Nein – pure function | Indirekt (via `marketService.js`) |
| Admin Snapshots (Insights, Diagnostics, Validation) | `services/adminSnapshots.repository.js` + `admin_snapshots` Tabelle | Ja – DB | Teilweise |
| Runtime State Cache (market + opportunity preview) | `learning_runtime_state` Tabelle | Ja – DB | Ja (server startup hydration) |

#### Was nur ähnlich aussieht, aber nicht dasselbe ist

- `regimeDetection.classifyMarketRegime()` liest aus `hqs_scores` und `market_advanced_metrics`, klassifiziert den Markt, **speichert das Ergebnis aber nicht**. Jeder Aufruf löst eine neue DB-Aggregation aus.
- `admin_snapshots` speichert Admin-Ansicht-Snapshots für Trendvergleich, ist aber kein lesbares Weltmodell für Agenten.
- `learning_runtime_state` ist ein Preview-Cache für die API, kein strukturiertes Zustandsmodell.

#### Produktive Pfade

- `opportunityScanner.service.js:1152` ruft `classifyMarketRegime()` bei jedem Scan-Lauf ab → Regime fließt in Debate und Guardian ein.
- `agenticDebate.service.js:runMacroJudge()` liest `marketCluster` (kommt aus `classifyMarketRegime`) und `interMarketData` (kommt aus `getInterMarketCorrelation()`).

#### Wo genau die Lücke noch ist

- **Fehlend:** Persistente `world_model` / `market_state` Tabelle, die alle globalen Zustände (Regime, Cross-Asset, Sektor-Spannung, Narrative, Liquidität, Quellenvertrauen, Marktstress) als ein Objekt speichert und versioniert
- **Fehlend:** Quellenvertrauen / Source Trust (welche Daten-Provider/News-Quellen gerade zuverlässig sind)
- **Fehlend:** Persistente Sektor-Spannungs-History (der `_sharpenedSectors` Map in `sectorCoherence.service.js` ist bewusst als In-Memory-Cache mit 4h TTL konzipiert – das Verhalten ist by design, stellt aber eine Lücke für ein persistentes World Model dar: bei Serverstart geht der Spannungszustand verloren)
- **Fehlend:** Globaler Liquiditäts-Status (wird per Signal berechnet, aber nicht marktübergreifend aggregiert)
- **Fehlend:** Einheitlicher Abruf-Punkt: Agenten müssen aus 4+ verschiedenen Services manuell lesen statt aus einem World Model

---

### C) Decision Memory statt nur Outcome Memory

**Status:** teilweise vorhanden – Outcomes + Debate-Zusammenfassung werden gespeichert; strukturiertes Entscheidungsgedächtnis fehlt

#### Was bereits existiert

| Komponente | Datei / Tabelle | Produktiv? |
|------------|-----------------|------------|
| Outcome Tracking (Entry, Signal, Performance 24h/7d, Pattern) | `outcome_tracking` Tabelle + `outcomeTracking.repository.js` | Ja |
| Pattern Memory (pattern_key, patternContext, Trefferquote, hitRate24h/7d) | `outcome_tracking.pattern_key/pattern_context` + `getPatternStats()` | Ja |
| Agentic Debate Summary (German text, stored in `raw_input_snapshot.debate.summary`) | `autonomy_audit.raw_input_snapshot` | Ja |
| Per-Agent-Forecast-Gründe (German reason text) | `agent_forecasts.forecast_reason` | Ja |
| Meta-Rationale (letzter Agent-Fehler als historischer Hinweis) | `causalMemory.repository.js:buildMetaRationale()` | Ja |
| Blocked-Signal-Details inkl. Debate-Votes | `guardian_near_miss.debate_result` (JSONB) | Ja (nur für suppressed) |
| Guardian Near-Miss Log | `guardian_near_miss` Tabelle | Ja |
| Suppression Reason | `autonomy_audit.suppression_reason` | Ja (nur 2 Werte: "Debate Consensus Failed" / "Kapitalschutz-Aktion") |

#### Was nur ähnlich aussieht, aber nicht dasselbe ist

- `autonomy_audit.raw_input_snapshot.debate.summary` speichert den deutschen Debattentext – aber **nicht** die strukturierten Einzel-Votes der drei Agenten (nur für `guardian_near_miss` werden die Votes als JSON gespeichert, und nur für geblockte Signale).
- `forecast_reason` enthält einen deutschsprachigen Begründungsstring, ist aber nicht als strukturierte Entscheidungslogik abfragbar.
- `buildMetaRationale()` ruft den letzten Fehler ab, injiziert ihn aber nur, wenn er **explizit** übergeben wird – es gibt keine systemische Rückkopplung für alle Symbole/Entscheidungen.
- `suppression_reason` hat nur zwei Werte – kein semantisch differenziertes Blockade-Gedächtnis.

#### Produktive Pfade

`opportunityScanner.service.js:1295` → `recordAutonomyDecision()`: speichert `debate.summary` + `debate.approvalCount` in `raw_input_snapshot` der `autonomy_audit` Tabelle.

`opportunityScanner.service.js:1315` → `logNearMiss()`: speichert `debate_result.votes` (strukturiert) nur für geblockte Signale in `guardian_near_miss`.

#### Wo genau die Lücke noch ist

- **Fehlend:** Strukturierte Einzel-Agent-Votes für **freigegebene** Signale (nur in `agent_forecasts`, nicht als Entscheidungskontext)
- **Fehlend:** Persistenz der verworfenen Alternativen (welche anderen Symbole wurden in diesem Scan-Lauf evaluiert und verworfen – und warum?)
- **Fehlend:** Gegenargumente als strukturiertes Feld (die Vote-Reasons der ablehnenden Agenten sind nur im Debattentext, nicht als queryable Feld)
- **Fehlend:** Systemische `metaRationale`-Schleife: wird nur in `opportunityScanner` für das aktuelle Symbol injiziert, aber nicht für alle Entscheidungen standardmäßig aktiviert
- **Fehlend:** Verbindung zwischen einer Entscheidung und der Entscheidung, die sie korrigiert (kein `parent_decision_id` oder ähnliche Verkettung)

---

### D) Portfolio Twin / Capital Twin

**Status:** indirekt vorhanden – Simulationsbausteine auf Einzelsignal-Ebene existieren, aber kein Portfolio-Gesamtzwilling

#### Was bereits existiert

| Komponente | Datei | Ebene | Produktiv? |
|------------|-------|-------|------------|
| 10-Szenario Black-Swan-Stress pro Signal | `services/syntheticStressTest.service.js:runBlackSwanTest()` | Einzelsignal | Ja (via `opportunityScanner`) |
| Portfolio-Antifragilitäts-Ranking | `syntheticStressTest.service.js:rankPortfolioAntifragility()` | Portfolio-Array | Ja (Funktion existiert, wird gerufen) |
| Monte-Carlo-Simulation (GBM, per Symbol) | `engines/monteCarloEngine.js:monteCarloSimulation()` | Einzelsymbol | Ja (via `marketService.js`) |
| 4-Szenario Markt-Simulation (Bull/Bear/Volatility/Momentum) | `engines/marketSimulationEngine.js:runMarketSimulations()` | Einzelsignal | Indirekt |
| Portfolio HQS-Score + Risikolevel + Exposure | `services/portfolioHqs.service.js:calculatePortfolioHQS()` | Portfolio | Ja |
| HQS-Score-gewichtete Allokation | `services/portfolioOptimizer.js:optimizePortfolio()` | Portfolio | Ja |
| Historischer Backtest (HQS-Threshold-Strategie) | `services/backtestEngine.js` | Backtest | Ja |
| Max-Drawdown-Berechnung | `services/riskMetrics.service.js` | Historisch | Ja |

#### Was nur ähnlich aussieht, aber nicht dasselbe ist

- `rankPortfolioAntifragility()` übergibt die Signale als Array an `runBlackSwanTest()`, aber jedes Signal wird **unabhängig** gestresst – es gibt keine Modellierung von Korrelationen oder Portfolio-Effekten.
- `calculatePortfolioHQS()` berechnet den gewichteten Schnitt des aktuellen HQS-Scores – **keine** hypothetische Simulation: „Was würde passieren, wenn wir Symbol X hinzufügen?"
- `monteCarloEngine.js` simuliert Preispfade für **ein Symbol** (GBM), ist kein Portfolio-Level-Simulator.
- `backtestEngine.js` testet eine **einzelne Schwellenstrategie** auf historischen Daten, kein Portfolio-Backtest.

#### Produktive Pfade

`opportunityScanner.service.js:408ff` → `simulateMarketStress()` / `calculateRobustnessScore()`: 10 stress variants mit 5–15 % Degradation → robustness score → wird in payload gespeichert.

`syntheticStressTest.service.js:runBlackSwanTest()`: 10 deterministische Phantom-Szenarien → antifragilityScore → wird in `opportunityScanner` genutzt.

#### Wo genau die Lücke noch ist

- **Fehlend:** Portfolioweites Stress-Szenario: „Was passiert mit dem gesamten Portfolio im FLASH_CRASH-Szenario?"
- **Fehlend:** Hypothetische Alternativallokation: „Was wäre, wenn wir statt AAPL MSFT halten?"
- **Fehlend:** Nicht-Handeln als Alternative: kein „cost of not acting"-Vergleich
- **Fehlend:** Drawdown-Vermeidung auf Portfolio-Ebene (riskMetrics berechnet Drawdown historisch, setzt ihn aber nicht als aktiven Filter ein)
- **Fehlend:** Kapitalallokations-Modellierung in EUR mit Positionslogik

---

### E) Self-Critique / Sanktionen für Agenten

**Status:** teilweise vorhanden – Gewichtsanpassung per Accuracy aktiv; echter Sanktionsmechanismus fehlt

#### Was bereits existiert

| Mechanismus | Datei / Tabelle | Produktiv? |
|-------------|-----------------|------------|
| 48h-Accuracy-basierte Gewichtsanpassung (±LEARN_STEP=0.05) | `causalMemory.repository.js:adjustAgentWeights()` + `dynamic_weights` Tabelle | Ja |
| Gewichtsgrenzen [0.10 – 0.60] + Normalisierung | `causalMemory.repository.js:normaliseWeights()` | Ja |
| Per-Agent-Trefferquote (Wisdom Score) | `agentForecast.repository.js:getAgentWisdomScores()` + `agent_forecasts` Tabelle | Ja |
| Meta-Rationale: Fehlererinnerung (letzter Irrtum als Debattenkontext) | `causalMemory.repository.js:buildMetaRationale()` | Ja |
| Sektor-Alert: RISK_SKEPTIC erhält 15 % schärfere Schwellen | `sectorCoherence.service.js:getSharpenedThresholds()` | Ja |
| Pattern-Memory-Penalty: RISK_SKEPTIC erhöht Robustheits-Floor bei schwachem Muster | `agenticDebate.service.js:runRiskSkeptic()` (PATTERN_ROBUSTNESS_PENALTY) | Ja |
| Agentic-Debate-Weighted-Vote (dynamicWeights aus `dynamic_weights`) | `agenticDebate.service.js:runAgenticDebate()` | Ja |

> ⚠️ **Hinweis:** `dynamic_weights` (Agenten-Gewichte) ist ein **anderes System** als `weight_history` (HQS-Faktorgewichte). Beide existieren produktiv – nicht verwechseln. Siehe Überschneidungs-Risiko Abschnitt 3.

#### Was nur ähnlich aussieht, aber nicht dasselbe ist

- `adjustAgentWeights()` passt Gewichte **einheitlich über alle Regime** an – keine regime-spezifische Sanktion (z. B. „GROWTH_BIAS wird in Danger-Regimen temporär heruntergewichtet").
- Das Gewichts-Floor von `WEIGHT_MIN = 0.10` bedeutet: ein Agent kann **niemals** deaktiviert oder auf null gesetzt werden, selbst wenn er dauerhaft falsch liegt.
- Die Sektor-Schärfung betrifft nur den RISK_SKEPTIC und nur wenn der Sektor-Leader fällt – sie ist **kein universeller Sanktionsmechanismus**.
- `buildMetaRationale()` erinnert an den letzten Fehler, setzt aber **keine strengeren Schwellen** für den verantwortlichen Agenten.
- Die Gewichtsanpassung benötigt `MIN_SAMPLE_SIZE = 3` und `REVIEW_WINDOW_HOURS = 6` – sehr langsamer Feedback-Zyklus, kein sofortiger Sanktions-Trigger.

#### Produktive Pfade

`jobs/causalMemory.job.js` → `adjustAgentWeights()`: läuft periodisch, passt Gewichte für alle 3 Agenten an.

`opportunityScanner.service.js:1217` → `runAgenticDebate()` mit `dynamicWeights` aus `getAgentWeights()`: angepasste Gewichte fließen direkt in `weightedApproval` ein.

`opportunityScanner.service.js:1228` → `getSharpenedThresholds(symbol)`: regime-ähnliche Schwellenverschärfung für den Risiko-Skeptiker.

#### Wo genau die Lücke noch ist

- **Fehlend:** Regime-spezifische Agent-Gewichte (z. B. MACRO_JUDGE hat in Danger mehr Gewicht als GROWTH_BIAS)
- **Fehlend:** Temporäre Suspendierung / „Timeout" eines Agenten (z. B. wenn Accuracy < 30 % über 7 Tage)
- **Fehlend:** Verschärfte individuelle Schwellen für einen konkreten Agenten bei schlechter Performance (derzeit nur RISK_SKEPTIC bei Sektor-Alert, nicht performancebasiert)
- **Fehlend:** Explizites Sanktions-Logging (warum wurde ein Agent heruntergewichtet?)

---

## 3. Überschneidungs-Risiko

### Bereits teilweise abgedeckte Zukunftsideen

| Neue Idee | Existierendes Modul | Risiko der Doppelarbeit |
|-----------|---------------------|------------------------|
| Policy-/Capital-Allocation | `portfolioOptimizer.js` + `guardianService` | **Mittel** – Blockade-Logik existiert, aber keine Kapital-Dimension; Erweiterung möglich statt Neubau |
| World Model (Regime) | `regimeDetection.service.js` | **Hoch** – Regime-Klassifikation ist produktiv integriert; World Model wäre Wrapper/Persistenzschicht darüber |
| World Model (Cross-Asset) | `interMarketCorrelation.service.js` | **Mittel** – BTC/Gold-Status existiert in-memory; Persistenz und Erweiterung nötig |
| Decision Memory | `autonomy_audit` + `outcome_tracking` | **Hoch** – Grundstruktur ist da; Gefahr, eine zweite parallele Tabelle zu bauen, die dieselben Daten dupliziert |
| Portfolio Twin (Stress) | `syntheticStressTest.service.js` | **Mittel** – Per-Signal-Stress existiert; Portfolio-Level ist echter Ausbau, kein Doppel |
| Agent Sanctions | `causalMemory.repository.js` + `dynamic_weights` | **Hoch** – Weight-Adjustments existieren; Sanktions-Konzept müsste über bestehende `dynamic_weights` Tabelle erweitert werden |

### Begriffe, die ähnlich klingen, fachlich aber etwas anderes bedeuten

| Begriff im System | Bedeutung im System | Bedeutung der Zukunftsidee |
|-------------------|---------------------|---------------------------|
| `robustnessScore` | Per-Signal-Stresstest-Score (0–1), Anteil bestandener Szenarien | In Idee D: Portfolio-Robustheit als Ganzes |
| `finalConviction` | Numerischer Score 0–100, kombiniert HQS + AI + Orchestrator | In Idee A: Freigabe-Gate für Kapital (ist es nicht – es ist nur ein Score) |
| `guardian_applied` | Boolean: Guardian wurde ausgeführt (nicht: hat blockiert) | In Idee A: Guardian als Freigabe-Gate für Kapital |
| `suppressionReason` | String mit 2 Werten ("Debate Consensus Failed" / "Kapitalschutz-Aktion") | In Idee C: Semantisch differenzierter Blockadegrund |
| `debateSummary` | Deutscher Freitext, beschreibt Abstimmungsergebnis | In Idee C: Strukturiertes Entscheidungsgedächtnis mit Gegenargumenten |
| `weight_history` | Faktoren-Gewichte (momentum/quality/stability/relative) für HQS-Berechnung | In Idee E: Agenten-Gewichte (`dynamic_weights`) – **zwei verschiedene Gewichtssysteme!** |
| `market_cluster` | Feld in `autonomy_audit`/`agent_forecasts` für Safe/Volatile/Danger | In Idee B: Teil eines World Models – derzeit nur Attribut, nicht Modell |
| `metaRationale` | Hinweis auf letzten Agent-Fehler für ein Symbol | In Idee C: Systematisches Entscheidungsgedächtnis |

### Besonders kritische Doppelgefahr

1. **`weight_history` vs. `dynamic_weights`**: Das System hat **zwei separate Gewichts-Systeme**. `weight_history` speichert momentum/quality/stability/relative-Gewichte für die HQS-Faktorgewichtung (via `weightHistory.repository.js`). `dynamic_weights` speichert die Agenten-Gewichte für GROWTH_BIAS/RISK_SKEPTIC/MACRO_JUDGE (via `causalMemory.repository.js`). Bei Erweiterung: unbedingt unterscheiden.

2. **Stress-Test Doppel**: `services/opportunityScanner.service.js:simulateMarketStress()` (5–15 % zufällige Degradation, 10 Varianten) und `services/syntheticStressTest.service.js:runBlackSwanTest()` (deterministische Phantom-Szenarien) sind **beide** aktiv. Beide produzieren einen `robustnessScore` – unterschiedliche Methodik!

3. **Pattern Memory**: `outcome_tracking.pattern_key` + `getPatternStats()` (DB-basiert) vs. `engines/marketMemoryEngine.js:buildSetupSignature()` (In-Memory, anderes Schlüsselformat). Beide versuchen wiederkehrende Setups zu erkennen – nur `outcome_tracking` ist produktiv integriert.

---

## 4. Klare Schlussfolgerung

### Was haben wir davon schon?

**Vollständig produktiv:**
- Regime-Klassifikation (Safe/Volatile/Danger) → fließt in Guardian und Debate ein
- 3-Agenten-Debatte mit Mehrheitsvotum und gewichteter Zustimmung
- Per-Signal Black-Swan-Stresstest (10 Szenarien, antifragilityScore)
- Outcome Tracking mit Pattern Memory (hitRate24h/7d)
- Agent-Forecast-Logging + 24h-Verifikation
- Gewichtsanpassung (dynamic_weights) via causalMemory-Job (48h-Zyklus)
- Cross-Asset Frühwarnung (BTC/Gold, in-memory, 5min TTL)
- Guardian Protocol (Signalblockade + near-miss Logging)

### Was haben wir nur halb?

**Halb vorhanden, funktioniert aber isoliert:**
- **Decision Memory (C):** Debattentext gespeichert, aber strukturierte Votes nur für geblockte Signale; kein queryables Gegenargument-Feld; keine Verbindung zwischen Entscheidungen
- **Agent-Sanktionen (E):** Gewichtsanpassung aktiv, aber kein Regime-Bezug, kein Timeout, Mindestgewicht = 0.10 verhindert echte Sanktion
- **World Model (B):** Regime, Cross-Asset, Sektor-Spannung existieren als Fragmente, aber nicht persistiert als einheitliches Modell; verlieren ihren Zustand bei Serverstart (sectorCoherence) oder werden nicht gespeichert (regimeDetection)
- **Capital Allocation (A):** Blockade-Logik und %-Allokation vorhanden, aber kein Kapital-Budget, keine Positionsgrößen, keine Priorisierung konkurrierender Signale

### Was fehlt wirklich?

1. **Portfolio Twin (D):** Keine portfolioweite Simulation; Stress-Test ist rein Signal-individuell; kein Alternativszenario-Vergleich; kein „Nicht-Handeln"-Modell
2. **Persistentes World Model (B):** Kein unified `world_state` Datenbankrecord der alle globalen Zustände versioniert speichert; Sektor-Spannung geht bei Neustart verloren
3. **Echte Agent-Sanktionen (E):** Kein Regime-spezifisches Gewicht; kein Timeout; kein Sanktions-Log
4. **Structured Decision Memory (C):** Kein queryables Feld für Gegenargumente und verworfene Alternativen; keine decision-zu-decision Verlinkung
5. **Capital-Allocation-Logik (A):** Positionsgrößen in EUR/%, Risiko-Budget, Freigabe-Gate oberhalb von `finalConviction`

### Was wäre der nächste nicht-doppelte Ausbau-Schritt?

**Priorität 1 – World Model Persistenz (B):**
Bestehende Fragmente (regimeDetection, interMarketCorrelation, sectorCoherence) in eine `world_state` Tabelle zusammenführen, die bei jedem Scan-Lauf ein versioniertes Snapshot des globalen Zustands speichert. Kein Neubau der Erkennungslogik, nur Persistenzschicht oben drauf.

**Priorität 2 – Decision Memory strukturieren (C):**
`autonomy_audit.raw_input_snapshot` enthält bereits `debate.summary`. Ergänzung um strukturiertes `debate_votes` JSONB-Feld (die drei Agenten + ihre Vote-Begründung) für **alle** Entscheidungen (nicht nur geblockte). Kein Neubau, nur Erweiterung des bestehenden INSERT.

**Priorität 3 – Agent-Sanktionen erweitern (E):**
In `dynamic_weights` ein `regime` Feld hinzufügen und `adjustAgentWeights()` um regime-spezifische Gewichtspfade erweitern. Nutzt bestehende Infrastruktur vollständig.

**Priorität 4 – Capital Allocation Schicht (A):**
Über `finalConviction` + `robustnessScore` + `regimeCluster` eine einfache Positionsgrößen-Policy definieren und in `portfolioOptimizer.js` integrieren. Kein Neubau der Scorelogik nötig.

**Priorität 5 – Portfolio Twin (D):**
`rankPortfolioAntifragility()` um Korrelations-Modellierung erweitern und `syntheticStressTest.service.js` mit einer Portfolio-Gesamtbewertungsfunktion ergänzen. Bestehende Einzel-Signal-Tests bleiben erhalten.

---

*Ende der Bestandsaufnahme – keine Implementierung, keine neuen Quelldateien, kein Refactoring.*
