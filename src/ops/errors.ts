// Single error envelope for every route: { error: { message, type } }.
// 4xx keep "invalid_request_error"; 500 uses the standard OpenAI "server_error".
export type ErrorType = "invalid_request_error" | "server_error";
export function errorResponse(message: string, status: number, type: ErrorType = "invalid_request_error"): Response {
  return Response.json({ error: { message, type } }, { status });
}
