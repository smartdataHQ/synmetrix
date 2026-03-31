# Cube Modeling Principles

These principles govern how we design, build, and maintain Cube.dev semantic layer models. They apply to every cube we create. This document is domain-agnostic — domain-specific details belong in the cubes themselves.

---

## A. Use-Case First

Don't start building until you fully understand what questions the cube needs to answer. Discuss the use cases in detail with the user before touching YAML.

- **One cube = one grain.** Each cube models exactly one analytical grain (stay event, trip event, vehicle lifetime, stockout occurrence). If the use case needs multiple grains, that's multiple cubes. The grain determines the primary key — if you can't express it as a composite key, the grain is wrong.

- **Cube families model the same domain at different grains.** A domain may need an event-level cube, an entity-level cube, and a time-series cube. Each grain answers different questions. Identify which grains the use case requires before building.

- **Segments encode analyst intent.** Name segments for what the analyst wants to see (`exclude_pickup_dropoff`, `confirmed_only`, `inter_region_only`), not for the technical filter they apply. Each segment should trace to a question the user actually asks.

- **Hierarchies encode drill-down paths.** If the use case involves drilling from region → municipality → locality → location, declare that path explicitly. The hierarchy makes the analytical workflow visible and enables MDX API drill-down for pivot table consumers.

- **Start small.** Begin with the core metrics the business actively debates — 3-5 tier-0 metrics — rather than modeling everything at once. Expand as use cases demand. Over-engineering is a recognized anti-pattern across the industry.

---

## B. Probe the Data Infrastructure

Understand the source tables, their schema, how data flows in, what fields are available, what the grain is, what's in nested structures. Don't assume — query and explore.

- **Map the source shape before designing.** Know the table, the partition scheme, the event types, the nested map/array structures (`dimensions[]`, `metrics[]`, `flags[]`, `location.*`, `involves.*`). The cube's SQL is an extraction and reshaping of this raw shape.

- **Understand refresh cadence and latency.** How often does data arrive? What's the delay? This determines pre-aggregation refresh windows and what you tell dashboards about data freshness.

- **Identify the natural key.** The grain determines the primary key. Build composite keys as `concat(partition, '|', entity_parts...)` — the key encodes the grain.

- **Partition is always present.** Every cube carries `partition` as its first dimension and first pre-aggregation index column. It's a tenant/data-source discriminator that scopes all queries.

- **Understand join cardinality before modeling relationships.** When cubes need joins, explicitly declare `many_to_one`, `one_to_many`, or `one_to_one`. Undeclared or incorrect cardinality leads to fan traps — chained one-to-many joins that silently duplicate rows and inflate aggregates. Cube's pre-aggregation matcher will refuse to match if measures are multiplied via `one_to_many`, so getting this right is critical for both correctness and performance.

- **Understand ClickHouse ORDER BY alignment.** The single most impactful ClickHouse performance decision is aligning the table's ORDER BY key with query filter patterns. Data is stored in granules of 8,192 rows with a sparse index — queries whose WHERE clause matches a prefix of the ORDER BY key skip irrelevant granules entirely. Queries filtering on columns not in the ORDER BY prefix trigger full scans. When writing Cube SQL, ensure the most common filter columns (typically `partition`, `event`, time dimensions) align with the source table's ORDER BY prefix. Rule of thumb: low cardinality columns first, high cardinality last.

- **ClickHouse favors denormalized, append-only data.** Our source tables (`cst.semantic_events`) are append-only event streams — the ideal ClickHouse pattern. Doing all joins and denormalization in the Cube SQL layer (rather than requiring pre-joined tables) is correct for this pattern. Avoid multi-table JOINs at query time in ClickHouse; prefer extracting and flattening in the Cube SQL block.

---

## C. Row-Level SQL Foundation

When the use case needs transformations, build SQL that delivers one row per grain unit with all computed columns ready. Cube.dev sits on top of flat row-level results.

- **Push all computation into SQL.** Window functions, array operations, aggregations, joins — everything happens in the SQL block. Cube dimensions and measures reference pre-computed columns. The cube layer is a thin projection, not a computation layer.

- **Layered subquery architecture.** Build complex analytics in discrete layers, each adding one concern: base extraction → window functions → array accumulation → change-point detection → derived columns. Each layer is a `SELECT * FROM (...)` that adds columns without modifying previous ones.

- **Work around cube.dev's parser, not against it.** Always wrap SQL in `SELECT * FROM (...)`. Never rely on HAVING, WITH/CTE, or Jinja functions in SQL blocks. Accept the parser's limitations and design SQL that reads naturally within those constraints. Note: the Cube style guide recommends CTEs over subqueries for readability — this applies to simpler SQL, but our complex analytical SQL requires nested subqueries due to parser limitations.

- **Use `sql_table` for simple cases.** When a cube maps directly to a table without transformations, use `sql_table` instead of `sql`. Reserve `sql` for when you need extraction, reshaping, or computation.

- **Cube-to-cube SQL composition.** When a higher-grain cube builds on a lower-grain cube, use `{other_cube.sql()}` to reference the base SQL. This avoids duplication and keeps the analytical lineage explicit.

- **Use `add_group_by` for nested aggregates.** When you need an aggregate-of-an-aggregate (e.g., average stays per booking), prefer Cube's multi-stage `add_group_by` over pushing nested aggregation into the SQL layer. This keeps the computation in Cube's optimization path:

  ```yaml
  measures:
    - name: avg_booking_stay_count
      multi_stage: true
      sql: "{count}"
      type: avg
      add_group_by:
        - booking
  ```

  This computes count per booking in the inner stage, then averages across bookings in the outer stage.

---

## D. Only What's Needed

Every dimension, measure, segment, and filter must trace back to the use case. No speculative "might be useful" fields.

- **Raw values as dimensions, interpretation as tiers.** Expose the raw numeric value AND a derived tier dimension only when the use case requires both ad-hoc analysis on the value and grouping/filtering by business meaning.

- **Tiers are `case/when` with exhaustive coverage.** Every tier dimension has a final `else` label. No row is unclassified.

- **Segments and filtered measures are complementary.** A filtered measure gives you a number within the full dataset. A segment restricts the entire query context. Create both only when the use case requires both query patterns. Use segments when the filter logic is complex (multi-column, OR conditions) or encodes reusable business intent. Use dimension filters when the filter value changes per user query.

- **Hide internal plumbing.** Window function intermediates, array buffers, index arrays — anything the cube needs internally but consumers shouldn't see gets `public: false`. The public API exposes only what serves the use case.

- **Avoid `FILTER_PARAMS`.** Heavy use of `FILTER_PARAMS` in SQL blocks is a code smell — it signals that the data model is trying to compensate for upstream issues. Limit its use to predicate pushdown optimization only. If you find yourself relying on it, rethink the modeling approach.

- **Consider subquery dimensions for cross-cube aggregates.** When you need a measure from a joined cube as a filterable/groupable dimension, use `sub_query: true` rather than duplicating the logic. Use `propagate_filters_to_sub_query: true` when the subquery should respect the main query's filters.

---

## E. All Calculated Metrics That Support Analysis

Within the use case scope, be thorough. If an analyst working the use case would naturally want to derive a metric, pre-compute it.

- **The cube is the single source of truth for all calculated KPIs.** No metric should be computed outside the cube — not in the dashboard, not in a notebook, not in a downstream tool. If an analyst needs a derived number, it must be defined as a measure in the cube. The core purpose: every consumer calculates a metric the exact same way. When "exploration rate" or "long stay rate" is defined once in the cube, there is zero risk of two dashboards computing it differently. If a dashboard is doing arithmetic on cube measures, that arithmetic belongs in the cube instead.

- **Research industry KPIs before designing derived metrics.** Every industry has established metrics that analysts expect and can benchmark against. Before proposing calculated measures, research the domain's standard KPIs (e.g., tourism analytics, SaaS metrics, logistics fleet KPIs). Prioritize industry-standard metrics that are computable from the cube's grain. Only propose custom metrics when no standard KPI answers the question, and document why.

- **Counts come in pairs: total + filtered.** The base `count` plus filtered counts for each meaningful subset. This enables rate calculations without requiring the consumer to apply filters.

- **Derived metrics reference other metrics, never raw SQL.** Rate and ratio measures must compose from other measures (`1.0 * {filtered_count} / NULLIF({total_count}, 0)`), never from raw SQL expressions. This ensures changes to component metrics propagate automatically — a core semantic layer principle.

- **Understand measure additivity.** Cube measure types have different pre-aggregation behavior:
  - **Additive** (`count`, `sum`, `min`, `max`, `count_distinct_approx`): can be rolled up freely. These are pre-aggregation friendly.
  - **Non-additive** (`avg`, `count_distinct`, `number`): cannot be rolled up directly. Pre-aggregations with these are less likely to be matched by Cube's query planner.
  - **Decomposition pattern for `avg`**: Rewrite as `{sum_field} / {count_field}` using a `number` type measure referencing additive `sum` and `count` components. Both components pre-aggregate; the ratio computes at query time.
  - **`count_distinct_approx`** uses HyperLogLog and is additive — but does **not** work in pre-aggregations when ClickHouse is the source database (driver limitation). Use `count_distinct` instead and accept it won't pre-aggregate, or handle the approximation in SQL.
  - **Semi-additive measures** (values that can't be summed across time, like balances or availability ratios): Cube has no built-in semi-additive support. Handle via `avg`, period-ending values, or calculated measures in the SQL layer.

- **Cover the statistical surface.** Important metrics get avg, max, sum, and median as the use case warrants. Median uses inline aggregate functions — document that it bypasses pre-aggregations (though v1.6+ Cube Store can now accelerate multi-stage measures).

- **Day-of-week as a measure suite.** Seven filtered count measures plus weekday/weekend composites. This enables DOW heatmaps and pattern detection without post-processing. Apply when temporal patterns matter to the use case.

- **Time-shift for seasonal comparison.** YoY measures use `multi_stage: true` + `time_shift`. For seasonal domains (tourism, retail), prior-year comparison is a core measure, not an afterthought. Period-to-date measures use `rolling_window: { type: to_date }`.

  ```yaml
  measures:
    - name: count_prior_year
      multi_stage: true
      sql: "{count}"
      type: number
      time_shift:
        - time_dimension: ended_at
          interval: 1 year
          type: prior

    - name: count_mtd
      type: count
      rolling_window:
        type: to_date
        granularity: month
  ```

- **Composite scores when the use case demands ranking.** Weighted formulas that combine multiple factors into a single sortable/filterable number. Document the formula and weights in the description.

- **Drill members on the primary count.** The main count always declares which dimensions to show when a user drills through, making the cube self-documenting for dashboard builders and AI agents.

---

## F. Concise Documentation

Document everything clearly but don't over-document. The cube should be self-explanatory where possible, with descriptions filling the gaps.

- **Cube-level description.** One paragraph: what the grain is, what the source is, what analytical questions it supports.

- **Cube-level meta block.** Declare grain, grain_description, time_dimension, time_zone, period bounds, refresh cadence, granularity options, and seasonality. This is a contract with dashboards — they read it via `/api/meta` to configure date pickers, granularity selectors, and seasonal comparisons.

- **Descriptions on non-obvious measures.** If a measure has subtle behavior (median bypassing pre-aggregations, a rate biased toward longer events, a delta vs cumulative distinction), say so in the description.

- **Color semantics on the field.** `color_map` for categorical values, `color_scale` for numeric thresholds, always using the named palette (green/amber/orange/red/blue/muted). Every tier and flag that classifies data also declares how to color that classification. Dashboards read these from `/api/meta` and render accordingly — no dashboard-side color logic.

- **Section comments in dimensions/measures.** Use YAML comments (`# --- Vehicle ---`, `# --- Speeding ---`) to group related fields. Readers scan headings before reading fields.

- **Titles on every public member.** Every dimension and measure that is `public` (or not explicitly `public: false`) must have a `title` that makes sense to a non-technical consumer or an AI agent querying the semantic layer.

---

## G. Meaningful Pre-Aggregations

Match rollups to actual dashboard query patterns. Don't create rollups that won't be hit.

- **2-3 rollups per cube at different aggregation levels.** A detail-level rollup (by entity + location/product), a mid-level rollup (by region/store), and optionally a cross-cut rollup (by customer origin/supplier). Each rollup serves a specific dashboard view.

- **Include the measures dashboards actually query.** Don't dump all measures into every rollup. Match the measures to the queries that rollup is designed to accelerate.

- **Standardized refresh: hourly, incremental, 7-day window.** Consistent across all cubes: `every: 1 hour`, `incremental: true`, `update_window: 7 days`. This is a system-level decision.

- **Partition by month, index by primary filters.** `partition_granularity: month` everywhere. Index columns are the dimensions most commonly used in WHERE clauses. Keep partitions under 500-1,000 per pre-aggregation to avoid overhead.

- **Build range from source data.** `build_range_start` queries the source table for `min(timestamp)`, `build_range_end` uses `SELECT NOW()`. Don't hardcode dates.

- **`allow_non_strict_date_range_match: true`.** For time-dimensioned rollups, allow non-strict matching to avoid full table scans when the query range doesn't align perfectly with partition boundaries.

- **Multi-stage measures can now be pre-aggregated.** As of Cube Core v1.6 (late 2025), the upgraded Cube Store supports pre-aggregation of multi-stage measures (`time_shift`, `rolling_window`, `add_group_by`). When designing new pre-aggregations, include multi-stage measures where they match the dashboard query pattern.

- **Consider lambda pre-aggregations for real-time + batch.** `rollup_lambda` combines a batch pre-aggregation with real-time streaming data, using built partitions where available and falling back to live queries for the latest window. Applicable when dashboards need near-real-time freshness with historical depth.

- **Monitor pre-aggregation hit rates.** A pre-aggregation that isn't being hit is wasted build time. Verify that dashboard queries are actually matching your rollup definitions.

- **Understand how pre-aggregation matching works.** Cube tests pre-aggregations in definition order — rollups before `original_sql`. A rollup matches when it contains all query dimensions, all filter dimensions (which must also be included as dimensions in the rollup), and all leaf measures. Time dimension + granularity together act as a dimension, and the time zone must match. If no pre-aggregation matches, Cube falls back to the upstream data source.

- **Use `original_sql` for expensive base SQL.** When a cube's SQL involves complex nested subqueries, window functions, or multiple joins, consider an `original_sql` pre-aggregation to materialize the base result. Other rollup pre-aggregations can then build from this materialized base using `use_original_sql_pre_aggregations: true`, avoiding re-execution of the expensive SQL for each rollup.

- **ClickHouse-specific: always define indexes.** ClickHouse requires index definitions in pre-aggregations — it will error without them. This is a ClickHouse driver constraint, not a general Cube requirement.

- **Rollup join constraint: ~1M row limit.** Cross-cube rollup joins can only join two tables, and one side must contain fewer than approximately 1 million rows. Plan cross-cube pre-aggregation strategies accordingly.

- **Cube Store index ordering matters.** Cube Store performs scans on sorted data. When a `GROUP BY` matches the index ordering, it uses merge sort-based algorithms (much faster than hash-based). Order index columns to match the most common GROUP BY patterns in dashboard queries.

---

## H. Know Cube.dev's Current Capabilities

Research the latest version's features before implementing. Don't reinvent what cube.dev already provides, and don't use patterns that conflict with current best practices.

- **Use native features over workarounds.** `time_shift`, `rolling_window`, `multi_stage`, `add_group_by`, `case/when`, `hierarchies`, `segments`, `drill_members`, `format`, `sub_query`, `propagate_filters_to_sub_query`, `extends` — use what cube.dev provides natively before building custom SQL solutions.

- **Use `extends` for shared structure.** When multiple cubes share common dimensions, measures, or joins, extract the common elements into a base cube and `extends` from it. This avoids duplication and ensures changes propagate. Useful for polymorphic cubes (e.g., a base entity cube extended by type-specific variants).

- **Use `format` on measures.** Cube supports `format: currency` and `format: percent` on measures. For percent format, store the raw decimal (0.5, not 50) — presentation tools apply the ×100 multiplication implicitly. Using native format ensures consistent rendering across all consumers.

- **Understand parser limitations.** No HAVING, no WITH/CTE, no Jinja functions in SQL blocks. Design around these constraints from the start.

- **Understand pre-aggregation compatibility.** Know which measure types can be pre-aggregated (count, sum, min, max, count_distinct_approx) and which cannot be rolled up directly (avg, count_distinct, number). See principle E for decomposition patterns. As of v1.6, multi-stage measures can also be pre-aggregated.

- **Validate models with `cube validate`.** Use the CLI command to check data model definitions for errors (missing properties, broken references, invalid types) before deploying. There is no built-in unit testing framework — validation is via CLI + Playground manual verification + branch-based dev environments.

- **Multi-tenancy via security context, not compile context.** For our `partition`-based tenancy, use `SECURITY_CONTEXT` (query-time filtering) rather than `COMPILE_CONTEXT` (model-compilation-time branching). Security context injects a WHERE clause at query time; compile context recompiles the entire model per tenant, which is unnecessary when tenants share the same model structure.

- **Check for new features before building.** Cube.dev evolves. Before implementing a new cube, check current documentation for features that might simplify the design. Key recent additions (2024-2025):
  - **Tesseract engine** — next-gen SQL planner enabling multi-stage calculations (`CUBEJS_TESSERACT_SQL_PLANNER`)
  - **`add_group_by`** — nested aggregates without SQL-layer workarounds
  - **Views with folders** — organized consumer-facing API (see Future Considerations)
  - **Member-level security** — column-level access control per user/role
  - **Lambda pre-aggregations** — batch + real-time hybrid caching
  - **Agentic analytics** — AI agents that query the semantic layer via natural language
  - **`original_sql` pre-aggregations** — materialize expensive base SQL for reuse across rollups

- **File organization.** One cube per file, organized in `schema/` subdirectories by domain. Use `.cubes.yaml` extension. When views are introduced, they go in a separate `views/` directory.

---

## Future Considerations

### Views as the Public API

Cube.dev's official style guide recommends that cubes be `public: false` and that **views** serve as the consumer-facing facade. Views select and organize dimensions/measures from connected cubes into use-case-specific APIs.

Two design approaches:
- **Entity-first**: Views built around a business entity, pulling from multiple cubes
- **Metrics-first**: Views built around a single key metric plus relevant dimensions

Views also support **folders** (nested groups of dimensions/measures) for organizing large APIs, and **member-level security** for per-user/role visibility.

We are not adopting views yet — our current cubes serve as both model and API. When we do adopt views, cubes should move to `public: false` and views should become the sole public interface.

---

## Industry Context

These principles are informed by broader semantic layer best practices from across the industry:

- **Single source of truth** — Every metric gets exactly one canonical definition. All downstream consumers query that definition. The anti-pattern is having the same metric defined differently across multiple tools.
- **Business-first, not schema-first** — Build around business questions, not physical schemas. Teams that expose every table find that business users don't recognize the terms.
- **Metrics as code** — Metric definitions belong in version-controlled files with PR review, not scattered across BI tool calculated fields.
- **Measures → metrics → KPIs hierarchy** — Measures are raw aggregations. Metrics are calculated from measures. KPIs are the business-critical subset leadership tracks.
- **Derived metrics reference other metrics** — A derived metric should always reference other metrics, never raw SQL. This ensures changes propagate.
- **Declare join cardinality** — Undeclared or incorrect cardinality leads to fan traps that silently inflate aggregates.
- **Document everything** — Undocumented models work for their creator but fail for everyone else — analysts, AI agents, new team members.
- **Semantic layers as AI infrastructure** — Gartner and AtScale position semantic layers as essential for AI agent accuracy, not just BI convenience. Organizations that prioritize semantic modeling increase AI tool accuracy significantly. Model Context Protocol (MCP) is emerging as the mechanism for AI agents to query governed semantic definitions directly.
- **Headless BI decouples metrics from visualization** — The semantic layer acts as a metrics hub that any downstream consumer (BI tools, apps, notebooks, AI agents) queries via API. Cube exposes REST, SQL (Postgres-wire), and Arrow Flight APIs. Definitions authored once serve all consumers.
- **Interoperability standards are emerging** — The Open Semantic Interchange (OSI) spec (Snowflake/dbt/Salesforce consortium) defines a vendor-neutral format for representing semantic constructs. Worth watching for future export/portability needs.

---

## References

### Cube.dev — Official Documentation

- [Cube: Accelerating Non-Additive Measures](https://cube.dev/docs/guides/recipes/query-acceleration/non-additivity) — decomposition patterns for avg, count_distinct
- [Cube: Calculated Members](https://cube.dev/docs/product/data-modeling/concepts/calculated-members)
- [Cube: CLI Command Reference](https://cube.dev/docs/reference/cli) — `cube validate`
- [Cube: ClickHouse Data Source Configuration](https://cube.dev/docs/product/configuration/data-sources/clickhouse) — driver constraints, index requirements, count_distinct_approx limitation
- [Cube: Code Reusability — Extending Cubes](https://cube.dev/docs/product/data-modeling/concepts/code-reusability-extending-cubes)
- [Cube: Context Variables](https://cube.dev/docs/product/data-modeling/reference/context-variables) — FILTER_PARAMS anti-pattern
- [Cube: Data Modeling Concepts](https://cube.dev/docs/product/data-modeling/concepts)
- [Cube: Designing Metrics](https://cube.dev/docs/product/data-modeling/recipes/designing-metrics)
- [Cube: Dimensions Reference](https://cube.dev/docs/product/data-modeling/reference/dimensions) — sub_query, propagate_filters_to_sub_query
- [Cube: Incrementally Building Pre-Aggregations](https://cube.dev/docs/product/caching/recipes/incrementally-building-pre-aggregations-for-a-date-range)
- [Cube: Lambda Pre-Aggregations](https://cube.dev/docs/product/caching/lambda-pre-aggregations)
- [Cube: Matching Queries with Pre-Aggregations](https://cube.dev/docs/product/caching/matching-pre-aggregations) — matching algorithm, fan-out detection
- [Cube: Measures Reference](https://cube.dev/docs/product/data-modeling/reference/measures)
- [Cube: Meta API Endpoint](https://cube.dev/docs/product/apis-integrations/core-data-apis/rest-api/reference) — custom metadata, hierarchies, folders
- [Cube: Multi-Stage Calculations](https://cube.dev/docs/product/data-modeling/concepts/multi-stage-calculations) — time_shift, rolling_window, add_group_by
- [Cube: Multitenancy](https://cube.dev/docs/product/configuration/multitenancy) — SECURITY_CONTEXT vs COMPILE_CONTEXT
- [Cube: Nested Aggregates Recipe](https://cube.dev/docs/product/data-modeling/recipes/nested-aggregates)
- [Cube: Polymorphic Cubes / Extends](https://cube.dev/docs/product/data-modeling/concepts/polymorphic-cubes)
- [Cube: Pre-Aggregations Reference](https://cube.dev/docs/product/data-modeling/reference/pre-aggregations)
- [Cube: Segments Reference](https://cube.dev/docs/product/data-modeling/reference/segments) — when to use segments vs. filters
- [Cube: Style Guide](https://cube.dev/docs/product/data-modeling/recipes/style-guide) — naming, file organization, sql_table vs sql
- [Cube: Types and Formats](https://cube.dev/docs/product/data-modeling/reference/types-and-formats) — measure types, format: percent/currency
- [Cube: Using original_sql and Rollups Effectively](https://cube.dev/docs/product/caching/recipes/using-originalsql-and-rollups-effectively)
- [Cube: Using Pre-Aggregations](https://cube.dev/docs/product/caching/using-pre-aggregations) — rollup join constraints, Cube Store internals
- [Cube: Views Reference](https://cube.dev/docs/product/data-modeling/reference/view)
- [Cube: Working with Joins](https://cube.dev/docs/product/data-modeling/concepts/working-with-joins)

### Cube.dev — Blog & Workshops

- [Cube: Agentic Analytics](https://cube.dev/blog/cube-agentic-analytics)
- [Cube: Exploring the Semantic Layer Through the Lens of MVC](https://cube.dev/blog/exploring-the-semantic-layer-through-the-lens-of-mvc)
- [Cube: Introducing Hierarchies and Folders](https://cube.dev/blog/introducing-hierarchies-and-folders-support)
- [Cube: Mastering Pre-Aggregations](https://cube.dev/blog/cube-cloud-deep-dive-mastering-pre-aggregations) — partition sizing, index strategy
- [Cube: October 2025 Product Updates](https://cube.dev/blog/whats-new-in-cube-october-2025-product-updates)
- [Cube: Tesseract Engine](https://cube.dev/blog/introducing-next-generation-data-modeling-engine)
- [Cube Core v1.6: Multi-Stage Pre-Aggregation Support](https://cube.dev/blog/cube-core-v1-6-cube-store-upgrade-multi-stage-pre-aggregations)
- [GigaOm: 2025 Radar for Semantic Layers & Metric Stores](https://cube.dev/blog/cube-cloud-named-leader-and-outperformer-in-2025-gigaom-radar-for-semantic)

### ClickHouse

- [ClickHouse: Denormalization Guide](https://clickhouse.com/docs/data-modeling/denormalization) — when to denormalize vs. star schema
- [ClickHouse: Schema Design](https://clickhouse.com/docs/data-modeling/schema-design) — ORDER BY, partitioning, LowCardinality
- [ClickHouse: Sparse Primary Indexes Guide](https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes) — granule skipping mechanics
- [ClickHouse + Cube: Building a Fast & Open-Source Data Stack](https://cube.dev/events/Building-a-fast&open-source-data-stack-with-ClickHouse-and-Cube.pdf)
- [Altinity: How to Pick ORDER BY / PRIMARY KEY / PARTITION BY](https://kb.altinity.com/engines/mergetree-table-engine-family/pick-keys/)

### Industry — Semantic Layer Best Practices

- [AtScale: Implementing Semantic Layer for Effective Data Governance](https://www.atscale.com/blog/implementing-semantic-layer-effective-data-governance/)
- [AtScale: State of the Semantic Layer 2025](https://www.atscale.com/blog/semantic-layer-2025-in-review/)
- [AtScale: The Golden Age of the Semantic Layer](https://www.atscale.com/blog/golden-age-of-the-semantic-layer/) — semantic layers as AI infrastructure
- [Coalesce: Semantic Layers 2025 Playbook](https://coalesce.io/data-insights/semantic-layers-2025-catalog-owner-data-leader-playbook/)
- [Datacadamia: Fan Trap Issue](https://www.datacadamia.com/data/type/cube/semantic/fan_trap)
- [dbt: Advanced Metrics](https://docs.getdbt.com/best-practices/how-we-build-our-metrics/semantic-layer-5-advanced-metrics) — derived metrics should reference other metrics
- [dbt: Building Semantic Models](https://docs.getdbt.com/best-practices/how-we-build-our-metrics/semantic-layer-3-build-semantic-models)
- [dbt: Centrally Defined Metrics](https://www.getdbt.com/blog/centrally-defined-metrics)
- [dbt: Risks of a Poorly Designed Semantic Layer](https://www.getdbt.com/blog/semantic-layer-pitfalls)
- [dbt: Semantic Layer Architecture](https://www.getdbt.com/blog/semantic-layer-architecture)
- [dbt: The OSI Spec Updates](https://www.getdbt.com/blog/the-osi-spec-updates) — Open Semantic Interchange standard
- [DEV Community: 7 Semantic Layer Mistakes to Avoid](https://dev.to/alexmercedcoder/semantic-layer-best-practices-7-mistakes-to-avoid-303h)
- [Gartner: Rethink Semantic Layers to Support the Future of Analytics and AI](https://www.gartner.com/en/documents/6337279)
- [Google Cloud: LookML Best Practices](https://docs.cloud.google.com/looker/docs/best-practices/best-practices-lookml-dos-and-donts)
- [Grid Dynamics: Semantic Data Layer Design Principles](https://www.griddynamics.com/blog/semantic-data-layer-design-principles)
- [Improvado: The Metrics Layer](https://improvado.io/blog/what-is-a-metrics-layer) — measures → metrics → KPIs hierarchy
- [VentureBeat: Headless vs Native Semantic Layer](https://venturebeat.com/ai/headless-vs-native-semantic-layer-the-architectural-key-to-unlocking-90-text)
