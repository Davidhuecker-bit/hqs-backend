"use strict";

/*
  Opportunity Plugin Registry
  ===========================
  Modular extension point for the OpportunityEngine pipeline.
  Register plugins that receive the fully integrated market view and
  can enrich, filter, or annotate it without touching core engine code.

  Usage:
    const { registerPlugin, runPlugins } = require('./opportunityPluginRegistry');

    registerPlugin('myAIAgent', async (context) => {
      context.agentSignal = await myAIAgent.analyze(context);
      return context;
    });
*/

const logger = require("../utils/logger");

/** @type {Map<string, Function>} */
const _plugins = new Map();

/**
 * Register a named plugin function.
 *
 * @param {string} name   - Unique plugin identifier (used for logging and removal).
 * @param {Function} fn   - Async or sync function: (context) => context | augmentedContext.
 *                          Must return the (possibly enriched) context object.
 */
function registerPlugin(name, fn) {
  if (!name || typeof name !== "string") {
    throw new TypeError("Plugin name must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new TypeError(`Plugin '${name}' must be a function`);
  }

  _plugins.set(name, fn);
  logger.info(`OpportunityPlugin registered: ${name}`);
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

/**
 * Run all registered plugins sequentially on the given context object.
 * Each plugin receives the (possibly already enriched) context from the
 * previous plugin. Plugin failures are caught and logged so that one
 * failing plugin never blocks the rest of the pipeline.
 *
 * @param {object} context  - The integrated market view produced by integrationEngine.
 * @returns {Promise<object>} The final, potentially enriched context.
 */
async function runPlugins(context) {
  if (!_plugins.size) return context;

  let result = context;

  for (const [name, fn] of _plugins) {
    try {
      const augmented = await fn(result);
      if (augmented && typeof augmented === "object" && !Array.isArray(augmented)) {
        result = augmented;
      } else if (augmented !== undefined) {
        logger.warn(
          `OpportunityPlugin '${name}' returned an invalid type (${Array.isArray(augmented) ? "array" : typeof augmented}) – result unchanged`
        );
      }
    } catch (err) {
      logger.warn(`OpportunityPlugin '${name}' failed – skipping`, {
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
