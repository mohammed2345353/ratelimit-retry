import test from "node:test";
import assert from "node:assert/strict";
import { parseDuration, parseRateLimit, withRetry, retryFetch, createLimiter, RateLimitError, parseDump }
  from "../src/index.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("parseDuration", () => {
  assert.equal(parseDuration("6m0s"), 360000);
  assert.equal(parseDuration("1h2m3.5s"), 3723500);
  assert.equal(parseDuration("20ms"), 20);
  assert.equal(parseDuration("37s"), 37000);
  assert.equal(parseDuration("1.5"), 1500);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration(null), null);
});

test("retry-after seconds, ms and HTTP date", () => {
  assert.equal(parseRateLimit({ status: 429, headers: { "retry-after": "12" } }).retryAfterMs, 12000);
  assert.equal(parseRateLimit({ status: 429, headers: { "retry-after-ms": "250", "retry-after": "1" } }).retryAfterMs, 250);
  const date = new Date(NOW + 30_000).toUTCString();
  assert.equal(parseRateLimit({ status: 429, headers: { "Retry-After": date } }, null, { now: NOW }).retryAfterMs, 30000);
});

test("anthropic headers + 529", () => {
  const info = parseRateLimit({ status: 429, headers: {
    "retry-after": "8",
    "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "49",
    "anthropic-ratelimit-requests-reset": "2026-11-14T12:00:01Z",
    "anthropic-ratelimit-input-tokens-limit": "40000", "anthropic-ratelimit-input-tokens-remaining": "0",
    "anthropic-ratelimit-input-tokens-reset": "2026-11-14T12:00:20Z",
  } }, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }, { now: NOW });
  assert.equal(info.provider, "anthropic");
  assert.equal(info.kind, "rate");
  assert.equal(info.retryable, true);
  assert.equal(info.retryAfterMs, 8000);
  assert.equal(info.limits.inputTokens.remaining, 0);
  assert.equal(info.limits.inputTokens.resetAt.toISOString(), "2026-11-14T12:00:20.000Z");
  const over = parseRateLimit({ status: 529, headers: {} }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  assert.equal(over.kind, "overloaded");
  assert.equal(over.retryable, true);
});

test("anthropic: falls back to soonest exhausted bucket reset", () => {
  const info = parseRateLimit({ status: 429, headers: {
    "anthropic-ratelimit-output-tokens-limit": "8000", "anthropic-ratelimit-output-tokens-remaining": "0",
    "anthropic-ratelimit-output-tokens-reset": "2026-11-14T12:00:05Z" } }, null, { now: NOW });
  assert.equal(info.retryAfterMs, 5000);
});

test("openai rate limit vs insufficient_quota", () => {
  const rl = parseRateLimit({ status: 429, headers: {
    "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "6m0s",
    "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-reset-requests": "120ms" } },
  { error: { code: "rate_limit_exceeded", type: "tokens", message: "Rate limit reached ... Please try again in 1.5s." } }, { now: NOW });
  assert.equal(rl.provider, "openai");
  assert.equal(rl.kind, "rate");
  assert.equal(rl.retryAfterMs, 1500);
  assert.equal(rl.limits.tokens.resetAt.getTime(), NOW + 360000);
  const billing = parseRateLimit({ status: 429, headers: {} },
    { error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota" } });
  assert.equal(billing.kind, "billing");
  assert.equal(billing.retryable, false);
});

test("gemini RetryInfo + QuotaFailure per minute / per day / zero", () => {
  const body = (quotaId, value = "15") => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId, quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaValue: value }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] } });
  const minute = parseRateLimit({ status: 429, headers: {} }, body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"));
  assert.equal(minute.provider, "gemini");
  assert.equal(minute.kind, "rate");
  assert.equal(minute.retryAfterMs, 37000);
  assert.equal(minute.quota.window, "minute");
  assert.equal(minute.quota.freeTier, true);
  const day = parseRateLimit({ status: 429, headers: {} }, body("GenerateRequestsPerDayPerProjectPerModel-FreeTier"));
  assert.equal(day.kind, "quota");
  assert.equal(day.retryable, false);
  const zero = parseRateLimit({ status: 429, headers: {} }, body("GenerateRequestsPerMinutePerProjectPerModel", "0"));
  assert.equal(zero.retryable, false);
});

test("withRetry retries with provider delay then succeeds", async () => {
  const delays = [];
  let calls = 0;
  const res = await withRetry(async () => {
    calls++;
    return calls < 3 ? json(429, { error: { code: "rate_limit_exceeded", message: "x" } }, { "retry-after": "2" })
      : json(200, { ok: true });
  }, { sleepFn: async (ms) => delays.push(ms), random: () => 0, onRetry: () => {} });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 2000]);
});

test("withRetry uses jittered backoff without hints and caps maxRetries", async () => {
  const delays = [];
  await assert.rejects(withRetry(async () => json(503, {}), {
    maxRetries: 3, baseDelayMs: 100, sleepFn: async (ms) => delays.push(ms), random: () => 0.999 }),
  (e) => e instanceof RateLimitError && e.info.kind === "overloaded");
  assert.deepEqual(delays, [99, 199, 399]);
});

test("withRetry does not retry billing or daily quota", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; return json(429, { error: { code: "insufficient_quota", message: "no credit" } }); },
    { sleepFn: async () => {} }), (e) => e instanceof RateLimitError && /credit/.test(e.hint) && e.info.kind === "billing");
  assert.equal(calls, 1);
});

test("withRetry returns non-rate 4xx responses untouched and rethrows unrelated errors", async () => {
  const res = await withRetry(async () => json(400, { error: { message: "bad" } }), { sleepFn: async () => {} });
  assert.equal(res.status, 400);
  await assert.rejects(withRetry(async () => { throw new TypeError("boom"); }), TypeError);
});

test("withRetry understands SDK-style thrown errors", async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls === 1) {
      const e = new Error("429 rate_limit_error");
      e.status = 429;
      e.headers = { "retry-after": "1" };
      e.error = { type: "error", error: { type: "rate_limit_error", message: "slow down" } };
      throw e;
    }
    return "done";
  }, { sleepFn: async () => {}, random: () => 0 });
  assert.equal(out, "done");
});

test("withRetry refuses to wait longer than maxDelayMs", async () => {
  await assert.rejects(withRetry(async () => json(429, {}, { "retry-after": "3600" }), { maxDelayMs: 1000, sleepFn: async () => {} }),
    (e) => e instanceof RateLimitError && /exceeds maxDelayMs/.test(e.message));
});

test("retryFetch uses injected fetch", async () => {
  let n = 0;
  const fakeFetch = async () => (++n === 1 ? json(529, { type: "error", error: { type: "overloaded_error" } }) : json(200, {}));
  const res = await retryFetch("https://api.example.test", {}, { fetch: fakeFetch, sleepFn: async () => {}, random: () => 0 });
  assert.equal(res.status, 200);
  assert.equal(n, 2);
});

test("limiter waits when buckets are empty", async () => {
  let t = 0;
  const waits = [];
  const lim = createLimiter({ requestsPerMinute: 2, tokensPerMinute: 1000, now: () => t,
    sleepFn: async (ms) => { waits.push(ms); t += ms; } });
  await lim.acquire(400);
  await lim.acquire(400);
  assert.deepEqual(waits, []);
  await lim.acquire(400); // requests bucket empty -> needs 1 request = 30s
  assert.equal(waits.length, 1);
  assert.equal(waits[0], 30000);
});

test("parseDump", () => {
  const d = parseDump('HTTP/1.1 429 Too Many Requests\nretry-after: 7\ncontent-type: application/json\n\n{"error":{"code":"rate_limit_exceeded","message":"x"}}');
  assert.equal(d.status, 429);
  assert.equal(d.headers["retry-after"], "7");
  assert.equal(d.body.error.code, "rate_limit_exceeded");
  assert.equal(parseRateLimit(d.response, d.body).retryAfterMs, 7000);
});
