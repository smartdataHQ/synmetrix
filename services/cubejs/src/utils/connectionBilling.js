let cachedRaw = null;
let cached = null;

export function resolveSystemLLMBilling() {
  const connectionId = String(process.env.CXS_LLM_CONNECTION_ID || '').trim();
  if (!connectionId) return null;
  const raw = String(process.env.CXS_LLM_BILLING_JSON || '').trim();
  if (!raw) return { connectionId, billing: null };
  if (raw === cachedRaw) return { connectionId, billing: cached };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.connectionId !== connectionId || !Array.isArray(parsed?.rateCards)) return null;
    cachedRaw = raw;
    cached = parsed;
    return { connectionId, billing: parsed };
  } catch {
    return null;
  }
}
