# Profiler ARRAY JOIN Threading Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the profiler's LC probe and Map stats queries to include the ARRAY JOIN clause, so nested column profiling works correctly with entry_type filtering.

**Architecture:** Single line fix — the `lcFrom` variable (used by Map stats and LC probe queries) is missing `arrayJoinClause`. All 4 broken queries derive from this one variable.

**Tech Stack:** JavaScript (ES modules, Node.js 22), ClickHouse

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `services/cubejs/src/utils/smart-generation/profiler.js:882` | Add `arrayJoinClause` to `lcFrom` |

---

### Task 1: Fix `lcFrom` to include ARRAY JOIN clause

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/profiler.js:882`

- [ ] **Step 1: Fix the lcFrom definition**

Find line 882 in `profiler.js`:

```javascript
const lcFrom = `${schema}.\`${table}\`${whereClause}`;
```

Replace with:

```javascript
const lcFrom = `${schema}.\`${table}\`${arrayJoinClause}${whereClause}`;
```

This threads ARRAY JOIN through all 4 dependent queries:
- Line 916: Numeric map stats (`SELECT minIf/maxIf/avgIf... FROM ${lcFrom}`)
- Line 963: String map stats (`SELECT uniqIf... FROM ${lcFrom}`)
- Line 1036: LC probe (`SELECT groupUniqArray... FROM ${lcFrom}`)

- [ ] **Step 2: Verify with direct ClickHouse query**

```bash
curl -s 'http://localhost:18123/?user=admin&password=Sk48JMXiVnZMWxTDOIdBoxxD2wLsyJ7R' -d "
SELECT arraySort(groupUniqArray(10)(type)) AS type__lc_values
FROM cst.semantic_events
LEFT ARRAY JOIN
  \`commerce.products.entry_type\` AS \`commerce_products_entry_type\`
WHERE partition IN ('somi.is') AND commerce_products_entry_type = 'Line Item'
"
```

Expected: Array of distinct type values (not an error).

- [ ] **Step 3: Commit**

```bash
git add services/cubejs/src/utils/smart-generation/profiler.js
git commit -m "fix: include arrayJoinClause in lcFrom for Map stats and LC probe queries"
```

- [ ] **Step 4: Restart and test full flow in browser**

```bash
docker compose -f docker-compose.dev.yml restart cubejs
```

Run the full smart gen flow: select `cst.semantic_events`, check `commerce`, add `entry_type IN [Line Item]`, click Profile Table. Verify:
- Row count is 4,377,428 (not 0)
- Active columns > 0
- No errors in cubejs logs for LC probe or Map stats
- Preview Changes shows fields with correct stats
