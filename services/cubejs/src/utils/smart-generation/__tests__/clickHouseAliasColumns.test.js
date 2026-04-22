import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fetchClickHouseAliasColumnNames } from '../clickHouseAliasColumns.js';

describe('fetchClickHouseAliasColumnNames', () => {
  it('returns distinct names from driver rows (ALIAS-only query)', async () => {
    const driver = {
      query: async (sql) => {
        assert.ok(sql.includes("default_kind = 'ALIAS'"), sql);
        return [{ name: 'duration_ratio' }, { name: 'other_alias' }];
      },
    };
    const names = await fetchClickHouseAliasColumnNames(driver, 'dev', 'semantic_events');
    assert.deepStrictEqual(names, ['duration_ratio', 'other_alias']);
  });

  it('reads name from alternate row keys', async () => {
    const driver = {
      query: async () => [{ Name: 'col_a' }],
    };
    const names = await fetchClickHouseAliasColumnNames(driver, 'd', 't');
    assert.deepStrictEqual(names, ['col_a']);
  });

  it('returns [] when query throws', async () => {
    const driver = {
      query: async () => {
        throw new Error('no system.columns');
      },
    };
    const names = await fetchClickHouseAliasColumnNames(driver, 'd', 't');
    assert.deepStrictEqual(names, []);
  });
});
