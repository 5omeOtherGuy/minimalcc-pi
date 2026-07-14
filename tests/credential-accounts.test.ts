import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverClaudeCodeCredentialAccounts,
  formatClaudeSubscriptionCredentialDiagnostics,
  importClaudeCodeCredentials,
  loadActiveClaudeCodeCredentials,
  switchClaudeCodeCredentialAccount,
} from "../src/credential-accounts.ts";

const NOW = Date.UTC(2026, 0, 2);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "minimalcc-accounts-"));
}

function fakeCredentials(fields: Record<string, unknown> = {}): unknown {
  return {
    claudeAiOauth: {
      accessToken: "fake-oauth-token",
      refreshToken: "fake-refresh-token",
      expiresAt: NOW + 60 * 60 * 1000,
      subscriptionType: "max",
      ...fields,
    },
    account: { email: "person@example.test" },
  };
}

test("discoversMultipleKeychainAccountsAndPersistsSelectedAccount", async () => {
  const dir = tempDir();
  const statePath = join(dir, "credential-state.json");
  const missingCredentialPath = join(dir, "missing-.credentials.json");
  const serviceForWork = "Claude Code-credentials-work";
  const runSecurity = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "dump-keychain") {
      return [
        "    \"svce\"<blob>=\"Claude Code-credentials\"",
        "    \"svce\"<blob>=\"Claude Code-credentials-work\"",
      ].join("\n");
    }

    const service = args[args.indexOf("-s") + 1];
    return JSON.stringify(fakeCredentials({
      accessToken: service === serviceForWork ? "fake-work-token" : "fake-personal-token",
      subscriptionType: service === serviceForWork ? "team" : "pro",
    }));
  };

  try {
    const accounts = await discoverClaudeCodeCredentialAccounts({
      credentialPath: missingCredentialPath,
      platform: "darwin",
      runSecurity,
      now: () => NOW,
    });
    assert.equal(accounts.length, 2);
    assert.ok(accounts.some((account) => account.label.includes("team")));

    const switched = await switchClaudeCodeCredentialAccount(
      async (_title, options) => options.find((option) => option.includes("team")),
      { credentialPath: missingCredentialPath, platform: "darwin", runSecurity, statePath, now: () => NOW },
    );

    assert.equal(switched.status, "selected");
    assert.equal(switched.account?.source.type, "keychain");
    assert.match(readFileSync(statePath, "utf8"), /Claude Code-credentials-work/);

    const token = await loadActiveClaudeCodeCredentials(missingCredentialPath, {
      platform: "darwin",
      runSecurity,
      statePath,
      now: () => NOW,
    });
    assert.equal(token, "fake-work-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectedKeychainAccountTakesPrecedenceOverDefaultCredentialFile", async () => {
  const dir = tempDir();
  const credentialPath = join(dir, ".credentials.json");
  const statePath = join(dir, "credential-state.json");
  const serviceForWork = "Claude Code-credentials-work";
  writeFileSync(credentialPath, JSON.stringify(fakeCredentials({ accessToken: "fake-file-token" })));

  const runSecurity = async (args: readonly string[]): Promise<string> => {
    if (args[0] === "dump-keychain") {
      return `    \"svce\"<blob>=\"${serviceForWork}\"`;
    }

    assert.equal(args[args.indexOf("-s") + 1], serviceForWork);
    return JSON.stringify(fakeCredentials({ accessToken: "fake-keychain-token", subscriptionType: "team" }));
  };

  try {
    await switchClaudeCodeCredentialAccount(
      async (_title, options) => options.find((option) => option.includes("team")),
      { credentialPath, platform: "darwin", runSecurity, statePath, now: () => NOW },
    );

    const token = await loadActiveClaudeCodeCredentials(credentialPath, {
      platform: "darwin",
      runSecurity,
      statePath,
      now: () => NOW,
    });
    assert.equal(token, "fake-keychain-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("importsSelectedClaudeCodeCredentialsIntoMinimalccOwnedState", async () => {
  const dir = tempDir();
  const credentialPath = join(dir, ".credentials.json");
  const statePath = join(dir, "credential-state.json");
  const importedCredentialPath = join(dir, "imported-credentials.json");
  writeFileSync(credentialPath, JSON.stringify(fakeCredentials({ accessToken: "fake-import-source-token" })));

  try {
    const imported = await importClaudeCodeCredentials(
      async (_title, options) => options[0],
      { credentialPath, statePath, importedCredentialPath, platform: "linux", now: () => NOW },
    );

    assert.equal(imported.status, "imported");
    assert.ok(existsSync(importedCredentialPath), "import command must write only minimalcc-owned credential state");
    assert.match(readFileSync(importedCredentialPath, "utf8"), /fake-import-source-token/);

    writeFileSync(credentialPath, JSON.stringify(fakeCredentials({ accessToken: "fake-rotated-source-token" })));
    const token = await loadActiveClaudeCodeCredentials(credentialPath, {
      statePath,
      importedCredentialPath,
      platform: "linux",
      now: () => NOW,
    });
    assert.equal(token, "fake-import-source-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentialDiagnosticsReportExpiredTokenMissingRefreshAndActionableErrors", async () => {
  const dir = tempDir();
  const credentialPath = join(dir, ".credentials.json");
  writeFileSync(credentialPath, JSON.stringify(fakeCredentials({ expiresAt: NOW - 1, refreshToken: undefined })));

  try {
    const diagnostics = await formatClaudeSubscriptionCredentialDiagnostics({
      credentialPath,
      platform: "linux",
      now: () => NOW,
    });

    assert.equal(diagnostics.level, "warning");
    assert.match(diagnostics.message, /account=person@example\.test/);
    assert.match(diagnostics.message, /token=expired/);
    assert.match(diagnostics.message, /refresh=missing/);
    assert.match(diagnostics.message, /Run Claude Code login/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentialDiagnosticsDoNotFallBackToAnthropicApiKeyWhenClaudeCodeCredentialsAreMissing", async () => {
  const dir = tempDir();
  const missingCredentialPath = join(dir, "missing-.credentials.json");
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-api-key-must-not-be-used";

  try {
    const diagnostics = await formatClaudeSubscriptionCredentialDiagnostics({
      credentialPath: missingCredentialPath,
      platform: "linux",
    });

    assert.equal(diagnostics.level, "error");
    assert.match(diagnostics.message, /No Claude Code OAuth credentials found/);
    assert.match(diagnostics.message, /No API-key fallback/);
    assert.ok(!diagnostics.message.includes("sk-ant-fake-api-key-must-not-be-used"));
  } finally {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
