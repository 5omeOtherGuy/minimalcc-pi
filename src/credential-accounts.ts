import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  loadClaudeCodeCredentials,
  type LoadCredentialOptions,
  resolveCredentialPath,
} from "./credentials.ts";
import { isRecord } from "./type-guards.ts";

const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";
const EXPIRY_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type CredentialAccountSource =
  | { type: "file"; path: string }
  | { type: "keychain"; service: string }
  | { type: "imported"; path: string };

export type TokenFreshness = "fresh" | "near-expiry" | "expired" | "unknown";

export type CredentialAccount = {
  id: string;
  label: string;
  source: CredentialAccountSource;
  account: string;
  subscription?: string;
  expiresAt?: number;
  tokenFreshness: TokenFreshness;
  refreshAvailable: boolean;
};

export type CredentialCommandResult = {
  status: "selected" | "unchanged" | "cancelled" | "none" | "imported";
  level: "info" | "warning" | "error";
  message: string;
  account?: CredentialAccount;
};

export type CredentialDiagnostics = {
  level: "info" | "warning" | "error";
  message: string;
};

export type CredentialAccountOptions = LoadCredentialOptions & {
  credentialPath?: string;
  statePath?: string;
  importedCredentialPath?: string;
};

type StoredCredentialState = {
  activeAccount?: CredentialAccountSource;
  importedFrom?: CredentialAccountSource;
};

type ParsedCredentials = {
  root: Record<string, unknown>;
  oauth: Record<string, unknown>;
};

type SelectAccount = (title: string, options: string[]) => Promise<string | undefined>;

export function getDefaultCredentialStatePath(): string {
  return join(getAgentDir(), "pi-claude-subscription", "credential-state.json");
}

export function getDefaultImportedCredentialPath(): string {
  return join(getAgentDir(), "pi-claude-subscription", "imported-credentials.json");
}

function sourceKey(source: CredentialAccountSource): string {
  if (source.type === "keychain") return `keychain:${source.service}`;
  return `${source.type}:${source.path}`;
}

function sourceLabel(source: CredentialAccountSource): string {
  if (source.type === "keychain") return `macOS Keychain service ${source.service}`;
  if (source.type === "imported") return `minimalcc-owned import ${source.path}`;
  return `Claude Code credentials file ${source.path}`;
}

function parseCredentials(raw: string): ParsedCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed;
  if (!isRecord(oauth)) return undefined;
  const token = oauth.accessToken;
  if (typeof token !== "string" || token.trim().length === 0) return undefined;
  return { root: parsed, oauth };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function accountName(root: Record<string, unknown>, oauth: Record<string, unknown>): string {
  const candidates = [
    isRecord(root.account) ? root.account.email : undefined,
    isRecord(root.user) ? root.user.email : undefined,
    isRecord(root.profile) ? root.profile.email : undefined,
    oauth.email,
    oauth.accountEmail,
  ];
  return candidates.map(stringField).find((value): value is string => value !== undefined) ?? "unknown-account";
}

function subscriptionName(root: Record<string, unknown>, oauth: Record<string, unknown>): string | undefined {
  return stringField(oauth.subscriptionType)
    ?? stringField(root.subscriptionType)
    ?? stringField(oauth.rateLimitTier);
}

function tokenFreshness(expiresAt: unknown, now: number): TokenFreshness {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return "unknown";
  if (expiresAt <= now) return "expired";
  if (expiresAt <= now + EXPIRY_REFRESH_MARGIN_MS) return "near-expiry";
  return "fresh";
}

function accountFromParsed(source: CredentialAccountSource, parsed: ParsedCredentials, now: number): CredentialAccount {
  const account = accountName(parsed.root, parsed.oauth);
  const subscription = subscriptionName(parsed.root, parsed.oauth);
  const expiresAt = typeof parsed.oauth.expiresAt === "number" && Number.isFinite(parsed.oauth.expiresAt)
    ? parsed.oauth.expiresAt
    : undefined;
  const refreshAvailable = typeof parsed.oauth.refreshToken === "string" && parsed.oauth.refreshToken.trim().length > 0;
  const labelParts = [account, subscription, sourceLabel(source)].filter((part): part is string => !!part);
  return {
    id: sourceKey(source),
    label: labelParts.join(" — "),
    source,
    account,
    subscription,
    expiresAt,
    tokenFreshness: tokenFreshness(parsed.oauth.expiresAt, now),
    refreshAvailable,
  };
}

async function readState(path: string): Promise<StoredCredentialState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const activeAccount = parseSource(parsed.activeAccount);
    const importedFrom = parseSource(parsed.importedFrom);
    return {
      ...(activeAccount ? { activeAccount } : {}),
      ...(importedFrom ? { importedFrom } : {}),
    };
  } catch {
    return {};
  }
}

async function writeState(path: string, state: StoredCredentialState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function parseSource(value: unknown): CredentialAccountSource | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "file" && typeof value.path === "string" && value.path.length > 0) {
    return { type: "file", path: value.path };
  }
  if (value.type === "imported" && typeof value.path === "string" && value.path.length > 0) {
    return { type: "imported", path: value.path };
  }
  if (value.type === "keychain" && typeof value.service === "string" && value.service.length > 0) {
    return { type: "keychain", service: value.service };
  }
  return undefined;
}

async function rawCredentialsFromSource(
  source: CredentialAccountSource,
  options: CredentialAccountOptions,
): Promise<string> {
  if (source.type === "file" || source.type === "imported") return readFile(source.path, "utf8");
  const runSecurity = options.runSecurity;
  if (!runSecurity) throw new Error("No macOS Keychain runner is available for the selected Claude Code account.");
  return runSecurity(["find-generic-password", "-s", source.service, "-w"]);
}

async function discoverCredentialFile(path: string, now: number): Promise<CredentialAccount[]> {
  try {
    const parsed = parseCredentials(await readFile(path, "utf8"));
    return parsed ? [accountFromParsed({ type: "file", path }, parsed, now)] : [];
  } catch {
    return [];
  }
}

function keychainServicesFromDump(output: string): string[] {
  const services = new Set<string>();
  const pattern = /"svce"<blob>="([^"]+)"/g;
  for (const match of output.matchAll(pattern)) {
    const service = match[1];
    if (service === DEFAULT_KEYCHAIN_SERVICE || service.startsWith(`${DEFAULT_KEYCHAIN_SERVICE}-`)) {
      services.add(service);
    }
  }
  services.add(DEFAULT_KEYCHAIN_SERVICE);
  return [...services].sort();
}

async function discoverKeychainAccounts(options: CredentialAccountOptions, now: number): Promise<CredentialAccount[]> {
  if ((options.platform ?? process.platform) !== "darwin") return [];
  const runSecurity = options.runSecurity;
  if (!runSecurity) return [];

  let services: string[];
  try {
    services = keychainServicesFromDump(await runSecurity(["dump-keychain"]));
  } catch {
    services = [DEFAULT_KEYCHAIN_SERVICE];
  }

  const accounts: CredentialAccount[] = [];
  for (const service of services) {
    const source: CredentialAccountSource = { type: "keychain", service };
    try {
      const parsed = parseCredentials(await rawCredentialsFromSource(source, options));
      if (parsed) accounts.push(accountFromParsed(source, parsed, now));
    } catch {
      // Skip unreadable Keychain entries; status reports no accounts if none are usable.
    }
  }
  return accounts;
}

export async function discoverClaudeCodeCredentialAccounts(
  options: CredentialAccountOptions = {},
): Promise<CredentialAccount[]> {
  const credentialPath = options.credentialPath ?? resolveCredentialPath();
  const now = options.now?.() ?? Date.now();
  const [fileAccounts, keychainAccounts] = await Promise.all([
    discoverCredentialFile(credentialPath, now),
    discoverKeychainAccounts(options, now),
  ]);

  const seen = new Set<string>();
  return [...keychainAccounts, ...fileAccounts].filter((account) => {
    if (seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}

function optionFor(account: CredentialAccount): string {
  return `${account.label} [${account.id}]`;
}

function accountFromSelectedOption(accounts: readonly CredentialAccount[], selected: string | undefined): CredentialAccount | undefined {
  if (!selected) return undefined;
  return accounts.find((account) => optionFor(account) === selected);
}

async function chooseAccount(
  select: SelectAccount,
  options: CredentialAccountOptions,
): Promise<CredentialCommandResult> {
  const accounts = await discoverClaudeCodeCredentialAccounts(options);
  if (accounts.length === 0) {
    return {
      status: "none",
      level: "error",
      message: "No Claude Code OAuth credentials found. Run Claude Code login (`claude`) and retry; No API-key fallback is used.",
    };
  }

  if (accounts.length === 1) {
    return { status: "unchanged", level: "info", message: `Using ${accounts[0].label}.`, account: accounts[0] };
  }

  const selected = accountFromSelectedOption(
    accounts,
    await select("Select Claude Code account for claude-subscription", accounts.map(optionFor)),
  );
  if (!selected) return { status: "cancelled", level: "warning", message: "Claude Code account selection cancelled." };
  return { status: "selected", level: "info", message: `Selected ${selected.label}.`, account: selected };
}

export async function switchClaudeCodeCredentialAccount(
  select: SelectAccount,
  options: CredentialAccountOptions = {},
): Promise<CredentialCommandResult> {
  const result = await chooseAccount(select, options);
  if (!result.account) return result;
  const statePath = options.statePath ?? getDefaultCredentialStatePath();
  await writeState(statePath, { ...(await readState(statePath)), activeAccount: result.account.source });
  return result.status === "unchanged"
    ? { ...result, status: "selected", message: `Selected ${result.account.label}.` }
    : result;
}

export async function importClaudeCodeCredentials(
  select: SelectAccount,
  options: CredentialAccountOptions = {},
): Promise<CredentialCommandResult> {
  const result = await chooseAccount(select, options);
  if (!result.account) return result;

  const importedCredentialPath = options.importedCredentialPath ?? getDefaultImportedCredentialPath();
  const statePath = options.statePath ?? getDefaultCredentialStatePath();
  const raw = await rawCredentialsFromSource(result.account.source, options);
  await mkdir(dirname(importedCredentialPath), { recursive: true, mode: 0o700 });
  await writeFile(importedCredentialPath, raw.endsWith("\n") ? raw : `${raw}\n`, { mode: 0o600 });
  await writeState(statePath, {
    ...(await readState(statePath)),
    activeAccount: { type: "imported", path: importedCredentialPath },
    importedFrom: result.account.source,
  });

  return {
    status: "imported",
    level: "info",
    message: `Imported ${result.account.label} into minimalcc-owned credential state.`,
    account: result.account,
  };
}

async function activeSource(
  credentialPath: string,
  options: CredentialAccountOptions,
): Promise<CredentialAccountSource> {
  const state = await readState(options.statePath ?? getDefaultCredentialStatePath());
  if (state.activeAccount) return state.activeAccount;
  return { type: "file", path: credentialPath };
}

export async function loadActiveClaudeCodeCredentials(
  credentialPath = resolveCredentialPath(),
  options: CredentialAccountOptions = {},
): Promise<string> {
  const source = await activeSource(credentialPath, options);
  if (source.type === "keychain") {
    return loadClaudeCodeCredentials(credentialPath, { ...options, platform: "darwin", keychainService: source.service });
  }
  return loadClaudeCodeCredentials(source.path, options);
}

function freshnessAction(account: CredentialAccount): string | undefined {
  if (account.tokenFreshness === "expired" && !account.refreshAvailable) return "action=Run Claude Code login; expired token has no refresh token";
  if (account.tokenFreshness === "expired") return "action=token will refresh on next request";
  if (account.tokenFreshness === "near-expiry") return "action=token will refresh before request";
  return undefined;
}

function diagnosticsLevel(account: CredentialAccount): CredentialDiagnostics["level"] {
  if (account.tokenFreshness === "expired" && !account.refreshAvailable) return "warning";
  if (account.tokenFreshness === "expired" || account.tokenFreshness === "near-expiry") return "warning";
  return "info";
}

export async function formatClaudeSubscriptionCredentialDiagnostics(
  options: CredentialAccountOptions = {},
): Promise<CredentialDiagnostics> {
  const credentialPath = options.credentialPath ?? resolveCredentialPath();
  const source = await activeSource(credentialPath, options);
  const now = options.now?.() ?? Date.now();
  let account: CredentialAccount | undefined;

  try {
    const parsed = parseCredentials(await rawCredentialsFromSource(source, options));
    if (parsed) account = accountFromParsed(source, parsed, now);
  } catch {
    // Fall through to discovery below.
  }

  const accounts = await discoverClaudeCodeCredentialAccounts(options);
  account ??= accounts.find((candidate) => sourceKey(candidate.source) === sourceKey(source)) ?? accounts[0];

  if (!account) {
    return {
      level: "error",
      message: "credentials=missing accounts=0 No Claude Code OAuth credentials found. Run Claude Code login (`claude`) or /claude-subscription-import after credentials exist. No API-key fallback is used.",
    };
  }

  const parts = [
    `credentials=${sourceLabel(account.source)}`,
    `account=${account.account}`,
    account.subscription ? `subscription=${account.subscription}` : undefined,
    `token=${account.tokenFreshness}`,
    `refresh=${account.refreshAvailable ? "available" : "missing"}`,
    `accounts=${accounts.length}`,
    freshnessAction(account),
  ].filter((part): part is string => part !== undefined);

  return { level: diagnosticsLevel(account), message: parts.join(" ") };
}
