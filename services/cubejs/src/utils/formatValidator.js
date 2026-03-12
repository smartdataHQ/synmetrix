const SUPPORTED_FORMATS = ["json", "csv", "jsonstat"];

export function validateFormat(format) {
  if (!format) return "json";
  if (SUPPORTED_FORMATS.includes(format)) return format;
  const safeFormat = String(format).slice(0, 50);
  const err = new Error(
    `Unsupported format: ${safeFormat}. Supported formats: ${SUPPORTED_FORMATS.join(", ")}`
  );
  err.status = 400;
  throw err;
}
