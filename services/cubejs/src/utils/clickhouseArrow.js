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

function getClickHouseClient(driver) {
  if (driver?.client && typeof driver.client.exec === "function") {
    return driver.client;
  }
  if (driver && typeof driver.exec === "function") {
    return driver;
  }
  return null;
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
 * that codec, even to the current value, so skip or retry without it.
 */
export async function execClickHouseArrowStream({ driver, sql, signal }) {
  const client = getClickHouseClient(driver);
  if (!client) {
    throw new Error("ClickHouse driver has no exec client for ArrowStream");
  }

  const query = `${removeTrailingSemicolon(sql)}\nFORMAT ArrowStream`;
  const baseSettings = { ...(driver.config?.clickhouseSettings || {}) };
  const readonly = typeof driver.readOnly === "function" && driver.readOnly();

  const run = (clickhouse_settings) => client.exec({
    query,
    clickhouse_settings,
    abort_signal: signal
  });

  if (!readonly) {
    try {
      return await run({
        ...baseSettings,
        output_format_arrow_compression_method: "none"
      });
    } catch (err) {
      if (!isForbiddenClickHouseArrowCompressionError(err)) throw err;
    }
  }

  return await run(baseSettings);
}
