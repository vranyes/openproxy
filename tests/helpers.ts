import type { UpstreamFetcher } from "../src/server";
export async function json<T>(res: Response): Promise<T> { return (await res.json()) as T; }
export function stubUpstream(handler: (req: Request) => Response | Promise<Response>): UpstreamFetcher {
  return async (url, init) => handler(new Request(url, init));
}
export type ModelEntry = { id: string; object: string; owned_by: string; context_length: number | null };
export type ModelsResponse = { object: string; data: ModelEntry[] };
export type ChatCompletionResponse = { choices: Array<{ message: unknown }> };

/**
 * A real HTTP upstream for adapter tests: the @opencode/ai runtime fetches real
 * URLs, so a fake must be a real server (not a `stubUpstream` closure). `url`
 * already ends in `/v1`, matching what `OpenAICompatible.configure` expects.
 */
export function fakeUpstreamServer(handler: (req: Request) => Response | Promise<Response>): { url: string; stop: () => void } {
  // Bind loopback explicitly and retry on collision: `port: 0` on the wildcard
  // address can be assigned an ephemeral port that a host loopback service already
  // holds on 127.0.0.1, so requests would reach that service instead of the fake.
  let server: ReturnType<typeof Bun.serve> | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 20 && !server; attempt++) {
    try {
      server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    } catch (e) {
      lastError = e;
    }
  }
  if (!server) throw lastError ?? new Error("could not bind fake upstream server");
  const started = server;
  return {
    url: `http://127.0.0.1:${started.port}/v1`,
    stop: () => {
      started.stop(true);
    },
  };
}

/** Join raw SSE payload lines (each `data: ...`, no trailing newline) into a stream body. */
export function sse(frames: string[]): string {
  return frames.join("\n\n") + "\n\n";
}
