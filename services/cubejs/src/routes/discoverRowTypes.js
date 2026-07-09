/**
 * Row-type discovery probe (cxs2 spec 080, research D3 — additive).
 *
 * POST /api/v1/discover-row-types
 * Body: { table: 'semantic_events'|'entities'|'data_points', schema, since?, limitPerType? }
 *
 * Two EXACT passes per run (never sampled):
 *  1. Novelty snapshot (cursor-independent, every run): full GROUP BY over the
 *     discriminator — cheap on LowCardinality/leading-PK columns — so a row
 *     type present in the data is NEVER missed regardless of cursor semantics.
 *  2. Stats pass (per-table strategy):
 *     - semantic_events: delta via compound cursor (timestamp, event_gid),
 *       tie-safe strictly-greater tuple compare; counts accumulate caller-side.
 *     - data_points: delta via compound cursor (timestamp, signature); same.
 *     - entities: NO row timestamp exists — `_version` (monotone epoch-ms)
 *       cursor for change detection; counts are a CURRENT-STATE snapshot
 *       (uniqExact(gid) — ReplacingMergeTree semantics), returned by the
 *       novelty pass.
 *     The delta scan also gathers the observed inventory (map keys per Map
 *     column + JSON paths, both capped) for the changed slice only.
 *
 * The next cursor derives from the SCAN BOUNDS (max seen tuple), never wall
 * clock. Read-only; partition scoping comes from the caller's token scope,
 * same as profile-table.
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
    tsExpr: 'toUnixTimestamp64Milli(timestamp)',
    tie: 'event_gid',
    // count() + max(ts) are the PRIMARY active-indicator (owner) — computed in
    // the FULL novelty pass as a SNAPSHOT, so they are always correct and never
    // depend on the delta cursor. count()/min()/max() are cheap columnar
    // aggregates; only the dedup (types/sources/JSON inventory) stays on the
    // delta for efficiency.
    totalCountExpr: 'count()',
    cursorMode: 'tie',
  },
  entities: {
    discriminator: 'type',
    // `_version` IS monotone epoch-ms (entities.sql:112) — the seen-timestamp
    // axis and the change-detection cursor in one.
    tsExpr: '_version',
    versionExpr: '_version',
    totalCountExpr: 'uniqExact(gid)',
    cursorMode: 'version',
  },
  data_points: {
    discriminator: 'series_gid',
    tsExpr: 'toUnixTimestamp(timestamp) * 1000',
    tie: 'signature',
    totalCountExpr: 'count()',
    cursorMode: 'tie',
  },
};

const escapeSql = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export default async (req, res, cubejs) => {
  const { securityContext } = req;
  const { table, schema, since, limitPerType, headSchema } = req.body || {};

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

    // ── Pass 1: novelty snapshot (every run, cursor-independent) ──
    // The SNAPSHOT of the ACTIVE indicators — total count + first/last seen —
    // per key over the whole partition. Always correct regardless of the delta
    // cursor (owner: count + max(ts) decide whether a type is active). These
    // are cheap columnar aggregates; the expensive dedup is on the delta only.
    const noveltySelect = [
      `${disc} AS key`,
      `${config.totalCountExpr} AS total_count`,
      `min(${config.tsExpr}) AS min_ts`,
      `max(${config.tsExpr}) AS max_ts`,
    ].join(', ');
    const noveltyRows = await driver.query(
      `SELECT ${noveltySelect} FROM ${qualified} WHERE ${partitionCond} GROUP BY key`
    );

    // ── Pass 2: stats delta (per-table cursor strategy) ──
    let deltaCond;
    let cursorBoundSelect;
    if (config.versionExpr) {
      const sinceVersion = Number(since?.version) || 0;
      deltaCond = sinceVersion > 0 ? `${config.versionExpr} > ${sinceVersion}` : null;
      cursorBoundSelect = `max(${config.versionExpr}) AS bound_ts`;
    } else {
      const sinceTs = Number(since?.timestamp) || 0;
      const sinceTie = typeof since?.tie === 'string' ? since.tie : '';
      deltaCond =
        sinceTs > 0
          ? `(${config.tsExpr}, toString(${config.tie})) > (${sinceTs}, '${escapeSql(sinceTie)}')`
          : null;
      // argMax over the (ts, tie) tuple gives the tie-breaker AT the scan bound
      cursorBoundSelect =
        `max(${config.tsExpr}) AS bound_ts, `
        + `argMax(toString(${config.tie}), tuple(${config.tsExpr}, toString(${config.tie}))) AS bound_tie`;
    }

    const inventorySelects = [
      ...mapColumns.map(
        (col) => `arraySort(groupUniqArrayArray(${mapKeyCap})(mapKeys(${col}))) AS mk_${col}`
      ),
      ...jsonColumns.map(
        (col) => `arraySort(groupUniqArrayArray(${jsonPathCap + 1})(JSONAllPaths(${col}))) AS jp_${col}`
      ),
    ];
    const statsWhere = [partitionCond, ...(deltaCond ? [deltaCond] : [])].join(' AND ');
    // The delta pass carries ONLY the expensive, union-mergeable evidence
    // (distinct Segment types, source labels, map keys, JSON paths). Counts and
    // first/last-seen come from the full novelty pass above. `uniqExact` gives
    // the TRUE cardinality so cxs2 can flag when the (capped) display array was
    // truncated instead of silently losing values.
    const OBSERVED_TYPES_CAP = 100;
    const OBSERVED_SOURCES_CAP = 256;
    const statsRows = await driver.query(
      `SELECT ${[
        `${disc} AS key`,
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
      ].join(', ')} FROM ${qualified} WHERE ${statsWhere} GROUP BY key`
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

    // Next cursor = the max (ts, tie) of the DELTA slice (not the whole table).
    // The delta already contains the newest rows, so its max IS the current
    // global bound — scoping to the delta avoids a second full-partition scan.
    const boundRows = await driver.query(
      `SELECT ${cursorBoundSelect} FROM ${qualified} WHERE ${statsWhere}`
    );
    const boundTs = Number(boundRows?.[0]?.bound_ts) || 0;
    let cursor = since ?? null;
    if (boundTs > 0) {
      cursor = config.versionExpr
        ? { version: boundTs }
        : { timestamp: boundTs, tie: String(boundRows?.[0]?.bound_tie ?? '') };
    }

    const statsByKey = new Map(statsRows.map((r) => [String(r.key), r]));
    const rowTypes = noveltyRows.map((novelty) => {
      const key = String(novelty.key);
      const stats = statsByKey.get(key) || null;
      const inventory = { mapKeys: {}, jsonPaths: [] };
      let jsonPathsTruncated = false;
      if (stats) {
        for (const col of mapColumns) {
          const keys = stats[`mk_${col}`];
          if (Array.isArray(keys) && keys.length > 0) inventory.mapKeys[col] = keys.map(String);
        }
        for (const col of jsonColumns) {
          const paths = stats[`jp_${col}`];
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
      }
      const observedTypes = (stats?.observed_types ?? []).map(String);
      const observedSources = (stats?.observed_sources ?? [])
        .map((s) => String(s))
        .filter((s) => s.length > 0);
      // Truncation flag — the (capped) display array vs the exact cardinality.
      const observedSourcesTotal = Number(stats?.observed_sources_total) || observedSources.length;
      const observedTypesTruncated = Number(stats?.observed_types_total) > observedTypes.length;
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
        // total_count is the SNAPSHOT over the full partition — always correct
        // (the active indicator), independent of the delta cursor.
        snapshotCount: Number(novelty.total_count) || 0,
        minTs: Number(novelty.min_ts) || 0,
        maxTs: Number(novelty.max_ts) || 0,
        inventory: {
          ...(Object.keys(inventory.mapKeys).length > 0 ? { mapKeys: inventory.mapKeys } : {}),
          jsonPaths: inventory.jsonPaths,
          ...(jsonPathsTruncated ? { jsonPathsTruncated: true } : {}),
        },
      };
    });

    return res.json({ table, rowTypes, cursor });
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
