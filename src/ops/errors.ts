// Single error envelope for every route: { error: { message, type } }.
// 4xx keep "invalid_request_error"; 500 uses the standard OpenAI "server_error".
// Optional `opts` add a machine-readable `error.code` and a top-level `max_context`
// (used by context-overflow responses); both keys are omitted when not supplied.
export type ErrorType = "invalid_request_error" | "server_error";

export interface ErrorResponseOptions {
  /** Machine-readable code, e.g. "context_length_exceeded". Omitted when undefined. */
  code?: string;
  /** Model context window in tokens, surfaced top-level as max_context. Omitted when unknown. */
  maxContext?: number;
}

export function errorResponse(
  message: string,
  status: number,
  type: ErrorType = "invalid_request_error",
  opts: ErrorResponseOptions = {},
): Response {
  const error: Record<string, unknown> = { message, type };
  if (opts.code !== undefined) error.code = opts.code;
  const body: Record<string, unknown> = { error };
  if (opts.maxContext !== undefined) body.max_context = opts.maxContext;
  return Response.json(body, { status });
}
