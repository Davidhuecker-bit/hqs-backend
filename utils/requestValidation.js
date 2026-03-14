"use strict";

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/;

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function badRequest(res, message, details = {}) {
  return res.status(400).json({
    success: false,
    message,
    ...details,
  });
}

function parseInteger(value, options = {}) {
  const {
    defaultValue = null,
    min = null,
    max = null,
    required = false,
    label = "value",
  } = options;

  if (!hasValue(value)) {
    if (required) {
      return { error: `${label} is required` };
    }
    return { value: defaultValue };
  }

  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return { error: `${label} must be an integer` };
  }

  let normalized = numeric;
  if (min !== null && normalized < min) normalized = min;
  if (max !== null && normalized > max) normalized = max;

  return { value: normalized };
}

function parseNumber(value, options = {}) {
  const {
    defaultValue = null,
    min = null,
    max = null,
    required = false,
    label = "value",
  } = options;

  if (!hasValue(value)) {
    if (required) {
      return { error: `${label} is required` };
    }
    return { value: defaultValue };
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return { error: `${label} must be a number` };
  }

  let normalized = numeric;
  if (min !== null && normalized < min) normalized = min;
  if (max !== null && normalized > max) normalized = max;

  return { value: normalized };
}

function parseBoolean(value, options = {}) {
  const {
    defaultValue = false,
    label = "value",
  } = options;

  if (!hasValue(value)) {
    return { value: defaultValue };
  }

  if (value === true || value === false) {
    return { value };
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return { value: true };
  }

  if (["0", "false", "no"].includes(normalized)) {
    return { value: false };
  }

  return { error: `${label} must be a boolean flag` };
}

function parseEnum(value, allowedValues, options = {}) {
  const {
    defaultValue = null,
    required = false,
    label = "value",
  } = options;

  if (!hasValue(value)) {
    if (required) {
      return { error: `${label} is required` };
    }
    return { value: defaultValue };
  }

  const normalized = String(value).trim().toLowerCase();
  if (!allowedValues.includes(normalized)) {
    return {
      error: `${label} must be one of: ${allowedValues.join(", ")}`,
    };
  }

  return { value: normalized };
}

function parseSymbol(value, options = {}) {
  const {
    required = false,
    label = "symbol",
  } = options;

  if (!hasValue(value)) {
    if (required) {
      return { error: `${label} is required` };
    }
    return { value: null };
  }

  const normalized = String(value).trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(normalized)) {
    return {
      error: `${label} must contain only letters, numbers, dots or hyphens`,
    };
  }

  return { value: normalized };
}

module.exports = {
  badRequest,
  parseBoolean,
  parseEnum,
  parseInteger,
  parseNumber,
  parseSymbol,
};
