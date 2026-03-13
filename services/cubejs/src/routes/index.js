import express from "express";

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
import generateDataSchema from "./generateDataSchema.js";
import getSchema from "./getSchema.js";
import preAggregationPreview from "./preAggregationPreview.js";
import preAggregations from "./preAggregations.js";
import profileTable from "./profileTable.js";
import runSql from "./runSql.js";
import smartGenerate from "./smartGenerate.js";
import testConnection from "./testConnection.js";
import validate from "./validate.js";
import version from "./version.js";

const router = express.Router();

function addUniqueColumns(target, names) {
  if (!Array.isArray(names)) return;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (typeof name === "string" && !target.includes(name)) {
      target.push(name);
    }
  }
}

function normalizeLoadQuery(rawQuery) {
  if (!rawQuery) return null;
  if (typeof rawQuery === "string") {
    try {
      return JSON.parse(rawQuery);
    } catch {
      return null;
    }
  }
  return rawQuery;
}

function deriveExportColumnsFromLoad(req, annotation, data) {
  if (data.length > 0) {
    return Object.keys(data[0]);
  }

  const columns = [];
  const query = req.method === "POST"
    ? normalizeLoadQuery(req.body?.query)
    : normalizeLoadQuery(req.query?.query);
  const primaryQuery = Array.isArray(query) ? query[0] : query;

  if (primaryQuery) {
    addUniqueColumns(columns, primaryQuery.dimensions);
    addUniqueColumns(
      columns,
      Array.isArray(primaryQuery.timeDimensions)
        ? primaryQuery.timeDimensions.map((item) => typeof item === "string" ? item : item?.dimension)
        : []
    );
    addUniqueColumns(columns, primaryQuery.measures);
  }

  if (columns.length === 0) {
    addUniqueColumns(columns, Object.keys(annotation.dimensions || {}));
    addUniqueColumns(columns, Object.keys(annotation.timeDimensions || {}));
    addUniqueColumns(columns, Object.keys(annotation.measures || {}));
  }

  return columns;
}

export default ({ basePath, cubejs }) => {
  // Format-aware middleware for the load endpoint.
  // When format=csv, format=jsonstat, or format=arrow, Cube.js processes the query as normal
  // but the response is intercepted and re-serialized in the requested format.
  // When format is absent or "json", the request passes through unchanged.
  router.use(`${basePath}/v1/load`, (req, res, next) => {
    if (req.method !== "POST" && req.method !== "GET") return next();

    const rawFormat =
      req.method === "POST" ? req.body?.format : req.query?.format;

    let format;
    try {
      format = validateFormat(rawFormat);
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
    const queryLimit = parseInt(process.env.CUBEJS_DB_QUERY_LIMIT, 10) || 1000000;
    if (req.method === "POST" && req.body?.query) {
      if (!req.body.query.limit) {
        req.body.query.limit = queryLimit;
      }
    } else if (req.method === "GET" && req.query?.query) {
      try {
        const q = typeof req.query.query === "string"
          ? JSON.parse(req.query.query)
          : req.query.query;
        if (!q.limit) {
          q.limit = queryLimit;
          req.query.query = JSON.stringify(q);
        }
      } catch { /* leave as-is if unparseable */ }
    }

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
          const columns = deriveExportColumnsFromLoad(req, annotation, data);
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
          const columns = deriveExportColumnsFromLoad(req, annotation, data);
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
    `${basePath}/v1/validate`,
    checkAuthMiddleware,
    async (req, res) => validate(req, res)
  );

  // Version endpoint is public — returns only the schema-compiler version string
  router.get(`${basePath}/v1/version`, (req, res) => version(req, res));

  return router;
};
