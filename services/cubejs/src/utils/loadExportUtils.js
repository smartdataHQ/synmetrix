export function addUniqueColumns(target, names) {
  if (!Array.isArray(names)) return;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (typeof name === "string" && !target.includes(name)) {
      target.push(name);
    }
  }
}

export function normalizeLoadQuery(rawQuery) {
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

export function getLoadRequestFormat(req) {
  return req.method === "POST" ? req.body?.format : req.query?.format;
}

export function getLoadRequestQuery(req) {
  return normalizeLoadQuery(
    req.method === "POST" ? req.body?.query : req.query?.query
  );
}

export function applyLoadExportQueryLimit(req, queryLimit) {
  const limit =
    queryLimit ?? (parseInt(process.env.CUBEJS_DB_QUERY_LIMIT, 10) || 1000000);

  if (req.method === "POST" && req.body?.query && !req.body.query.limit) {
    req.body.query.limit = limit;
    return;
  }

  if (req.method === "GET" && req.query?.query) {
    const query = getLoadRequestQuery(req);
    if (query && !query.limit) {
      query.limit = limit;
      req.query.query = JSON.stringify(query);
    }
  }
}

export function deriveExportColumnsFromLoad(query, annotation = {}, data = []) {
  if (data.length > 0) {
    return Object.keys(data[0]);
  }

  const columns = [];
  const primaryQuery = Array.isArray(query) ? query[0] : query;

  if (primaryQuery) {
    addUniqueColumns(columns, primaryQuery.dimensions);
    addUniqueColumns(
      columns,
      Array.isArray(primaryQuery.timeDimensions)
        ? primaryQuery.timeDimensions.map((item) => {
            if (typeof item === "string") {
              return item;
            }

            if (item?.dimension && item?.granularity) {
              return `${item.dimension}.${item.granularity}`;
            }

            return item?.dimension;
          })
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
