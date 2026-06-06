/**
 * Slice 1 — credential loader and native header builder.
 *
 * Tests cover:
 *   - resolveCredentialPath uses CLAUDE_CONFIG_DIR env var
 *   - resolveCredentialPath falls back to $HOME/.claude when env var is absent
 *   - loadClaudeCodeCredentials reads .claudeAiOauth.accessToken from file
 *   - missing credentials → error with login hint (no secret in message)
 *   - malformed credentials → error without leaking file contents
 *   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are never consulted
 *   - buildNativeHeaders produces OAuth headers with no x-api-key
 *
 * No live Anthropic calls; no real credentials are read, printed, or fixture-committed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MESSAGE_BATCHES_300K_OUTPUT_BETA } from "../src/constants.ts";
import { loadClaudeCodeCredentials, resolveCredentialPath } from "../src/credentials.ts";
import { buildNativeHeaders } from "../src/native-headers.ts";

// ---------- constants -------------------------------------------------------

/** Clearly fake; never a real token. */
const FAKE_TOKEN = "fake-oauth-access-token-for-testing";
const FAKE_REFRESH_TOKEN = "fake-oauth-refresh-token-for-testing";

const EXPECTED_ANTHROPIC_BETA =
  "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14";

// ---------- helpers ---------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "native-creds-test-"));
}

function writeFakeCredentialsAt(credPath: string, content: unknown): void {
  writeFileSync(credPath, JSON.stringify(content));
}

function fakeCredentialContent(token: string = FAKE_TOKEN): unknown {
  return { claudeAiOauth: { accessToken: token } };
}

function fakeOauthCredentials(fields: Record<string, unknown> = {}): unknown {
  return {
    claudeAiOauth: {
      accessToken: FAKE_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: Date.UTC(2026, 0, 1),
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
      ...fields,
    },
  };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), message);
}

// ---------- resolveCredentialPath -------------------------------------------

test("readsClaudeCodeOauthCredentialFromClaudeConfigDir", () => {
  const configDir = "/fake/claude/config";
  const path = resolveCredentialPath({ CLAUDE_CONFIG_DIR: configDir });
  assert.equal(path, join(configDir, ".credentials.json"));
});

test("fallsBackToHomeClaudeCredentialsPath", () => {
  const home = "/fake/home";
  // No CLAUDE_CONFIG_DIR in the injected env.
  const path = resolveCredentialPath({ HOME: home });
  assert.equal(path, join(home, ".claude", ".credentials.json"));
});

test("ignoresAmbientAnthropicApiKeyAndAuthToken", () => {
  const configDir = "/fake/config";
  const path = resolveCredentialPath({
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "must-be-ignored-billing-key",
    ANTHROPIC_AUTH_TOKEN: "must-be-ignored-auth-token",
  });
  // Path must come from CLAUDE_CONFIG_DIR, not from any ANTHROPIC_* var.
  assert.equal(path, join(configDir, ".credentials.json"));
  assert.ok(!path.includes("must-be-ignored"), "path must not contain any ANTHROPIC_* value");
});

test("emptyClaudeConfigDirFallsBackToHomeClaudeCredentialsPath", () => {
  const home = "/fake/home-for-empty-configdir-test";
  const path = resolveCredentialPath({ CLAUDE_CONFIG_DIR: "", HOME: home });

  assert.equal(path, join(home, ".claude", ".credentials.json"));
  assert.ok(!path.startsWith("/.credentials"), "empty CLAUDE_CONFIG_DIR must not resolve at filesystem root");
});

// ---------- loadClaudeCodeCredentials ---------------------------------------

test("loadClaudeCodeCredentialsReadsAccessTokenFromFile", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  writeFakeCredentialsAt(credPath, fakeCredentialContent());

  try {
    const token = await loadClaudeCodeCredentials(credPath);
    assert.equal(typeof token, "string");
    assert.ok(token.length > 0, "returned token must be non-empty");
    assert.equal(token, FAKE_TOKEN);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("missingCredentialsFailWithLoginHintAndNoSecret", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, "nonexistent-.credentials.json");
  // File is intentionally absent.

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        // Error should reference Claude Code login so the user knows what to do.
        assert.match(
          err.message,
          /claude|login/i,
          "error message must hint at Claude Code login",
        );
        // Error must not contain any token-like content.
        assert.ok(
          !err.message.includes(FAKE_TOKEN),
          "error must not contain token material",
        );
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("emptyCredentialsFailWithoutLeakingFileContents", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  writeFileSync(credPath, "");

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
        assert.ok(!err.message.includes("SyntaxError"), "error must not expose raw JSON parser details");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("malformedCredentialsFailWithoutLeakingFileContents", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  // Write clearly identifiable garbage that must not appear in any error message.
  const SECRET_IN_FILE = "secret-content-xyz-789-must-not-appear-in-errors";
  writeFileSync(credPath, `{ this is malformed json ${SECRET_IN_FILE} `);

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        // Must still produce a useful login-hint error, not a raw parse dump.
        assert.match(
          err.message,
          /claude|login/i,
          "error message must hint at Claude Code login even for malformed files",
        );
        assert.ok(
          !err.message.includes(SECRET_IN_FILE),
          "error must not leak file contents",
        );
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("unexpectedCredentialObjectShapesFailWithLoginHintAndNoBlobLeakage", async () => {
  for (const content of [
    null,
    [],
    "not-an-object",
    { claudeAiOauth: "secret-non-object-oauth-blob" },
    { claudeAiOauth: { refreshToken: "secret-refresh-token-without-access-token" } },
  ]) {
    const tmpDir = makeTempDir();
    const credPath = join(tmpDir, ".credentials.json");
    writeFakeCredentialsAt(credPath, content);

    try {
      await assert.rejects(
        () => loadClaudeCodeCredentials(credPath),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
          assert.ok(!err.message.includes("secret-non-object-oauth-blob"), "error must not leak malformed oauth blob");
          assert.ok(!err.message.includes("secret-refresh-token-without-access-token"), "error must not leak refresh token");
          return true;
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test("missingAccessTokenFieldFailsWithLoginHint", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  // Valid JSON but missing the expected field.
  writeFakeCredentialsAt(credPath, { claudeAiOauth: {} });

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(
          err.message,
          /claude|login/i,
          "error message must hint at Claude Code login",
        );
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("whitespaceOnlyAccessTokenFailsWithLoginHint", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  writeFakeCredentialsAt(credPath, { claudeAiOauth: { accessToken: "   " } });

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
        assert.ok(!err.message.includes("   "), "error must not echo whitespace token material");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("nonStringAccessTokenValuesFailWithLoginHint", async () => {
  for (const badValue of [null, 0, false, {}, []]) {
    const tmpDir = makeTempDir();
    const credPath = join(tmpDir, ".credentials.json");
    writeFakeCredentialsAt(credPath, { claudeAiOauth: { accessToken: badValue } });

    try {
      await assert.rejects(
        () => loadClaudeCodeCredentials(credPath),
        (err: unknown) => {
          assert.ok(err instanceof Error, "must throw an Error");
          assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
          return true;
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test("missingCredentialsOnNonDarwinDoesNotAttemptKeychainFallback", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, "nonexistent-.credentials.json");
  let keychainCalled = false;

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        platform: "linux",
        runSecurity: async () => {
          keychainCalled = true;
          throw new Error("Keychain must not be called on non-darwin");
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
        return true;
      },
    );
    assert.equal(keychainCalled, false, "Keychain fallback must not run on non-darwin platforms");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refreshHttpFailureDoesNotLeakTokenResponseBody", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  const secretResponseToken = "secret-refresh-response-token-must-not-leak";
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now - 1 }));

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        now: () => now,
        fetch: async () => new Response(JSON.stringify({
          error: "invalid_grant",
          access_token: secretResponseToken,
          refresh_token: FAKE_REFRESH_TOKEN,
        }), { status: 400, headers: { "content-type": "application/json" } }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /refresh failed with HTTP 400/);
        assert.ok(!err.message.includes(secretResponseToken), "error must not leak refresh response access token");
        assert.ok(!err.message.includes(FAKE_REFRESH_TOKEN), "error must not leak refresh token");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("malformedRefreshResponseDoesNotLeakTokenResponseBody", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  const secretResponseToken = "secret-malformed-refresh-response-token-must-not-leak";
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now - 1 }));

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        now: () => now,
        fetch: async () => new Response(`{ "access_token": "${secretResponseToken}",`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /refresh response is malformed/);
        assert.ok(!err.message.includes(secretResponseToken), "error must not leak malformed refresh response body");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("malformedRefreshResponseMissingFieldsDoesNotLeakTokenMaterial", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  const secretResponseToken = "secret-missing-fields-refresh-token-must-not-leak";
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now - 1 }));

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        now: () => now,
        fetch: async () => new Response(JSON.stringify({
          access_token: secretResponseToken,
          refresh_token: FAKE_REFRESH_TOKEN,
        }), { status: 200, headers: { "content-type": "application/json" } }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /refresh response is missing required fields/);
        assert.ok(!err.message.includes(secretResponseToken), "error must not leak refresh response access token");
        assert.ok(!err.message.includes(FAKE_REFRESH_TOKEN), "error must not leak refresh token");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refreshUsesBundledClaudeCodeOauthClientIdInsteadOfEnvironmentOverride", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  const originalClientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID;
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now - 1 }));

  try {
    process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = "attacker-controlled-client-id-must-not-be-used";

    await loadClaudeCodeCredentials(credPath, {
      now: () => now,
      fetch: async (_url: string, init: RequestInit) => {
        assert.deepEqual(JSON.parse(String(init.body)).client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
        return new Response(JSON.stringify({
          access_token: "fake-refreshed-access-token",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  } finally {
    if (originalClientId === undefined) delete process.env.CLAUDE_CODE_OAUTH_CLIENT_ID;
    else process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = originalClientId;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refreshesExpiredClaudeCodeOauthCredentialsFromFileBeforeReturningToken", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now - 1 }));
  let refreshCalls = 0;

  try {
    const token = await loadClaudeCodeCredentials(credPath, {
      now: () => now,
      fetch: async (url: string, init: RequestInit) => {
        refreshCalls += 1;
        assert.equal(url, "https://platform.claude.com/v1/oauth/token");
        assert.equal(init.method, "POST");
        assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/json");
        assert.equal((init.headers as Record<string, string>)["anthropic-beta"], "oauth-2025-04-20");
        assert.deepEqual(JSON.parse(String(init.body)), {
          grant_type: "refresh_token",
          refresh_token: FAKE_REFRESH_TOKEN,
          client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
          scope: "user:profile user:inference",
        });
        return new Response(JSON.stringify({
          access_token: "fake-refreshed-access-token",
          refresh_token: "fake-refreshed-refresh-token",
          expires_in: 3600,
          scope: "user:profile user:inference user:file_upload",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    assert.equal(token, "fake-refreshed-access-token");
    assert.equal(refreshCalls, 1);
    const saved = readJson(credPath).claudeAiOauth;
    assert.equal(saved.accessToken, "fake-refreshed-access-token");
    assert.equal(saved.refreshToken, "fake-refreshed-refresh-token");
    assert.equal(saved.expiresAt, now + 3600 * 1000);
    assert.deepEqual(saved.scopes, ["user:profile", "user:inference", "user:file_upload"]);
    assert.equal(saved.subscriptionType, "max", "refresh must preserve unrelated Claude Code metadata");
    assert.equal(saved.rateLimitTier, "default_claude_max_5x");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("usesCachedClaudeCodeOauthTokenWhenItIsNotNearExpiry", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now + 60 * 60 * 1000 }));

  try {
    const token = await loadClaudeCodeCredentials(credPath, {
      now: () => now,
      fetch: async () => {
        throw new Error("refresh must not be called for a fresh token");
      },
    });

    assert.equal(token, FAKE_TOKEN);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("forceRefreshRefreshesFreshClaudeCodeOauthCredentials", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now + 60 * 60 * 1000 }));
  let refreshCalls = 0;

  try {
    const token = await loadClaudeCodeCredentials(credPath, {
      now: () => now,
      forceRefresh: true,
      previousAccessToken: FAKE_TOKEN,
      fetch: async () => {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          access_token: "fake-forced-refreshed-access-token",
          refresh_token: "fake-forced-refreshed-refresh-token",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    assert.equal(token, "fake-forced-refreshed-access-token");
    assert.equal(refreshCalls, 1);
    const saved = readJson(credPath).claudeAiOauth;
    assert.equal(saved.accessToken, "fake-forced-refreshed-access-token");
    assert.equal(saved.refreshToken, "fake-forced-refreshed-refresh-token");
    assert.equal(saved.expiresAt, now + 3600 * 1000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("concurrentForceRefreshesReuseTheFirstPersistedToken", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now + 60 * 60 * 1000 }));
  let refreshCalls = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });

  try {
    const first = loadClaudeCodeCredentials(credPath, {
      now: () => now,
      forceRefresh: true,
      previousAccessToken: FAKE_TOKEN,
      fetch: async () => {
        refreshCalls += 1;
        await refreshGate;
        return new Response(JSON.stringify({
          access_token: "fake-shared-refreshed-access-token",
          refresh_token: "fake-shared-refreshed-refresh-token",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const second = loadClaudeCodeCredentials(credPath, {
      now: () => now,
      forceRefresh: true,
      previousAccessToken: FAKE_TOKEN,
      fetch: async () => {
        throw new Error("concurrent refresh should observe the first persisted token instead of refreshing again");
      },
    });

    await waitFor(
      () => refreshCalls === 1,
      "first refresh should start before releasing the refresh gate",
    );
    assert.equal(refreshCalls, 1, "second refresh must wait instead of starting a duplicate token exchange");
    releaseRefresh();

    const [firstToken, secondToken] = await Promise.all([first, second]);
    assert.equal(firstToken, "fake-shared-refreshed-access-token");
    assert.equal(secondToken, "fake-shared-refreshed-access-token");
    assert.equal(refreshCalls, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("doesNotOverwriteCredentialsRefreshedByAnotherProcessDuringRefresh", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now + 60 * 60 * 1000 }));

  try {
    const token = await loadClaudeCodeCredentials(credPath, {
      now: () => now,
      forceRefresh: true,
      previousAccessToken: FAKE_TOKEN,
      fetch: async () => {
        writeFakeCredentialsAt(credPath, fakeOauthCredentials({
          accessToken: "fake-external-refreshed-access-token",
          refreshToken: "fake-external-refreshed-refresh-token",
          expiresAt: now + 2 * 60 * 60 * 1000,
        }));
        return new Response(JSON.stringify({
          access_token: "fake-late-refreshed-access-token",
          refresh_token: "fake-late-refreshed-refresh-token",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    assert.equal(token, "fake-external-refreshed-access-token");
    const saved = readJson(credPath).claudeAiOauth;
    assert.equal(saved.accessToken, "fake-external-refreshed-access-token");
    assert.equal(saved.refreshToken, "fake-external-refreshed-refresh-token");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("refreshesExpiredMacOsKeychainCredentialsAndPersistsCredentialFileFallback", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  const keychainBlob = JSON.stringify(fakeOauthCredentials({ expiresAt: now - 1 }));

  try {
    const token = await loadClaudeCodeCredentials(credPath, {
      platform: "darwin",
      now: () => now,
      runSecurity: async (args: readonly string[]) => {
        assert.deepEqual(args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        return keychainBlob;
      },
      fetch: async () => new Response(JSON.stringify({
        access_token: "fake-macos-refreshed-access-token",
        expires_in: 1800,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    assert.equal(token, "fake-macos-refreshed-access-token");
    const saved = readJson(credPath).claudeAiOauth;
    assert.equal(saved.accessToken, "fake-macos-refreshed-access-token");
    assert.equal(saved.refreshToken, FAKE_REFRESH_TOKEN, "refresh response may omit refresh_token; preserve existing token");
    assert.equal(saved.expiresAt, now + 1800 * 1000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("expiredClaudeCodeOauthCredentialsWithoutRefreshTokenFailBeforeApiRequest", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const now = Date.UTC(2026, 0, 2);
  writeFakeCredentialsAt(credPath, fakeOauthCredentials({ expiresAt: now - 1, refreshToken: undefined }));

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        now: () => now,
        fetch: async () => { throw new Error("refresh must not be called without a refresh token"); },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /expired|refresh|login/i);
        assert.ok(!err.message.includes(FAKE_TOKEN));
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCredentialsAcceptsFlatTopLevelAccessToken", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  writeFakeCredentialsAt(credPath, { accessToken: "fake-flat-format-token" });

  try {
    const token = await loadClaudeCodeCredentials(credPath);
    assert.equal(token, "fake-flat-format-token");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("nativeCredentialLoaderIgnoresAnthropicEnvironmentWhenFileTokenExists", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, ".credentials.json");
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const fakeApiKey = "sk-ant-env-api-key-must-not-be-used";
  const fakeAuthToken = "env-auth-token-must-not-be-used";
  writeFakeCredentialsAt(credPath, fakeCredentialContent("fake-file-token-wins"));

  try {
    process.env.ANTHROPIC_API_KEY = fakeApiKey;
    process.env.ANTHROPIC_AUTH_TOKEN = fakeAuthToken;

    const token = await loadClaudeCodeCredentials(credPath, {
      fetch: async () => { throw new Error("refresh must not be called for a present file token"); },
    });

    assert.equal(token, "fake-file-token-wins");
    assert.notEqual(token, fakeApiKey);
    assert.notEqual(token, fakeAuthToken);
  } finally {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("missingCredentialsDoNotFallBackToAnthropicApiKeyEnvironment", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, "nonexistent-.credentials.json");
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const fakeApiKey = "sk-ant-must-not-be-used-as-token";
  const fakeAuthToken = "anthropic-auth-token-must-not-be-used";

  try {
    process.env.ANTHROPIC_API_KEY = fakeApiKey;
    process.env.ANTHROPIC_AUTH_TOKEN = fakeAuthToken;

    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, { platform: "linux" }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
        assert.ok(!err.message.includes(fakeApiKey), "error must not leak ANTHROPIC_API_KEY");
        assert.ok(!err.message.includes(fakeAuthToken), "error must not leak ANTHROPIC_AUTH_TOKEN");
        return true;
      },
    );
  } finally {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("macOsFallsBackToClaudeCodeKeychainWhenCredentialsFileIsMissing", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, "missing-.credentials.json");
  const keychainBlob = JSON.stringify(fakeCredentialContent("fake-macos-keychain-oauth-token"));
  const securityCalls: string[][] = [];

  try {
    const token = await loadClaudeCodeCredentials(credPath, {
      platform: "darwin",
      runSecurity: async (args: readonly string[]) => {
        securityCalls.push([...args]);
        assert.deepEqual(args, ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        return keychainBlob;
      },
    });

    assert.equal(token, "fake-macos-keychain-oauth-token");
    assert.equal(securityCalls.length, 1, "must read the Claude Code Keychain service once");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("macOsKeychainFailureKeepsLoginHintAndDoesNotLeakBlob", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, "missing-.credentials.json");
  const SECRET_IN_KEYCHAIN = "secret-keychain-content-must-not-leak";

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        platform: "darwin",
        runSecurity: async () => `{ "bad": "${SECRET_IN_KEYCHAIN}" }`,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /keychain|claude|login/i);
        assert.ok(!err.message.includes(SECRET_IN_KEYCHAIN), "error must not leak Keychain contents");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("macOsKeychainRunnerErrorsAreSanitized", async () => {
  const tmpDir = makeTempDir();
  const credPath = join(tmpDir, "missing-.credentials.json");
  const rawSecurityError = "security: SecKeychainSearchCopyNext: The specified item could not be found.";

  try {
    await assert.rejects(
      () => loadClaudeCodeCredentials(credPath, {
        platform: "darwin",
        runSecurity: async () => { throw new Error(rawSecurityError); },
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "must throw an Error");
        assert.match(err.message, /keychain|claude|login/i);
        assert.ok(!err.message.includes(rawSecurityError), "error must not expose raw security tool output");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------- buildNativeHeaders ----------------------------------------------

test("buildsOAuthHeadersWithoutXApiKey", () => {
  const headers = buildNativeHeaders(FAKE_TOKEN);

  assert.equal(headers["Authorization"], `Bearer ${FAKE_TOKEN}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["anthropic-beta"], EXPECTED_ANTHROPIC_BETA);

  // Must not include x-api-key in any casing variant.
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("x-api-key"), "must not include x-api-key");
});

test("buildNativeHeadersCanOptIntoMessageBatches300kOutputBeta", () => {
  const headers = buildNativeHeaders(FAKE_TOKEN, { messageBatchesOutput300k: true });

  assert.equal(
    headers["anthropic-beta"],
    `${EXPECTED_ANTHROPIC_BETA},${MESSAGE_BATCHES_300K_OUTPUT_BETA}`,
  );
});

test("headerAuthorizationValueContainsOnlyTheBearerToken", () => {
  const headers = buildNativeHeaders(FAKE_TOKEN);
  const auth = headers["Authorization"];

  assert.match(auth, /^Bearer /, "Authorization must start with 'Bearer '");
  // Strip the prefix and verify only the token follows (no extra whitespace/values).
  const tokenPart = auth.replace(/^Bearer /, "");
  assert.equal(tokenPart, FAKE_TOKEN);
});

test("buildNativeHeadersRejectsWhitespaceOnlyToken", () => {
  assert.throws(
    () => buildNativeHeaders("   "),
    (err: unknown) => {
      assert.ok(err instanceof Error, "must throw an Error");
      assert.match(err.message, /claude|login/i, "error message must hint at Claude Code login");
      assert.ok(!err.message.includes("   "), "error must not echo whitespace token material");
      return true;
    },
  );

  assert.doesNotThrow(() => buildNativeHeaders(FAKE_TOKEN));
});
