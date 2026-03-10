# Data Model: Model Authoring Improvements

**Date**: 2026-03-10
**Feature**: 006-model-authoring

## Entities

### SchemaSpec (static, client-side)

The structured definition of all valid Cube.js model properties. Shipped as a TypeScript file in client-v2.

| Field | Type | Description |
|-------|------|-------------|
| version | string | Cube.js version this spec targets (e.g., "1.6.19") |
| constructs | Map<string, ConstructSpec> | Top-level constructs: cube, view |
| templateVariables | TemplateVariableSpec[] | CUBE, FILTER_PARAMS, SECURITY_CONTEXT, SQL_UTILS, COMPILE_CONTEXT |

### ConstructSpec

| Field | Type | Description |
|-------|------|-------------|
| name | string | "cube" or "view" |
| properties | Map<string, PropertySpec> | All valid top-level properties |
| memberTypes | Map<string, MemberTypeSpec> | dimensions, measures, joins, segments, pre_aggregations |

### PropertySpec

| Field | Type | Description |
|-------|------|-------------|
| key | string | Property name (snake_case for YAML, camelCase for JS) |
| jsKey | string | camelCase variant |
| yamlKey | string | snake_case variant |
| type | "string" \| "boolean" \| "number" \| "enum" \| "object" \| "array" \| "sql" \| "reference" \| "function" | Value type |
| required | boolean | Whether property is required |
| values | string[] | Valid values for enum types |
| description | string | Human-readable description for hover/completion docs |
| deprecated | boolean | Whether this property is deprecated |
| deprecatedBy | string | Replacement property name |
| children | Map<string, PropertySpec> | Nested properties for object types |
| referenceType | "cube" \| "dimension" \| "measure" \| "segment" \| "pre_aggregation" | For reference-typed properties |

### MemberTypeSpec

| Field | Type | Description |
|-------|------|-------------|
| name | string | "dimensions", "measures", "joins", etc. |
| properties | Map<string, PropertySpec> | Valid properties for this member type |
| typeValues | string[] | Valid values for the `type` property of this member |

### CubeRegistryEntry (runtime, client-side)

Populated from FetchMeta query. One entry per cube in the current branch.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Cube name |
| title | string | Display title |
| type | "cube" \| "view" | Construct type |
| dimensions | MemberEntry[] | All dimensions |
| measures | MemberEntry[] | All measures |
| segments | MemberEntry[] | All segments |

### MemberEntry

| Field | Type | Description |
|-------|------|-------------|
| name | string | Member name |
| title | string | Display title |
| type | string | Member type value (string, number, sum, count, etc.) |
| primaryKey | boolean | Whether this is a primary key dimension |

### ParsedDocument (transient, client-side)

Format-agnostic representation of a model file, produced by YAML or JS parser.

| Field | Type | Description |
|-------|------|-------------|
| format | "yaml" \| "js" | Source format |
| cubes | ParsedCube[] | Parsed cube definitions |
| views | ParsedView[] | Parsed view definitions |
| errors | ParseError[] | Syntax errors found during parsing |

### ParsedCube / ParsedView

| Field | Type | Description |
|-------|------|-------------|
| name | string | Cube/view name |
| nameRange | MonacoRange | Source position of the name |
| properties | ParsedProperty[] | Top-level properties |
| members | Map<string, ParsedMember[]> | dimensions, measures, joins, etc. |

### ParsedMember

| Field | Type | Description |
|-------|------|-------------|
| name | string | Member name |
| range | MonacoRange | Full member source range |
| nameRange | MonacoRange | Name-only source range |
| properties | ParsedProperty[] | Member properties with positions |

### ParsedProperty

| Field | Type | Description |
|-------|------|-------------|
| key | string | Property name |
| value | any | Parsed value |
| range | MonacoRange | Full property range |
| valueRange | MonacoRange | Value-only range |

### ValidationError (backend → frontend)

Returned from the `/api/v1/validate` endpoint.

| Field | Type | Description |
|-------|------|-------------|
| severity | "error" \| "warning" | Error severity |
| message | string | Human-readable error message |
| fileName | string | File containing the error |
| startLine | number | 1-based start line |
| startColumn | number | 1-based start column |
| endLine | number \| null | 1-based end line (null if unavailable) |
| endColumn | number \| null | 1-based end column (null if unavailable) |

## Relationships

```
SchemaSpec ──provides property definitions──▶ CompletionProvider
SchemaSpec ──provides validation rules──▶ DiagnosticProvider (client-side)
CubeRegistry ──provides cube/member names──▶ CompletionProvider
CubeRegistry ──populated from──▶ FetchMeta GraphQL query
ParsedDocument ──provides cursor context──▶ CompletionProvider, HoverProvider
ParsedDocument ──provides structure for──▶ DiagnosticProvider (client-side)
ValidationError ──produced by──▶ CubeJS /api/v1/validate endpoint
ValidationError ──consumed by──▶ DiagnosticProvider (backend results)
```

## State Transitions

### Cube Registry Lifecycle
1. **Empty** → **Loading** (on editor mount, FetchMeta query fires)
2. **Loading** → **Ready** (FetchMeta returns, registry populated)
3. **Ready** → **Refreshing** (on file save or smart regeneration)
4. **Refreshing** → **Ready** (FetchMeta returns updated data)
5. **Loading/Refreshing** → **Error** (FetchMeta fails — autocomplete works without cube refs)

### Validation Lifecycle (per file)
1. **Clean** → **Validating (client)** (user edits file, debounce timer fires)
2. **Validating (client)** → **Client errors shown** (parser + schema spec validation complete)
3. **Client errors shown** → **Validating (backend)** (user saves file)
4. **Validating (backend)** → **All errors shown** (backend returns, markers merged)
5. **All errors shown** → **Validating (client)** (user edits again)
