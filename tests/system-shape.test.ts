import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_CODE_IDENTITY } from "../src/constants.ts";
import { sanitizePiPrompt, shapeSystemBlocks, shouldShapePayload } from "../src/system-shape.ts";

test("sanitizePiPrompt removes Pi docs routing lines", () => {
  assert.equal(
    sanitizePiPrompt([
      "Keep this line.",
      "- When asked about: extensions, read docs",
      "- When working on pi topics, read docs",
      "- Always read pi .md files completely",
      "Keep that line.",
    ].join("\n")),
    "Keep this line.\nKeep that line.",
  );
});

test("shouldShapePayload only accepts Anthropic message payloads", () => {
  assert.equal(shouldShapePayload(null), false);
  assert.equal(shouldShapePayload({ model: "claude-sonnet", messages: [], max_tokens: 1 }), true);
  assert.equal(shouldShapePayload({ model: "gpt-5", messages: [], max_tokens: 1 }), false);
  assert.equal(shouldShapePayload({ model: "claude-sonnet", max_tokens: 1 }), false);
  assert.equal(shouldShapePayload({ model: "claude-sonnet", messages: [] }), false);
});

test("shapeSystemBlocks omits empty Pi prompt after identity-only input", () => {
  const shaped = shapeSystemBlocks({
    model: "claude-sonnet-4-6",
    messages: [],
    max_tokens: 1,
    system: CLAUDE_CODE_IDENTITY,
  });

  assert.deepEqual(shaped.system, [{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
});

test("shapeSystemBlocks preserves appended subagent system prompt content", () => {
  const piPrompt = [
    "You are an AI coding assistant operating inside pi.",
    "Current date: 2026-05-23",
    "Current working directory: /repo",
    "",
    "You are a scout. Quickly investigate a codebase and return structured findings.",
    "Output format:",
    "## Files Retrieved",
  ].join("\n");

  const shaped = shapeSystemBlocks({
    model: "claude-sonnet-4-6",
    messages: [],
    max_tokens: 1,
    system: piPrompt,
  });

  assert.deepEqual(shaped.system, [
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    { type: "text", text: piPrompt },
  ]);
});
