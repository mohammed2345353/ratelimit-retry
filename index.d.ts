export type Provider = "anthropic" | "openai" | "gemini" | "unknown";
export type FailureKind = "rate" | "quota" | "billing" | "overloaded" | "server" | "unknown";

export interface Bucket {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

export interface RateLimitInfo {
  provider: Provider;
  status: number | null;
  kind: FailureKind;
  /** Delay the provider asked for (retry-after, RetryInfo, "try again in"), in ms. */
  retryAfterMs: number | null;
  retryable: boolean;
  limits: Partial<Record<"requests" | "tokens" | "inputTokens" | "outputTokens", Bucket>>;
  quota: { id: string; metric: string | null; value: string | number | null; window: "minute" | "day" | "unknown"; freeTier: boolean } | null;
  message: string | null;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined> | { headers?: unknown; status?: number };

export function parseDuration(text: string | null | undefined): number | null;
export function parseRateLimit(responseOrHeaders: HeaderSource | null | undefined, body?: unknown, opts?: { now?: number }): RateLimitInfo;

export class RateLimitError extends Error {
  readonly info: RateLimitInfo;
  readonly hint: string;
  readonly status: number | null;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (e: { attempt: number; delayMs: number; info: RateLimitInfo }) => void | Promise<void>;
  shouldRetry?: (info: RateLimitInfo, attempt: number) => boolean | Promise<boolean>;
  random?: () => number;
  now?: () => number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function withRetry<T>(fn: (attempt: number) => Promise<T>, opts?: RetryOptions): Promise<T>;
export function retryFetch(url: string | URL, init?: RequestInit, opts?: RetryOptions & { fetch?: typeof fetch }): Promise<Response>;

export interface Limiter {
  acquire(estimatedTokens?: number): Promise<void>;
  refund(tokens: number): void;
}
export function createLimiter(opts: { requestsPerMinute?: number; tokensPerMinute?: number; now?: () => number; sleepFn?: (ms: number) => Promise<void> }): Limiter;

export function parseDump(text: string): { status: number | null; headers: Record<string, string>; body: unknown; response: { status: number | null; headers: Record<string, string> } };
export const HINTS: Record<FailureKind, string>;
