# Tychi × Cube Test Setup

Single-page handover so any new session can pick up where this one left off:
making Tychi reliably build a data-exploration dashboard from a natural-language
prompt, against the Synmetrix semantic layer, via the cxs2 MCP.

---

## Goal

The end-to-end test:

> User in cxs2 chat (logged in to "Blue Car Rental" / `blue.is` partition):
> **"I would like to explore popular POIs last summer"**

Expected behaviour:
1. Dex (orchestrator) delegates to Tychi via `communicate(['tychi'])`.
2. Tychi invokes the `data-exploration` skill.
3. Tychi calls `cube_list` (cxs MCP, scoped to active partition).
4. Tychi calls `cube_discover(action="describe", cubeName=<chosen>)` for the cube it picks (today: `bluecar_stays`).
5. Tychi calls `browser_render_data_visualization` with a config built from the discovered schema.
6. The cxs2 canvas renders a multi-section dashboard (KPIs, time series, map, top-N tables) — verdict `PASS` or `PASS_WITH_WARNINGS`.

Final-state screenshot saved this session: `dashboard-rendered.png` at synmetrix repo root (untracked).

---

## Repos & roles

| Repo | Role | Local path |
|---|---|---|
| **synmetrix** | Backend: Hasura + cubejs + actions + cubestore + Postgres. Owns `/api/v1/meta-all`, `/api/v1/discover`, security context, partition-scoped data access. | `/Users/stefanbaxter/Development/synmetrix` |
| **client-v2** | Synmetrix legacy frontend (Vite/React). Talks directly to local synmetrix on port 8000. Used for direct semantic-layer authoring/exploration. | `/Users/stefanbaxter/Development/client-v2` |
| **cxs2** | FraiOS app (Next.js + Convex + WorkOS). Hosts chat, agent canvas, MCP server (`/api/mcp/v1/messages`), generative-UI render tools. The `cube_list` / `cube_discover` / `cube_query` tools that Tychi sees are defined here, in `src/lib/services/mcp/component-tools/cube-analytics/`. | `/Users/stefanbaxter/Development/cxs2` |
| **cxs-agents** | Python orchestrator (Tychi, Dex, Provi …). Connects to cxs2's MCP via `cxs-platform` MCP client. Skill files for Tychi at `agents/Tychi/skills/`. | `/Users/stefanbaxter/Development/cxs-agents` |

---

## Pre-flight (do these once on a fresh session)

1. **Confirm `agentscope==1.0.18` in the cxs-agents venv.** Stale 1.0.11 was
   the cause-of-everything in the previous debugging session
   (`Toolkit.register_tool_function() got an unexpected keyword argument
   'func_name'` swallowed by a broad `except`, no CXS MCP attaches, agent
   thrashes on `search_tools`):
   ```bash
   ~/Development/cxs-agents/.venv/bin/pip show agentscope | grep Version
   # if < 1.0.18:
   ~/Development/cxs-agents/.venv/bin/pip install -r ~/Development/cxs-agents/requirements.txt --upgrade
   ```

2. **Start cxs2's local infra (Redis + Qdrant + Convex studio) before the dev
   server**:
   ```bash
   cd ~/Development/cxs2 && bun run dev:infra:start && bun run dev:https
   ```

3. **Point `kubectl` at the dev cluster** if you'll need cluster-admin
   queries (only relevant if `meta-all` returns empty and you need to
   inspect Hasura state on `dbx.fraios.dev`):
   ```bash
   kubectl config get-contexts        # should list a context for the dev cluster
   kubectl config use-context <name>
   kubectl get pods -n synmetrix      # should list synmetrix-* pods
   ```

4. **ClickHouse port-forward** (synmetrix CubeJS reaches it via
   `host.docker.internal:18123`):
   ```bash
   kubectl port-forward -n clickhouse svc/clickhouse-fraios-clickhouse 18123:8123 &
   ```

5. **Log into cxs2 as the right org.** The canonical test assumes you're in
   the **Blue Car Rental** organization (synmetrix partition `blue.is`). The
   cluster-side data state below is keyed to that team; testing under a
   different org will show different cubes.

6. **Restart the orchestrator after any cxs-agents code change** — Python
   doesn't hot-reload:
   ```bash
   ~/Development/cxs-agents/utils/devctl.sh orchestrator restart
   ```
   Cubejs (synmetrix) and cxs2 (Next.js) DO hot-reload, no restart needed.

---

## Local stack

All four run concurrently:

| Component | How to run | Port | Notes |
|---|---|---|---|
| Synmetrix backend (hasura, cubejs, actions, cubestore, postgres) | `./cli.sh compose up` (in synmetrix) | 8080 (hasura), 4000 (cubejs), 3001 (actions), …| Cubejs uses `yarn start.dev` w/ nodemon — source-mounted, hot-reloads on local edits. |
| client-v2 (Vite) | `cd ../client-v2 && yarn dev` | 8000 | Independent of cxs2; dev-only. |
| cxs-agents orchestrator | `./utils/devctl.sh orchestrator restart` | 8090 | Restart picks up Python edits. Default agent for `agent restart` is now `orchestrator` (was `baseline`). |
| cxs2 (Next.js HTTPS) | `bun run dev:https` (or already running) | 3000 (HTTPS at `https://local.fraios.dev:3000`) | Next.js + Turbopack hot-reloads. Cert is `local.fraios.dev` → `localhost` won't validate. |
| ClickHouse port-forward | `kubectl port-forward -n clickhouse svc/clickhouse-fraios-clickhouse 18123:8123` | 18123 | Memory note: `dbx.fraios.dev` Tailscale address is deprecated; this kubectl forward is the current method. Synmetrix CubeJS reaches it via `host.docker.internal:18123`. |

Health checks:

```bash
curl -sf -o /dev/null -w "cubejs %{http_code}\n"   -m 3 http://localhost:4000/readyz
curl -sf -o /dev/null -w "hasura %{http_code}\n"   -m 3 http://localhost:8080/healthz
curl -sf -o /dev/null -w "client-v2 %{http_code}\n" -m 3 http://localhost:8000/
curl -ksf -o /dev/null -w "cxs2 %{http_code}\n"    -m 3 https://local.fraios.dev:3000/
curl -sf -o /dev/null -w "cxs-agents %{http_code}\n" -m 3 http://localhost:8090/health
```

Local synmetrix env (`.env`):
- `JWT_KEY` (HS256 secret used by FraiOS-style local tokens) — `LGB6j3RkoVuOuqKzjgnCeq7vwfqBYJDw` in this dev environment.
- Local Hasura admin secret: `devsecret` (from container env, not in repo `.env`).

---

## Driving the test

1. Open `https://local.fraios.dev:3000/dashboard` in Playwright (or browser).
2. Cache-bust the URL (`?cb=anything`) on first load — older builds may serve cached HTML referencing missing JS bundles.
3. Type the prompt into the "I would like to..." textbox; submit.
4. Wait ~60–120 s. Monitor `cxs-agents/.logs/orchestrator.log` for tool calls.
5. Expect the right pane (canvas) to populate with a `data-visualization` iframe.

Useful Playwright bits:

```js
// Submit programmatically (UI controls are flaky)
const tb = document.querySelector('input[type="text"], textarea, [role="textbox"]');
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
setter.call(tb, 'I would like to explore popular POIs last summer');
tb.dispatchEvent(new Event('input', {bubbles:true}));
tb.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
```

---

## Fastest A-Z test (one prompt, two grades)

The whole test boils down to **one prompt + one grader command**. Two
separable grades come out of every run:

- **A — Ability**: did the chain reach a render? (`cube_list` ≥1,
  `cube_discover` ≥1, `browser_render_data_visualization` ≥1)
- **B — Quality**: did Tychi consult the dashboard reference material
  before authoring, and what did the cxs2 validator say
  (`PASS` / `PASS_WITH_WARNINGS` / `FAIL`, plus counts of `autoFixed`,
  `warnings`, `remainingIssues`)?

### Recipe

```bash
# 1) Snapshot the log offset BEFORE the prompt
OFF=$(wc -c < ~/Development/cxs-agents/.logs/orchestrator.log)

# 2) Drive the prompt in the cxs2 chat (Playwright snippet above, or by hand)
#    Wait ~60–120s for Tychi to finish.

# 3) Score the slice — six greps, paste-and-read
LOG=~/Development/cxs-agents/.logs/orchestrator.log
SLICE=$(mktemp); tail -c "+$OFF" "$LOG" > "$SLICE"

# Infrastructure
echo "cxs MCP attaches:           $(grep -ac 'attached.*CXS MCP tools' "$SLICE")"
echo "cxs MCP no-cached misses:   $(grep -ac 'no cached CXS MCP clients' "$SLICE")"
echo "cxs MCP TypeError failures: $(grep -ac 'Failed to initialize CXS MCP' "$SLICE")"
echo "  (TypeError > 0 → agentscope venv stale; reinstall)"

# A) ability — tool counts
echo
echo "=== A: ABILITY ==="
grep -aoE '"name":[[:space:]]*"(cube_list|cube_discover|cube_query|browser_render_data_visualization|read_skill_file)"' "$SLICE" \
  | sort | uniq -c | sort -rn

# B) quality — verdict + reference reads
echo
echo "=== B: QUALITY ==="
echo -n "validator verdict: "
grep -aoE '\\"verdict\\":[[:space:]]*\\"(PASS_WITH_WARNINGS|PASS|FAIL)\\"|"verdict":[[:space:]]*"(PASS_WITH_WARNINGS|PASS|FAIL)"' "$SLICE" \
  | tail -1 | grep -oE '(PASS_WITH_WARNINGS|PASS|FAIL)' | head -1 || echo "(no render reached)"
echo "reference files read:"
grep -aoE '"name":[[:space:]]*"read_skill_file"[^}]*"file_path":[[:space:]]*"[^"]+\.md"' "$SLICE" \
  | grep -oE '[a-z0-9_-]+\.md' | sort | uniq -c | sort -rn || echo "  (none)"

# Side-channel
echo
echo "=== SIDE-CHANNEL ==="
echo "skill invocations: $(grep -ac 'SKILL_INVOKE' "$SLICE")"
echo "destructive plan replacements (should be 0): $(grep -ac 'PLAN_SEED_REPLACING_ACTIVE_PLAN' "$SLICE")"

rm -f "$SLICE"
```

Sample of a healthy run:
```
cxs MCP attaches:           1
cxs MCP no-cached misses:   0
cxs MCP TypeError failures: 0

=== A: ABILITY ===
   1 "name": "browser_render_data_visualization"
   2 "name": "cube_discover"
   1 "name": "cube_list"
   3 "name": "read_skill_file"

=== B: QUALITY ===
validator verdict: PASS_WITH_WARNINGS
reference files read:
   2 dashboard-principles.md
   1 lazy-classification.md

=== SIDE-CHANNEL ===
skill invocations: 1
destructive plan replacements (should be 0): 0
```

**A grade** = `cube_list ≥1` AND `cube_discover ≥1` AND `render ≥1`.
**B grade** = `verdict ∈ {PASS, PASS_WITH_WARNINGS}` AND `read_skill_file ≥1`.

Sample of a healthy run:
```
A) Ability — did the chain run?
  cube_list:     1
  cube_discover: 2
  render:        1
  GRADE:         PASS

B) Quality — references + validator
  read_skill_file calls:  3
  Files read (top):
    3 dashboard-principles.md
    1 lazy-classification.md
  Validator verdict: PASS_WITH_WARNINGS
  autoFixed items:   2
  warnings items:    1
  remainingIssues:   0
  GRADE:             WARN
```

### What "good quality" looks like

Tychi's `data-exploration` skill ships these references at
`agents/Tychi/skills/data-exploration/references/`:

| File | Loaded when … |
|---|---|
| `improve-pipeline.md` | Always (validator pipeline overview) |
| `lazy-classification.md` | Field-cardinality decisions |
| (any other reference files added later) | Per their own when-to-read clauses in the SKILL.md |

If `read_skill_file calls = 0` in the scorecard, Tychi authored the
dashboard purely from the system prompt — that's the most common cause
of low B-grade runs even when verdict is PASS_WITH_WARNINGS. Two ways to
push reference reads up:

1. **Skill-side** — strengthen the "you MUST `read_skill_file(...)`
   before authoring" prose in `data-exploration/SKILL.md`. The
   `semantic-layer` skill's `workflow.steps` frontmatter is the
   gold-standard pattern (each step prescribes exactly which file to
   read with a "MUST quote outcome" clause).
2. **Tool-boundary** — make `browser_render_data_visualization`'s
   nextActions, on FAIL, name a specific reference file to read; today
   it already does this for sparse dashboards (Tychi/skills/data-exploration
   `dashboard-principles.md` mention).

### What "good ability" looks like

`A grade = PASS` requires all three of `cube_list`, `cube_discover`,
`browser_render_data_visualization` to fire. Common failure modes and
where to look:

| Symptom | Likely cause | Where |
|---|---|---|
| `cxs MCP TypeError failures > 0` | agentscope venv stale | `.venv/bin/pip show agentscope` |
| `no cached CXS MCP` > 0 | cxs MCP attach failed silently (or parent session hadn't connected) | `shared/agents/server/stream.py:206` |
| `cube_list` returns empty | partition mismatch on the active team | synmetrix `metaAll.js` + team `settings.partition` (PR #50 widens to also match `team.name`) |
| `cube_discover` not called | tool descriptions don't pull the agent past `cube_list` | cxs2 `cube-analytics/discover.ts` description |
| `render` not called or hallucinated cube | data-exploration skill prose ignored | strengthen with `workflow.steps` |
| `destructive plan replacements > 0` | wrong-skill misroute (semantic-layer fired for catalog) | cxs-agents PR #207 + further description tightening |

---

## Diagnostics

### Did Tychi attach the CXS MCP tools?

```bash
grep -aE "attached.*CXS MCP|no cached CXS MCP|Failed to initialize CXS MCP" \
  ~/Development/cxs-agents/.logs/orchestrator.log | tail
```

Healthy looks like:
```
INFO | client.py:96  | MCP client 'cxs-platform' connected with 11 tools
INFO | stream.py:290 | attach_cached_cxs_mcp_tools_to_agent: attached 11 CXS MCP tools (groups=['cxs']) to agent 'tychi'
```

Bad looks like:
```
WARNING | stream.py:1987 | Failed to initialize CXS MCP 'cxs': ...
INFO    | stream.py:244  | attach_cached_cxs_mcp_tools_to_agent: no cached CXS MCP clients
```

### Are cube tools visible to the LLM at reasoning time?

`agents/orchestrator/service_adapter.py` emits a `[TOOL_VISIBILITY]` line per Tychi spawn (added this session, INFO-level):

```
INFO | service_adapter.py:1107 | [TOOL_VISIBILITY] agent=tychi
  groups={'skills':True,'workers':False,'search':False,'files':False,
          'plan_related':False,'cxs':True,'browser':True,'communication':False}
  visible=25 hidden=19 cube_visible=['cube_list','cube_discover','cube_query']
```

If `cxs:False` here, the bootstrap pass didn't activate it. If `cube_visible` is empty, the cxs MCP didn't attach.

### Tool-call counts for a single conversation

```bash
# Mark log offset, drive prompt, then:
tail -c +<offset> ~/Development/cxs-agents/.logs/orchestrator.log \
  | grep -aoE '"name":\s*"[a-z_]+"' | sort | uniq -c | sort -rn
```

Healthy run for the canonical prompt looks like:
- ≥1 `cube_list`
- ≥1 `cube_discover`
- ≥1 `browser_render_data_visualization`
- 1 `communicate` (Dex → Tychi delegation)
- multiple `activate_tool_groups` (skills, cxs, browser, plan_related, communication)

### What cube_list actually returned

```bash
TOKEN=$(...mint or extract...)  # see below
curl -sk -m 15 -H "Authorization: Bearer $TOKEN" \
  https://dbx.fraios.dev/api/v1/meta-all | jq '{
    count: (.datasources|length),
    teams: [.datasources[] | {name:.datasource_name, cubes:(.cubes|length)}]
  }'
```

### Extracting a fresh user JWT via Playwright

```js
const r = await fetch('/api/v1/auth/token', { credentials: 'include' });
const { accessToken } = await r.json();
console.log(accessToken);  // RS256 WorkOS JWT, ~30-min lifetime
```

This token is accepted by both **dbx.fraios.dev** synmetrix and **localhost:4000** synmetrix (both verify via WorkOS JWKS — local synmetrix is configured for the same WorkOS app).

### Minting a local FraiOS HS256 JWT (for development/test)

```bash
cd services/cubejs && node -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({
  accountId: 'test-account',          // REQUIRED — detectTokenType uses this
  userId:    '<existing-user-uuid>',
  email:     '<existing-email>',
  partition: '<team-name-or-partition>',
  iat: Math.floor(Date.now()/1000),
  exp: Math.floor(Date.now()/1000)+3600,
}, process.env.JWT_KEY || 'LGB6j3RkoVuOuqKzjgnCeq7vwfqBYJDw',
   { algorithm: 'HS256' }));"
```

Note: the `JWT_KEY` in synmetrix `.env` may differ from what the running cubejs container has loaded. Check with `docker exec synmetrix-cubejs-1 env | grep JWT_KEY` before relying on a self-minted token.

`detectTokenType` requires `payload.accountId` to classify a token as FraiOS (HS256). Without that claim, it falls through to `hasura` and is rejected by `/meta-all`.

---

## What's been fixed this session

All merged unless noted:

| # | Repo / PR | Title | What it fixes |
|---|---|---|---|
| 1 | synmetrix #48 | fix(actions): prevent unhandledRejection crash on WorkOS refresh failure | Actions service crashed when WorkOS rejected an expired refresh token — `.finally()` chain produced a dangling rejection. Added `.catch(()=>{})`. |
| 2 | synmetrix #49 | fix(cubejs): guard express error handler against already-sent responses | Fallback error handler called `res.status().send()` unconditionally → `Cannot set headers after they are sent`. Added `res.headersSent` guard. |
| 3 | cxs2 #498 | fix(mcp/cube-analytics): treat non-UUID datasourceId/branchId as null | Solution-link metadata sometimes carried placeholder strings like `"primary"`; the resolver short-circuited partition lookup if any value was set. Added a UUID guard so non-UUIDs become `null` and partition resolution runs. |
| 4 | cxs2 #499 | fix(canvas): guard render handler against unresolved cube metadata | When `validateBeforeRender` threw "Cube metadata unavailable" the raw error bubbled to the agent. Now caught and translated into a structured FAIL with prescriptive `nextActions` (call `cube_list`, then `cube_discover`, then retry render). Also normalised tool-name underscores throughout `CanvasTools.ts`. |
| 5 | cxs2 #500 | fix(mcp/cube-analytics): tighten cube_list/cube_discover/cube_query descriptions | Old descriptions read like reference docs ("what I return"); none mentioned trigger words like *explore* or *what's available*. Rewrote each as a tight input/output spec — the LLM derives ordering from the parameter chain (no "Step 1/2/3" prose). This is the change that finally got Tychi to actually call `cube_list`. |
| 6 | cxs-agents #208 | fix(tychi): make tool-call path reliable end-to-end | Three small bundled changes: <br>(a) Tychi system prompt — drop skill-naming, add anti-hallucination clause ("never assert presence/absence of data without running the tool"); <br>(b) `_log_tool_visibility` diagnostic + INFO-level bootstrap log; <br>(c) `devctl.sh DEFAULT_AGENT="orchestrator"`. |
| 7 | cxs-agents #207 | fix(skills/semantic-layer): refuse catalog listing — redirect to cxs MCP tools | The semantic-layer skill's plan-seeder destructively replaces the active plan when invoked. Tychi was reaching for it for catalog listing → killing the dashboard plan. Tightened the skill's description and `call_requirement` with a negative requirement at the top. |
| 8 | synmetrix #50 | fix(cubejs/meta-all): widen partition match to team.name OR team.settings.partition | `meta-all` filtered teams by `team.settings.partition === jwt.partition`. A team's settings.partition can drift from its name; we found a `blue.is` team whose settings.partition was left at `"bluecar.is"`. Match now succeeds if EITHER the team name OR the soft setting matches the JWT partition — single-team scope preserved. Threaded `team.name` through the `findUser` GraphQL projection. |

Cluster-side state changes on `dbx.fraios.dev` (no PR — direct Hasura admin):
- Copied 2 datasources + 4 dataschemas from `bluecar.is` team to `blue.is` team.
- Promoted `stefan@snjallgogn.is` → `owner` of `blue.is`.
- Corrected `blue.is.team.settings.partition` from `"bluecar.is"` → `"blue.is"`.

Two upstream dependency changes (no PR but worth recording):
- **`agentscope: 1.0.11 → 1.0.18`** in cxs-agents venv (`requirements.txt` already pinned 1.0.18; venv was stale). 1.0.11's `Toolkit.register_tool_function` lacked the `func_name` kwarg — every CXS MCP attach raised `TypeError`, the broad catch swallowed it, and the cache stayed empty. **One pinned-version mismatch caused: search-tools loops, wrong-skill pivots, hallucinated cube names, stuck plans, duplicated plans.** If the test starts misbehaving again, check this version first (`/Users/stefanbaxter/Development/cxs-agents/.venv/bin/pip show agentscope`).
- Confirmed `bootstrap_groups=["skills","cxs"]` in `agents/tychi/config.py` is honoured by `_post_integration_bootstrap` after the MCP attach completes (it runs AFTER `attach_cached_cxs_mcp_tools_to_agent`, so the `cxs` group exists by then).

---

## Open improvements / known gaps

These are good candidates for the next session:

1. **`cube_list` initial empty result.** First `cube_list` per Tychi spawn occasionally returns `{datasources:[]}` because synmetrix's `findUser` 30 s cache served stale data from a prior request before partition was right. Hits the cache miss on retry. Worth surfacing the cache hit/miss in logs, or invalidating on auth state change.

2. **Tychi's skill machinery still emits a stale `create_plan()` empty-args call once per run** (visible as `Error: PlanNotebook.create_plan() missing 4 required positional arguments`). Doesn't break anything but is noisy. Look at `agents/orchestrator/service_adapter.py` plan seeding around skill invocation.

3. **`semantic-layer` skill's destructive plan replacement** (`SKILL_PLAN_SEED_REPLACING_ACTIVE_PLAN`) is still possible if Tychi misroutes. PR #207 makes the description discourage it; the harder fix is to make plan-seeding non-destructive when an active plan exists for the conversation.

4. **`data-exploration` skill prose still says "Activate silently on entry: cxs and browser. If either group is absent, the user is not in cxs2 — say so once and stop."** That's now structurally false (groups are pre-activated by `bootstrap_groups`) and gives the LLM a license to bail. Worth a follow-up edit in `agents/Tychi/skills/data-exploration/SKILL.md`.

5. **No `workflow.steps` on `data-exploration`.** The semantic-layer skill has a frontmatter `workflow.steps` that the runtime seeds as a plan with examiner-enforced "MUST quote outcome" clauses. data-exploration only has prose. Adding a 3-step contract (`cube_list` → `cube_discover` → `browser_render_data_visualization`) would be a structural belt-and-braces over the description-side fix that already works.

6. **`Toolkit.register_tool_function` failure-mode** — the broad `except BaseException` in `_connect_single_cxs_mcp` swallowed the TypeError silently for many sessions before we found it. Worth narrowing to known network/timeout errors so future API drifts surface immediately.

7. **Local meta-all retest of synmetrix #50.** The fix is on `main` and live in the local cubejs (nodemon picked it up), but the local end-to-end test ran into a JWT signature mismatch (self-minted token vs running container's `JWT_KEY`). Easiest path: extract a real session token from cxs2 via `/api/v1/auth/token` and curl `localhost:4000/api/v1/meta-all` with that.

8. **Tychi's PERSONA.md is stale** — describes a `delegate_to_specialist` architecture with `pipeline`/`cube`/`dev`/`explorer` specialists that have all been disabled (`Tychi specialists disabled (pipeline/explorer/dev). Set TYCHI_ENABLE_SPECIALISTS=1 to re-enable.`). System prompt is correctly loaded from `prompts/system.txt` (PERSONA.md is fallback only) but the file should be deleted or rewritten so it doesn't mislead future readers.

---

## Useful one-liners

```bash
# Tail orchestrator log filtered for the current investigation
tail -f ~/Development/cxs-agents/.logs/orchestrator.log \
  | grep --line-buffered -aE "TOOL_VISIBILITY|attached.*CXS|SKILL_INVOKE|cube_list|cube_discover|browser_render|verdict|PLAN_SEED"

# Count tool calls in current run
tail -c +<offset> ~/Development/cxs-agents/.logs/orchestrator.log \
  | grep -aoE '"name":\s*"[a-z_]+"' | sort | uniq -c | sort -rn

# Verify Tychi config has cxs in bootstrap_groups
grep -A2 bootstrap_groups ~/Development/cxs-agents/agents/tychi/config.py

# Verify agentscope version (must be ≥ 1.0.18)
~/Development/cxs-agents/.venv/bin/pip show agentscope | grep Version

# Check active synmetrix branch
git -C ~/Development/synmetrix branch --show-current

# Restart orchestrator (default is now `orchestrator`, was `baseline`)
~/Development/cxs-agents/utils/devctl.sh orchestrator restart
```

---

## Cluster admin (when needed)

The `dbx.fraios.dev` cluster's Hasura is reachable via port-forward + admin secret stored in a k8s Secret. The harness asks for explicit user authorization before extracting credentials each session.

```bash
# Stash admin secret (requires user-confirmed permission scope)
kubectl get secret -n synmetrix synmetrix-secrets -o json \
  | jq -r '.data.HASURA_GRAPHQL_ADMIN_SECRET' | base64 -d > /tmp/hadmin

# Port-forward Hasura
kubectl port-forward -n synmetrix svc/synmetrix-hasura 18080:8080 &

# Query
curl -s http://localhost:18080/v1/graphql \
  -H "x-hasura-admin-secret: $(cat /tmp/hadmin)" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{ teams(where:{name:{_eq:\"blue.is\"}}){ id name settings members{ user{ display_name } member_roles{ team_role } } datasources{ id name } } }"}'
```

`blue.is` reference IDs (current state on `dbx.fraios.dev`):
- team_id: `c523ec6d-cf6d-4bb1-b5db-cb90d76980d2`
- `dev-clickhouse` datasource_id: `394db2d6-bf14-4517-ac33-f605f73871d6` (1 cube: `bluecar_stays`)
- `prod` datasource_id: `bdf28038-2f63-4203-ae40-4042c44db495` (0 cubes)
- branch_id (dev-clickhouse `main`): `fecbdd1f-68f6-4083-8df2-1c54c55c9911`
- version_id (dev-clickhouse latest): `94f83d27-ca8d-4036-b4eb-1948099e44c5`
- stefan@snjallgogn.is user_id: `3319c92b-9310-43b5-92b9-e6789c497b4f` (`owner` of `blue.is`)

---

## Where everything lives

Code paths worth knowing:

| What | Path |
|---|---|
| `/api/v1/meta-all` handler | `synmetrix/services/cubejs/src/routes/metaAll.js` |
| `findUser` + `userQuery` GraphQL | `synmetrix/services/cubejs/src/utils/dataSourceHelpers.js` (line ~244) |
| `provisionUserFromWorkOS` / `provisionUserFromFraiOS` | same file (line ~653 / ~808) |
| `defineUserScope` (request-time auth) | `synmetrix/services/cubejs/src/utils/defineUserScope.js` |
| `resolvePartitionTeamIds` (other routes still use this) | `synmetrix/services/cubejs/src/routes/discover.js` (line ~42) |
| cxs MCP cube tools (descriptions, schemas, handlers) | `cxs2/src/lib/services/mcp/component-tools/cube-analytics/{list,discover,query}.ts` |
| cxs MCP solution-link resolution (with UUID guard) | `cxs2/src/lib/services/mcp/component-tools/cube-analytics/cube-meta.ts` |
| `browser_render_data_visualization` handler (with order-guard nextActions) | `cxs2/src/lib/rpc/CanvasTools.ts` (~line 1516) |
| `validateBeforeRender` | `cxs2/src/lib/dashboard-adjuster/validate-before-render.ts` |
| Tychi system prompt | `cxs-agents/agents/Tychi/prompts/system.txt` |
| Tychi config (incl. `bootstrap_groups`) | `cxs-agents/agents/tychi/config.py` |
| `data-exploration` skill | `cxs-agents/agents/Tychi/skills/data-exploration/SKILL.md` |
| `semantic-layer` skill (with negative-requirement frontmatter) | `cxs-agents/agents/Tychi/skills/semantic-layer/SKILL.md` |
| Orchestrator service adapter (bootstrap + tool-visibility log + cxs MCP attach) | `cxs-agents/agents/orchestrator/service_adapter.py` |
| `attach_cached_cxs_mcp_tools_to_agent` (Tychi inherits parent's MCP) | `cxs-agents/shared/agents/server/stream.py` (~line 206) |
| `_post_integration_bootstrap` (re-applies bootstrap_groups after late integrations) | `cxs-agents/agents/orchestrator/service_adapter.py` (~line 493) |
| devctl (orchestrator default) | `cxs-agents/utils/devctl.sh` |
