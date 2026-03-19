import React, { useState, useEffect, useCallback } from "react";

// ─── Backend URL constants ─────────────────────────────────────────────────
const backendUrls = {
  systemIntelligence: "/api/admin/system-intelligence",
  agentWisdom:        "/api/admin/agent-wisdom",
  agentWeights:       "/api/admin/agent-weights",
  dynamicWeights:     "/api/admin/dynamic-weights",
  worldState:         "/api/admin/world-state",
  operationalStatus:  "/api/admin/operational-status",
  interfaceState:     "/api/admin/interface-state",
  nearMisses:         "/api/admin/near-misses",
  savedCapital:       "/api/admin/saved-capital",
  portfolioTwin:      "/api/admin/portfolio-twin",
  virtualPositions:   "/api/admin/virtual-positions",
};

// ─── Helpers ───────────────────────────────────────────────────────────────
async function safeFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatCurrency(value, currency = "EUR") {
  const num = Number(value);
  if (!Number.isFinite(num)) return "–";
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${num.toFixed(2)} ${currency}`;
  }
}

function formatPercent(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "–";
  return `${num.toFixed(digits)} %`;
}

// ─── Section Components ────────────────────────────────────────────────────

function SystemIntelligence({ data }) {
  if (!data) return <div className="panel loading">Lade System-Intelligence…</div>;
  const sis = data.sis ?? 0;
  const maturity = data.maturity || {};
  return (
    <div className="panel">
      <h3>🧠 System Intelligence</h3>
      <div className="sis-score" style={{ color: maturity.color }}>
        {sis} / 100
      </div>
      <div className="sis-maturity">{maturity.label || "–"}</div>
      {Array.isArray(data.layers) && (
        <div className="sis-layers">
          {data.layers.map((l, i) => (
            <div key={i} className={`sis-layer status-${l.status}`}>
              <span className="layer-icon">{l.icon}</span>
              <span className="layer-label">{l.label}</span>
              <span className="layer-score">{l.score}/{l.max}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentWisdom({ data }) {
  if (!data) return <div className="panel loading">Lade Agent-Wisdom…</div>;
  const agents = data.agents || [];
  return (
    <div className="panel">
      <h3>🐝 Schwarmintelligenz</h3>
      <div className="consensus">
        {data.consensus ? "✅ Konsens erreicht" : "⚠️ Kein Konsens"}
      </div>
      <div className="agent-list">
        {agents.map((a, i) => (
          <div key={i} className="agent-card">
            <span className="agent-name">{a.name}</span>
            <span className="agent-accuracy">
              {a.accuracy != null ? formatPercent(a.accuracy) : "–"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentWeights({ data }) {
  if (!data) return <div className="panel loading">Lade Agent-Weights…</div>;
  const weights = data.weights || [];
  return (
    <div className="panel">
      <h3>⚖️ Agentengewichte</h3>
      <div className="weights-list">
        {weights.map((w, i) => (
          <div key={i} className="weight-row">
            <span>{w.agent || w.name}</span>
            <span>{w.weight != null ? w.weight.toFixed(3) : "–"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DynamicWeights({ data }) {
  if (!data) return <div className="panel loading">Lade Dynamic-Weights…</div>;
  const entries = data.weights || data.entries || [];
  return (
    <div className="panel">
      <h3>📊 Dynamische Gewichte</h3>
      <div className="weights-list">
        {entries.map((e, i) => (
          <div key={i} className="weight-row">
            <span>{e.name || e.factor}</span>
            <span>{e.value != null ? e.value.toFixed(3) : "–"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorldState({ data }) {
  if (!data) return <div className="panel loading">Lade World-State…</div>;
  return (
    <div className="panel">
      <h3>🌍 Weltstatus</h3>
      <div className="world-risk">
        Risiko-Modus: <strong>{data.riskMode || "–"}</strong>
      </div>
      <div className="world-regime">
        Regime: <strong>{data.regime || "–"}</strong>
      </div>
      {data.generatedAt && (
        <div className="timestamp">
          Stand: {new Date(data.generatedAt).toLocaleTimeString("de-DE")}
        </div>
      )}
    </div>
  );
}

function OperationalStatus({ data }) {
  if (!data) return <div className="panel loading">Lade Operational-Status…</div>;
  const mode = (data.operationalRelease || {}).recommendedMode || {};
  return (
    <div className="panel">
      <h3>🚦 Betriebsstatus</h3>
      <div className="ops-mode" style={{ color: mode.color }}>
        {mode.label || "–"}
      </div>
      <div className="ops-desc">{mode.description || "–"}</div>
      {data.nextStep && <div className="ops-next">💡 {data.nextStep}</div>}
    </div>
  );
}

function InterfaceState({ data }) {
  if (!data) return <div className="panel loading">Lade Interface-State…</div>;
  return (
    <div className="panel">
      <h3>🎛 Interface-Zustand</h3>
      <div className="surface-mode">Modus: {data.surfaceMode || "–"}</div>
      {data.chiefSummary && (
        <div className="chief-summary">{data.chiefSummary}</div>
      )}
    </div>
  );
}

function NearMisses({ data }) {
  if (!data) return <div className="panel loading">Lade Near-Misses…</div>;
  const misses = data.nearMisses || data.records || [];
  return (
    <div className="panel">
      <h3>🛡 Guardian Near-Misses</h3>
      <div className="near-miss-count">
        {misses.length} Beinahe-Treffer
      </div>
      <div className="near-miss-list">
        {misses.slice(0, 10).map((m, i) => (
          <div key={i} className="near-miss-row">
            <span>{m.symbol || "–"}</span>
            <span>{m.reason || m.trigger || "–"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SavedCapital({ data }) {
  if (!data) return <div className="panel loading">Lade Saved-Capital…</div>;
  const currency = data.currency || data.priceCurrency || "EUR";
  return (
    <div className="panel">
      <h3>💰 Geschütztes Kapital</h3>
      <div className="saved-total">
        {formatCurrency(data.totalSavedCapital, currency)}
      </div>
      <div className="blocked-count">
        {data.blockedSignalsCount || 0} blockierte Signale
      </div>
    </div>
  );
}

function PortfolioTwin({ data }) {
  if (!data) return <div className="panel loading">Lade Portfolio-Twin…</div>;
  const stage4 = data.stage4 || data;
  const currency = stage4.currency || stage4.priceCurrency || "EUR";
  return (
    <div className="panel">
      <h3>👯 Portfolio-Twin</h3>
      <div className="twin-positions">
        Offene Positionen: {stage4.openPositionsCount ?? "–"}
      </div>
      {stage4.unrealizedPnl != null && (
        <div className="twin-pnl">
          Unrealisierter P&L: {formatCurrency(stage4.unrealizedPnl, currency)}
        </div>
      )}
    </div>
  );
}

function VirtualPositions({ data }) {
  if (!data) return <div className="panel loading">Lade Virtual-Positions…</div>;
  const positions = data.positions || data.rows || [];
  return (
    <div className="panel">
      <h3>📋 Virtuelle Positionen</h3>
      <div className="vp-count">{positions.length} Positionen</div>
      <div className="vp-list">
        {positions.slice(0, 20).map((p, i) => (
          <div key={i} className="vp-row">
            <span className="vp-symbol">{p.symbol}</span>
            <span className="vp-status">{p.status}</span>
            <span className="vp-score">{p.hqs_score ?? "–"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Dashboard Component ──────────────────────────────────────────────

function DashboardIntegrated() {
  const [systemIntelligence, setSystemIntelligence] = useState(null);
  const [agentWisdom, setAgentWisdom]               = useState(null);
  const [agentWeights, setAgentWeights]             = useState(null);
  const [dynamicWeights, setDynamicWeights]         = useState(null);
  const [worldState, setWorldState]                 = useState(null);
  const [operationalStatus, setOperationalStatus]   = useState(null);
  const [interfaceState, setInterfaceState]         = useState(null);
  const [nearMisses, setNearMisses]                 = useState(null);
  const [savedCapital, setSavedCapital]             = useState(null);
  const [portfolioTwin, setPortfolioTwin]           = useState(null);
  const [virtualPositions, setVirtualPositions]     = useState(null);
  const [error, setError]                           = useState(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const results = await Promise.allSettled([
        safeFetch(backendUrls.systemIntelligence),
        safeFetch(backendUrls.agentWisdom),
        safeFetch(backendUrls.agentWeights),
        safeFetch(backendUrls.dynamicWeights),
        safeFetch(backendUrls.worldState),
        safeFetch(backendUrls.operationalStatus),
        safeFetch(backendUrls.interfaceState),
        safeFetch(backendUrls.nearMisses),
        safeFetch(backendUrls.savedCapital),
        safeFetch(backendUrls.portfolioTwin),
        safeFetch(backendUrls.virtualPositions),
      ]);

      const val = (i) => results[i].status === "fulfilled" ? results[i].value : null;
      setSystemIntelligence(val(0));
      setAgentWisdom(val(1));
      setAgentWeights(val(2));
      setDynamicWeights(val(3));
      setWorldState(val(4));
      setOperationalStatus(val(5));
      setInterfaceState(val(6));
      setNearMisses(val(7));
      setSavedCapital(val(8));
      setPortfolioTwin(val(9));
      setVirtualPositions(val(10));
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  return (
    <div className="dashboard-integrated">
      <header className="dashboard-header">
        <div className="logo">
          <span className="logo-icon">HQS</span>
          <span className="logo-text">Portfolio Intelligence</span>
        </div>
        <button className="reload-btn" onClick={loadAll}>↻ Aktualisieren</button>
      </header>

      {error && <div className="error-banner">⚠️ {error}</div>}

      <main className="dashboard-grid">
        <SystemIntelligence data={systemIntelligence} />
        <AgentWisdom data={agentWisdom} />
        <AgentWeights data={agentWeights} />
        <DynamicWeights data={dynamicWeights} />
        <WorldState data={worldState} />
        <OperationalStatus data={operationalStatus} />
        <InterfaceState data={interfaceState} />
        <NearMisses data={nearMisses} />
        <SavedCapital data={savedCapital} />
        <PortfolioTwin data={portfolioTwin} />
        <VirtualPositions data={virtualPositions} />
      </main>
    </div>
  );
}

export default DashboardIntegrated;
