import { resolveCodePricedCost } from "./pricingResolver.js";

export const ENRICHMENT_PRICING_ENV = "ENRICHMENT_CODE_PRICING_JSON";

let cachedRaw;
let cachedConfig;

function configurationError(message) {
  const error = new Error(
    `enrichment billing configuration unavailable: ${message}`,
  );
  error.status = 503;
  error.code = "enrichment_billing_unavailable";
  return error;
}

function parseAmount(value) {
  const amount = String(value ?? "");
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) {
    throw configurationError("invalid code-based amount");
  }
  return amount;
}

export function parseEnrichmentCodePricing(
  raw = process.env[ENRICHMENT_PRICING_ENV],
) {
  const source = String(raw || "").trim();
  if (!source) throw configurationError(`${ENRICHMENT_PRICING_ENV} is missing`);
  if (source === cachedRaw && cachedConfig) return cachedConfig;

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw configurationError(`${ENRICHMENT_PRICING_ENV} is not valid JSON`);
  }
  if (!String(parsed?.pricing_code_version || "").trim()) {
    throw configurationError("pricing_code_version is missing");
  }
  if (!parsed.items || typeof parsed.items !== "object") {
    throw configurationError("items are missing");
  }

  const items = {};
  for (const [item, entry] of Object.entries(parsed.items)) {
    const currency = String(entry?.currency || "")
      .trim()
      .toUpperCase();
    const connectionId = String(entry?.connection_id || "").trim();
    if (!/^[A-Z]{3}$/.test(currency) || !connectionId) {
      throw configurationError(
        `${item} requires currency and a real Connection`,
      );
    }
    items[item] = {
      amount: parseAmount(entry.amount),
      currency,
      connectionId,
    };
  }

  cachedRaw = source;
  cachedConfig = Object.freeze({
    pricingCodeVersion: String(parsed.pricing_code_version),
    items: Object.freeze(items),
  });
  return cachedConfig;
}

/**
 * Resolve only through the existing in-code/legacy-rate branch. The function
 * has no Convex projection argument, making that dependency impossible here.
 */
export function resolveEnrichmentCodePrice(item, options = {}) {
  const config = options.config || parseEnrichmentCodePricing(options.raw);
  const entry = config.items[item];
  if (!entry) throw configurationError(`${item} has no code-based price`);

  const pricingResolution = resolveCodePricedCost({
    usage: { request: "1" },
    legacyRates: [
      {
        meter: "request",
        amount: entry.amount,
        unitSize: 1,
        qualifiers: {},
      },
    ],
    legacyCurrency: entry.currency,
    pricingCodeVersion: config.pricingCodeVersion,
  });
  if (pricingResolution.pricingSource !== "legacy_runtime_rate") {
    throw configurationError(
      `${item} did not resolve through legacy_runtime_rate`,
    );
  }
  return {
    connectionId: entry.connectionId,
    pricingCodeVersion: config.pricingCodeVersion,
    unitAmount: entry.amount,
    pricingResolution,
  };
}
