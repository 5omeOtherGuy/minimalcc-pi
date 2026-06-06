import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitiveText } from "../src/redaction.ts";

test("redactsApiKeyHeaderPatterns", () => {
  const xApiKey = redactSensitiveText("Forbidden: x-api-key: sk-ant-XXXXXXXXXXXX plain text after");
  assert.ok(!xApiKey.includes("sk-ant-XXXXXXXXXXXX"), "x-api-key value must be redacted");
  assert.match(xApiKey, /x-api-key: \[REDACTED\]/);

  const anthropicApiKey = redactSensitiveText("rejected: anthropic-api-key: sk-ant-YYYYYYYYYYYY");
  assert.ok(!anthropicApiKey.includes("sk-ant-YYYYYYYYYYYY"), "anthropic-api-key value must be redacted");
  assert.match(anthropicApiKey, /anthropic-api-key: \[REDACTED\]/);
});

test("redactsAuthorizationBearerWithFlexibleWhitespace", () => {
  const output = redactSensitiveText("Authorization  :  Bearer  my-token-abc123 and more");

  assert.ok(!output.includes("my-token-abc123"), "Bearer token must be redacted");
  assert.match(output, /Authorization: \[REDACTED\]/);
});

test("redactsAllOccurrencesOfKnownSecretsAndSkipsEmptySecrets", () => {
  const token = "multi-appear-token";
  const output = redactSensitiveText(`first: ${token}, second: ${token}, third: ${token}`, [token]);

  assert.ok(!output.includes(token), "all known-secret occurrences must be redacted");
  assert.equal((output.match(/\[REDACTED\]/g) ?? []).length, 3);

  assert.doesNotThrow(() => redactSensitiveText("normal  error message", ["", "  "]));
  assert.equal(redactSensitiveText("normal  error message", ["", "  "]), "normal  error message");
});

test("documentsBareTokenRequiresKnownSecrets", () => {
  const token = "raw-token-xyz";

  const withoutKnownSecrets = redactSensitiveText(`error: ${token}`, []);
  assert.ok(withoutKnownSecrets.includes(token), "bare token without knownSecrets is not regex-redacted");

  const withKnownSecrets = redactSensitiveText(`error: ${token}`, [token]);
  assert.ok(!withKnownSecrets.includes(token), "bare token must be redacted when passed as a known secret");
  assert.match(withKnownSecrets, /REDACTED/);
});
