/**
 * Row-type discovery probe (cxs2 spec 080, research D3 — additive).
 *
 * POST /api/v1/discover-row-types
 * Body: { table: 'semantic_events'|'entities'|'data_points', schema, limitPerType? }
 *
 * ONE EXACT, STATELESS full-partition snapshot per run (never sampled, no
 * cursor). A single `GROUP BY` over the discriminator carries EVERYTHING —
 * count + first/last-seen + the observed evidence (Segment types, source
 * labels) + the inventory (map keys per Map column + JSON paths, both capped).
 *
 * Why no cursor: a delta cursor on the event `timestamp` is unsound because
 * event-time is a business attribute, not an ingestion watermark — forecast
 * rows carry FUTURE timestamps (poison the cursor, stall the delta forever) and
 * backfills carry PAST timestamps (sit below the cursor, never scanned). The
 * only clean ingestion axis (`received_at`) is ~68% null, so it can't replace
 * it. Since the counts already came from a full cursor-independent scan and the
 * inventory is union-merged (idempotent) caller-side, folding the inventory
 * into that one full scan makes discovery a pure, stateless snapshot — immune
 * to forecasts, backfills, late data and clock skew, permanently. The cost is
 * one bounded aggregation per (manual) run; the caps below bound memory.
 *
 * Read-only; partition scoping comes from the caller's token scope, same as
 * profile-table.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TABLES = {
  semantic_events: {
    // Row-type identity = the `event` value when present; Segment-style rows
    // without one (page/screen/identify/log/custom) fall back to their TYPE
    // CLASS as a synthetic `type:<type>` key (cxs2 080 — owner amendment:
    // `type` joins the discriminator; real event names are Title-Case past
    // tense and can never collide with the prefix).
    discriminator: "if(empty(event), concat('type:', type), event)",
    evidence: 'type',
    // cxs2 080 (owner refinement): capture the distinct set of SOURCE labels an
    // event type is observed from. `source.label` is a scalar Nullable(String)
    // per row (the dot is a column-name convention, NOT a Nested/Array column),
    // so one event type spans several sources across rows — grouUniqArray drops
    // NULLs (system/platform events with no source fall out cleanly). Back-tick
    // required because of the dot.
    sourceEvidence: '`source.label`',
    // Seen-timestamp axis (min/max only — no longer a cursor). count()/min/max
    // are cheap columnar aggregates computed over the full partition.
    tsExpr: 'toUnixTimestamp64Milli(timestamp)',
    totalCountExpr: 'count()',
  },
  entities: {
    discriminator: 'type',
    // `_version` IS monotone epoch-ms (entities.sql:112) — the seen-timestamp axis.
    tsExpr: '_version',
    // Current-state count (ReplacingMergeTree): the deduped cardinality.
    totalCountExpr: 'uniqExact(gid)',
  },
  data_points: {
    discriminator: 'series_gid',
    tsExpr: 'toUnixTimestamp(timestamp) * 1000',
    totalCountExpr: 'count()',
  },
};

// Evidence-array display caps (uniqExact gives the true cardinality so cxs2 can
// flag when the capped array truncated instead of silently losing values).
const OBSERVED_TYPES_CAP = 100;
const OBSERVED_SOURCES_CAP = 256;

const escapeSql = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const { table, schema, limitPerType, headSchema } = req.body || {};

  const config = TABLES[table];
  if (!config) {
    return res.status(400).json({
      code: 'discover_row_types_bad_table',
      message: `table must be one of: ${Object.keys(TABLES).join(', ')}`,
    });
  }
  if (!schema || !IDENT.test(schema)) {
    return res.status(400).json({
      code: 'discover_row_types_bad_schema',
      message: 'A valid schema (database) name is required.',
    });
  }

  const mapKeyCap = Math.min(Math.max(Number(limitPerType) || 100, 10), 500);
  const jsonPathCap = 200;

  let driver;
  try {
    const partition = securityContext.userScope?.dataSource?.partition || null;
    if (!partition) {
      return res.status(403).json({
        code: 'discover_row_types_no_partition',
        message: 'The caller token resolves no partition scope.',
      });
    }

    driver = await cubejs.options.driverFactory({ securityContext });
    const qualified = `${schema}.${table}`;
    const partitionCond = `partition = '${escapeSql(partition)}'`;
    const disc = config.discriminator;

    // Discover the open-ended surfaces dynamically from the live DDL.
    const described = await driver.query(`DESCRIBE TABLE ${qualified}`);
    const mapColumns = described
      .filter((c) => IDENT.test(c.name) && /^Map\(/.test(c.type))
      .map((c) => c.name);
    const jsonColumns = described
      .filter((c) => IDENT.test(c.name) && /^(JSON|Object\('json'\))/.test(c.type))
      .map((c) => c.name);

    // ── One stateless full-partition snapshot (GROUP BY key) ──
    // Count + first/last-seen + evidence (Segment types, source labels) + the
    // inventory (map keys per Map column, JSON paths), all in ONE scan. count()/
    // min/max are cheap columnar aggregates; the dedup/inventory aggregations
    // are memory-bounded by the caps below. No cursor, no delta — the result is
    // the complete, current key set for the partition every run.
    const inventorySelects = [
      ...mapColumns.map(
        (col) => `arraySort(groupUniqArrayArray(${mapKeyCap})(mapKeys(${col}))) AS mk_${col}`
      ),
      ...jsonColumns.map(
        (col) => `arraySort(groupUniqArrayArray(${jsonPathCap + 1})(JSONAllPaths(${col}))) AS jp_${col}`
      ),
    ];
    const snapshotSelect = [
      `${disc} AS key`,
      `${config.totalCountExpr} AS total_count`,
      `min(${config.tsExpr}) AS min_ts`,
      `max(${config.tsExpr}) AS max_ts`,
      ...(config.evidence
        ? [
            `groupUniqArray(${OBSERVED_TYPES_CAP})(${config.evidence}) AS observed_types`,
            `uniqExact(${config.evidence}) AS observed_types_total`,
          ]
        : []),
      ...(config.sourceEvidence
        ? [
            `groupUniqArray(${OBSERVED_SOURCES_CAP})(${config.sourceEvidence}) AS observed_sources`,
            `uniqExact(${config.sourceEvidence}) AS observed_sources_total`,
          ]
        : []),
      ...inventorySelects,
    ].join(', ');
    const snapshotRows = await driver.query(
      `SELECT ${snapshotSelect} FROM ${qualified} WHERE ${partitionCond} GROUP BY key`
    );

    // Series head-label enrichment (cxs2 080 D12): data_points row types are
    // gids — resolve display labels from the series head table when it is
    // reachable. The head database is config-driven per environment
    // (`cst` vs `ql`); a missing head table is non-fatal (labels stay gids).
    const labelsByKey = new Map();
    if (table === 'data_points') {
      const headDb =
        typeof headSchema === 'string' && IDENT.test(headSchema) ? headSchema : schema;
      try {
        const rows = await driver.query(
          `SELECT toString(gid) AS gid, anyLast(label) AS label ` +
            `FROM ${headDb}.timeseries WHERE ${partitionCond} GROUP BY gid`
        );
        for (const row of rows || []) {
          if (row.label) labelsByKey.set(String(row.gid), String(row.label));
        }
      } catch (err) {
        console.warn(`[discoverRowTypes] series head lookup failed (non-fatal): ${err.message}`);
      }
    }

    const rowTypes = snapshotRows.map((snap) => {
      const key = String(snap.key);
      const inventory = { mapKeys: {}, jsonPaths: [] };
      let jsonPathsTruncated = false;
      for (const col of mapColumns) {
        const keys = snap[`mk_${col}`];
        if (Array.isArray(keys) && keys.length > 0) inventory.mapKeys[col] = keys.map(String);
      }
      for (const col of jsonColumns) {
        const paths = snap[`jp_${col}`];
        if (Array.isArray(paths) && paths.length > 0) {
          for (const p of paths) {
            if (inventory.jsonPaths.length >= jsonPathCap) {
              jsonPathsTruncated = true;
              break;
            }
            inventory.jsonPaths.push(String(p));
          }
        }
      }
      inventory.jsonPaths.sort();

      const observedTypes = (snap.observed_types ?? []).map(String);
      const observedSources = (snap.observed_sources ?? [])
        .map((s) => String(s))
        .filter((s) => s.length > 0);
      // Truncation flag — the (capped) display array vs the exact cardinality.
      const observedSourcesTotal = Number(snap.observed_sources_total) || observedSources.length;
      const observedTypesTruncated = Number(snap.observed_types_total) > observedTypes.length;
      const observedSourcesTruncated = observedSourcesTotal > observedSources.length;
      const label = labelsByKey.get(key);
      return {
        key,
        ...(label ? { label } : {}),
        ...(config.evidence ? { observedTypes } : {}),
        ...(config.sourceEvidence
          ? { observedSources, observedSourcesTotal }
          : {}),
        ...(observedTypesTruncated || observedSourcesTruncated
          ? { evidenceTruncated: true }
          : {}),
        // total_count is the SNAPSHOT over the full partition — always the true
        // current total (the active indicator).
        snapshotCount: Number(snap.total_count) || 0,
        minTs: Number(snap.min_ts) || 0,
        maxTs: Number(snap.max_ts) || 0,
        inventory: {
          ...(Object.keys(inventory.mapKeys).length > 0 ? { mapKeys: inventory.mapKeys } : {}),
          jsonPaths: inventory.jsonPaths,
          ...(jsonPathsTruncated ? { jsonPathsTruncated: true } : {}),
        },
      };
    });

    // `cursor: null` — discovery is stateless now; the field is retained for
    // response-shape back-compat with the cxs2 client (which ignores it).
    return res.json({ table, rowTypes, cursor: null });
  } catch (err) {
    console.error('[discoverRowTypes]', err);
    return res.status(500).json({
      code: 'discover_row_types_error',
      message: err.message || String(err),
    });
  } finally {
    if (driver && driver.release) {
      await driver.release();
    }
  }
};
