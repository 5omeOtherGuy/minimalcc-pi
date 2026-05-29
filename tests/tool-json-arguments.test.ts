import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFinalToolArgumentsFromJson,
  parseToolArgumentsFromJson,
} from "../src/tool-json-arguments.ts";

test("parsesCompleteAndEmptyToolArgumentJson", () => {
  assert.deepEqual(parseToolArgumentsFromJson('{"command":"echo PI_OK"}'), { command: "echo PI_OK" });
  assert.deepEqual(parseToolArgumentsFromJson(""), {});
  assert.deepEqual(parseToolArgumentsFromJson("   \n\t "), {});
});

test("recoversTruncatedStringAndContainerFragments", () => {
  assert.deepEqual(parseToolArgumentsFromJson('{"command":"echo'), { command: "echo" });
  assert.deepEqual(parseToolArgumentsFromJson('{"path":"/tmp/x"'), { path: "/tmp/x" });
  assert.deepEqual(parseToolArgumentsFromJson('{"items":[1,2'), { items: [1, 2] });
  assert.deepEqual(parseToolArgumentsFromJson('{"nested":{"a":1'), { nested: { a: 1 } });
  // A fragment truncated mid-key (dangling comma + opening quote) is not
  // recoverable into an object, so it collapses to an empty record.
  assert.deepEqual(parseToolArgumentsFromJson('{"path":"/tmp/x","'), {});
});

test("escapesRawControlCharactersInsideStringLiterals", () => {
  assert.deepEqual(
    parseToolArgumentsFromJson('{"command":"line one\nline two"}'),
    { command: "line one\nline two" },
  );
  assert.deepEqual(
    parseToolArgumentsFromJson('{"text":"tab\there"}'),
    { text: "tab\there" },
  );
});

test("returnsEmptyRecordForNonObjectAndUnrecoverableJson", () => {
  // Valid JSON that is not an object collapses to {} (arrays/scalars are not tool arguments).
  assert.deepEqual(parseToolArgumentsFromJson("[]"), {});
  assert.deepEqual(parseToolArgumentsFromJson('[1,2,3]'), {});
  assert.deepEqual(parseToolArgumentsFromJson("42"), {});
  // Garbage that cannot be repaired into JSON also yields {}.
  assert.deepEqual(parseToolArgumentsFromJson("not json at all"), {});
});

test("finalToolArgumentJsonFailsClosedForNonEmptyUnparseableInput", () => {
  assert.throws(
    () => parseFinalToolArgumentsFromJson('{"path":"/tmp/x","'),
    /Unable to parse Anthropic tool input JSON.*length=18/,
  );
  assert.throws(
    () => parseFinalToolArgumentsFromJson("not json at all"),
    /Unable to parse Anthropic tool input JSON.*length=15/,
  );
});

test("finalToolArgumentJsonRequiresAJsonObject", () => {
  assert.throws(
    () => parseFinalToolArgumentsFromJson("[]"),
    /Anthropic tool input JSON must parse to an object/,
  );
  assert.throws(
    () => parseFinalToolArgumentsFromJson("42"),
    /Anthropic tool input JSON must parse to an object/,
  );
});

test("finalToolArgumentJsonStillAllowsExplicitEmptyObject", () => {
  assert.deepEqual(parseFinalToolArgumentsFromJson("{}"), {});
  assert.deepEqual(parseFinalToolArgumentsFromJson(" { } \n"), {});
});

test("preservesValidEscapesWhileRewritingInvalidBackslashes", () => {
  // Valid escapes (including \uXXXX) are preserved by the repair path and parsed normally.
  assert.deepEqual(parseToolArgumentsFromJson('{"a":"\\n\\t\\u0041"}'), { a: "\n\tA" });
  // An invalid escape becomes a literal backslash so the fragment can parse.
  assert.deepEqual(parseToolArgumentsFromJson('{"path":"C:\\Users"}'), { path: "C:\\Users" });
  // A lone trailing backslash inside a string is closed safely.
  assert.deepEqual(parseToolArgumentsFromJson('{"path":"a\\'), { path: "a\\" });
});

test("closesNestedStructuresThroughThePublicParser", () => {
  assert.deepEqual(parseToolArgumentsFromJson('{"a":[{"b":1'), { a: [{ b: 1 }] });
  assert.deepEqual(parseToolArgumentsFromJson('{"s":"unterminated'), { s: "unterminated" });
  assert.deepEqual(parseToolArgumentsFromJson('{"a":1}'), { a: 1 });
});
