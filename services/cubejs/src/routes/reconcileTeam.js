import YAML from "yaml";
import { prepareCompiler } from "@cubejs-backend/schema-compiler";

import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { createDataSchema } from "../utils/dataSourceHelpers.js";
import defineUserScope from "../utils/defineUserScope.js";
import createMd5Hex from "../utils/md5Hex.js";
import { diffVersions } from "../utils/versionDiff.js";
import { invalidateCompilerForBranch } from "../utils/compilerCacheInvalidator.js";
import { profileTable } from "../utils/smart-generation/profiler.js";
import { buildCubesFromTemplate } from "../utils/smart-generation/cubeBuilder.js";
import { generateYaml } from "../utils/smart-generation/yamlGenerator.js";
import { parseCubesFromJs } from "../utils/smart-generation/diffModels.js";
import { mergeTemplateModel } from "../utils/smart-generation/templateMerger.js";

const PROBE_TIMEOUT_MS = 60_000;

/**
 * Version checksum over a file set, files SORTED BY NAME before hashing —
 * GraphQL row order is unstable and an order-sensitive checksum causes false
 * version churn (SC-007). Every comparison in this pipeline uses this形.
 */
export const computeVersionChecksum = (files) =>
  createMd5Hex(
    [...files]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .reduce((acc, f) => `${acc}${f.name}:${f.code}\n`, "")
  );

const parseCubesFromFile = (name, code) => {
  try {
    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      return YAML.parse(code)?.cubes || null;
    }
    return parseCubesFromJs(code) || null;
  } catch {
    return null;
  }
};

/**
 * Per-team reconcile pipeline (contracts/cubejs-internal.md). Pure control
 * flow — every io step is injected via `deps` so the pipeline is unit-testable
 * and failure of one template never affects another (FR-018 within a team).
 *
 * deps: { loadCurrentSchemas, probe, generate, validate, publish, diff }
 * Returns { outcomes, versionId }.
 */
export async function reconcileTeamCore(params, deps) {
  const {
    templates = [],
    optOut = [],
    dryRun = false,
    systemUserId,
    partition,
    internalTables = [],
  } = params;

  const current = (await deps.loadCurrentSchemas()) || [];
  const currentByName = new Map(current.map((f) => [f.name, f]));

  // working set starts as the current version's files, keyed by file name
  const working = new Map(
    current.map((f) => [f.name, { name: f.name, code: f.code }])
  );

  const outcomes = [];
  const pendingUpdated = []; // outcomes that get versionId after publish
  const templateNames = new Set(templates.map((t) => t.name));
  const probeCache = new Map();

  // Lazy baseline compile of the ORIGINAL current set: discriminates
  // "this template broke the branch" (counts toward rollout halt) from
  // "the branch was already broken before this run" (reported, but a
  // template-independent condition — never a rollout-quality signal).
  let baselinePromise = null;
  const baselineIsValid = () => {
    if (!baselinePromise) {
      baselinePromise = deps
        .validate(current.map((f) => ({ name: f.name, code: f.code })))
        .then((v) => v.valid)
        .catch(() => true); // uncertain baseline: assume valid (strict class)
    }
    return baselinePromise;
  };

  // 014: probes are additionally keyed by event scope — the same table
  // yields different profiles per event-scoped template.
  const probeOnce = async (schema, table, { eventScope = null, jsonPaths = null } = {}) => {
    const key = `${schema}.${table}|${eventScope || ""}`;
    if (!probeCache.has(key)) {
      probeCache.set(
        key,
        await deps.probe({ schema, table, eventScope, jsonPaths })
      );
    }
    return probeCache.get(key);
  };

  // 014 FR-010: registry_path entries ("<column>.<path> (<type>)") tell the
  // probe which JSON paths need presence checks, grouped per JSON column.
  const collectRegistryPaths = (cubes) => {
    const byColumn = {};
    for (const cube of cubes) {
      for (const list of [cube.dimensions, cube.measures, cube.segments]) {
        for (const field of list || []) {
          const raw = field?.meta?.registry_path;
          if (!raw) continue;
          const match = /^([A-Za-z_][A-Za-z0-9_]*)\.(.+?)\s*(?:\(|$)/.exec(raw);
          if (!match) continue;
          const [, column, path] = match;
          (byColumn[column] = byColumn[column] || []).push(path.trim());
        }
      }
    }
    return Object.keys(byColumn).length > 0 ? byColumn : null;
  };

  // --- Retirement sweep (FR-020): current derived models whose template is
  // no longer published get the unmanaged stamp, content otherwise untouched.
  for (const file of current) {
    const cubes = parseCubesFromFile(file.name, file.code);
    if (!cubes) continue;
    const needsStamp = cubes.some(
      (c) =>
        c?.meta?.default_model === true &&
        c?.meta?.template &&
        !templateNames.has(c.meta.template) &&
        c?.meta?.default_model_unmanaged !== true
    );
    if (!needsStamp) continue;

    let doc;
    try {
      doc = YAML.parse(file.code);
    } catch {
      continue;
    }
    const retiredTemplates = [];
    for (const cube of doc.cubes || []) {
      if (
        cube?.meta?.default_model === true &&
        cube?.meta?.template &&
        !templateNames.has(cube.meta.template) &&
        cube?.meta?.default_model_unmanaged !== true
      ) {
        cube.meta.default_model_unmanaged = true;
        retiredTemplates.push(cube.meta.template);
      }
    }
    const stamped = YAML.stringify(doc, { lineWidth: 0 });

    const trial = new Map(working);
    trial.set(file.name, { name: file.name, code: stamped });
    const validation = await deps.validate([...trial.values()]);
    if (!validation.valid) {
      for (const template of retiredTemplates) {
        outcomes.push({
          template,
          result: "failed",
          reason: `retirement stamp failed validation: ${formatErrors(validation.errors)}`,
        });
      }
      continue;
    }
    working.set(file.name, { name: file.name, code: stamped });
    for (const template of retiredTemplates) {
      const outcome = { template, result: "updated", reason: "retired" };
      outcomes.push(outcome);
      pendingUpdated.push(outcome);
    }
  }

  // --- Per-template pipeline; each template's failure is isolated.
  for (const template of templates) {
    const fileName = template.fileName || `${template.name}.yml`;

    // opt-out double-check (FR-013): neither created nor updated
    if (optOut.includes(template.name)) {
      outcomes.push({ template: template.name, result: "skipped_opt_out" });
      continue;
    }

    const templateCubes = parseCubesFromFile(fileName, template.code) || [];
    if (templateCubes.length === 0) {
      outcomes.push({
        template: template.name,
        result: "failed",
        reason: "template file has no parseable cubes",
      });
      continue;
    }

    // collision check (FR-019): same file or cube name without provenance
    // meta means a team-authored model — never overwrite it.
    const templateCubeNames = new Set(templateCubes.map((c) => c.name));
    const collision = current.find((file) => {
      const cubes = parseCubesFromFile(file.name, file.code);
      const nameMatch =
        file.name === fileName ||
        (cubes || []).some((c) => templateCubeNames.has(c?.name));
      if (!nameMatch) return false;
      // unparseable team file counts as a collision — never overwrite
      if (!cubes) return true;
      return !cubes.some((c) => c?.meta?.default_model === true);
    });
    if (collision) {
      outcomes.push({
        template: template.name,
        result: "skipped_collision",
        reason: `team-authored model '${collision.name}' exists without provenance meta`,
      });
      continue;
    }

    try {
      // probe the team's partition slice (cached per source table + event scope)
      const primaryCube = templateCubes[0] || {};
      const sourceTable =
        primaryCube.sql_table ||
        (primaryCube.meta?.source_database && primaryCube.meta?.source_table
          ? `${primaryCube.meta.source_database}.${primaryCube.meta.source_table}`
          : (/FROM\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(primaryCube.sql || "") || [])[1] ||
            null);
      let profile = null;
      if (sourceTable) {
        const parts = sourceTable.split(".");
        const table = parts.pop();
        const schema = parts.join(".") || null;
        profile = await probeOnce(schema, table, {
          eventScope: primaryCube.meta?.event_scope || null,
          jsonPaths: collectRegistryPaths(templateCubes),
        });
      }

      const generated = await deps.generate({
        template,
        templateCubes,
        profile,
        partition,
        internalTables,
      });
      const skeleton = generated.skeleton;

      // merge with the team's current file (templateMerger, D4): template-owned
      // converges, probe fields regenerate, team-added content is preserved
      const existing = working.get(fileName);
      const candidateCode =
        existing && deps.merge
          ? deps.merge(existing.code, generated.code)
          : generated.code;

      // no-op guard, per template
      if (existing && existing.code === candidateCode) {
        outcomes.push({ template: template.name, result: "skipped_no_change" });
        continue;
      }

      // validate the FULL candidate set with this template applied
      const trial = new Map(working);
      trial.set(fileName, { name: fileName, code: candidateCode });
      const validation = await deps.validate([...trial.values()]);
      if (!validation.valid) {
        const preexisting = !(await baselineIsValid());
        outcomes.push({
          template: template.name,
          result: "failed",
          reason: `${preexisting ? "preexisting_invalid_branch" : "validation"}: ${formatErrors(validation.errors)}`,
        });
        continue; // previous file (if any) stays live
      }

      working.set(fileName, { name: fileName, code: candidateCode });
      const outcome = {
        template: template.name,
        result: skeleton ? "updated_skeleton" : "updated",
      };
      outcomes.push(outcome);
      pendingUpdated.push(outcome);
    } catch (err) {
      outcomes.push({
        template: template.name,
        result: "failed",
        reason: err?.message || String(err),
      });
    }
  }

  // --- Publish once per team when anything effectively changed.
  const workingFiles = [...working.values()];
  const changed =
    pendingUpdated.length > 0 &&
    computeVersionChecksum(workingFiles) !== computeVersionChecksum(current);

  let versionId = null;
  if (changed && !dryRun) {
    const checksum = computeVersionChecksum(workingFiles);
    const published = await deps.publish({
      files: workingFiles,
      checksum,
      userId: systemUserId,
    });
    versionId = published?.versionId || null;

    const breaking = deps.diff ? deps.diff(current, workingFiles) || {} : {};
    for (const outcome of pendingUpdated) {
      outcome.versionId = versionId;
      outcome.checksum = checksum;
      if (breaking[outcome.template]?.length > 0) {
        outcome.breaking = breaking[outcome.template];
      }
    }
  }

  return { outcomes, versionId };
}

const formatErrors = (errors = []) =>
  errors
    .map((e) => e?.message || String(e))
    .slice(0, 3)
    .join("; ") || "unknown validation error";

// ---------------------------------------------------------------------------
// io wiring
// ---------------------------------------------------------------------------

class InMemorySchemaFileRepository {
  constructor(files) {
    this.files = files;
  }

  localPath() {
    return "/";
  }

  async dataSchemaFiles() {
    return this.files;
  }
}

const compileValidate = async (files) => {
  const repoFiles = files.map((f) => ({ fileName: f.name, content: f.code }));
  const repo = new InMemorySchemaFileRepository(repoFiles);
  const { compiler } = prepareCompiler(repo, {
    allowNodeRequire: false,
    standalone: true,
  });
  try {
    await compiler.compile();
  } catch (err) {
    const rawErrors = compiler.errorsReport?.getErrors?.() || [];
    const errors = rawErrors.length
      ? rawErrors.map((e) => ({ message: e.plainMessage || e.message }))
      : [{ message: err?.plainMessage || err?.message || String(err) }];
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
};

const DATASOURCE_QUERY = `
  query ($id: uuid!, $branchId: uuid!) {
    datasources_by_pk(id: $id) {
      id
      name
      db_type
      db_params
      team_id
      team {
        id
        settings
      }
      branches(where: { id: { _eq: $branchId } }) {
        id
        status
        versions(limit: 1, order_by: { created_at: desc }) {
          id
          checksum
          dataschemas {
            id
            name
            code
          }
        }
      }
    }
  }
`;

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms).unref?.()
    ),
  ]);

const generateCandidate = async ({
  template,
  templateCubes,
  profile,
  partition,
  internalTables,
}) => {
  const built = templateCubes.map((cube) =>
    buildCubesFromTemplate(cube, profile, {
      partition,
      internalTables,
      templateName: template.name,
      templateChecksum: template.checksum,
    })
  );
  return {
    code: generateYaml(built.map((b) => b.cube)),
    skeleton: built.every((b) => b.skeleton),
  };
};

const buildBreakingDiff = (fromFiles, toFiles) => {
  const diff = diffVersions({
    fromDataschemas: fromFiles,
    toDataschemas: toFiles,
  });

  // map cubeName -> template from either side's provenance meta
  const cubeToTemplate = new Map();
  for (const file of [...toFiles, ...fromFiles]) {
    const cubes = parseCubesFromFile(file.name, file.code) || [];
    for (const cube of cubes) {
      if (cube?.meta?.template && !cubeToTemplate.has(cube.name)) {
        cubeToTemplate.set(cube.name, cube.meta.template);
      }
    }
  }

  const breaking = {};
  const add = (cubeName, member) => {
    const template = cubeToTemplate.get(cubeName);
    if (!template) return;
    (breaking[template] = breaking[template] || []).push(
      `${cubeName}.${member}`
    );
  };

  for (const removed of diff.removedCubes || []) {
    add(removed.cubeName, "*");
  }
  for (const modified of diff.modifiedCubes || []) {
    for (const change of modified.changes || []) {
      for (const gone of change.removed || []) {
        add(modified.cubeName, gone.name || gone);
      }
    }
  }
  return breaking;
};

/**
 * POST /api/v1/internal/reconcile-team — per-team reconcile worker (013).
 *
 * Service-to-service only: verifies the caller's JWT resolves to the
 * configured system user (contracts/cubejs-internal.md "Auth & scope
 * construction"). No membership-based checkAuth — the datasource is fetched
 * admin-side and the scope is built via defineUserScope with a synthetic
 * owner membership, keeping resolution on the Principle II path without
 * granting the system user any real memberships.
 */
export default async function reconcileTeam(req, res, cubejs) {
  const systemUserId = process.env.DEFAULT_MODELS_SYSTEM_USER_ID;
  if (!systemUserId) {
    return res.status(503).json({
      code: "default_models_unconfigured",
      message: "DEFAULT_MODELS_SYSTEM_USER_ID is not set",
    });
  }

  const verified = await verifyAndProvision(req);
  if (verified.error) {
    return res
      .status(verified.error.status || 403)
      .json({ code: verified.error.code, message: verified.error.message });
  }
  if (verified.userId !== systemUserId) {
    return res.status(403).json({
      code: "forbidden",
      message: "reconcile-team is restricted to the default-models system user",
    });
  }

  const {
    teamId,
    datasourceId,
    branchId,
    partition,
    templates,
    optOut = [],
    dryRun = false,
  } = req.body || {};

  if (!teamId || !datasourceId || !branchId || !partition || !Array.isArray(templates)) {
    return res.status(400).json({
      code: "invalid_input",
      message:
        "teamId, datasourceId, branchId, partition and templates are required",
    });
  }

  let dataSource;
  try {
    const dsRes = await fetchGraphQL(DATASOURCE_QUERY, {
      id: datasourceId,
      branchId,
    });
    dataSource = dsRes?.data?.datasources_by_pk;
  } catch (err) {
    return res.status(500).json({
      code: "datasource_fetch_failed",
      message: err?.message || String(err),
    });
  }

  if (!dataSource) {
    return res
      .status(404)
      .json({ code: "datasource_not_found", message: `datasource ${datasourceId}` });
  }
  if (dataSource.team_id !== teamId) {
    return res.status(403).json({
      code: "datasource_team_mismatch",
      message: "datasource does not belong to the requested team",
    });
  }
  const targetName = process.env.DEFAULT_MODELS_TARGET_DATASOURCE_NAME;
  if (targetName && dataSource.name !== targetName) {
    return res.status(400).json({
      code: "datasource_not_target",
      message: `datasource '${dataSource.name}' is not the configured target '${targetName}'`,
    });
  }
  const branch = dataSource.branches?.[0];
  if (!branch) {
    return res
      .status(404)
      .json({ code: "branch_not_found", message: `branch ${branchId}` });
  }

  const teamSettings = dataSource.team?.settings || {};
  const syntheticMembers = [
    {
      team_id: dataSource.team_id,
      member_roles: [{ team_role: "owner", access_list: null }],
      team: { settings: teamSettings },
      properties: {},
    },
  ];

  let userScope;
  try {
    userScope = defineUserScope(
      [dataSource],
      syntheticMembers,
      datasourceId,
      branchId
    );
  } catch (err) {
    return res
      .status(err.status || 500)
      .json({ code: "scope_error", message: err.message });
  }

  const securityContext = {
    authToken: (req.headers.authorization || "").replace(/^Bearer /, ""),
    userId: systemUserId,
    userScope,
  };

  const previousDataschemas = branch.versions?.[0]?.dataschemas || [];
  const previousSchemaVersion = createMd5Hex(
    previousDataschemas.map((s) => s.id)
  );

  // derived-model scoping must always bake the partition literal (FR-005):
  // internalTables for generation is the union of the team's configured
  // internal tables and every template source table.
  const templateTables = templates
    .map((t) => {
      const cubes = parseCubesFromFile(t.fileName || `${t.name}.yml`, t.code) || [];
      return cubes[0]?.sql_table?.split(".").pop();
    })
    .filter(Boolean);
  const internalTables = [
    ...new Set([...(teamSettings.internal_tables || []), ...templateTables]),
  ];

  const deps = {
    loadCurrentSchemas: async () => previousDataschemas,
    probe: async ({ schema, table, eventScope = null, jsonPaths = null }) => {
      const driver = await cubejs.options.driverFactory({ securityContext });
      const escape = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const profile = await withTimeout(
        profileTable(driver, schema, table, {
          partition,
          internalTables,
          // 014 FR-009: event-scoped templates prune against the same scope
          filters: eventScope
            ? [{ column: "event", operator: "=", value: eventScope }]
            : [],
          emitter: null,
        }),
        PROBE_TIMEOUT_MS,
        "probe timeout"
      );
      // 014 FR-010: JSON path presence for registry pruning
      if (jsonPaths && profile) {
        profile.jsonPaths = new Set();
        for (const column of Object.keys(jsonPaths)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) continue;
          const where = [`partition = '${escape(partition)}'`];
          if (eventScope) where.push(`event = '${escape(eventScope)}'`);
          const rows = await driver.query(
            `SELECT DISTINCT arrayJoin(JSONAllPaths(${column})) AS p ` +
              `FROM ${schema ? `${schema}.` : ""}${table} WHERE ${where.join(" AND ")}`
          );
          for (const row of rows || []) {
            profile.jsonPaths.add(row.p);
          }
        }
      }
      return profile;
    },
    generate: generateCandidate,
    merge: mergeTemplateModel,
    validate: compileValidate,
    publish: async ({ files, checksum, userId }) => {
      const version = await createDataSchema({
        branch_id: branchId,
        user_id: userId,
        checksum,
        dataschemas: {
          data: files.map((f) => ({
            name: f.name,
            code: f.code,
            user_id: userId,
            datasource_id: datasourceId,
          })),
        },
      });
      return { versionId: version?.id || null };
    },
    diff: buildBreakingDiff,
  };

  try {
    const { outcomes, versionId } = await reconcileTeamCore(
      {
        teamId,
        partition,
        templates,
        optOut,
        dryRun,
        systemUserId,
        internalTables,
      },
      deps
    );

    if (versionId) {
      // evict the superseded compiler-cache entry and pre-warm the new meta
      // (fire-and-forget — never blocks the response)
      invalidateCompilerForBranch(cubejs, previousSchemaVersion);
      setImmediate(async () => {
        try {
          const apiGateway = cubejs.apiGateway();
          const context = await apiGateway.contextByReq(
            req,
            { ...securityContext },
            `reconcile-prewarm-${versionId}`
          );
          const compilerApi = await apiGateway.getCompilerApi(context);
          await compilerApi.metaConfig(context, {
            requestId: `reconcile-prewarm-${versionId}`,
          });
        } catch {
          // pre-warm is best-effort
        }
      });
    }

    return res.json({ teamId, outcomes, versionId });
  } catch (err) {
    return res.status(500).json({
      code: "reconcile_failed",
      message: err?.message || String(err),
    });
  }
}
