import { applyDefaultModelRules } from "./defaultModelRules.js";
import {
  resolveDefaultModelContext,
  resolvePartitionForUser,
} from "./defaultModelMeta.js";

/**
 * Query pre-processor middleware (013, FR-015/FR-016) — mounted BEFORE
 * cubejs.initApp so the fixed rule set runs before ALL gateway processing,
 * including Joi structural validation (contracts/query-preprocessor.md).
 *
 * Guarantees:
 *  - exclusivity: out-of-scope queries pass through byte-identical
 *  - fail-open to gateway auth: on ANY internal failure the ORIGINAL request
 *    goes through untouched; this middleware never authorizes, never mints
 *    credentials, never blocks on its own availability
 *  - the deliberate R1 rejection (DEFAULT_MODEL_MEMBER_UNAVAILABLE) is the
 *    single 400 it ever produces
 */

const decodeJwtPayload = (token) => {
  try {
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

// Decode-only identity resolution: partition claim (FraiOS tokens), else the
// legacy fallback userId -> membership -> team.settings.partition. The
// gateway VERIFIES the token afterwards — this value only selects which
// member map to translate against, it grants nothing.
const defaultResolvePartition = async (req) => {
  const auth = req.headers?.authorization;
  if (!auth) return null;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;

  if (typeof payload.partition === "string" && payload.partition) {
    return payload.partition;
  }

  const namespace = process.env.JWT_CLAIMS_NAMESPACE || "hasura";
  const userId =
    payload?.[namespace]?.["x-hasura-user-id"] || payload?.sub || null;
  if (!userId) return null;
  return resolvePartitionForUser(userId);
};

const extractQueries = (req) => {
  if (req.method === "GET") {
    const raw = req.query?.query;
    if (typeof raw !== "string" || !raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return {
      queries: Array.isArray(parsed) ? parsed : [parsed],
      isArray: Array.isArray(parsed),
      write: (queries, isArray) => {
        req.query.query = JSON.stringify(isArray ? queries : queries[0]);
      },
    };
  }

  const raw = req.body?.query;
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return {
    queries: Array.isArray(parsed) ? parsed : [parsed],
    isArray: Array.isArray(parsed),
    write: (queries, isArray) => {
      req.body.query = isArray ? queries : queries[0];
    },
  };
};

export const createQueryPreprocessor = (deps = {}) => {
  const {
    resolveContext = resolveDefaultModelContext,
    resolvePartition = defaultResolvePartition,
  } = deps;

  return async (req, res, next) => {
    try {
      // branch/version previews resolve non-active model sets — never touch
      if (
        req.headers["x-hasura-branch-id"] ||
        req.headers["x-hasura-branch-version-id"]
      ) {
        return next();
      }

      const extraction = extractQueries(req);
      if (!extraction) return next();

      const partition = await resolvePartition(req);
      if (!partition) return next();

      // datasource-first resolution with tenancy cross-check: the header
      // datasource must BELONG to the JWT partition's team and be the
      // configured target — otherwise no context (pass-through)
      const headerDatasourceId = req.headers["x-hasura-datasource-id"];
      if (!headerDatasourceId) return next();

      const context = await resolveContext({
        partition,
        datasourceId: headerDatasourceId,
      });
      if (!context || !context.memberMap || context.memberMap.size === 0) {
        return next();
      }
      // defense-in-depth: resolver returns the header datasource or nothing
      if (headerDatasourceId !== context.datasourceId) {
        return next();
      }

      const processed = [];
      let changed = false;
      for (const query of extraction.queries) {
        const result = applyDefaultModelRules(query, {
          memberMap: context.memberMap,
          partition,
          adaptations: context.adaptations,
        });
        if (result.action === "reject") {
          return res.status(400).json(result.rejection);
        }
        if (result.action === "rewrite") {
          changed = true;
          processed.push(result.query);
        } else {
          processed.push(query);
        }
      }

      if (changed) {
        extraction.write(processed, extraction.isArray);
      }
      return next();
    } catch {
      // fail-open to gateway auth/validation (guarantee 3)
      return next();
    }
  };
};

export default createQueryPreprocessor;
