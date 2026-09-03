function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

function fraction(numerator, denominator = 1n) {
  if (denominator === 0n) throw new Error('zero denominator');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (numerator / divisor) * sign,
    denominator: (denominator / divisor) * sign,
  };
}

function parseDecimal(value) {
  const match = String(value).match(/^(0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!match) throw new Error(`invalid decimal ${value}`);
  const scale = match[2]?.length || 0;
  return fraction(BigInt(match[1] + (match[2] || '')), 10n ** BigInt(scale));
}

function add(left, right) {
  return fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left, right) {
  return fraction(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left, right) {
  return fraction(left.numerator * right.denominator, left.denominator * right.numerator);
}

function decimalString(value, precision = 18) {
  const negative = value.numerator < 0n;
  let numerator = negative ? -value.numerator : value.numerator;
  const integer = numerator / value.denominator;
  let remainder = numerator % value.denominator;
  let decimals = '';
  while (remainder && decimals.length < precision) {
    remainder *= 10n;
    decimals += String(remainder / value.denominator);
    remainder %= value.denominator;
  }
  decimals = decimals.replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${decimals ? `.${decimals}` : ''}`;
}

function applies(required = {}, served = {}) {
  return Object.entries(required).every(([key, value]) => served[key] === value);
}

function calculate(rates, usage, qualifiers, source) {
  if (!Object.values(usage).some((units) => parseDecimal(units).numerator > 0n)) return null;
  let total = fraction(0n);
  let score = 0;
  const components = [];
  for (const [meter, rawUnits] of Object.entries(usage)) {
    const units = parseDecimal(rawUnits);
    if (units.numerator < 0n) return null;
    if (units.numerator === 0n) continue;
    const applicable = rates.filter(
      (rate) => rate.meter === meter && applies(rate.qualifiers, qualifiers),
    );
    if (!applicable.length) return null;
    const specificity = Math.max(
      ...applicable.map((rate) => Object.keys(rate.qualifiers || {}).length),
    );
    const selected = applicable.filter(
      (rate) => Object.keys(rate.qualifiers || {}).length === specificity,
    );
    if (
      selected.length !== 1 ||
      !Number.isInteger(selected[0].unitSize) ||
      selected[0].unitSize <= 0
    ) {
      return null;
    }
    let rate;
    try {
      rate = parseDecimal(selected[0].amount);
    } catch {
      return null;
    }
    const subtotal = multiply(divide(units, fraction(BigInt(selected[0].unitSize))), rate);
    total = add(total, subtotal);
    score += specificity;
    components.push({
      meter,
      units: decimalString(units),
      unit_size: String(selected[0].unitSize),
      rate: decimalString(rate),
      subtotal: decimalString(subtotal),
      source,
    });
  }
  components.sort((left, right) => left.meter.localeCompare(right.meter));
  return { amount: decimalString(total), components, score };
}

function resolveCards(cards, usage, qualifiers, pricingSource) {
  const candidates = [];
  for (const card of cards) {
    if (card.pricing?.billingMode === 'no_cost') {
      candidates.push({
        score: 0,
        result: {
          amount: '0',
          currency: card.pricing.currency,
          pricing: 'no_cost',
          pricingSource: 'zero_cost_contract',
          components: [],
          priceCardId: card.id,
          priceEffectiveAt: card.activeFrom,
        },
      });
      continue;
    }
    const calculated = calculate(
      card.pricing?.rates || [],
      usage,
      qualifiers,
      'configured_rate',
    );
    if (!calculated) continue;
    candidates.push({
      score: calculated.score,
      result: {
        amount: calculated.amount,
        currency: card.pricing.currency,
        pricing: 'estimated',
        pricingSource,
        components: calculated.components,
        priceCardId: card.id,
        priceEffectiveAt: card.activeFrom,
      },
    });
  }
  if (!candidates.length) return null;
  const best = Math.max(...candidates.map(({ score }) => score));
  const selected = candidates.filter(({ score }) => score === best);
  return selected.length === 1 ? selected[0].result : null;
}

export function resolveCallCost({
  billing = null,
  usage = {},
  qualifiers = {},
  occurredAt = Date.now(),
  providerBilling = null,
  legacyRates = [],
  legacyCurrency = null,
  legacyRateSource = null,
} = {}) {
  const unknownCurrency = providerBilling?.currency || billing?.accountingCurrency || 'XXX';
  if (providerBilling?.amount != null && providerBilling?.currency) {
    try {
      const amount = parseDecimal(providerBilling.amount);
      if (amount.numerator >= 0n) {
        return {
          amount: decimalString(amount),
          currency: providerBilling.currency,
          pricing: 'actual',
          pricingSource: 'provider_amount',
          components: [],
        };
      }
    } catch {}
  }
  if (providerBilling?.rates?.length && providerBilling?.currency) {
    const calculated = calculate(
      providerBilling.rates,
      usage,
      qualifiers,
      'provider_rate',
    );
    if (calculated) {
      return {
        amount: calculated.amount,
        currency: providerBilling.currency,
        pricing: 'actual',
        pricingSource: 'provider_rate',
        components: calculated.components,
      };
    }
  }
  if (billing) {
    const active = (billing.rateCards || []).filter(
      (card) =>
        card.activeFrom <= occurredAt &&
        (card.activeUntil == null || occurredAt < card.activeUntil),
    );
    const connection = resolveCards(
      active.filter((card) => card.connectionId === billing.connectionId),
      usage,
      qualifiers,
      'connection_rate',
    );
    if (connection) return connection;
    const connector = resolveCards(
      active.filter((card) => !card.connectionId),
      usage,
      qualifiers,
      'connector_rate',
    );
    if (connector) return connector;
  }
  if (legacyRates.length && legacyCurrency) {
    const calculated = calculate(legacyRates, usage, qualifiers, 'legacy_runtime_rate');
    if (calculated) {
      return {
        amount: calculated.amount,
        currency: legacyCurrency,
        pricing: 'estimated',
        pricingSource: 'legacy_runtime_rate',
        components: calculated.components,
        legacyRateSource,
      };
    }
  }
  return {
    amount: '0',
    currency: unknownCurrency,
    pricing: 'unknown',
    pricingSource: 'none',
    components: [],
  };
}

/**
 * Resolve a product whose pricing authority is the current in-code runtime
 * table. The deliberately narrow signature cannot accept a Convex/billing
 * projection or provider rate, so callers cannot accidentally change the
 * source priority for Spec 102 enrichment items.
 */
export function resolveCodePricedCost({
  usage = {},
  qualifiers = {},
  legacyRates = [],
  legacyCurrency = null,
  pricingCodeVersion = null,
} = {}) {
  return resolveCallCost({
    usage,
    qualifiers,
    legacyRates,
    legacyCurrency,
    legacyRateSource: pricingCodeVersion,
  });
}
