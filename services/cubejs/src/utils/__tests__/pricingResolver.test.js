import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { resolveCallCost, resolveCodePricedCost } from '../pricingResolver.js';

describe('pricing resolver', () => {
  it('keeps code pricing as the only authority for enrichment-style items', () => {
    const resolved = resolveCodePricedCost({
      usage: { request: 1 },
      legacyRates: [
        { meter: 'request', unitSize: 1, amount: '0.25', qualifiers: {} },
      ],
      legacyCurrency: 'USD',
      pricingCodeVersion: 'test-code-v1',
    });
    assert.equal(resolved.amount, '0.25');
    assert.equal(resolved.pricingSource, 'legacy_runtime_rate');
    assert.equal(resolved.legacyRateSource, 'test-code-v1');
    assert.ok(
      !['connection_rate', 'connector_rate'].includes(resolved.pricingSource),
      'the legacy-only API has no Convex/billing projection input',
    );
  });

  it('matches every shared cross-language fixture', async () => {
    const embeddedRaw = await readFile(
      new URL('./fixtures/pricing-resolution.json', import.meta.url),
      'utf8',
    );
    if (process.env.FRAIOS_PRICING_FIXTURE) {
      const canonicalRaw = await readFile(process.env.FRAIOS_PRICING_FIXTURE, 'utf8');
      assert.deepEqual(
        JSON.parse(embeddedRaw),
        JSON.parse(canonicalRaw),
        'embedded pricing fixture drifted from the canonical Fraios fixture',
      );
    }
    const fixture = JSON.parse(embeddedRaw);
    for (const scenario of fixture.scenarios) {
      const resolved = resolveCallCost({
        billing: scenario.billing,
        usage: scenario.usage,
        qualifiers: scenario.qualifiers,
        occurredAt: scenario.occurredAt,
        providerBilling: scenario.providerBilling,
        legacyRates: scenario.legacyRates,
        legacyCurrency: scenario.legacyCurrency,
        legacyRateSource: scenario.legacyRateSource,
      });
      assert.equal(Number(resolved.amount), Number(scenario.expected.amount), scenario.name);
      assert.equal(resolved.currency, scenario.expected.currency, scenario.name);
      assert.equal(resolved.pricing, scenario.expected.pricing, scenario.name);
      assert.equal(resolved.pricingSource, scenario.expected.pricingSource, scenario.name);
      assert.equal(resolved.priceCardId || null, scenario.expected.priceCardId, scenario.name);
      assert.equal(resolved.legacyRateSource || null, scenario.expected.legacyRateSource || null, scenario.name);
      assert.equal(resolved.components.length, scenario.expected.componentCount, scenario.name);
    }
  });
});
