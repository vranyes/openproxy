// Small structural helpers shared by the inbound dialects (chat + responses).
//
// These were inlined in `opencode.ts`; extracting them keeps the OpenAI
// Chat Completions and OpenAI Responses inbound paths over one copy of the
// capability checks. No behavior change.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Does any message carry an image part? */
export function containsImage(body: Record<string, unknown>): boolean {
  for (const raw of asArray(body.messages)) {
    const m = asRecord(raw);
    if (!m || !Array.isArray(m.content)) continue;
    for (const rawPart of m.content) {
      const part = asRecord(rawPart);
      if (part && (part.type === "image_url" || part.type === "image")) return true;
    }
  }
  return false;
}

/** Does the request ask for tools, or continue a tool conversation? */
export function containsTools(body: Record<string, unknown>): boolean {
  if (asArray(body.tools).length > 0) return true;
  for (const raw of asArray(body.messages)) {
    const m = asRecord(raw);
    if (!m) continue;
    if (m.role === "tool") return true;
    if (m.role === "assistant" && asArray(m.tool_calls).length > 0) return true;
  }
  return false;
}
