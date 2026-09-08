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

export function isForbiddenClickHouseArrowCompressionError(err) {
  const msg = String(err?.message || err);
  return (
    msg.includes("output_format_arrow_compression_method")
    && (msg.includes("readonly") || msg.includes("Cannot modify"))
  );
}

/**
 * Native ClickHouse ArrowStream. Prefer uncompressed IPC so the browser
 * apache-arrow decoder can read it. Readonly ClickHouse users cannot SET
 * that codec, even to the current value, so retry without the override.
 */
export async function execClickHouseArrowStream({ driver, sql, signal }) {
  const query = `${removeTrailingSemicolon(sql)}\nFORMAT ArrowStream`;
  const baseSettings = { ...(driver.config?.clickhouseSettings || {}) };

  const run = (clickhouse_settings) => driver.client.exec({
    query,
    clickhouse_settings,
    abort_signal: signal
  });

  try {
    return await run({
      ...baseSettings,
      output_format_arrow_compression_method: "none"
    });
  } catch (err) {
    if (!isForbiddenClickHouseArrowCompressionError(err)) throw err;
    return await run(baseSettings);
  }
}
