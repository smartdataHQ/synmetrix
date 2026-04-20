# Model Management API — StepCI Workflows

End-to-end contract coverage for the six Model Management endpoints introduced in
feature `011-model-mgmt-api`.

## Layout

```
tests/workflows/model-management/
├── README.md                     ← this file
├── fixtures/                     ← SC-003 corpus + shared scenario seeds
│   ├── valid-append.yml
│   ├── dangling-join.yml
│   ├── circular-extends.yml
│   ├── measure-to-measure-typo.yml
│   ├── preagg-reference-break.yml
│   └── filter-params-orphan.yml
├── is-current-invariant.yml      ← guards the versions.is_current trigger (T008)
├── validate-in-branch.yml        ← POST /api/v1/validate-in-branch (US1)
├── refresh-compiler.yml          ← POST /api/v1/internal/refresh-compiler (US2)
├── delete-dataschema.yml         ← DELETE /api/v1/dataschema/:id (US3)
├── meta-single-cube.yml          ← GET /api/v1/meta/cube/:cubeName (US4)
├── version-diff.yml              ← POST /api/v1/version/diff (US5)
├── version-rollback.yml          ← POST /api/v1/version/rollback (US5)
└── end-to-end.yml                ← full quickstart.md flow
```

## Fixture shape

Every fixture under `fixtures/` is a self-describing YAML document:

```yaml
name: <slug>
mode: append | replace | preview-delete
branchSeed:
  - file: <fileName.yml>
    code: |
      cubes:
        - name: <cube>
          sql_table: <table>
          measures: [...]
          dimensions: [...]
draft:                   # absent when mode is preview-delete
  fileName: <fileName.yml>
  content: |
    cubes: ...
targetCube: <cubeName>   # present when mode is replace or preview-delete
expectedOutcome:
  valid: true | false
  errorCode: null | <ErrorCode enum value>
  referenceKind: null | joins | extends | sub_query | formula | segment | pre_aggregation | filter_params
```

## Running

```bash
./cli.sh tests stepci                 # runs every workflow (including this folder)
./cli.sh tests stepci model-management  # filtered run
```

Workflow entry points assume the dev stack is up (`./cli.sh compose up`) and a
seeded org/datasource matching the credentials in `tests/data/`.
