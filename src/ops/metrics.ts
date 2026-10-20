// In-memory Prometheus metrics for the gateway.
//
// No dependencies: counters + histograms rendered as Prometheus exposition
// text on `GET /metrics`. One registry per app instance (pass via
// `AppOptions.metrics`) so tests stay isolated; the server creates its own
// when none is supplied.
//
// Series:
// - openproxy_requests_total{method,path,status,model,upstream}
// - openproxy_request_duration_seconds_bucket/sum/count{path}
// - openproxy_generations_total{model,upstream,finish_reason,outcome}
// - openproxy_midstream_errors_total{model,upstream,error_tag}
// - openproxy_empty_generations_total{model,upstream}
// - openproxy_generation_tokens_in_total / _out_total{model,upstream}
// - openproxy_generation_cost_usd_total{model,upstream}
// - openproxy_generation_duration_seconds_bucket/sum/count{model,upstream}
//
// `outcome` is "ok" or "midstream_error". "empty" generations (stream closed
// ok with null usage — the silent-truncation signature) are counted both in
// generations_total{outcome="ok"} and in empty_generations_total so the
// dashboard can ratio them.

export const REQUEST_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
export const GENERATION_DURATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(rec: Record<string, string>): string {
  const parts = Object.entries(rec).map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

function sanitize(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "unknown";
  return value;
}

interface Histogram {
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
}

function newHistogram(buckets: number[]): Histogram {
  return { buckets, counts: buckets.map(() => 0), sum: 0, count: 0 };
}

function observeHistogram(h: Histogram, value: number): void {
  h.sum += value;
  h.count += 1;
  for (let i = 0; i < h.buckets.length; i += 1) {
    if (value <= h.buckets[i]!) h.counts[i]! += 1;
  }
}

export type GenerationOutcome = "ok" | "midstream_error" | "client_aborted";

export interface RequestObservation {
  method: string;
  path: string;
  status: number;
  model?: string | null;
  upstream?: string | null;
  durationSeconds: number;
}

export interface GenerationObservation {
  model: string | null;
  upstream: string | null;
  finishReason: string | null;
  outcome: GenerationOutcome;
  errorTag?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  durationSeconds?: number | null;
}

export function createMetrics() {
  const requests = new Map<string, { labels: Record<string, string>; count: number }>();
  const requestDuration = new Map<string, Histogram>();
  const generations = new Map<string, { labels: Record<string, string>; count: number }>();
  const midstreamErrors = new Map<string, { labels: Record<string, string>; count: number }>();
  const emptyGenerations = new Map<string, { labels: Record<string, string>; count: number }>();
  const tokensInSum = new Map<string, { labels: Record<string, string>; sum: number }>();
  const tokensOutSum = new Map<string, { labels: Record<string, string>; sum: number }>();
  const costSum = new Map<string, { labels: Record<string, string>; sum: number }>();
  const generationDuration = new Map<string, Histogram>();
  const retries = new Map<string, { labels: Record<string, string>; count: number }>();
  const sessionSources = new Map<string, { labels: Record<string, string>; count: number }>();
  const discoveryErrors = new Map<string, { labels: Record<string, string>; count: number }>();

  function inc(
    table: Map<string, { labels: Record<string, string>; count: number }>,
    key: string,
    lbl: Record<string, string>,
  ): void {
    const row = table.get(key);
    if (row) row.count += 1;
    else table.set(key, { labels: lbl, count: 1 });
  }

  function add(
    table: Map<string, { labels: Record<string, string>; sum: number }>,
    key: string,
    lbl: Record<string, string>,
    value: number,
  ): void {
    const row = table.get(key);
    if (row) row.sum += value;
    else table.set(key, { labels: lbl, sum: value });
  }

  function observeRequest(o: RequestObservation): void {
    const model = sanitize(o.model);
    const upstream = sanitize(o.upstream);
    const key = `${o.method}\u0000${o.path}\u0000${o.status}\u0000${model}\u0000${upstream}`;
    inc(requests, key, {
      method: o.method,
      path: o.path,
      status: String(o.status),
      model,
      upstream,
    });
    let h = requestDuration.get(o.path);
    if (!h) {
      h = newHistogram(REQUEST_DURATION_BUCKETS);
      requestDuration.set(o.path, h);
    }
    observeHistogram(h, o.durationSeconds);
  }

  function observeGeneration(o: GenerationObservation): void {
    const model = sanitize(o.model);
    const upstream = sanitize(o.upstream);
    const finish = o.finishReason ?? "unknown";
    const gkey = `${model}\u0000${upstream}\u0000${finish}\u0000${o.outcome}`;
    inc(generations, gkey, { model, upstream, finish_reason: finish, outcome: o.outcome });
    if (o.outcome === "midstream_error") {
      const tag = o.errorTag && o.errorTag.length > 0 ? o.errorTag : "unknown";
      const ekey = `${model}\u0000${upstream}\u0000${tag}`;
      inc(midstreamErrors, ekey, { model, upstream, error_tag: tag });
    }
    const empty = o.tokensIn == null && o.tokensOut == null;
    if (o.outcome === "ok" && empty) {
      const ekey = `${model}\u0000${upstream}`;
      inc(emptyGenerations, ekey, { model, upstream });
    }
    if (typeof o.tokensIn === "number" && Number.isFinite(o.tokensIn)) {
      const key = `${model}\u0000${upstream}`;
      add(tokensInSum, key, { model, upstream }, o.tokensIn);
    }
    if (typeof o.tokensOut === "number" && Number.isFinite(o.tokensOut)) {
      const key = `${model}\u0000${upstream}`;
      add(tokensOutSum, key, { model, upstream }, o.tokensOut);
    }
    if (typeof o.costUsd === "number" && Number.isFinite(o.costUsd)) {
      const key = `${model}\u0000${upstream}`;
      add(costSum, key, { model, upstream }, o.costUsd);
    }
    if (typeof o.durationSeconds === "number" && Number.isFinite(o.durationSeconds)) {
      const key = `${model}\u0000${upstream}`;
      let h = generationDuration.get(key);
      if (!h) {
        h = newHistogram(GENERATION_DURATION_BUCKETS);
        generationDuration.set(key, h);
      }
      observeHistogram(h, o.durationSeconds);
    }
  }

  function observeRetry(model: string | null, upstream: string | null, tag: string): void {
    const m = sanitize(model);
    const u = sanitize(upstream);
    const t = tag.length > 0 ? tag : "unknown";
    inc(retries, `${m}\u0000${u}\u0000${t}`, { model: m, upstream: u, error_tag: t });
  }

  function observeSessionSource(upstream: string | null, source: string): void {
    const u = sanitize(upstream);
    inc(sessionSources, `${u}\u0000${source}`, { upstream: u, source });
  }

  function observeDiscoveryError(upstream: string | null): void {
    inc(discoveryErrors, sanitize(upstream), { upstream: sanitize(upstream) });
  }

  function counter(name: string, help: string, table: Map<string, { labels: Record<string, string>; count: number }>): string {
    let out = `# HELP ${name} ${help}\n# TYPE ${name} counter\n`;
    for (const row of table.values()) {
      out += `${name}${labels(row.labels)} ${row.count}\n`;
    }
    return out;
  }

  function sumCounter(name: string, help: string, table: Map<string, { labels: Record<string, string>; sum: number }>): string {
    let out = `# HELP ${name} ${help}\n# TYPE ${name} counter\n`;
    for (const row of table.values()) {
      out += `${name}${labels(row.labels)} ${row.sum}\n`;
    }
    return out;
  }

  function histogram(
    name: string,
    help: string,
    table: Map<string, Histogram>,
    extra: Record<string, string> | ((key: string) => Record<string, string>),
  ): string {
    let out = `# HELP ${name} ${help}\n# TYPE ${name} histogram\n`;
    for (const [key, h] of table) {
      const base = typeof extra === "function" ? extra(key) : extra;
      let cumulative = 0;
      for (let i = 0; i < h.buckets.length; i += 1) {
        cumulative += h.counts[i]!;
        out += `${name}_bucket${labels({ ...base, le: String(h.buckets[i]) })} ${cumulative}\n`;
      }
      out += `${name}_bucket${labels({ ...base, le: "+Inf" })} ${h.count}\n`;
      out += `${name}_sum${labels(base)} ${h.sum}\n`;
      out += `${name}_count${labels(base)} ${h.count}\n`;
    }
    return out;
  }

  function render(): string {
    let out = "";
    out += counter("openproxy_requests_total", "Gateway requests by route and outcome.", requests);
    out += histogram("openproxy_request_duration_seconds", "Gateway request duration in seconds.", requestDuration, (path) => ({
      path,
    }));
    out += counter("openproxy_generations_total", "Translated generations by finish reason and outcome.", generations);
    out += counter(
      "openproxy_midstream_errors_total",
      "Streams that failed after headers were committed.",
      midstreamErrors,
    );
    out += counter(
      "openproxy_empty_generations_total",
      "Streams that closed ok with null token usage (silent truncation).",
      emptyGenerations,
    );
    out += counter(
      "openproxy_upstream_retries_total",
      "Pre-headers upstream retry attempts by error tag.",
      retries,
    );
    out += counter(
      "openproxy_session_source_total",
      "Upstream session id source by upstream (forwarded, generated, pinned, none).",
      sessionSources,
    );
    out += counter(
      "openproxy_discovery_errors_total",
      "Upstream model-list discovery failures.",
      discoveryErrors,
    );
    out += sumCounter("openproxy_generation_tokens_in_total", "Sum of input tokens per model.", tokensInSum);
    out += sumCounter("openproxy_generation_tokens_out_total", "Sum of output tokens per model.", tokensOutSum);
    out += sumCounter("openproxy_generation_cost_usd_total", "Sum of estimated cost in USD per model.", costSum);
    out += histogram(
      "openproxy_generation_duration_seconds",
      "Time from request start until the generation completed.",
      generationDuration,
      (key) => {
        const [model = "unknown", upstream = "unknown"] = key.split("\u0000");
        return { model, upstream };
      },
    );
    return out;
  }

  return { observeRequest, observeGeneration, observeRetry, observeSessionSource, observeDiscoveryError, render };
}

export type MetricsRegistry = ReturnType<typeof createMetrics>;
