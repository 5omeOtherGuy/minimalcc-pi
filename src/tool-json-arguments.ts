import { isRecord } from "./type-guards.ts";

// Partial tool-call JSON argument repair/parsing.
//
// Anthropic streams tool_use input as incremental `input_json_delta` fragments.
// A block may stop on a syntactically incomplete fragment (truncated string,
// unterminated object/array, lone trailing backslash, or a raw control
// character that JSON forbids inside a string literal). Incremental parsing is
// best-effort for live deltas; final parsing fails closed when a non-empty
// fragment cannot be repaired into an object.

const VALID_JSON_STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function escapeJsonControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

function isJsonControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

// Repairs the contents of JSON string literals: escapes raw control characters,
// preserves valid escape sequences (including `\uXXXX`), and rewrites any other
// backslash as a literal backslash so the fragment can be parsed as JSON.
function repairJsonStringLiterals(json: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index] ?? "";
    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_STRING_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      repaired += "\\\\";
      continue;
    }

    repaired += isJsonControlCharacter(char) ? escapeJsonControlCharacter(char) : char;
  }

  return repaired;
}

// Closes any unterminated string, escape, object, and array so a truncated
// fragment parses. Closers are emitted in reverse open order via a stack.
function completePartialJsonContainers(json: string): string {
  let completed = "";
  let inString = false;
  let escaping = false;
  const closingStack: string[] = [];

  for (let index = 0; index < json.length; index++) {
    const char = json[index] ?? "";
    completed += char;

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      closingStack.push("}");
    } else if (char === "[") {
      closingStack.push("]");
    } else if (char === "}" || char === "]") {
      if (closingStack.at(-1) === char) closingStack.pop();
    }
  }

  if (escaping) completed += "\\";
  if (inString) completed += '"';
  while (closingStack.length > 0) completed += closingStack.pop();
  return completed;
}

type ToolArgumentsCandidateParse =
  | { type: "record"; value: Record<string, unknown> }
  | { type: "nonObject" };

function tryParseToolArgumentsCandidate(candidate: string): ToolArgumentsCandidateParse | undefined {
  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? { type: "record", value: parsed } : { type: "nonObject" };
  } catch {
    return undefined;
  }
}

function nonObjectToolArgumentError(partialJson: string): Error {
  return new Error(
    `Anthropic tool input JSON must parse to an object; got non-object JSON (length=${partialJson.length}).`,
  );
}

function parseToolArgumentCandidates(
  partialJson: string,
  onNonObject: () => Record<string, unknown>,
): Record<string, unknown> | undefined {
  const rawParsed = tryParseToolArgumentsCandidate(partialJson);
  if (rawParsed?.type === "record") return rawParsed.value;
  if (rawParsed?.type === "nonObject") return onNonObject();

  const repairedJson = repairJsonStringLiterals(partialJson);
  const repairedParsed = tryParseToolArgumentsCandidate(repairedJson);
  if (repairedParsed?.type === "record") return repairedParsed.value;
  if (repairedParsed?.type === "nonObject") return onNonObject();

  const completedJson = completePartialJsonContainers(partialJson);
  const completedParsed = tryParseToolArgumentsCandidate(completedJson);
  if (completedParsed?.type === "record") return completedParsed.value;
  if (completedParsed?.type === "nonObject") return onNonObject();

  const completedRepairedParsed = tryParseToolArgumentsCandidate(completePartialJsonContainers(repairedJson));
  if (completedRepairedParsed?.type === "record") return completedRepairedParsed.value;
  if (completedRepairedParsed?.type === "nonObject") return onNonObject();

  return undefined;
}

// Best-effort parse of a (possibly partial) tool_use input JSON fragment into a
// plain object. Tries the raw fragment first, then escalating repairs, and
// always returns a record (empty when nothing parses, or when the fragment
// parses to a non-object such as an array or scalar).
export function parseToolArgumentsFromJson(partialJson: string): Record<string, unknown> {
  if (partialJson.trim().length === 0) return {};
  return parseToolArgumentCandidates(partialJson, () => ({})) ?? {};
}

// Final parse used at content_block_stop. Empty input means Anthropic supplied
// no streamed arguments beyond the tool_use start block; non-empty but invalid
// input is a transport/model contract failure and must not become `{}`.
export function parseFinalToolArgumentsFromJson(partialJson: string): Record<string, unknown> {
  if (partialJson.trim().length === 0) return {};

  const parsed = parseToolArgumentCandidates(partialJson, () => {
    throw nonObjectToolArgumentError(partialJson);
  });
  if (parsed) return parsed;

  throw new Error(
    `Unable to parse Anthropic tool input JSON after repair attempts (length=${partialJson.length}).`,
  );
}
