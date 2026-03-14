import { randomUUID } from "crypto";

import sqlstring from "sqlstring";
import * as prepareAnnotationModule from "@cubejs-backend/api-gateway/dist/src/helpers/prepare-annotation.js";
import { QueryType } from "@cubejs-backend/api-gateway/dist/src/types/enums.js";
import * as QueryCacheModule from "@cubejs-backend/query-orchestrator/dist/src/orchestrator/QueryCache.js";

import {
  deriveExportColumnsFromLoad,
  getLoadRequestFormat,
  getLoadRequestQuery,
  applyLoadExportQueryLimit,
} from "../utils/loadExportUtils.js";
import {
  canSemanticStreamLoadExport,
  resolveLoadExportCapabilities,
} from "../utils/loadExportCapabilities.js";
import { validateFormat } from "../utils/formatValidator.js";
import {
  escapeCSVField,
  writeRowStreamAsCSV,
  writeTextChunk,
} from "../utils/csvSerializer.js";
import {
  writeBinaryChunk,
  writeRowStreamAsArrow,
} from "../utils/arrowSerializer.js";

const prepareAnnotation =
  typeof prepareAnnotationModule.prepareAnnotation === "function"
    ? prepareAnnotationModule.prepareAnnotation
    : prepareAnnotationModule.default;
const QueryCache = QueryCacheModule.QueryCache;

const CSV_HEADERS = {
  "Content-Type": "text/csv",
  "Content-Disposition": 'attachment; filename="query-result.csv"',
};
const ARROW_HEADERS = {
  "Content-Type": "application/vnd.apache.arrow.stream",
  "Content-Disposition": 'attachment; filename="query-result.arrow"',
};
const CSV_STREAM_CHUNK_SIZE = 128 * 1024;
const CLICKHOUSE_NULL_TOKEN_RE = /(?<=,|^)\\N(?=,|\r?\n|$)/g;

function getRequestId(req) {
  return req.get?.("x-request-id")
    || req.get?.("traceparent")
    || `${randomUUID()}-span-1`;
}

function isClickHouseContext(securityContext) {
  const dbType = securityContext?.userScope?.dataSource?.dbType;
  return typeof dbType === "string" && dbType.toLowerCase() === "clickhouse";
}

function removeTrailingSemicolon(query) {
  const trimmed = String(query ?? "").trimEnd();
  let lastNonSemiIdx = trimmed.length;
  for (let i = lastNonSemiIdx; i > 0; i--) {
    if (trimmed[i - 1] !== ";") {
      lastNonSemiIdx = i;
      break;
    }
  }
  return lastNonSemiIdx !== trimmed.length
    ? trimmed.slice(0, lastNonSemiIdx)
    : trimmed;
}

function normalizeClickHouseCSVLine(line) {
  const normalized = line.replace(CLICKHOUSE_NULL_TOKEN_RE, "");
  if (normalized.endsWith("\r\n")) return normalized;
  if (normalized.endsWith("\n")) return normalized.slice(0, -1) + "\r\n";
  return normalized + "\r\n";
}

function createAbortController(res) {
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

  return abortController;
}

async function runMiddleware(middleware, req, res) {
  await new Promise((resolve, reject) => {
    let settled = false;

    const next = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    Promise.resolve(middleware(req, res, next))
      .then(() => {
        if (settled) return;
        settled = true;
        resolve();
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
  });
}

function getGatewayErrorStatus(err) {
  if (err?.error === "Continue wait") return 200;
  if (err?.type === "UserError") return 400;
  if (err?.error) return 400;
  return err?.status || 500;
}

function sendGatewayError(res, err, statusOverride) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  res.status(statusOverride || getGatewayErrorStatus(err)).json(err);
}

function emitGatewayHandledError(apiGateway, res, context, query, error, requestStarted) {
  if (typeof apiGateway?.handleError !== "function") {
    sendGatewayError(res, {
      error: error?.message || error?.error || String(error),
    });
    return;
  }

  let payload = null;
  let status;

  apiGateway.handleError({
    e: error,
    context,
    query,
    requestStarted,
    res: (message, options = {}) => {
      payload = message;
      status = options.status;
    },
  });

  if (payload) {
    sendGatewayError(res, payload, status);
  }
}

function getAliasNameToMember(plan) {
  return plan?.streamingQuery?.aliasNameToMember || null;
}

function canUseNativeArrowPassthrough(plan) {
  const aliasNameToMember = getAliasNameToMember(plan);
  if (!aliasNameToMember || Object.keys(aliasNameToMember).length === 0) {
    return true;
  }

  return Object.entries(aliasNameToMember).every(
    ([alias, member]) => alias === member
  );
}

function rewriteNativeCsvHeader(line, aliasNameToMember) {
  const stripped = line.replace(/\r?\n$/, "");
  const aliases = stripped.length > 0 ? stripped.split(",") : [];
  const members = aliases.map((alias) => {
    const unquoted = alias.startsWith('"') && alias.endsWith('"')
      ? alias.slice(1, -1).replace(/""/g, '"')
      : alias;
    return escapeCSVField(aliasNameToMember?.[unquoted] || unquoted);
  });
  return members.join(",") + "\r\n";
}

async function prepareLoadContext(req, res, cubejs) {
  const apiGateway = cubejs.apiGateway();

  await runMiddleware(apiGateway.checkAuth, req, res);
  if (res.headersSent) return null;

  await runMiddleware(apiGateway.requestContextMiddleware, req, res);
  if (res.headersSent) return null;

  await cubejs.contextRejectionMiddleware(req, res);
  if (res.headersSent) return null;

  if (!req.context) {
    req.context = await apiGateway.contextByReq(
      req,
      req.securityContext,
      getRequestId(req)
    );
  }

  return { apiGateway, context: req.context };
}

async function buildLoadExportPlan(req, res, cubejs, query) {
  const requestStarted = new Date();
  const prepared = await prepareLoadContext(req, res, cubejs);
  if (!prepared) return { handled: true };

  const { apiGateway, context } = prepared;

  try {
    await apiGateway.assertApiScope("data", context.securityContext);

    const [queryType, normalizedQueries] = await apiGateway.getNormalizedQueries(
      query,
      context,
      true
    );

    if (
      queryType !== QueryType.REGULAR_QUERY
      || !Array.isArray(normalizedQueries)
      || normalizedQueries.length !== 1
    ) {
      return { handled: false, unsupported: true };
    }

    const normalizedQuery = normalizedQueries[0];
    const capabilities = resolveLoadExportCapabilities(context.securityContext);
    const compilerApi = await apiGateway.getCompilerApi(context);
    let metaConfig = await compilerApi.metaConfig(context, {
      requestId: context.requestId,
    });
    metaConfig = apiGateway.filterVisibleItemsInMeta(context, metaConfig);

    const annotation = prepareAnnotation(metaConfig, normalizedQuery);
    const sqlQuery = (await apiGateway.getSqlQueriesInternal(
      context,
      normalizedQueries
    ))[0];
    const streamingQuery = {
      ...sqlQuery,
      query: sqlQuery.sql[0],
      values: sqlQuery.sql[1],
      cacheMode: "stale-if-slow",
      requestId: context.requestId,
      context,
      persistent: true,
      forceNoCache: true,
    };

    return {
      handled: false,
      requestStarted,
      apiGateway,
      context,
      capabilities,
      normalizedQuery,
      annotation,
      columns: deriveExportColumnsFromLoad(normalizedQuery, annotation),
      streamingQuery,
    };
  } catch (err) {
    emitGatewayHandledError(
      apiGateway,
      res,
      context,
      query,
      err,
      requestStarted
    );
    return { handled: true };
  }
}

async function prepareNativeClickHouseExport(plan) {
  if (!isClickHouseContext(plan.context.securityContext)) {
    return null;
  }

  const adapterApi = await plan.apiGateway.getAdapterApi(plan.context);
  const queryOrchestrator = adapterApi.getQueryOrchestrator?.();
  const preAggregations = queryOrchestrator?.getPreAggregations?.();
  if (!preAggregations?.loadAllPreAggregationsIfNeeded) {
    return null;
  }

  const {
    preAggregationsTablesToTempTables,
    values,
  } = await preAggregations.loadAllPreAggregationsIfNeeded(plan.streamingQuery);

  const inlineTables = preAggregationsTablesToTempTables.flatMap(
    ([, preAggregation]) => (preAggregation.lambdaTable ? [preAggregation.lambdaTable] : [])
  );

  if (inlineTables.length > 0) {
    return null;
  }

  return {
    query: QueryCache.replacePreAggregationTableNames(
      plan.streamingQuery.query,
      preAggregationsTablesToTempTables
    ),
    values: values || plan.streamingQuery.values,
  };
}

async function executeNativeClickHouseCsv(
  res,
  query,
  values,
  driver,
  signal,
  aliasNameToMember
) {
  const resultSet = await driver.client.query({
    query: sqlstring.format(query, values || []),
    format: "CSVWithNames",
    clickhouse_settings: driver.config?.clickhouseSettings,
    abort_signal: signal,
  });

  let chunk = "";
  let wroteHeader = false;
  for await (const rows of resultSet.stream()) {
    for (const row of rows) {
      if (!wroteHeader) {
        chunk += rewriteNativeCsvHeader(row.text, aliasNameToMember);
        wroteHeader = true;
        continue;
      }

      chunk += normalizeClickHouseCSVLine(row.text);
      if (chunk.length >= CSV_STREAM_CHUNK_SIZE) {
        await writeTextChunk(res, chunk, signal);
        chunk = "";
      }
    }
  }

  if (chunk.length > 0) {
    await writeTextChunk(res, chunk, signal);
  }
}

async function executeNativeClickHouseArrow(res, query, values, driver, signal) {
  const result = await driver.client.exec({
    query: `${removeTrailingSemicolon(sqlstring.format(query, values || []))}\nFORMAT ArrowStream`,
    clickhouse_settings: {
      ...driver.config?.clickhouseSettings,
      output_format_arrow_compression_method: "none",
    },
    abort_signal: signal,
  });

  const stream = typeof result.stream === "function"
    ? result.stream()
    : result.stream;

  for await (const chunk of stream) {
    await writeBinaryChunk(res, chunk, signal);
  }
}

async function streamSemanticRows(plan) {
  const adapterApi = await plan.apiGateway.getAdapterApi(plan.context);
  return adapterApi.streamQuery(plan.streamingQuery);
}

async function tryHandleLoadExport(req, res, cubejs, query, format) {
  const plan = await buildLoadExportPlan(req, res, cubejs, query);
  if (!plan || plan.handled) return true;
  if (plan.unsupported) return false;

  const abortController = createAbortController(res);

  try {
    if (
      format === "csv"
      && plan.capabilities.nativeCsvPassthrough
      && isClickHouseContext(plan.context.securityContext)
    ) {
      const nativeQuery = await prepareNativeClickHouseExport(plan);
      if (nativeQuery) {
        const driver = await cubejs.options.driverFactory({
          securityContext: plan.context.securityContext,
        });
        res.set(CSV_HEADERS);
        await executeNativeClickHouseCsv(
          res,
          nativeQuery.query,
          nativeQuery.values,
          driver,
          abortController.signal,
          getAliasNameToMember(plan)
        );
        res.end();
        return true;
      }
    }

    if (
      format === "arrow"
      && plan.capabilities.nativeArrowPassthrough
      && canUseNativeArrowPassthrough(plan)
      && isClickHouseContext(plan.context.securityContext)
    ) {
      const nativeQuery = await prepareNativeClickHouseExport(plan);
      if (nativeQuery) {
        const driver = await cubejs.options.driverFactory({
          securityContext: plan.context.securityContext,
        });
        res.set(ARROW_HEADERS);
        await executeNativeClickHouseArrow(
          res,
          nativeQuery.query,
          nativeQuery.values,
          driver,
          abortController.signal
        );
        res.end();
        return true;
      }
    }

    if (!canSemanticStreamLoadExport(format, plan.capabilities)) {
      return false;
    }

    const stream = await streamSemanticRows(plan);

    if (format === "csv") {
      res.set(CSV_HEADERS);
      await writeRowStreamAsCSV(res, stream, {
        columns: plan.columns,
        signal: abortController.signal,
      });
      res.end();
      return true;
    }

    res.set(ARROW_HEADERS);
    await writeRowStreamAsArrow(res, stream, {
      columns: plan.columns,
      annotation: plan.annotation,
      signal: abortController.signal,
    });
    res.end();
    return true;
  } catch (err) {
    if (abortController.signal.aborted) return true;

    emitGatewayHandledError(
      plan.apiGateway,
      res,
      plan.context,
      query,
      err,
      plan.requestStarted
    );
    return true;
  }
}

export async function maybeHandleLoadExport(req, res, next, cubejs) {
  if (req.method !== "POST" && req.method !== "GET") {
    next();
    return;
  }

  let format;
  try {
    format = validateFormat(getLoadRequestFormat(req));
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (format !== "csv" && format !== "arrow") {
    next();
    return;
  }

  applyLoadExportQueryLimit(req);

  const query = getLoadRequestQuery(req);
  if (!query || Array.isArray(query)) {
    next();
    return;
  }

  try {
    const handled = await tryHandleLoadExport(req, res, cubejs, query, format);

    if (!handled) {
      next();
    }
  } catch (err) {
    console.error("Semantic load export failed:", err);

    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }

    res.status(err.status || 500).json({
      error: err.message || String(err),
    });
  }
}

export default maybeHandleLoadExport;
