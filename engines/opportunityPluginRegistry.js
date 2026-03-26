"use strict";

/*
  Opportunity Plugin Registry
  ===========================
  Modular extension point for the OpportunityEngine pipeline.
  Register plugins that receive the fully integrated market view and
  can enrich, filter, or annotate it without touching core engine code.

  Compatible upgraded version:
  - supports plugin priority
  - supports per-plugin timeout protection
  - keeps the same public API
*/

const logger = require("../utils/logger");

/** @type {Map<string, { fn: Function, priority: number }>} */
const _plugins = new Map();

function safePriority(value, fallback = 100) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pluginTimeoutMs() {
  const raw = Number(process.env.OPPORTUNITY_PLUGIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * Register a named plugin function.
 *
 * Backward compatible:
 * - old usage: registerPlugin(name, fn)
 * - new usage: registerPlugin(name, fn, priority)
 *
 * @param {string} name
 * @param {Function} fn
 * @param {number} [priority=100]
 */
function registerPlugin(name, fn, priority = 100) {
  if (!name || typeof name !== "string") {
    throw new TypeError("Plugin name must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new TypeError(`Plugin '${name}' must be a function`);
  }

  const normalizedPriority = safePriority(priority, 100);

  _plugins.set(name, { fn, priority: normalizedPriority });

  logger.info(
    `OpportunityPlugin registered: ${name} (priority=${normalizedPriority})`
  );
}

/**
 * Remove a previously registered plugin by name.
 *
 * @param {string} name
 */
function unregisterPlugin(name) {
  if (_plugins.delete(name)) {
    logger.info(`OpportunityPlugin unregistered: ${name}`);
  }
}

/**
 * List all currently registered plugin names.
 *
 * @returns {string[]}
 */
function listPlugins() {
  return [..._plugins.keys()];
}

function getSortedPlugins() {
  return [..._plugins.entries()].sort(
    (a, b) => b[1].priority - a[1].priority
  );
}

/**
 * Run all registered plugins sequentially on the given context object.
 * Each plugin receives the (possibly already enriched) context from the
 * previous plugin. Plugin failures are caught and logged so that one
 * failing plugin never blocks the rest of the pipeline.
 *
 * @param {object} context
 * @returns {Promise<object>}
 */
async function runPlugins(context) {
  if (!_plugins.size) return context;

  let result = context;
  const timeoutMs = pluginTimeoutMs();

  for (const [name, plugin] of getSortedPlugins()) {
    try {
      const pluginPromise = Promise.resolve(plugin.fn(result));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      );

      const augmented = await Promise.race([pluginPromise, timeoutPromise]);

      if (
        augmented &&
        typeof augmented === "object" &&
        !Array.isArray(augmented)
      ) {
        result = augmented;
      } else if (augmented !== undefined) {
        logger.warn(
          `OpportunityPlugin '${name}' returned an invalid type (${Array.isArray(augmented) ? "array" : typeof augmented}) – result unchanged`
        );
      }
    } catch (err) {
      logger.warn(`OpportunityPlugin '${name}' failed or timed out – skipping`, {
        message: err.message,
      });
    }
  }

  return result;
}

module.exports = {
  registerPlugin,
  unregisterPlugin,
  listPlugins,
  runPlugins,
};
