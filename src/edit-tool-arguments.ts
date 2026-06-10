import { isRecord } from "./type-guards.ts";

// Normalize Pi built-in `edit` tool arguments into the exact runtime contract
// Pi validates: `{ path, edits: [{ oldText, newText }] }`.
//
// Anthropic models intermittently emit two malformed-but-recoverable shapes for
// the `edit` tool. Both are valid JSON, so the transport/parse layer cannot
// reject them, but both fail Pi's `additionalProperties: false` edit schema and
// abort the whole tool call with an opaque validation error:
//
//   1. extra annotation keys inside an edit item alongside valid oldText/newText
//      strings, e.g. `newText_unused`, `_x`, or `structuredPatch`
//      (-> Pi: `edits.N: must not have additional properties`).
//   2. the `edits` array serialized as a JSON string instead of a JSON array
//      (-> Pi: `edits.0: must be object`).
//
// This normalizer is intentionally conservative and `edit`-specific so it never
// changes the observable arguments of any other tool:
//   - only `edits` is reshaped; all other top-level keys pass through untouched
//     (so Pi's own legacy single-edit handling and `path` stay intact);
//   - a stringified `edits` is parsed only when it yields an array;
//   - an edit item is reduced to exactly `{ oldText, newText }` only when both
//     are strings, so a genuinely malformed item still reaches Pi's validator
//     and surfaces a real error instead of being silently "fixed".
//
// The caller must gate on the tool name (`edit`); this function does not inspect
// it. Returns a new object and never mutates the input.
export function normalizeEditToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const edits = resolveEditsArray(args.edits);
  if (edits === undefined) return args;
  return { ...args, edits: edits.map(normalizeEditItem) };
}

// Returns the edits as an array (parsing a JSON-string array), or `undefined`
// when edits is absent or cannot be confidently treated as an array.
function resolveEditsArray(edits: unknown): unknown[] | undefined {
  if (Array.isArray(edits)) return edits;
  if (typeof edits !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(edits);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEditItem(item: unknown): unknown {
  if (isRecord(item) && typeof item.oldText === "string" && typeof item.newText === "string") {
    return { oldText: item.oldText, newText: item.newText };
  }
  return item;
}
