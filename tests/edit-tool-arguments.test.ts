import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEditToolArguments } from "../src/edit-tool-arguments.ts";

test("stripsExtraKeysFromEditItemsKeepingOnlyOldTextAndNewText", () => {
  // Anthropic intermittently appends a stray annotation key (always alongside
  // valid oldText/newText) such as `newText_unused` or `structuredPatch`, which
  // trips Pi's `additionalProperties: false` edit-item schema.
  const input = {
    path: "x",
    edits: [
      { oldText: "a", newText: "b", newText_unused: "" },
      { oldText: "c", newText: "d", structuredPatch: [] },
    ],
  };
  assert.deepEqual(normalizeEditToolArguments(input), {
    path: "x",
    edits: [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ],
  });
});

test("stripsTheRealOpus48OldTextNoteAnnotationKeyCapturedFromAFreeModeRun", () => {
  // Captured verbatim from a free-mode native-Pi run against claude-opus-4-8
  // (no mmr loaded): the model appended a stray `oldText_note` annotation to the
  // first edit item, which made Pi abort with `edits.0: must not have additional
  // properties`. The normalizer drops exactly that key and keeps the edit.
  const input = {
    path: "INDEX.md",
    edits: [
      {
        oldText: "- `module_01.ts` — handles concern number 01.",
        newText: "- `module_01.ts` — handles concern number 01. Covered by `module_01.test.ts`.",
        oldText_note: "01",
      },
      { oldText: "- `module_02.ts`", newText: "- `module_02.ts` updated" },
    ],
  };
  assert.deepEqual(normalizeEditToolArguments(input), {
    path: "INDEX.md",
    edits: [
      {
        oldText: "- `module_01.ts` — handles concern number 01.",
        newText: "- `module_01.ts` — handles concern number 01. Covered by `module_01.test.ts`.",
      },
      { oldText: "- `module_02.ts`", newText: "- `module_02.ts` updated" },
    ],
  });
});

test("parsesStringifiedEditsArrayIntoAnArrayOfObjects", () => {
  // Anthropic sometimes serializes the whole `edits` array as a JSON string,
  // which fails Pi's `edits.0: must be object` (the array element is a string).
  const input = {
    path: "x",
    edits: JSON.stringify([
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d", newText_x: "" },
    ]),
  };
  assert.deepEqual(normalizeEditToolArguments(input), {
    path: "x",
    edits: [
      { oldText: "a", newText: "b" },
      { oldText: "c", newText: "d" },
    ],
  });
});

test("leavesEditItemsWithoutStringOldTextAndNewTextUnchanged", () => {
  // Items that are not a clean {oldText, newText} pair are left as-is so Pi's
  // validator still surfaces a genuine error instead of a silent "fix".
  const input = { path: "x", edits: [{ oldText: "a" }, { foo: "bar" }, 5] };
  assert.deepEqual(normalizeEditToolArguments(input), {
    path: "x",
    edits: [{ oldText: "a" }, { foo: "bar" }, 5],
  });
});

test("leavesNonStringNonArrayEditsUnchanged", () => {
  assert.deepEqual(normalizeEditToolArguments({ path: "x" }), { path: "x" });
  assert.deepEqual(normalizeEditToolArguments({ path: "x", edits: 5 }), { path: "x", edits: 5 });
  assert.deepEqual(
    normalizeEditToolArguments({ path: "x", edits: { a: 1 } }),
    { path: "x", edits: { a: 1 } },
  );
});

test("leavesEditsStringThatDoesNotParseToAnArrayUnchanged", () => {
  assert.deepEqual(
    normalizeEditToolArguments({ path: "x", edits: "{not json" }),
    { path: "x", edits: "{not json" },
  );
  // A JSON object string is not an array; leave it for Pi to reject.
  const objectString = JSON.stringify({ oldText: "a", newText: "b" });
  assert.deepEqual(
    normalizeEditToolArguments({ path: "x", edits: objectString }),
    { path: "x", edits: objectString },
  );
});

test("preservesEmptyEditsArray", () => {
  // An empty array stays empty; Pi rejects empty edits with its own message.
  assert.deepEqual(normalizeEditToolArguments({ path: "x", edits: [] }), { path: "x", edits: [] });
});

test("preservesOtherTopLevelKeysAndDoesNotMutateInput", () => {
  const input: Record<string, unknown> = {
    path: "x",
    edits: [{ oldText: "a", newText: "b", extra: 1 }],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = normalizeEditToolArguments(input);

  // Input is not mutated.
  assert.deepEqual(input, snapshot);
  assert.notEqual(out, input);
  // Only the edit-item shape is normalized; top-level keys pass through.
  assert.deepEqual(out, { path: "x", edits: [{ oldText: "a", newText: "b" }] });
});
