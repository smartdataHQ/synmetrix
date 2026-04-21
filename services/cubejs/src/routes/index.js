import express from "express";

// Model Management API (feature 011-model-mgmt-api) adds six routes registered
// below — each handler owns its own auth where indicated:
//   POST   /api/v1/validate-in-branch         (direct-verify, US1)
//   POST   /api/v1/internal/refresh-compiler  (direct-verify, US2)
//   DELETE /api/v1/dataschema/:dataschemaId   (direct-verify, US3)
//   GET    /api/v1/meta/cube/:cubeName        (checkAuthMiddleware, US4)
//   POST   /api/v1/version/diff               (direct-verify, US5)
//   POST   /api/v1/version/rollback           (direct-verify, US5)

import checkAuthMiddleware from "../utils/checkAuth.js";
import {
  invalidateUserCache,
  invalidateWorkosSubCache,
} from "../utils/dataSourceHelpers.js";
import { mintedTokenCache } from "../utils/mintedTokenCache.js";
import { invalidateRulesCache } from "../utils/queryRewrite.js";
import { serializeRowsToArrow } from "../utils/arrowSerializer.js";
import { validateFormat } from "../utils/formatValidator.js";
import { writeRowsAsCSV } from "../utils/csvSerializer.js";
import { buildJSONStat } from "../utils/jsonstatBuilder.js";
import {
  applyLoadExportQueryLimit,
  deriveExportColumnsFromLoad,
  getLoadRequestFormat,
  getLoadRequestQuery,
} from "../utils/loadExportUtils.js";
import generateDataSchema from "./generateDataSchema.js";
import getSchema from "./getSchema.js";
import maybeHandleLoadExport from "./loadExport.js";
import preAggregationPreview from "./preAggregationPreview.js";
import preAggregations from "./preAggregations.js";
import profileTable from "./profileTable.js";
import runSql from "./runSql.js";
import smartGenerate from "./smartGenerate.js";
import columnValues from "./columnValues.js";
import discoverNested from "./discoverNested.js";
import discover from "./discover.js";
import metaAll from "./metaAll.js";
import testConnection from "./testConnection.js";
import deleteDataschema from "./deleteDataschema.js";
import metaSingleCube from "./metaSingleCube.js";
import refreshCompiler from "./refreshCompiler.js";
import validate from "./validate.js";
import validateInBranch from "./validateInBranch.js";
import versionDiff from "./versionDiff.js";
import versionRollback from "./versionRollback.js";
import version from "./version.js";

const router = express.Router();

export default ({ basePath, cubejs }) => {
  router.get(`${basePath}/v1/load`, (req, res, next) =>
    maybeHandleLoadExport(req, res, next, cubejs)
  );
  router.post(`${basePath}/v1/load`, (req, res, next) =>
    maybeHandleLoadExport(req, res, next, cubejs)
  );

  // Format-aware middleware for the load endpoint.
  // When format=csv, format=jsonstat, or format=arrow, Cube.js processes the query as normal
  // but the response is intercepted and re-serialized in the requested format.
  // When format is absent or "json", the request passes through unchanged.
  router.use(`${basePath}/v1/load`, (req, res, next) => {
    if (req.method !== "POST" && req.method !== "GET") return next();

    let format;
    try {
      format = validateFormat(getLoadRequestFormat(req));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (format === "json") return next();

    const abortController = new AbortController();
    let responseFinished = false;
    res.on("finish", () => {
      responseFinished = true;
    });
    res.on("close", () => {
      if (!responseFinished && !abortController.signal.aborted) {
        abortController.abort();
      }
    });

    // For CSV/JSON-Stat/Arrow, override the query limit to CUBEJS_DB_QUERY_LIMIT so
    // exports are not capped by CUBEJS_DB_QUERY_DEFAULT_LIMIT (10k).
    // The user can still set an explicit limit in the query body to cap results.
    applyLoadExportQueryLimit(req);

    // Wrap response methods to intercept Cube.js output
    const originalSend = res.send.bind(res);

    // Use originalSend for ALL transformed responses to avoid re-triggering
    // the override (Express's res.json() internally calls res.send()).
    const sendJson = (obj) => {
      res.set("Content-Type", "application/json");
      originalSend(JSON.stringify(obj));
    };

    const transform = async (cubeResponse) => {
      try {
        // Pass through Cube.js polling responses ("Continue wait") and errors
        // unchanged — the client handles retry logic
        if (cubeResponse?.error) {
          sendJson(cubeResponse);
          return;
        }

        const data = cubeResponse?.data
          || cubeResponse?.results?.[0]?.data
          || [];
        const annotation = cubeResponse?.annotation
          || cubeResponse?.results?.[0]?.annotation
          || {};

        if (format === "csv") {
          res.set("Content-Type", "text/csv");
          res.set("Content-Disposition", 'attachment; filename="query-result.csv"');
          if (data.length === 0) {
            res.set("Content-Length", "0");
            originalSend("");
            return;
          }
          await writeRowsAsCSV(res, data, { signal: abortController.signal });
          res.end();
          return;
        }

        if (format === "jsonstat") {
          const columns = deriveExportColumnsFromLoad(
            getLoadRequestQuery(req),
            annotation,
            data
          );
          const measures = Object.keys(annotation.measures || {});
          const timeDimensions = Object.keys(annotation.timeDimensions || {});
          const dataset = buildJSONStat(data, columns, { measures, timeDimensions });

          if (dataset.error) {
            res.status(dataset.status || 400);
            sendJson({ error: dataset.error });
            return;
          }

          res.set("Content-Disposition", 'attachment; filename="query-result.json"');
          sendJson(dataset);
          return;
        }

        if (format === "arrow") {
          // Load path buffers all rows in memory; apply safety limit to
          // prevent OOM from the 4x memory amplification in Arrow serialization.
          const ARROW_SAFETY_LIMIT = 100_000;
          if (data.length > ARROW_SAFETY_LIMIT) {
            console.warn(`Arrow /load response truncated: ${data.length} rows exceeded safety limit of ${ARROW_SAFETY_LIMIT}`);
            data.length = ARROW_SAFETY_LIMIT;
          }
          const columns = deriveExportColumnsFromLoad(
            getLoadRequestQuery(req),
            annotation,
            data
          );
          res.set("Content-Type", "application/vnd.apache.arrow.stream");
          res.set("Content-Disposition", 'attachment; filename="query-result.arrow"');
          originalSend(serializeRowsToArrow(data, { columns }));
          return;
        }
      } catch (err) {
        console.error("Format transform error:", err);
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        res.status(500);
        sendJson({ error: "Failed to transform response to " + format });
      }
    };

    res.json = (data) => {
      void transform(data);
      return res;
    };
    res.send = (buf) => {
      try {
        const str = Buffer.isBuffer(buf) ? buf.toString() : buf;
        const data = JSON.parse(str);
        void transform(data);
        return res;
      } catch {
        return originalSend(buf);
      }
    };

    next();
  });

  // Internal cache invalidation endpoint (called by Actions service, no auth)
  router.post(`${basePath}/v1/internal/invalidate-cache`, (req, res) => {
    const { type, userId } = req.body || {};

    if (type === "user") {
      invalidateUserCache(userId || null);
      if (userId) {
        mintedTokenCache.invalidate(userId);
      } else {
        mintedTokenCache.invalidateAll();
      }
    } else if (type === "workos") {
      invalidateWorkosSubCache(req.body.sub || null);
    } else if (type === "rules") {
      invalidateRulesCache();
    } else if (type === "all") {
      invalidateUserCache(null);
      invalidateWorkosSubCache(null);
      invalidateRulesCache();
      mintedTokenCache.invalidateAll();
    }

    res.json({ ok: true });
  });
  router.post(`${basePath}/v1/run-sql`, checkAuthMiddleware, (req, res) =>
    runSql(req, res, cubejs)
  );
  router.get(`${basePath}/v1/test`, checkAuthMiddleware, (req, res) =>
    testConnection(req, res, cubejs)
  );

  router.get(
    `${basePath}/v1/get-schema`,
    checkAuthMiddleware,
    async (req, res) => getSchema(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/generate-models`,
    checkAuthMiddleware,
    async (req, res) => generateDataSchema(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/pre-aggregation-preview`,
    checkAuthMiddleware,
    async (req, res) => preAggregationPreview(req, res, cubejs)
  );

  router.get(
    `${basePath}/v1/pre-aggregations`,
    checkAuthMiddleware,
    async (req, res) => preAggregations(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/profile-table`,
    checkAuthMiddleware,
    async (req, res) => profileTable(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/smart-generate`,
    checkAuthMiddleware,
    async (req, res) => smartGenerate(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/column-values`,
    checkAuthMiddleware,
    async (req, res) => columnValues(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/discover-nested`,
    checkAuthMiddleware,
    async (req, res) => discoverNested(req, res, cubejs)
  );

  router.post(
    `${basePath}/v1/validate`,
    checkAuthMiddleware,
    async (req, res) => validate(req, res)
  );

  // Discovery endpoint — WorkOS auth only, no datasource selection required
  router.get(`${basePath}/v1/discover`, async (req, res) => discover(req, res));

  // Aggregated meta across all visible datasources — WorkOS/FraiOS auth only
  router.get(`${basePath}/v1/meta-all`, async (req, res) =>
    metaAll(req, res, cubejs)
  );

  // Model Management API: contextual validation (US1).
  // Direct-verify auth — NOT behind checkAuthMiddleware (no x-hasura-datasource-id header).
  router.post(`${basePath}/v1/validate-in-branch`, async (req, res) =>
    validateInBranch(req, res)
  );

  // Model Management API: compiler-cache refresh (US2). Owner/admin only.
  router.post(`${basePath}/v1/internal/refresh-compiler`, async (req, res) =>
    refreshCompiler(req, res, cubejs)
  );

  // Model Management API: delete a single dataschema (US3). Owner/admin only.
  router.delete(
    `${basePath}/v1/dataschema/:dataschemaId`,
    async (req, res) => deleteDataschema(req, res)
  );

  // Model Management API: single-cube metadata (US4).
  // Datasource-scoped: runs behind checkAuthMiddleware (x-hasura-datasource-id
  // is mandatory by contract). The /cube/ path segment prevents collision
  // with Cube.js's built-in aggregate /api/v1/meta endpoint.
  router.get(
    `${basePath}/v1/meta/cube/:cubeName`,
    checkAuthMiddleware,
    async (req, res) => metaSingleCube(req, res, cubejs)
  );

  // Model Management API: diff + rollback (US5).
  router.post(`${basePath}/v1/version/diff`, async (req, res) =>
    versionDiff(req, res)
  );
  router.post(`${basePath}/v1/version/rollback`, async (req, res) =>
    versionRollback(req, res, cubejs)
  );

  // Version endpoint is public — returns only the schema-compiler version string
  router.get(`${basePath}/v1/version`, (req, res) => version(req, res));

  return router;
};
