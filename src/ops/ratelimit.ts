// F7c: optional, config-driven token-bucket rate limiting. In-memory and
// dependency-free; OFF by default with no bucket allocated until a limit is
// configured. A request may be subject to a global bucket and/or the bucket of
// its upstream. Both are previewed at the same instant and consumed together,
// so a denial never partially charges either bucket.
import type { RateLimitConfig } from "../config";

export interface RateLimitVerdict {
  ok: true;
}

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterMs: number };

/** Capacity = burst ?? rpm; refill = rpm/60000 tokens per millisecond. */
export interface Bucket {
  /** Non-consuming check at `atMs` (lazily refills the bucket first). */
  preview(atMs: number): RateLimitDecision;
  /** Consume one token at `atMs` (call only after a positive preview). */
  take(atMs: number): void;
}

export function createBucket(opts: { rpm: number; burst?: number; now?: () => number }): Bucket {
  const capacity = opts.burst ?? opts.rpm;
  const refillPerMs = opts.rpm / 60000;
  const clock = opts.now ?? (() => Date.now());
  let tokens = capacity;
  let last = clock();

  // Lazily add the tokens accrued since `last`, capped at capacity. Shared by
  // preview (which does not consume) and take (which then subtracts one).
  function refill(atMs: number): void {
    const elapsed = atMs - last;
    if (elapsed <= 0) return;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
    last = atMs;
  }

  return {
    preview(atMs) {
      refill(atMs);
      if (tokens >= 1) return { ok: true };
      return { ok: false, retryAfterMs: (1 - tokens) / refillPerMs };
    },
    take(atMs) {
      refill(atMs);
      tokens -= 1;
    },
  };
}

export interface RateLimiterDeps {
  now?: () => number;
  config: () => {
    rateLimit?: RateLimitConfig;
    upstreams: ReadonlyArray<{ id: string; rateLimit?: RateLimitConfig }>;
  };
}

export function createRateLimiter(deps: RateLimiterDeps): {
  check(upstreamId: string | null): RateLimitDecision;
} {
  const now = deps.now ?? (() => Date.now());
  const buckets = new Map<string, Bucket>();

  // Memoized by scope:id:rpm:burst, so a hot-reload that changes either value
  // starts a fresh bucket instead of inheriting stale tokens.
  function bucketFor(scope: string, id: string | null, cfg: RateLimitConfig): Bucket {
    const key = `${scope}:${id}:${cfg.rpm}:${cfg.burst ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = createBucket({ rpm: cfg.rpm, burst: cfg.burst, now });
      buckets.set(key, bucket);
    }
    return bucket;
  }

  return {
    check(upstreamId) {
      const config = deps.config();
      const global = config.rateLimit;
      const upstream =
        upstreamId === null ? undefined : config.upstreams.find((u) => u.id === upstreamId)?.rateLimit;

      // Off by default: neither limit configured means no bucket is allocated.
      if (global === undefined && upstream === undefined) return { ok: true };

      const at = now();
      const globalBucket = global !== undefined ? bucketFor("global", null, global) : null;
      const upstreamBucket =
        upstream !== undefined && upstreamId !== null ? bucketFor("upstream", upstreamId, upstream) : null;

      // Preview both at the same instant, then consume only if both allow. A
      // denial returns the first denial and charges nothing (Bun is single
      // threaded, so this synchronous check is atomic).
      const globalPreview = globalBucket?.preview(at) ?? null;
      const upstreamPreview = upstreamBucket?.preview(at) ?? null;
      if (globalPreview !== null && !globalPreview.ok) return globalPreview;
      if (upstreamPreview !== null && !upstreamPreview.ok) return upstreamPreview;

      globalBucket?.take(at);
      upstreamBucket?.take(at);
      return { ok: true };
    },
  };
}
