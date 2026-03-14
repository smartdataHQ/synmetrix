import {
  Bool,
  Float64,
  RecordBatch,
  RecordBatchStreamWriter,
  TimestampMillisecond,
  Utf8,
  tableFromArrays,
  tableToIPC,
  vectorFromArray,
} from "apache-arrow";

const ARROW_IPC_KIND = "stream";
const DEFAULT_ARROW_BATCH_SIZE = 4096;
const NUMERIC_CUBE_TYPES = new Set([
  "number",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "runningtotal",
  "countdistinct",
  "countdistinctapprox",
]);

function isArrayBufferLike(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function normalizeArrowValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;

  const type = typeof value;
  if (
    type === "string"
    || type === "number"
    || type === "boolean"
    || type === "bigint"
  ) {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (isArrayBufferLike(value)) {
    return Buffer.from(
      value instanceof ArrayBuffer
        ? value
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    ).toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeArrowValue(item));
  }

  if (type === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

export function rowsToArrowColumns(rows, options = {}) {
  const columns = options.columns
    ?? (rows && rows.length > 0 ? Object.keys(rows[0]) : []);
  const data = Object.create(null);

  for (let c = 0; c < columns.length; c++) {
    const column = columns[c];
    data[column] = new Array(rows.length);
  }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      data[column][r] = normalizeArrowValue(row[column]);
    }
  }

  return data;
}

export function serializeRowsToArrow(rows, options = {}) {
  const safeRows = rows ?? [];
  const columns = options.columns
    ?? (safeRows.length > 0 ? Object.keys(safeRows[0]) : []);
  const table = tableFromArrays(rowsToArrowColumns(safeRows, { columns }));
  const bytes = tableToIPC(table, ARROW_IPC_KIND);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function getAnnotationEntry(annotation = {}, column) {
  return annotation.measures?.[column]
    || annotation.dimensions?.[column]
    || annotation.timeDimensions?.[column]
    || null;
}

function inferArrowKindFromValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return "time";

  const type = typeof value;
  if (type === "boolean") return "boolean";
  if (type === "number" || type === "bigint") return "number";

  if (type === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "string";
    if (trimmed === "true" || trimmed === "false") return "boolean";
    if (Number.isFinite(Number(trimmed))) return "number";
    if (!Number.isNaN(Date.parse(trimmed))) return "time";
  }

  return "string";
}

function inferArrowKind(column, annotation = {}, sampleRows = []) {
  const annotatedType = String(getAnnotationEntry(annotation, column)?.type || "")
    .toLowerCase();

  if (annotatedType === "time") return "time";
  if (annotatedType === "boolean") return "boolean";
  if (NUMERIC_CUBE_TYPES.has(annotatedType)) return "number";
  if (annotatedType) return "string";

  for (let i = 0; i < sampleRows.length; i++) {
    const inferred = inferArrowKindFromValue(sampleRows[i]?.[column]);
    if (inferred) return inferred;
  }

  return "string";
}

function createArrowType(kind) {
  if (kind === "time") return new TimestampMillisecond();
  if (kind === "boolean") return new Bool();
  if (kind === "number") return new Float64();
  return new Utf8();
}

function normalizeUtf8ArrowValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (isArrayBufferLike(value)) {
    return Buffer.from(
      value instanceof ArrayBuffer
        ? value
        : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    ).toString("base64");
  }

  if (Array.isArray(value) || typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function coerceArrowValue(value, kind) {
  if (value == null) return null;

  if (kind === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (kind === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "bigint") return value !== 0n;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
    }
    return null;
  }

  if (kind === "time") {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === "string") {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  return normalizeUtf8ArrowValue(value);
}

function deriveArrowColumnSpecs(columns, annotation = {}, sampleRows = []) {
  return columns.map((column) => {
    const kind = inferArrowKind(column, annotation, sampleRows);
    return {
      name: column,
      kind,
      arrowType: createArrowType(kind),
    };
  });
}

function createArrowRecordBatch(rows, columnSpecs) {
  const vectors = Object.create(null);

  for (let c = 0; c < columnSpecs.length; c++) {
    const spec = columnSpecs[c];
    const values = new Array(rows.length);

    for (let r = 0; r < rows.length; r++) {
      values[r] = coerceArrowValue(rows[r]?.[spec.name], spec.kind);
    }

    vectors[spec.name] = vectorFromArray(values, spec.arrowType);
  }

  return new RecordBatch(vectors);
}

export async function writeBinaryChunk(writable, chunk, signal) {
  if (!chunk || chunk.length === 0) return;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Arrow output aborted.");
  }
  if (writable.destroyed || writable.writableEnded) {
    throw new Error("Arrow output stream is not writable.");
  }
  if (writable.write(chunk)) return;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off("drain", onDrain);
      writable.off("close", onClose);
      writable.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Arrow output stream closed before it drained."));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Arrow output aborted."));
    };

    writable.once("drain", onDrain);
    writable.once("close", onClose);
    writable.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function writeRowStreamAsArrow(writable, rows, options = {}) {
  let columns = Array.isArray(options.columns) ? options.columns.slice() : [];
  const annotation = options.annotation || {};
  const batchSize = options.batchSize ?? DEFAULT_ARROW_BATCH_SIZE;
  const writer = new RecordBatchStreamWriter();
  const pumpChunks = (async () => {
    for await (const chunk of writer) {
      await writeBinaryChunk(
        writable,
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        options.signal
      );
    }
  })();

  let currentRows = [];
  let columnSpecs = null;
  let wroteBatch = false;

  const flush = async () => {
    if (currentRows.length === 0) return;
    if (columns.length === 0) {
      columns = Object.keys(currentRows[0] || {});
    }
    if (!columnSpecs) {
      columnSpecs = deriveArrowColumnSpecs(columns, annotation, currentRows);
    }
    writer.write(createArrowRecordBatch(currentRows, columnSpecs));
    wroteBatch = true;
    currentRows = [];
  };

  try {
    for await (const row of rows) {
      currentRows.push(row);
      if (currentRows.length >= batchSize) {
        await flush();
      }
    }

    if (!columnSpecs) {
      columnSpecs = deriveArrowColumnSpecs(columns, annotation, currentRows);
    }

    if (currentRows.length > 0 || (!wroteBatch && columnSpecs.length > 0)) {
      if (currentRows.length === 0) {
        writer.write(createArrowRecordBatch([], columnSpecs));
      } else {
        await flush();
      }
    }

    writer.finish();
    await pumpChunks;
  } catch (err) {
    try {
      writer.abort(err);
    } catch {
      // Ignore secondary abort failures while preserving the original error.
    }
    await pumpChunks.catch(() => {});
    throw err;
  }
}
