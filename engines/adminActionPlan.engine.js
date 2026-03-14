"use strict";

function pickItems(list, limit = 3) {
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

function mapPriority(item, fallbackBucket = "next") {
  if (!item) return null;

  return {
    key: item.key || null,
    bucket: item.bucket || fallbackBucket,
    title: item.title || "Priorität prüfen",
    detail: item.detail || null,
    reason: item.reason || null,
  };
}

function mapDecision(item) {
  if (!item) return null;

  return {
    key: item.key || null,
    title: item.title || null,
    allowed: Boolean(item.allowed),
    status: item.status || (item.allowed ? "released" : "blocked"),
    reason: item.reason || null,
    nextStep: item.nextStep || null,
    blocker: item.blocker || null,
  };
}

function buildAdminActionPlan({
  briefing = {},
  priorities = {},
  recommendations = {},
  release = {},
} = {}) {
  const immediatePriorities = pickItems(priorities.immediate, 3).map((item) =>
    mapPriority(item, "immediate")
  );
  const nextPriorities = pickItems(priorities.next, 2).map((item) =>
    mapPriority(item, "next")
  );

  const blockedScale = Object.values(release.scale || {})
    .filter((item) => !item?.allowed)
    .slice(0, 2)
    .map(mapDecision);

  const blockedExpansion = Object.values(release.expansion || {})
    .filter((item) => !item?.allowed)
    .slice(0, 2)
    .map(mapDecision);

  const nextStep = mapPriority(
    briefing.nextAction || priorities?.summary?.topPriority || null,
    "next"
  );

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      overallStatus: briefing?.executiveSummary?.overallStatus || null,
      trustStatus: briefing?.executiveSummary?.trustStatus || null,
      scaleStatus: briefing?.executiveSummary?.scaleStatus || null,
      expansionStatus: briefing?.executiveSummary?.expansionStatus || null,
    },
    openAdjustments: [...immediatePriorities, ...nextPriorities].filter(Boolean),
    nextStep,
    releaseFocus: {
      blockedScale,
      blockedExpansion,
    },
    recommendedActions: pickItems(recommendations.nextActions, 3),
    adminText:
      briefing.adminText ||
      "Es wurde kein kompaktes Admin-Briefing für den aktuellen Zustand erzeugt.",
  };
}

module.exports = {
  buildAdminActionPlan,
};
