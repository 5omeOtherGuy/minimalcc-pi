import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { isRecord } from "./type-guards.ts";

const execFileAsync = promisify(execFile);
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CODE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";
const EXPIRY_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_CLAUDE_CODE_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;

function loginHint(path: string): string {
  return `Run Claude Code login, then ensure Claude Code credentials exist at ${path}.`;
}

function credentialError(path: string, reason: string): Error {
  return new Error(`${reason}. ${loginHint(path)}`);
}

type SecurityRunner = (args: readonly string[]) => Promise<string>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type LoadCredentialOptions = {
  platform?: string;
  runSecurity?: SecurityRunner;
  fetch?: FetchLike;
  now?: () => number;
};

type ClaudeCodeOauthCredentials = {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
};

type ParsedCredentialFile = {
  root: Record<string, unknown>;
  oauth: ClaudeCodeOauthCredentials;
  nested: boolean;
};

async function runMacOsSecurity(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/security", [...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function parseCredentialFile(rawCredentials: string, path: string, reasonPrefix: string): ParsedCredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCredentials);
  } catch {
    throw credentialError(path, `${reasonPrefix} are malformed`);
  }

  if (!isRecord(parsed)) {
    throw credentialError(path, `${reasonPrefix} are missing claudeAiOauth.accessToken`);
  }

  if (isRecord(parsed.claudeAiOauth)) {
    return {
      root: parsed,
      oauth: parsed.claudeAiOauth as ClaudeCodeOauthCredentials,
      nested: true,
    };
  }

  return {
    root: parsed,
    oauth: parsed as ClaudeCodeOauthCredentials,
    nested: false,
  };
}

function accessTokenFrom(parsed: ParsedCredentialFile, path: string, reasonPrefix: string): string {
  const token = parsed.oauth.accessToken;

  if (typeof token !== "string" || token.trim().length === 0) {
    throw credentialError(
      path,
      `${reasonPrefix} are missing claudeAiOauth.accessToken`,
    );
  }

  return token;
}

function scopesFor(credentials: ClaudeCodeOauthCredentials): string {
  if (Array.isArray(credentials.scopes)) {
    const scopes = credentials.scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
    if (scopes.length > 0) return scopes.join(" ");
  }

  if (typeof credentials.scopes === "string" && credentials.scopes.trim().length > 0) {
    return credentials.scopes.trim();
  }

  return DEFAULT_CLAUDE_CODE_SCOPES.join(" ");
}

function isExpiredOrNearExpiry(expiresAt: unknown, now: number): boolean {
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= now + EXPIRY_REFRESH_MARGIN_MS;
}

function refreshedRoot(
  parsed: ParsedCredentialFile,
  refreshedOauth: ClaudeCodeOauthCredentials,
): Record<string, unknown> {
  return parsed.nested
    ? { ...parsed.root, claudeAiOauth: refreshedOauth }
    : { ...parsed.root, ...refreshedOauth };
}

async function persistCredentialFile(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function refreshClaudeCodeCredentials(
  parsed: ParsedCredentialFile,
  path: string,
  options: Required<Pick<LoadCredentialOptions, "fetch" | "now">>,
): Promise<string> {
  const refreshToken = parsed.oauth.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw credentialError(path, "Claude Code OAuth access token is expired and no refresh token is available");
  }

  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.CLAUDE_CODE_OAUTH_CLIENT_ID || CLAUDE_CODE_OAUTH_CLIENT_ID,
    scope: scopesFor(parsed.oauth),
  };

  let response: Response;
  try {
    response = await options.fetch(CLAUDE_CODE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw credentialError(path, "Claude Code OAuth access token refresh failed");
  }

  if (!response.ok) {
    throw credentialError(path, `Claude Code OAuth access token refresh failed with HTTP ${response.status}`);
  }

  let refreshResponse: unknown;
  try {
    refreshResponse = await response.json();
  } catch {
    throw credentialError(path, "Claude Code OAuth token refresh response is malformed");
  }

  if (!isRecord(refreshResponse)) {
    throw credentialError(path, "Claude Code OAuth token refresh response is malformed");
  }

  const accessToken = refreshResponse.access_token;
  const expiresIn = refreshResponse.expires_in;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0 || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw credentialError(path, "Claude Code OAuth token refresh response is missing required fields");
  }

  const nextRefreshToken = typeof refreshResponse.refresh_token === "string" && refreshResponse.refresh_token.trim().length > 0
    ? refreshResponse.refresh_token
    : refreshToken;
  const nextScopes = typeof refreshResponse.scope === "string" && refreshResponse.scope.trim().length > 0
    ? refreshResponse.scope.trim().split(/\s+/)
    : parsed.oauth.scopes;
  const refreshedOauth = {
    ...parsed.oauth,
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: options.now() + expiresIn * 1000,
    ...(nextScopes !== undefined ? { scopes: nextScopes } : {}),
  };

  await persistCredentialFile(path, refreshedRoot(parsed, refreshedOauth));
  return accessToken;
}

async function accessTokenFromParsedCredentials(
  parsed: ParsedCredentialFile,
  path: string,
  reasonPrefix: string,
  options: LoadCredentialOptions,
): Promise<string> {
  const token = accessTokenFrom(parsed, path, reasonPrefix);
  const now = options.now?.() ?? Date.now();
  if (!isExpiredOrNearExpiry(parsed.oauth.expiresAt, now)) return token;

  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw credentialError(path, "Claude Code OAuth access token is expired and no fetch implementation is available to refresh it");
  }

  return refreshClaudeCodeCredentials(parsed, path, { fetch, now: () => now });
}

async function loadClaudeCodeCredentialsFromMacOsKeychain(
  credentialPath: string,
  runSecurity: SecurityRunner,
  options: LoadCredentialOptions,
): Promise<string> {
  let rawCredentials: string;
  try {
    rawCredentials = await runSecurity([
      "find-generic-password",
      "-s",
      CLAUDE_CODE_KEYCHAIN_SERVICE,
      "-w",
    ]);
  } catch {
    throw credentialError(
      credentialPath,
      `Claude Code credentials could not be read from macOS Keychain service ${CLAUDE_CODE_KEYCHAIN_SERVICE}`,
    );
  }

  const parsed = parseCredentialFile(rawCredentials, credentialPath, "Claude Code macOS Keychain credentials");
  return accessTokenFromParsedCredentials(parsed, credentialPath, "Claude Code macOS Keychain credentials", options);
}

/**
 * Resolves the path to the Claude Code credentials file.
 *
 * Lookup order (mirrors Claude Code's own resolution):
 *   1. `env.CLAUDE_CONFIG_DIR` / `.credentials.json`
 *   2. `env.HOME` / `.claude` / `.credentials.json`
 *
 * Accepts an explicit env map so callers can inject a fake environment in tests
 * without mutating `process.env`.
 *
 * Never reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.
 */
export function resolveCredentialPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir) return join(configDir, ".credentials.json");

  const home = env.HOME || homedir();
  return join(home, ".claude", ".credentials.json");
}

/**
 * Reads the Claude Code OAuth access token from the credentials file.
 *
 * - Reads `.claudeAiOauth.accessToken` from the JSON file at `credentialPath`.
 * - If `credentialPath` is omitted, calls `resolveCredentialPath()`.
 * - Throws a human-readable error (with login hint, no token/file contents)
 *   when the file is missing, malformed, or the field is absent.
 */
export async function loadClaudeCodeCredentials(
  credentialPath = resolveCredentialPath(),
  options: LoadCredentialOptions = {},
): Promise<string> {
  let rawCredentials: string;
  try {
    rawCredentials = await readFile(credentialPath, "utf8");
  } catch {
    if ((options.platform ?? process.platform) === "darwin") {
      return loadClaudeCodeCredentialsFromMacOsKeychain(
        credentialPath,
        options.runSecurity ?? runMacOsSecurity,
        options,
      );
    }

    throw credentialError(credentialPath, "Claude Code credentials could not be read");
  }

  const parsed = parseCredentialFile(rawCredentials, credentialPath, "Claude Code credentials");
  return accessTokenFromParsedCredentials(parsed, credentialPath, "Claude Code credentials", options);
}
