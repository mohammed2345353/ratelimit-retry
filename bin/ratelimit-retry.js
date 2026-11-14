#!/usr/bin/env node
// ratelimit-retry explain <file|-> : explain a raw HTTP error response dump.
import { readFileSync } from "node:fs";
import { parseDump, parseRateLimit, HINTS } from "../src/index.js";

const [cmd, file] = process.argv.slice(2);
if (cmd !== "explain") {
  console.log("usage: ratelimit-retry explain <file>   (or pipe the response: curl -i ... | ratelimit-retry explain -)");
  process.exit(cmd ? 1 : 0);
}
const text = !file || file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
const dump = parseDump(text);
const info = parseRateLimit(dump.response, dump.body);
const fmt = (d) => (d ? `${d.toISOString()} (in ${Math.max(0, Math.round((d - Date.now()) / 1000))}s)` : "—");
console.log(`provider     ${info.provider}`);
console.log(`status       ${info.status ?? "—"}`);
console.log(`kind         ${info.kind}`);
console.log(`retryable    ${info.retryable ? "yes" : "no"}`);
console.log(`retry after  ${info.retryAfterMs != null ? `${info.retryAfterMs / 1000}s` : "—"}`);
for (const [k, v] of Object.entries(info.limits)) {
  console.log(`${k.padEnd(12)} ${v.remaining ?? "?"}/${v.limit ?? "?"} remaining, resets ${fmt(v.resetAt)}`);
}
if (info.quota) console.log(`quota        ${info.quota.id} (per ${info.quota.window}${info.quota.freeTier ? ", free tier" : ""}, limit ${info.quota.value ?? "?"})`);
if (info.message) console.log(`message      ${info.message}`);
console.log(`\n→ ${HINTS[info.kind]}`);
