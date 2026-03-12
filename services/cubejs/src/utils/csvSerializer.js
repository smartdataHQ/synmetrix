/**
 * RFC 4180 compliant CSV serializer.
 *
 * Exports:
 *   escapeCSVField(value)       — escape a single field
 *   rowToCSV(row, columns)      — object → CSV line using column order
 *   serializeRowsToCSV(rows)    — array of objects → full CSV string with header
 *   writeRowsAsCSV(...)         — chunked CSV writer for response streams
 *   writeTextChunk(...)         — backpressure-aware text write helper
 */

const DEFAULT_CSV_CHUNK_SIZE = 128 * 1024;

/**
 * Escape a single value for inclusion in a CSV field (RFC 4180).
 *
 * - null / undefined → ""
 * - Buffer → base64 encoded string
 * - Numbers / booleans → converted to string
 * - Strings containing commas, double-quotes, or newlines → quoted, with
 *   internal double-quotes doubled.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeCSVField(value) {
  if (value == null) return "";

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  const str = typeof value === "string" ? value : String(value);
  if (str === "") return "";

  // If the field contains a comma, double-quote, or newline it must be quoted.
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }

  return str;
}

/**
 * Convert a row object to a CSV line string using the given column order.
 *
 * Missing keys produce an empty field.
 *
 * @param {Record<string, *>} row
 * @param {string[]} columns
 * @returns {string}
 */
export function rowToCSV(row, columns) {
  let line = "";
  for (let i = 0; i < columns.length; i++) {
    if (i > 0) line += ",";
    line += escapeCSVField(row[columns[i]]);
  }
  return line;
}

function headerToCSV(columns) {
  let header = "";
  for (let i = 0; i < columns.length; i++) {
    if (i > 0) header += ",";
    header += escapeCSVField(columns[i]);
  }
  return header;
}

export async function writeTextChunk(writable, chunk, signal) {
  if (!chunk) return;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("CSV output aborted.");
  }
  if (writable.destroyed || writable.writableEnded) {
    throw new Error("CSV output stream is not writable.");
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
      reject(new Error("CSV output stream closed before it drained."));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("CSV output aborted."));
    };

    writable.once("drain", onDrain);
    writable.once("close", onClose);
    writable.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Serialize an array of row objects to a complete CSV string.
 *
 * - Header row is derived from the keys of the first row.
 * - Uses CRLF line endings per RFC 4180.
 * - Returns empty string for an empty array.
 *
 * @param {Record<string, *>[]} rows
 * @returns {string}
 */
export function serializeRowsToCSV(rows) {
  if (!rows || rows.length === 0) return "";

  const columns = Object.keys(rows[0]);
  const lines = new Array(rows.length + 1);
  lines[0] = headerToCSV(columns);
  for (let i = 0; i < rows.length; i++) {
    lines[i + 1] = rowToCSV(rows[i], columns);
  }

  // RFC 4180: CRLF after every record including the last
  return lines.join("\r\n") + "\r\n";
}

/**
 * Write rows as CSV to a writable stream in bounded chunks.
 *
 * The rows are still provided in-memory, but this avoids constructing one
 * monolithic CSV string before sending the response.
 *
 * @param {{ write(chunk: string): boolean }} writable
 * @param {Record<string, *>[]} rows
 * @param {Object} [options]
 * @param {string[]} [options.columns]
 * @param {number} [options.chunkSize]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<void>}
 */
export async function writeRowsAsCSV(writable, rows, options = {}) {
  if (!rows || rows.length === 0) return;

  const columns = options.columns ?? Object.keys(rows[0]);
  const chunkSize = options.chunkSize ?? DEFAULT_CSV_CHUNK_SIZE;
  let chunkParts = [headerToCSV(columns), "\r\n"];
  let chunkLength = chunkParts[0].length + 2;

  for (let i = 0; i < rows.length; i++) {
    const line = rowToCSV(rows[i], columns);
    chunkParts.push(line, "\r\n");
    chunkLength += line.length + 2;

    if (chunkLength >= chunkSize) {
      await writeTextChunk(writable, chunkParts.join(""), options.signal);
      chunkParts = [];
      chunkLength = 0;
    }
  }

  if (chunkLength > 0) {
    await writeTextChunk(writable, chunkParts.join(""), options.signal);
  }
}
