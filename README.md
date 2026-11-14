# ratelimit-retry 🔁

**Retry Anthropic, OpenAI and Gemini API calls the way each provider *tells* you to: `retry-after`, rate-limit headers, Gemini `RetryInfo`. It never retries errors that won't fix themselves, like billing or daily quotas.**

[![CI](https://github.com/mohammed2345353/ratelimit-retry/actions/workflows/ci.yml/badge.svg)](https://github.com/mohammed2345353/ratelimit-retry/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Types](https://img.shields.io/badge/types-included-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

```js
import { retryFetch } from "ratelimit-retry";

const res = await retryFetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
  body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Hi" }] }),
}, { onRetry: ({ attempt, delayMs, info }) => console.warn(`${info.provider} ${info.kind}: retry #${attempt} in ${delayMs}ms`) });
```

## The problem

Blind exponential backoff is wrong in both directions for LLM APIs:

- **It retries things that will never succeed.** OpenAI's `429 insufficient_quota` means *out of credit*. Gemini's `PerDay` quota won't come back until midnight Pacific. A `limit: 0` quota means the model isn't on your tier at all. Retrying just burns time and requests.
- **It ignores what the server said.** Anthropic sends `retry-after` and `anthropic-ratelimit-*-reset`. OpenAI sends `x-ratelimit-reset-tokens: 6m0s` and "Please try again in 1.5s". Gemini sends `RetryInfo.retryDelay: "37s"`. Guessing either hammers the API or waits far too long.
- **It treats `529 overloaded` like your own rate limit**, so you can't tell "slow down" apart from "they're busy".

`ratelimit-retry` turns every provider's signals into one `RateLimitInfo` and retries only when that makes sense.

## Install

```bash
npm install github:mohammed2345353/ratelimit-retry
```

Node 18+, ESM, zero dependencies, TypeScript types included.

## API

### `withRetry(fn, options)`: wrap anything

`fn` can return a `fetch` `Response` (non-OK responses are inspected) **or** throw an SDK error that has `.status` / `.headers` (the official Anthropic and OpenAI SDKs do).

```js
import Anthropic from "@anthropic-ai/sdk";
import { withRetry, RateLimitError } from "ratelimit-retry";

const client = new Anthropic({ maxRetries: 0 }); // let ratelimit-retry decide
try {
  const msg = await withRetry(() => client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 512,
    messages: [{ role: "user", content: "Summarize this…" }] }), { maxRetries: 6, maxDelayMs: 120_000 });
} catch (e) {
  if (e instanceof RateLimitError) console.error(e.hint, e.info); // e.g. billing → top up, don't loop
  else throw e;
}
```

```js
// OpenAI
import OpenAI from "openai";
const openai = new OpenAI({ maxRetries: 0 });
const r = await withRetry(() => openai.responses.create({ model: "gpt-4.1-mini", input: "Hello" }));

// Gemini REST
const res = await retryFetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ contents: [{ parts: [{ text: "Hello" }] }] }),
});
```

| Option | Default | |
|---|---|---|
| `maxRetries` | 5 | |
| `baseDelayMs` | 1000 | full-jitter exponential backoff when the provider gives no hint |
| `maxDelayMs` | 60000 | if the provider asks to wait longer, it throws instead of hanging |
| `signal` | — | `AbortSignal` to cancel waiting |
| `onRetry({attempt, delayMs, info})` | — | logging / metrics |
| `shouldRetry(info, attempt)` | — | override the decision |

Non-rate errors (400, 401, 404…) aren't retried. Responses come back unchanged and thrown errors are re-thrown.

### `parseRateLimit(responseOrHeaders, body?)`

```js
const info = parseRateLimit(res, await res.clone().json());
// {
//   provider: "openai", status: 429, kind: "rate", retryable: true, retryAfterMs: 1500,
//   limits: { tokens: { limit: 30000, remaining: 0, resetAt: Date }, requests: {...} },
//   quota: null, message: "Rate limit reached…"
// }
```

`kind` is one of `rate` · `quota` · `billing` · `overloaded` · `server` · `unknown`.

### `createLimiter({ requestsPerMinute, tokensPerMinute })`: stay under the limit

```js
const limiter = createLimiter({ requestsPerMinute: 50, tokensPerMinute: 40_000 });
await limiter.acquire(estimatedInputTokens); // waits just long enough (token bucket, FIFO)
```

### CLI: explain a response

```bash
curl -si https://api.openai.com/v1/chat/completions … | npx ratelimit-retry explain -
```
```text
provider     openai
status       429
kind         rate
retryable    yes
retry after  7s
tokens       0/30000 remaining, resets 2026-11-14T16:07:06.596Z (in 360s)
→ Rate limited. Retry after the delay the provider gave.
```

## What it understands

| Provider | Signals |
|---|---|
| All | `retry-after` (seconds or HTTP date), `retry-after-ms`, 408/409/5xx |
| Anthropic | `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`, `rate_limit_error`, `529 overloaded_error`; when `retry-after` is missing, it falls back to the earliest exhausted bucket reset |
| OpenAI | `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` with Go-style durations (`6m0s`, `1h2m3.5s`, `20ms`), "Please try again in …", `rate_limit_exceeded` vs **`insufficient_quota` (never retried)** |
| Gemini | `RESOURCE_EXHAUSTED` + `google.rpc.RetryInfo.retryDelay`, `QuotaFailure` violations → per-minute (retry) vs **per-day or limit 0 (no retry)**, free-tier detection, `503 UNAVAILABLE` |

## Limitations

- Request bodies must be re-sendable (strings, buffers) for `retryFetch`. Streams can't be replayed.
- Streaming responses that fail *mid-stream* aren't retried. Only the initial response is checked.

## Roadmap

- [ ] Publish to npm
- [ ] Azure OpenAI, Bedrock and Vertex header variants
- [ ] Shared limiter state across processes (Redis adapter)

## Related tools in this suite

Small, dependency-free tools for people fighting AI usage limits:

| Tool | What it does |
|---|---|
| [burnrate](https://github.com/mohammed2345353/burnrate) | Forecast Claude Code / Codex limits from local logs |
| [context-diet](https://github.com/mohammed2345353/context-diet) | Find the CLAUDE.md / AGENTS.md / GEMINI.md bloat you pay for on every message |
| [ai-handoff](https://github.com/mohammed2345353/ai-handoff) | Hit a limit? Move the task to another AI with a handoff file |
| [ai-error-decoder](https://github.com/mohammed2345353/ai-error-decoder) | Explain 429 / 529 / quota errors from Anthropic, OpenAI and Gemini |
| **ratelimit-retry** | Retry that respects provider rate-limit headers (JS) |
| [chat-export-md](https://github.com/mohammed2345353/chat-export-md) | ChatGPT / Claude / Gemini exports → Markdown |
| [mcp-token-audit](https://github.com/mohammed2345353/mcp-token-audit) | Measure how many tokens each MCP server's tools cost |
| [logslim](https://github.com/mohammed2345353/logslim) | Shrink logs and stack traces before pasting them into a chat |
| [chunkwise](https://github.com/mohammed2345353/chunkwise) | Split big files into token-budgeted chunks with continuation prompts |
| [ai-reset-clock](https://github.com/mohammed2345353/ai-reset-clock) | When does my quota reset? A countdown in your timezone |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
