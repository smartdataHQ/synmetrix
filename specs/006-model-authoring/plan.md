# Implementation Plan: Model Authoring Improvements

**Branch**: `006-model-authoring` | **Date**: 2026-03-10 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/006-model-authoring/spec.md`

## Summary

Transform the Models IDE Monaco editor from a plain text editor into a Cube.js-aware authoring environment with context-sensitive autocomplete (both YAML and JS), real-time validation (client-side structural + backend semantic), hover documentation, and an editor toolbar regenerate button for smart-generated models. Built as a custom Monaco Language Service backed by a static Cube.js schema spec (v1.6.19) and a runtime cube registry from FetchMeta.

## Technical Context

**Language/Version**: TypeScript (client-v2, React 18 + Vite 4), JavaScript ES modules (CubeJS service, Node.js 18+)
**Primary Dependencies**: Monaco Editor (existing), `yaml` ^2.3.4 (existing in CubeJS, add to client-v2), `@cubejs-backend/schema-compiler` ^1.6.19 (existing in CubeJS), Ant Design 5 (existing in client-v2), URQL (existing GraphQL client)
**Storage**: N/A (schema spec is static; cube registry is in-memory from FetchMeta)
**Testing**: Vitest (client-v2), StepCI (integration tests for new endpoint)
**Target Platform**: Browser (client-v2), Docker/Node.js (CubeJS service)
**Project Type**: Web application (frontend language service + backend validation endpoint)
**Performance Goals**: Autocomplete <100ms, client validation <500ms, backend validation <3s
**Constraints**: Must work with both YAML and JS model formats; must not break existing editor functionality
**Scale/Scope**: ~10 new files in client-v2, 2 new route files in CubeJS, 1 schema spec file (~1500 lines)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Service Isolation — PASS
- New `/api/v1/validate` and `/api/v1/version` endpoints are internal to the CubeJS service
- Frontend communicates via existing proxy pattern (`/api/v1/*` → CubeJS)
- No new cross-service contracts; only new CubeJS REST routes
- client-v2 changes are purely frontend (language service, UI components)

### II. Multi-Tenancy First — PASS
- Validate endpoint uses `checkAuthMiddleware` (JWT verification)
- Validation operates on files passed in the request body — no datasource/branch resolution needed
- Cube registry populated from FetchMeta which already respects the user's security context
- No changes to `defineUserScope.js` or `buildSecurityContext.js`

### III. Test-Driven Development — REQUIRED
- Schema spec: unit tests validating every property definition against CubeValidator.js
- Parsers (YAML + JS): unit tests with fixture model files
- Completion provider: unit tests with mock Monaco models verifying context → suggestion mapping
- Diagnostic provider: unit tests verifying marker generation from known errors
- Validate endpoint: StepCI integration test
- Merge preservation: integration test (smart regenerate with user content, verify preservation)

### IV. Security by Default — PASS
- Validate endpoint requires JWT authentication (same middleware as all CubeJS routes)
- No new secrets or credentials introduced
- No user input is executed — file content is only compiled/validated, never evaluated as code in a user context

### V. Simplicity / YAGNI — PASS
- Static schema spec is the simplest approach (vs. LSP server, vs. runtime spec generation)
- Reuses existing FetchMeta query for cube registry (no new GraphQL queries)
- Reuses existing `prepareCompiler` API for backend validation (no custom compiler logic)
- No new databases, caches, or infrastructure

### Post-Phase 1 Re-check — PASS
- No violations introduced during design phase
- All new code lives within existing service boundaries

## Project Structure

### Documentation (this feature)

```text
specs/006-model-authoring/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 research findings
├── data-model.md        # Entity definitions
├── quickstart.md        # Development guide
├── contracts/
│   ├── validate-endpoint.md    # POST /api/v1/validate contract
│   └── cubejs-version-endpoint.md  # GET /api/v1/version contract
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
services/cubejs/src/
├── routes/
│   ├── index.js                    # (modify) Register validate + version routes
│   ├── validate.js                 # (new) POST /api/v1/validate
│   └── version.js                  # (new) GET /api/v1/version
└── ...

../client-v2/src/
├── utils/
│   └── cubejs-language/            # (new) Language service module
│       ├── types.ts                # Shared types (ParsedDocument, CursorContext, etc.)
│       ├── spec.ts                 # Static Cube.js schema spec (~1500 lines)
│       ├── registry.ts             # Cube registry (wraps FetchMeta)
│       ├── yamlParser.ts           # YAML → ParsedDocument
│       ├── jsParser.ts             # JS → ParsedDocument
│       ├── completionProvider.ts   # Monaco CompletionItemProvider
│       ├── diagnosticProvider.ts   # Client-side + backend validation → markers
│       └── hoverProvider.ts        # Monaco HoverProvider
├── components/
│   └── CodeEditor/
│       ├── index.tsx               # (modify) Register providers, add toolbar
│       └── RegenerateModal.tsx     # (new) Merge strategy modal for smart-generated files
└── ...

tests/stepci/
└── validate_flow.yml              # (new) StepCI test for validate endpoint
```

**Structure Decision**: Web application structure — this feature spans the CubeJS backend service (2 new route files) and the client-v2 frontend (new `cubejs-language` module + editor modifications). Both live in their existing project directories with no new top-level structure.

## Complexity Tracking

| Decision | Complexity | Rejected Simpler Alternative | Justification |
|----------|------------|------------------------------|---------------|
| Static schema spec (~1500-line TypeScript file defining all Cube.js properties) | HIGH | **Runtime extraction from CubeValidator.js**: parse validator source at build time to auto-generate the spec. Rejected because CubeValidator internals are not a stable API and would break on Cube.js upgrades. | Static spec is manually maintained but predictable, testable, and decoupled from Cube.js internals. Version mismatch detected at runtime via `/api/v1/version`. |
| Dual parsers (YAML + JS) with shared CursorContext type | MEDIUM | **Single YAML-only parser**: require all models in YAML. Rejected because existing codebases have JS models and the spec explicitly requires both formats (FR-001). | CursorContext union type keeps downstream consumers (completion, diagnostic, hover providers) format-agnostic. |

### Existing Utilities

The following existing files are referenced by tasks but not created by this feature:
- `../client-v2/src/utils/provenanceParser.ts` — exports `isSmartGenerated(code)` and `parseProvenance(code)`, used by T023 to detect smart-generated files

### Known Limitations (v1)

| Limitation | Impact | Deferred To |
|------------|--------|-------------|
| **Smart-gen writes JS, but merger/reprofile are YAML-only** | Regenerate button restricted to YAML files only (FR-004). JS smart-generated files can't be re-profiled with merge until a JS merge path is built. | Future: JS-aware merger + provenance detection |
| **Cube registry is save-based, not workspace-aware** | Cross-cube autocomplete uses last-saved FetchMeta state. Unsaved renames/additions not reflected until save. | Future: workspace overlay combining saved meta + parsed dirty buffers |
| **Existing Console error surface not migrated** | Branch-level compile errors from FetchMeta continue to show in Console component. New inline markers show per-file errors from `/api/v1/validate`. Both coexist — no deduplication or unification in v1. | Future: unify error surfaces, deprecate Console for model files |
| **JS parser uses regex+brace-matching, not AST** | Adequate for `cube()`/`view()` extraction but cannot handle deeply nested template literals or arbitrary JS. Code outside these blocks is ignored (no false positives). | Future: Babel/Acorn parser if JS model complexity warrants it |

### Prerequisite Bugs

| Bug | Location | Impact | Task |
|-----|----------|--------|------|
| Language detection splits on wrong `.` segment | `CodeEditor/index.tsx:128` — `active.split(".")[0]` extracts basename, not extension | Monaco providers keyed on `'yaml'`/`'javascript'` won't attach for files like `semantic_events.js` | T038 |
