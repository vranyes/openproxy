import type { UpstreamFetcher } from "../src/server";
export async function json<T>(res: Response): Promise<T> { return (await res.json()) as T; }
export function stubUpstream(handler: (req: Request) => Response | Promise<Response>): UpstreamFetcher {
  return async (url, init) => handler(new Request(url, init));
}
export type ModelEntry = { id: string; object: string; owned_by: string; context_length: number | null };
export type ModelsResponse = { object: string; data: ModelEntry[] };
export type ChatCompletionResponse = { choices: Array<{ message: unknown }> };
