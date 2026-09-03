import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { resolveSystemLLMBilling } from '../connectionBilling.js';
import { buildConnectionCalled } from '../eventEmitter.js';

const billing = {
  connectionId: 'system-connection-1',
  connectorId: 'connector-openai',
  provider: 'openai',
  accountingCurrency: 'USD',
  rateCards: [
    {
      id: 'connector-card',
      activeFrom: 0,
      pricing: {
        currency: 'USD',
        billingMode: 'metered',
        rates: [
          {
            meter: 'input_tokens',
            unitSize: 1000,
            amount: '2.00',
            qualifiers: { model: 'gpt-test' },
          },
          {
            meter: 'output_tokens',
            unitSize: 1000,
            amount: '4.00',
            qualifiers: { model: 'gpt-test' },
          },
        ],
      },
    },
  ],
};

afterEach(() => {
  delete process.env.CXS_LLM_CONNECTION_ID;
  delete process.env.CXS_LLM_BILLING_JSON;
});

describe('synmetrix Connection Called pricing', () => {
  it('loads only the non-secret projection for the configured system connection', () => {
    process.env.CXS_LLM_CONNECTION_ID = 'system-connection-1';
    process.env.CXS_LLM_BILLING_JSON = JSON.stringify(billing);
    assert.deepEqual(resolveSystemLLMBilling(), {
      connectionId: 'system-connection-1',
      billing,
    });
  });

  it('freezes configured pricing and both connection/model involves', () => {
    const event = buildConnectionCalled({
      partition: 'tenant.is',
      accountId: 'account-1',
      userId: 'user-1',
      provider: 'openai',
      model: 'gpt-test',
      item: 'smart-generation:enrich',
      connectionId: 'system-connection-1',
      billing,
      usage: { input_tokens: 1000, output_tokens: 500 },
      callIdentity: 'provider-call-1',
      timestamp: '2026-08-29T00:00:00.000Z',
    });
    assert.equal(event.analysis[0].amount, 4);
    assert.equal(event.properties.pricing, 'estimated');
    assert.equal(event.properties.pricing_source, 'connector_rate');
    assert.equal(event.properties.price_card_id, 'connector-card');
    assert.ok(
      event.involves.some(
        (row) => row.role === 'USES_CONNECTION' && row.id === 'system-connection-1',
      ),
    );
    assert.ok(
      event.involves.some((row) => row.role === 'USES_MODEL' && row.id === 'gpt-test'),
    );
  });
});
