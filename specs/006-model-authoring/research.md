# Research: Model Authoring Improvements

**Date**: 2026-03-10
**Feature**: 006-model-authoring

## 1. Monaco Editor Language Service APIs

### Decision: Register custom providers for both YAML and JavaScript

Monaco supports registering the same provider object for multiple languages via separate `register*` calls. Each returns an `IDisposable`.

### Key APIs

**CompletionItemProvider** — `monaco.languages.registerCompletionItemProvider(langId, provider)`
- `provideCompletionItems(model, position, context, token)` → `CompletionList`
- `triggerCharacters`: string[] on the provider object (e.g., `.`, `$`, `:`)
- CompletionItem properties: `label`, `kind`, `insertText`, `insertTextRules` (set `InsertAsSnippet` for snippet syntax), `documentation` (supports markdown), `sortText`, `detail`, `range`
- Snippet syntax: `$1`/`$2` tabstops, `${1:default}` placeholders, `${1|a,b,c|}` choice dropdowns, `$0` final position

**Markers API** — `monaco.editor.setModelMarkers(model, owner, markers)`
- No provider pattern — markers are pushed imperatively
- `IMarkerData`: `severity`, `message`, `startLineNumber`, `startColumn`, `endLineNumber`, `endColumn`, `source`, `code`
- Severity levels: `Error` (8), `Warning` (4), `Info` (2), `Hint` (1)
- Pattern: listen to `editor.onDidChangeModelContent`, debounce, validate, call `setModelMarkers`

**HoverProvider** — `monaco.languages.registerHoverProvider(langId, provider)`
- `provideHover(model, position, token)` → `Hover`
- Hover: `{ range, contents: IMarkdownString[] }`

### Alternatives Considered
- **monaco-languageclient** (LSP over WebSocket): Rejected — too heavy for our needs, adds infrastructure complexity
- **Custom language ID**: Rejected — registering on existing `yaml`/`javascript` IDs is simpler and avoids breaking syntax highlighting

---

## 2. Cube.js v1.6 Model Specification

### Decision: Build schema spec from CubeValidator.js Joi schema (authoritative source)

The complete spec was extracted from `@cubejs-backend/schema-compiler/dist/src/compiler/CubeValidator.js` (v1.6.19). This is the Joi-based validator that accepts/rejects every property.

### Coverage Summary

| Construct | Properties | Types/Enums |
|-----------|-----------|-------------|
| `cube()` top-level | 18 properties | — |
| `dimensions` | 14 base + case/geo/granularities | type: string, number, boolean, time, geo |
| `measures` | 15 base + multi-stage | type: count, sum, avg, min, max, number, count_distinct, count_distinct_approx, running_total, string, boolean, time + multi-stage: number_agg, rank |
| `joins` | 2 (sql, relationship) | relationship: many_to_one, one_to_many, one_to_one (+ aliases) |
| `segments` | 7 properties | — |
| `pre_aggregations` | 15 base + type-specific | type: rollup, original_sql, rollup_join, rollup_lambda, auto_rollup |
| `refresh_key` | 4 forms (every+sql, every+cron, immutable) | — |
| `view()` | base + cubes/folders arrays | — |
| Template variables | FILTER_PARAMS, SECURITY_CONTEXT, SQL_UTILS, COMPILE_CONTEXT, CUBE | — |
| `access_policy` | role, conditions, member_level, row_level | 22 filter operators |
| `hierarchies` | title, public, levels | — |

### YAML ↔ JS Key Mapping
YAML uses `snake_case`, JS uses `camelCase`. 40+ property name mappings documented. The schema spec must store both forms and select based on file format.

### Alternatives Considered
- **Scraping Cube.js docs**: Rejected — docs lag behind code, miss internal properties
- **Generating spec at build time from CubeValidator.js**: Considered but deferred — would automate spec updates on Cube.js upgrades, but adds build complexity. The static file with a version constant is simpler for now.

---

## 3. CubeJS Backend Validation Endpoint

### Decision: Use `prepareCompiler` from `@cubejs-backend/schema-compiler` for standalone validation

### Available APIs

**`prepareCompiler(repo, options)`** from `@cubejs-backend/schema-compiler`:
- Input: `SchemaFileRepository` with `dataSchemaFiles()` returning `FileContent[]`
- Output: `{ compiler, metaTransformer, cubeEvaluator, joinGraph, ... }`
- `compiler.compile()` triggers full validation
- `compiler.errorReport.getErrors()` → `CompilerErrorInterface[]` with `message`, `fileName`, `lineNumber`, `position`
- `compiler.errorReport.getWarnings()` → `SyntaxErrorInterface[]` with `loc: { start: { line, column }, end: { line, column } }`

**ErrorReporter** provides structured errors:
```typescript
interface CompilerErrorInterface {
  message: string;
  plainMessage?: string;
  fileName?: string;
  lineNumber?: string;
  position?: number;
}

interface SyntaxErrorInterface {
  message: string;
  plainMessage?: string;
  loc: { start: { line, column }, end?: { line, column } } | null;
}
```

**SchemaFileRepository** interface:
```typescript
interface FileContent { fileName: string; content: string; readOnly?: boolean; }
interface SchemaFileRepository {
  localPath(): string;
  dataSchemaFiles(includeDependencies?: boolean): Promise<FileContent[]>;
}
```

### Validation Stages Available
1. **Syntax** — YAML/JS parse errors (YamlCompiler, transpilers)
2. **Schema** — CubeValidator Joi validation (property names, types, required fields)
3. **Semantic** — CubeToMetaTransformer (cross-cube references, join validation)
4. **Graph** — JoinGraph (circular dependencies, relationship consistency)

### Endpoint Design
- Route: `POST /api/v1/validate`
- Input: `{ files: [{ fileName, content }] }` — all files in the current version
- Auth: Same `checkAuthMiddleware` as other routes
- Process: Create in-memory `SchemaFileRepository` → `prepareCompiler()` → `compile()` → collect errors
- Output: `{ errors: [...], warnings: [...] }` with file/line/column positions

### Alternatives Considered
- **Using `cubejs.getCompilerApi(context).compileSchema()`**: Rejected — requires full security context setup, caches results, heavier weight. `prepareCompiler` is more direct for validation-only use.
- **Client-side only validation**: Rejected (per spec) — can't catch semantic errors like invalid join targets or circular dependencies without the compiler.
