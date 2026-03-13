import { tableFromArrays, tableToIPC } from "apache-arrow";

const ARROW_IPC_KIND = "stream";

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
