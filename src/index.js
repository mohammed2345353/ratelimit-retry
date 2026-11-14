// ratelimit-retry — retry Anthropic / OpenAI / Gemini calls the way each provider tells you to.
// Zero dependencies. Node >= 18 (global fetch, AbortSignal).

/** "6m0s" | "1h2m3.5s" | "20ms" | "37s" | "1.5" -> milliseconds, or null. */
export function parseDuration(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/^"|"$/g, "");
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (!m || !m.slice(1).some(Boolean)) return null;
  const [h, mi, sec, ms] = m.slice(1).map((v) => (v ? Number(v) : 0));
  return Math.round(h * 3600e3 + mi * 60e3 + sec * 1e3 + ms);
}

function headerGetter(source) {
  if (!source) return () => null;
  const h = source.headers ?? source;
  if (typeof h.get === "function") return (k) => h.get(k);
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  return (k) => (lower[k.toLowerCase()] ?? null);
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resetToDate(v, now) {
  if (v == null) return null;
  const d = parseDuration(v); // OpenAI style "6m0s"
  if (d != null && !/^\d{4}-/.test(v)) return new Date(now + d);
  const t = Date.parse(v); // Anthropic RFC 3339
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Normalize rate-limit information from a fetch Response (or headers object) and its parsed JSON body.
 * @returns {import('../index').RateLimitInfo}
 */
export function parseRateLimit(responseOrHeaders, body, { now = Date.now() } = {}) {
  const get = headerGetter(responseOrHeaders);
  const status = responseOrHeaders?.status ?? body?.error?.code ?? null;
  const info = { provider: "unknown", status: typeof status === "number" ? status : null, kind: "unknown",
    retryAfterMs: null, retryable: false, limits: {}, quota: null, message: null };
  const err = body?.error ?? (body?.type === "error" ? body.error : null);
  info.message = err?.message ?? null;

  // generic retry-after
  const ra = get("retry-after-ms");
  if (ra != null && num(ra) != null) info.retryAfterMs = num(ra);
  else {
    const r = get("retry-after");
    if (r != null) {
      if (num(r) != null) info.retryAfterMs = num(r) * 1000;
      else if (!Number.isNaN(Date.parse(r))) info.retryAfterMs = Math.max(0, Date.parse(r) - now);
    }
  }

  // Anthropic
  if (get("anthropic-ratelimit-requests-limit") != null || get("anthropic-ratelimit-tokens-limit") != null ||
      get("anthropic-ratelimit-input-tokens-limit") != null || get("anthropic-ratelimit-output-tokens-limit") != null ||
      /_error$/.test(err?.type ?? "") ||
      body?.type === "error" || get("request-id")?.startsWith?.("req_")) {
    info.provider = "anthropic";
    for (const [key, prefix] of [["requests", "requests"], ["tokens", "tokens"], ["inputTokens", "input-tokens"],
      ["outputTokens", "output-tokens"]]) {
      const limit = num(get(`anthropic-ratelimit-${prefix}-limit`));
      const remaining = num(get(`anthropic-ratelimit-${prefix}-remaining`));
      const reset = resetToDate(get(`anthropic-ratelimit-${prefix}-reset`), now);
      if (limit != null || remaining != null || reset) info.limits[key] = { limit, remaining, resetAt: reset };
    }
  }

  // OpenAI
  if (get("x-ratelimit-limit-requests") != null || get("x-ratelimit-limit-tokens") != null ||
      ["insufficient_quota", "rate_limit_exceeded"].includes(err?.code) || err?.type === "insufficient_quota") {
    info.provider = "openai";
    for (const kind of ["requests", "tokens"]) {
      const limit = num(get(`x-ratelimit-limit-${kind}`));
      const remaining = num(get(`x-ratelimit-remaining-${kind}`));
      const reset = resetToDate(get(`x-ratelimit-reset-${kind}`), now);
      if (limit != null || remaining != null || reset) info.limits[kind] = { limit, remaining, resetAt: reset };
    }
    const m = /try again in ([\d.hms]+)/.exec(info.message ?? "");
    if (m && info.retryAfterMs == null) info.retryAfterMs = parseDuration(m[1].replace(/\.$/, ""));
  }

  // Gemini (google.rpc)
  if (err?.status === "RESOURCE_EXHAUSTED" || err?.status === "UNAVAILABLE" || Array.isArray(err?.details)) {
    info.provider = "gemini";
    for (const d of err?.details ?? []) {
      const type = d?.["@type"] ?? "";
      if (type.endsWith("RetryInfo") && d.retryDelay) info.retryAfterMs = parseDuration(d.retryDelay);
      if (type.endsWith("QuotaFailure")) {
        const v = (d.violations ?? [])[0] ?? {};
        const id = v.quotaId ?? "";
        info.quota = { id, metric: v.quotaMetric ?? null, value: v.quotaValue ?? null,
          window: /PerDay/i.test(id) ? "day" : /PerMinute/i.test(id) ? "minute" : "unknown",
          freeTier: /free/i.test(id + (v.quotaMetric ?? "")) };
      }
    }
  }

  // classify
  const code = err?.code ?? err?.type ?? err?.status;
  if (code === "insufficient_quota") info.kind = "billing";
  else if (info.quota?.window === "day" || info.quota?.value === "0" || info.quota?.value === 0) info.kind = "quota";
  else if (info.status === 529 || err?.type === "overloaded_error" || err?.status === "UNAVAILABLE" || info.status === 503) {
    info.kind = "overloaded";
  } else if (info.status === 429 || code === "rate_limit_error" || code === "rate_limit_exceeded" ||
             err?.status === "RESOURCE_EXHAUSTED") info.kind = "rate";
  else if (info.status >= 500) info.kind = "server";

  info.retryable = ["rate", "overloaded", "server"].includes(info.kind) || info.status === 408 || info.status === 409;

  // nothing explicit? use the soonest exhausted bucket reset
  if (info.retryAfterMs == null && info.kind === "rate") {
    const resets = Object.values(info.limits).filter((l) => l.remaining === 0 && l.resetAt).map((l) => l.resetAt - now);
    if (resets.length) info.retryAfterMs = Math.max(0, Math.min(...resets));
  }
  return info;
}

const HINTS = {
  billing: "Out of credit / quota (billing). Retrying won't help: add credit or check the project's budget.",
  quota: "Daily or zero quota exhausted. It resets at midnight Pacific (Gemini) or needs a higher tier / billing.",
  rate: "Rate limited. Retry after the delay the provider gave.",
  overloaded: "The provider is overloaded. This isn't your quota, so retry with backoff.",
  server: "Server error. Retry with backoff.",
  unknown: "Request failed.",
};

export class RateLimitError extends Error {
  constructor(info, cause) {
    super(`${info.provider} ${info.status ?? ""} ${info.kind}: ${info.message ?? HINTS[info.kind]}`.replace(/\s+/g, " ").trim());
    this.name = "RateLimitError";
    this.info = info;
    this.hint = HINTS[info.kind] ?? HINTS.unknown;
    this.status = info.status;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(signal.reason ?? new Error("aborted")); }, { once: true });
});

async function readBody(res) {
  try { return await res.clone().json(); } catch { return null; }
}

/**
 * Call `fn` and retry on retryable failures using provider hints.
 * `fn(attempt)` may return a Response (non-ok responses are inspected) or throw an error with
 * `.status` / `.headers` / `.response` / `.error` (shape used by the official SDKs).
 */
export async function withRetry(fn, opts = {}) {
  const { maxRetries = 5, baseDelayMs = 1000, maxDelayMs = 60_000, signal, onRetry,
    shouldRetry, random = Math.random, now = () => Date.now(), sleepFn = sleep } = opts;
  for (let attempt = 0; ; attempt++) {
    let info, failure, result;
    try {
      result = await fn(attempt);
      if (!(result && typeof result.ok === "boolean" && !result.ok)) return result;
      info = parseRateLimit(result, await readBody(result), { now: now() });
      failure = result;
    } catch (e) {
      if (signal?.aborted) throw e;
      const src = e?.response ?? e;
      if (src?.status == null && src?.headers == null) throw e; // network or programming error: not ours to judge
      info = parseRateLimit(src, e?.error ?? e?.body ?? null, { now: now() });
      if (info.status == null && typeof e?.status === "number") info.status = e.status;
      failure = e;
    }
    let retry = info.retryable;
    if (shouldRetry) retry = await shouldRetry(info, attempt);
    if (!retry || attempt >= maxRetries) {
      // Not a rate/quota/overload problem (e.g. 400, 401, 404): hand it back untouched.
      if (info.kind === "unknown") {
        if (failure instanceof Error) throw failure;
        return failure;
      }
      throw new RateLimitError(info, failure instanceof Error ? failure : undefined);
    }
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    let delay = info.retryAfterMs != null ? info.retryAfterMs + Math.floor(random() * 250) : Math.floor(random() * backoff);
    if (info.retryAfterMs != null && info.retryAfterMs > maxDelayMs) {
      throw new RateLimitError({ ...info, message: `${info.message ?? ""} (retry-after ${Math.round(info.retryAfterMs / 1000)}s exceeds maxDelayMs)`.trim() },
        failure instanceof Error ? failure : undefined);
    }
    delay = Math.min(delay, maxDelayMs);
    await onRetry?.({ attempt: attempt + 1, delayMs: delay, info });
    await sleepFn(delay, signal);
  }
}

/** fetch() with withRetry(). The request body must be re-sendable (string, Buffer, URLSearchParams…). */
export function retryFetch(url, init = {}, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  return withRetry(() => f(url, { ...init, signal: opts.signal ?? init.signal }), { signal: init.signal, ...opts });
}

/**
 * Client-side token bucket so you stay under RPM / TPM instead of bouncing off them.
 * await limiter.acquire(estimatedTokens) before each request.
 */
export function createLimiter({ requestsPerMinute = Infinity, tokensPerMinute = Infinity, now = () => Date.now(),
  sleepFn = sleep } = {}) {
  const buckets = [
    { cap: requestsPerMinute, level: requestsPerMinute, cost: () => 1 },
    { cap: tokensPerMinute, level: tokensPerMinute, cost: (t) => t },
  ].filter((b) => Number.isFinite(b.cap));
  let last = now();
  let chain = Promise.resolve();
  const refill = () => {
    const t = now(), dt = (t - last) / 60_000;
    last = t;
    for (const b of buckets) b.level = Math.min(b.cap, b.level + dt * b.cap);
  };
  async function take(tokens) {
    for (;;) {
      refill();
      const waits = buckets.map((b) => {
        const need = Math.min(b.cost(tokens), b.cap) - b.level;
        return need <= 0 ? 0 : (need / b.cap) * 60_000;
      });
      const wait = Math.max(0, ...waits);
      if (wait <= 0) {
        for (const b of buckets) b.level -= Math.min(b.cost(tokens), b.cap);
        return;
      }
      await sleepFn(Math.ceil(wait));
    }
  }
  return {
    acquire(tokens = 0) {
      const p = chain.then(() => take(tokens));
      chain = p.catch(() => {});
      return p;
    },
    /** Give back unused tokens once you know the real usage. */
    refund(tokens) {
      refill();
      const b = buckets.find((x) => x.cost(2) === 2);
      if (b) b.level = Math.min(b.cap, b.level + tokens);
    },
  };
}

/** Parse a raw HTTP response dump ("HTTP/1.1 429 ...\nheader: v\n\n{json}") for the CLI. */
export function parseDump(text) {
  const [head, ...rest] = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const headers = {};
  let status = null;
  const lines = head.split("\n");
  for (const line of lines) {
    const st = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line) ?? /^(\d{3})\b/.exec(line.trim());
    if (st && status == null) { status = Number(st[1]); continue; }
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) headers[kv[1].toLowerCase()] = kv[2];
  }
  const bodyText = (Object.keys(headers).length || status != null) ? rest.join("\n\n") : text;
  let body = null;
  const start = bodyText.indexOf("{");
  if (start >= 0) { try { body = JSON.parse(bodyText.slice(start)); } catch { body = null; } }
  return { status, headers: { ...headers }, body, response: { status, headers } };
}

export { HINTS };
