# Feature Specification: Aggregate-Aware Query Routing

**Feature Branch**: `015-aggregate-routing`
**Created**: 2026-11-20
**Status**: Draft
**Input**: User description: "Aggregate-aware query routing (namesake aggregates): an alternative to the built-in pre-aggregations that works at the database level. When a source table has one or more self-describing aggregate tables, the platform silently answers a semantic-layer query from the best suitable aggregate instead of the source table, and falls back to the source whenever the aggregate cannot answer it."
**Owner direction (2026-11-20)**:
1. Lag is acceptable; this is mostly for historical data.
2. Rely on the database's own deduplication.
3. Historical data must be exact as soon as it is stable.
4. The age from which data is summarised is configurable.
5. Aggregate and source are not combined in one answer. A long window (for example the last months) is answered from the aggregate, and the newest data in it may simply be wrong. The aggregate is not used for short windows that include now; those read the source.
6. An answer served from an aggregate says so, and through what time the aggregate holds data, so that a consumer can read newer buckets from the source (decided with the dashboard work; recorded in cxs2 spec 290, section 5.1).

**Research**: [research.md](./research.md) (prototype evidence, 2026-11-20)

Dashboards over very large tables read hundreds of millions of rows per query. On the first test candidate (a 1.14-billion-row sales table), a month-by-revenue chart over one year averages 5.8 seconds and reads 764 million rows, and a store-name list reads every row in the table. No built-in pre-aggregations are used for that model today.

This feature lets the database hold **aggregate tables** next to a source table. Each aggregate describes itself: which source it summarises, at what time grain, from what age data is summarised, how long a window must be to use it, and what each of its columns holds. A refresh process keeps the aggregate in step with its source, period by period.

For every query the platform decides whether an aggregate can answer it: every member must be reproducible exactly, and the query's time window must either lie within what the aggregate holds or be long. If so, the query reads the aggregate alone. If not, it reads the source as it does today. The consumer never sees a difference in names or columns, and no new model appears in the semantic layer. Historical periods are exact. In a long window that reaches the present, the newest periods may be missing or behind; that is accepted, and the answer carries a mark that says through what time it is complete.

The capability is generic. Nothing in it is specific to one table, tenant, or model; the sales table is only the first test candidate.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A dashboard query is answered from an aggregate, silently and exactly (Priority: P1)

A dashboard asks for revenue by month over a past year. An aggregate of the sales table exists at day grain and holds those months. The platform recognises that every member in the query can be answered exactly from that aggregate, reads the aggregate, and returns the same rows, the same member names and the same output columns the source would have returned. The person looking at the dashboard, and any agent composing queries, sees nothing new: no extra model, no new member, no changed metadata.

**Why this priority**: this is the whole value of the feature. Everything else exists to make it safe, or possible to set up.

**Independent Test**: with one aggregate that holds the queried periods, run the reference query set (time bucket by one dimension with sum measures; totals; dimension value lists; averages, minimums, maximums and counts on stored metrics) against both paths and compare. Every routed query returns identical rows and identical output columns, and the model list and metadata are unchanged.

**Acceptance Scenarios**:

1. **Given** a day-grain aggregate that holds the queried periods, **When** a query asks for a sum measure by month over a whole-day date range, **Then** it is answered from the aggregate and the result equals the source's result cell for cell.
2. **Given** the same aggregate, **When** a query asks only for the distinct values of a grouping column over those periods, **Then** it returns the same list as the source.
3. **Given** an aggregate that stores a sum, a non-null count, a minimum and a maximum for a metric, **When** a query asks for that metric's average, minimum, maximum, or a row count, **Then** each equals the source's value, including when no row matches (a count returns 0, not empty).
4. **Given** a query that was routed, **When** the consumer inspects the response, **Then** member names, output column names and their order are identical to the unrouted response.
5. **Given** any routed query, **When** a user or agent lists models or requests metadata, **Then** exactly the same models and members are listed as before the feature existed.
6. **Given** a measure defined as a product of one summed column and grouping columns (for example quantity times unit price where price is a grouping column of the aggregate), **When** it is queried, **Then** its result equals the source's.

---

### User Story 2 - Anything the aggregate cannot answer stays on the source (Priority: P1)

A query asks for something the aggregate cannot reproduce: a distinct count of a column the aggregate dropped, an hourly bucket on a day-grain aggregate, a date range that starts mid-day, a measure whose formula is not exact when re-summed, or a filter on a column the aggregate does not group by. Or it asks for a short window that includes now. The platform runs that query on the source exactly as it does today. No error, no partial answer. The reason is recorded.

**Why this priority**: a silent swap that returns a wrong member is worse than no swap. This story is what makes User Story 1 shippable, so it has the same priority.

**Independent Test**: run a corpus of deliberately unsuitable queries with an aggregate present. Each produces exactly the statement and result it produces with the feature switched off, and each has a recorded reason for staying on the source.

**Acceptance Scenarios**:

1. **Given** a day-grain aggregate, **When** a query asks for an hourly bucket, **Then** it runs on the source.
2. **Given** an aggregate, **When** a query's date range does not start and end on the aggregate's bucket boundaries, **Then** it runs on the source.
3. **Given** an aggregate that does not carry a column, **When** a query uses a member that reads that column, **Then** it runs on the source.
4. **Given** a measure whose formula multiplies two summed columns, or filters on a summed column, **When** it is queried, **Then** it runs on the source.
5. **Given** a request containing several queries, **When** no single aggregate is suitable for all of them, **Then** none of its queries is routed.
6. **Given** row-level rules or member access lists that apply to the requesting user, **When** a query is considered for routing, **Then** the rules are applied first, the decision is made on the resulting query, and a routed query returns only rows the user may see.
7. **Given** a query that reads more than one model, uses free-form expressions, asks for ungrouped rows, or is bucketed in a time zone other than UTC, **When** it is processed, **Then** it runs on the source.
8. **Given** a query whose window reaches past what the aggregate holds and is shorter than the aggregate's declared minimum window (for example "today" or "the last seven days"), **When** it is processed, **Then** it runs on the source.
9. **Given** the feature is switched off, or no aggregate exists for a data source, **When** any query runs, **Then** behaviour is identical to today.
10. **Given** any query that stayed on the source while the feature is on, **When** the decision record is read, **Then** it states a specific reason.

---

### User Story 3 - The best available aggregate is used (Priority: P2)

A source has several aggregates, for example one at 30 minutes and one at one day. A query asking for hourly buckets is answered from the 30-minute aggregate because no hourly one exists. A query asking for daily or monthly buckets is answered from the one-day aggregate because it is the smallest that qualifies. A query asking for minute buckets runs on the source.

**Why this priority**: one grain rarely fits all dashboards. Without this, operators must choose between fine grain (less speed-up) and coarse grain (fewer queries served).

**Independent Test**: with a 30-minute and a one-day aggregate present, run hour, day, week, month, minute and off-boundary queries and check which table each reads and that results equal the source's.

**Acceptance Scenarios**:

1. **Given** 30-minute and one-day aggregates, **When** an hourly query over whole days runs, **Then** the 30-minute aggregate answers it.
2. **Given** the same aggregates, **When** a daily, weekly or monthly query runs, **Then** the one-day aggregate answers it.
3. **Given** the same aggregates, **When** a query's range starts at 10:30, **Then** the 30-minute aggregate answers it, and when it starts at 10:15 the source answers it.
4. **Given** two aggregates that both qualify, **When** a query runs, **Then** the coarser one is used.

---

### User Story 4 - Long windows use the aggregate; history is exact, the newest data may be behind (Priority: P2)

Recent data is still changing: loads are repeated and the database has not yet removed the resulting duplicates. Old data is stable. Each aggregate declares the age from which data is summarised, the shortest window for which it may be used when the window reaches the present, and how long it may go without a successful refresh. A refresh process summarises each period old enough, and rebuilds a period whenever its source content has changed, for example after the database has consolidated duplicates. A query whose window lies within what the aggregate holds is answered from it. A long window that reaches the present is also answered from it, alone: its historical periods are exact, and its newest periods may be missing or behind. A short window that reaches the present reads the source.

**Why this priority**: it is what makes the aggregate useful for the slow queries, which are long windows, while keeping short, current views on live data.

**Independent Test**: build an aggregate for the old periods of a source. A window within those periods equals the source. A long window reaching now equals the source for every bucket the aggregate holds. A short window reaching now reads the source. After rows are loaded into an old period and the refresh runs, that period again equals the source.

**Acceptance Scenarios**:

1. **Given** a period whose data is entirely older than the declared minimum age, **When** the refresh process runs, **Then** that period is summarised into the aggregate from a plain read of the source.
2. **Given** a period with data younger than the declared minimum age, **When** the refresh process runs, **Then** that period is not summarised.
3. **Given** a query whose window lies entirely within what the aggregate holds, **When** it runs, **Then** it is answered from the aggregate and equals the source as of the last refresh.
4. **Given** a query whose window reaches past what the aggregate holds and is at least as long as the declared minimum window, or has no time limit, **When** it runs, **Then** it is answered from the aggregate alone; every bucket the aggregate holds equals the source as of the last refresh, and newer buckets may be missing or behind.
5. **Given** the source content of a held period changes (a re-load, or the database consolidating duplicates), **When** the refresh process runs, **Then** only that period is rebuilt, replaced in one step, and it again equals the source.
6. **Given** an aggregate without a successful refresh within its declared tolerance, or with no refresh record, **When** a suitable query runs, **Then** it is answered from the source.
7. **Given** a request to the query endpoint answered from an aggregate, **When** the consumer reads the answer, **Then** it carries a machine-readable mark giving the time through which the aggregate holds data; an answer from the source carries no such mark, and the answer's content is the same with or without it.

---

### User Story 5 - An operator generates an aggregate for any time-series table (Priority: P2)

An operator points the generator at a source table and chooses a time grain, the columns to group by, the minimum age, the minimum window and the refresh tolerance. The generator reads the table's own description, assigns a role to every column, reports which columns it left out and why, and produces a ready-to-apply definition. The refresh process fills it. The platform's own database account stays read-only: the generator produces text for the schema repository and never creates anything itself.

**Why this priority**: hand-writing an aggregate for a 124-column table is slow and error-prone, and an aggregate that breaks the column contract is ignored. Generation makes the contract the default.

**Independent Test**: generate aggregates for three structurally different source tables, apply them in an isolated environment, fill them, and compare sum, average, minimum, maximum and count of every stored metric against the source at a coarser grouping. All comparisons match, also after the database has merged the aggregate's parts.

**Acceptance Scenarios**:

1. **Given** a source table with a time column, **When** the operator requests an aggregate at a grain with a chosen grouping set, minimum age, minimum window and tolerance, **Then** the generator returns a definition and the list of left-out columns with a reason each.
2. **Given** a generated aggregate applied and filled, **When** the equivalence check runs, **Then** every stored metric matches the source for sum, average, minimum, maximum and count.
3. **Given** a source table without a time column, or one whose storage is not divided by time, **When** generation is requested, **Then** the generator declines and says why.
4. **Given** a metric stored as a map of named numeric values, **When** an aggregate is generated, **Then** it carries a per-key sum of that map, and sums by key match the source.
5. **Given** a source whose old periods are not consolidated automatically, **When** an aggregate is generated, **Then** the output states the source setting that makes old periods consolidate.

---

### Edge Cases

- An aggregate is dropped, or loses or changes a column, while its structure is still held in memory: the documented order (remove the aggregate's self-description, wait one refresh of the in-memory structure, then change or drop) produces no failed queries. Adding a column needs no such order.
- An aggregate's self-description is missing, unreadable, or names a source or time column that does not exist: the aggregate is ignored and the reason is recorded.
- An aggregate column that is neither a grouping column nor a declared aggregate (for example a plain column outside the aggregate's grouping key, whose value becomes arbitrary when the database merges rows): it is treated as unusable and members that read it stay on the source.
- A model's own table expression is not a single plain read of one source table (joins, unions, nested reads, or a duplicate-removing read): that model is never routed.
- A model's own table expression redefines a summed column with a formula: the redefined column is usable only if the formula stays exact when applied to summed values; otherwise members that read it stay on the source.
- A metric stored as a map with keys present on only some rows: sums and averages by key are routed, because they can be reproduced exactly; a minimum or maximum by key cannot be reproduced exactly and stays on the source.
- A query with a relative date range ("last 7 days"): alignment and window length are evaluated on the resolved range.
- A query with no time limit, such as a list of all values of a dimension: it counts as a long window. Values that occur only in periods the aggregate does not yet hold are missing until those periods are summarised.
- A query that compares two date ranges in one request: routed only if one aggregate qualifies for both ranges. Such an answer carries one mark, because one aggregate served all of it.
- A model that already declares built-in pre-aggregations: it is not routed by this feature.
- A preview of an unpublished model version or another branch: the decision is made against that version's own definitions.
- A period is being rebuilt while a query runs: the query sees that period's old content or its new content in full, never a mixture.
- A held period changed in the source after the last refresh: a routed answer shows its content as of that refresh until the next one.
- The source table gains or loses a column, or a column changes type: members that read a column the aggregate lacks stay on the source; an aggregate column whose type no longer fits a role is treated as unusable.
- Two aggregates of the same source at the same grain: the one with fewer rows is used.

## Requirements *(mandatory)*

### Functional Requirements

**Discovery**

- **FR-001**: The system MUST discover aggregate tables per data source from the database's own metadata, using only read access.
- **FR-002**: An aggregate MUST declare, in its own metadata, the source table it summarises, its time column, its time grain, the minimum age from which data is summarised, the minimum window for queries that reach past what it holds, and its refresh tolerance. Buckets are cut in UTC. An aggregate without a complete, readable declaration MUST be ignored.
- **FR-003**: The system MUST derive each aggregate column's role (time bucket, grouping column, sum, non-null count, minimum, maximum, row count, per-key sum of a map, or unusable) from the column's name and type and from whether it is part of the aggregate's grouping key. No role may be supplied from the semantic layer.
- **FR-004**: An aggregate column that carries a source column's bare name MUST hold either that column's grouping value or its sum. Every other function of a source column uses a fixed, documented suffix.
- **FR-005**: The system MUST hold discovered structures in memory with a bounded lifetime, refresh them without blocking queries, and reflect an added, removed or changed aggregate within one lifetime.

**Suitability**

- **FR-006**: The system MUST decide suitability per query after all row-level rules, access lists and other query rewriting have been applied, using the final query.
- **FR-007**: A query is suitable for an aggregate only if every member it uses (measures, dimensions, segments, filters, time dimension, ordering) is available from that aggregate under FR-008 to FR-012.
- **FR-008**: A dimension, segment or filter is available only if it reads grouping columns exclusively.
- **FR-009**: A measure is available only if its result is provably equal when computed over aggregate rows: a sum of one summed column or of one key of a summed map; a sum of an expression that is linear in exactly one such summed value with all other inputs being grouping columns; a minimum or maximum backed by a stored minimum or maximum or reading only grouping columns; a count backed by the stored row count; an average backed by a stored sum and the matching count; a distinct count reading only grouping columns; or a calculation composed solely of available measures. Any other measure is unavailable.
- **FR-010**: A measure with its own filter is available only if the filter reads grouping columns exclusively. A count MUST return 0, not an empty value, when no row matches.
- **FR-011**: The requested time bucket MUST be a whole multiple of the aggregate's grain, the query MUST be bucketed in UTC, and the resolved date-range bounds MUST fall on the aggregate's bucket boundaries.
- **FR-012**: A model is eligible only if its table expression is a single plain read of one source table that has an aggregate, it declares no built-in pre-aggregations, and every column redefinition it contains is classified as grouping-only or exact-when-summed. A member that reads a column outside those classes is unavailable.
- **FR-013**: Queries that read more than one model, use free-form member expressions, request ungrouped rows, or carry features the system cannot classify MUST NOT be routed.
- **FR-014**: A request containing several queries MUST be routed only if one aggregate is suitable for every query in it; otherwise every query of the request is answered from the source.

**Routing and invisibility**

- **FR-015**: A routed query MUST return the same member names and the same output columns in the same order as the source path, and, for every period the aggregate holds, the same values the source held at the last refresh. The mark of FR-030 is the only other difference a consumer can observe.
- **FR-016**: The system MUST NOT store, list, or expose any additional model, member, or model metadata as a result of this feature. Model lists, model metadata, validation and model editing MUST behave as if the feature did not exist.
- **FR-017**: A routed query MUST keep every tenant restriction and row-level restriction the source path would apply. An aggregate MUST carry the columns those restrictions read, or the query is not routed.
- **FR-018**: All query surfaces that pass through query rewriting (dashboard queries, statement previews, dry runs, streaming and export) MUST apply the same decision.

**Selection**

- **FR-019**: When several aggregates qualify for a request, the system MUST use the one with the coarsest grain, and among equal grains the one with the fewest rows.

**Time windows, history and refresh**

- **FR-020**: An aggregate MUST hold only periods of its source whose data is entirely older than its declared minimum age. The minimum age MUST be configurable per aggregate and may be zero. Periods MUST be built from a plain read of the source, never with duplicate removal at read time.
- **FR-021**: A routed query MUST be answered from the aggregate alone; aggregate and source MUST NOT be combined in one answer. A query whose window lies entirely within what the aggregate holds is suitable. A query whose window reaches past what the aggregate holds is suitable only if the window is at least as long as the aggregate's declared minimum window, or has no time limit; otherwise it MUST be answered from the source.
- **FR-022**: A refresh process MUST build each period the aggregate should hold and does not, MUST rebuild a held period whenever its source content has changed since it was built (including when the database consolidates duplicates), MUST replace a period in one step, and MUST record, after a complete and successful pass, the time of the pass and up to where the aggregate holds data.
- **FR-023**: The system MUST use an aggregate only while its last recorded successful pass is within its declared tolerance. When that record is missing, unreadable or older, queries MUST be answered from the source.

**Generation**

- **FR-024**: The system MUST generate, from a source table's metadata plus a chosen grain, grouping set, minimum age, minimum window and tolerance, an aggregate definition that satisfies FR-002 to FR-004. It MUST NOT execute it; an aggregate is filled only by the refresh process (FR-022).
- **FR-025**: For every numeric metric the generated aggregate MUST carry a sum, a non-null count, a minimum and a maximum; for every map of numeric values a per-key sum; and a row count.
- **FR-026**: The generator MUST report every source column it left out with a reason; MUST decline with a reason when the source has no usable time column, is not divided into periods by time, or the requested grain does not fit inside those periods; and MUST state the source setting that makes old periods consolidate when that is not configured.

**Control and safety**

- **FR-027**: The capability MUST be off by default and switchable on per environment. A single aggregate MUST be removable from use, without being dropped, by removing its self-description.
- **FR-028**: Every routing decision MUST be recorded with the query's identifier and either the chosen aggregate or a specific reason for staying on the source, in a form that does not expose tenant data.
- **FR-029**: A failure in discovery, derivation or decision MUST result in the query being answered from the source, never in a failed query.

**Answer mark**

- **FR-030**: An answer from the query endpoint that was served from an aggregate MUST carry a machine-readable mark stating the time through which that aggregate holds data, in every output format. An answer served from the source MUST NOT carry it. The mark MUST NOT alter the content of the answer. Answers over the SQL interface are routed by the same decision (FR-018) and carry no mark.

### Key Entities

- **Source table**: a table a model reads; identified per data source by its name.
- **Period**: one of the time-based divisions in which the database stores a source table (for example one month of one tenant). The unit that is summarised and replaced.
- **Aggregate**: a table that summarises periods of one source table at one time grain. Declares its source, time column, grain, minimum age, minimum window and refresh tolerance. Holds grouping columns and stored aggregates under the source's column names.
- **Column role**: what an aggregate column holds: time bucket, grouping column, sum, non-null count, minimum, maximum, row count, per-key sum of a map, or unusable.
- **Aggregate structure**: the in-memory description of all aggregates of a data source, with a bounded lifetime.
- **Refresh record**: per aggregate, when the last complete pass ran and up to where the aggregate holds data; per period, which source content it was built from.
- **Routing decision**: for one request, the chosen aggregate or the reason it stays on the source.
- **Answer mark**: on an answer served from an aggregate, the time through which that aggregate holds data.
- **Derived definition**: the in-memory variant of a model that reads an aggregate. Exists only while serving routed queries; never stored, listed or exposed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the equivalence suite (reference dashboard shapes for the test model plus generated cases, over windows the aggregate holds), 100% of routed queries return results equal to the source path, cell for cell, with numeric differences no greater than one part in a billion.
- **SC-002**: The reference long-range chart (revenue by month over one year, 5.8 s average today) completes at least 5 times faster when routed, and the reference dimension value list (1.3 s today, reading every row) reads at least 3 times fewer rows.
- **SC-003**: Consumers observe no change in shape: for 100% of routed queries, member names, output columns and model metadata are identical to the unrouted path, the answer's content is unchanged by the mark, and the count of visible models is unchanged.
- **SC-004**: With the capability off, or with no aggregate present, 100% of the regression corpus produces the same statements and results as before the feature.
- **SC-005**: Deciding whether to route adds no more than 5 ms at the 95th percentile per query once an aggregate's structure is in memory.
- **SC-006**: In a routed long window that reaches the present, 100% of the buckets the aggregate holds equal the source as of the last refresh. No query whose window reaches past what the aggregate holds and is shorter than the declared minimum window is routed. No query is answered from an aggregate whose last successful pass is older than its tolerance.
- **SC-007**: An operator obtains a ready-to-apply aggregate definition for a source table without writing statements by hand; generated aggregates for three structurally different tables pass the equivalence check with zero mismatches.
- **SC-008**: For every unrouted query in the test corpus, the decision record gives a specific reason.
- **SC-009**: 100% of answers from the query endpoint that were served from an aggregate carry the mark with that aggregate's coverage time, and no answer served from the source carries it.

## Assumptions

- **Members are exact or not routed.** A member that cannot be reproduced exactly from the aggregate is never routed; nothing changes meaning to make routing possible.
- **History is exact; the newest data in a long window may be wrong.** Periods the aggregate holds equal the source as of the last refresh. Periods it does not yet hold are missing from a routed long window, and a held period that changed since the last refresh is behind until the next one. This is accepted for long windows and is the reason short windows that reach the present are never routed.
- **Lag is acceptable.** The refresh runs on a schedule; the aggregate follows its source with that delay.
- **Deduplication is the database's own.** The aggregate is built from plain reads. When the database consolidates a period and removes duplicates, the period's content changes and the refresh rebuilds it, so a period is exact from the first refresh after it has become stable.
- **Creating, filling and refreshing aggregates happens outside the platform's read-only database account,** through the schema repository and a scheduled process with its own credentials.
- **Aggregates live in the same database as their source,** so existing read permissions cover them.
- **Dashboards bucket in UTC today,** so serving UTC-bucketed queries covers current use.
- **The built-in pre-aggregations remain available and unchanged.** A model uses one mechanism or the other.

## Out of Scope

- Combining an aggregate and its source in a single answer.
- A coverage mark on answers over the SQL interface, and any other detail of routing (which aggregate, why not) in an answer.
- Queries bucketed in a time zone other than UTC.
- Queries that read several models, views over models, or the SQL interface's pushed-down expressions.
- Aggregates for tables without a time column, or whose storage is not divided into periods by time.
- Dimensions stored inside maps, arrays or nested structures.
- Distinct counts of columns the aggregate does not group by, percentiles and medians, and minimum or maximum of individual map keys.
- Executing aggregate definitions from the platform's own database account.
- Changing how recent data is deduplicated in the source.
- Database types other than the first supported one; the design must not prevent adding others.

## Dependencies

- A place in the schema repository for aggregate definitions, and a scheduled process with write access to run the refresh.
- Source tables configured so that the database consolidates old periods by itself; this is what makes old periods duplicate-free. Switched on for the first candidate on the development cluster on 2026-11-20.
- Read access to the database's table and column metadata for the platform's database account (already in place on the test cluster), and permission for that account to have the database parse an expression. On the first supported database an account limited to its strictest read-only level cannot do the latter and is never routed; the test cluster's account can.
- A consumer that wants current numbers for recent buckets of a long window reads the answer mark and, if it reaches the endpoint through its own proxy, passes the mark on (the dashboard application, its spec 290).
