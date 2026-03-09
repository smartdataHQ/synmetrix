import express from "express";

import checkAuthMiddleware from "../utils/checkAuth.js";
import { invalidateUserCache } from "../utils/dataSourceHelpers.js";
import { invalidateRulesCache } from "../utils/queryRewrite.js";
import generateDataSchema from "./generateDataSchema.js";
import getSchema from "./getSchema.js";
import preAggregationPreview from "./preAggregationPreview.js";
import preAggregations from "./preAggregations.js";
import profileTable from "./profileTable.js";
import runSql from "./runSql.js";
import smartGenerate from "./smartGenerate.js";
import testConnection from "./testConnection.js";

const router = express.Router();

export default ({ basePath, cubejs }) => {
  // Internal cache invalidation endpoint (called by Actions service, no auth)
  router.post(`${basePath}/v1/internal/invalidate-cache`, (req, res) => {
    const { type, userId } = req.body || {};

    if (type === "user") {
      invalidateUserCache(userId || null);
    } else if (type === "rules") {
      invalidateRulesCache();
    } else if (type === "all") {
      invalidateUserCache(null);
      invalidateRulesCache();
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

  return router;
};
