import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ChangelogEntry = {
  version: string;
  content: string;
};

type StoredChangelogState = {
  lastVersion?: string;
  lastEntrySignature?: string;
};

type ExtensionChangelogOptions = {
  packageName: string;
  packageVersion: string;
  changelogPath: string;
  statePath?: string;
};

const VERSION_HEADER_PATTERN = /^##\s+\[?(\d+\.\d+\.\d+)\]?/;

export function getDefaultExtensionChangelogStatePath(): string {
  return join(getAgentDir(), "pi-claude-subscription", "changelog-state.json");
}

export function parseVersionedChangelogEntries(changelogPath: string): ChangelogEntry[] {
  if (!existsSync(changelogPath)) return [];

  const lines = readFileSync(changelogPath, "utf8").split("\n");
  const entries: ChangelogEntry[] = [];
  let currentVersion: string | undefined;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentVersion && currentLines.length > 0) {
        entries.push({ version: currentVersion, content: currentLines.join("\n").trim() });
      }

      const match = line.match(VERSION_HEADER_PATTERN);
      currentVersion = match?.[1];
      currentLines = currentVersion ? [line] : [];
      continue;
    }

    if (currentVersion) currentLines.push(line);
  }

  if (currentVersion && currentLines.length > 0) {
    entries.push({ version: currentVersion, content: currentLines.join("\n").trim() });
  }

  return entries;
}

export function compareSemver(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < 3; index += 1) {
    const diff = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function getPackageRootFromExtension(extensionImportMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(extensionImportMetaUrl)), "..");
}

export function getExtensionChangelogOptions(extensionImportMetaUrl: string): ExtensionChangelogOptions {
  const packageRoot = getPackageRootFromExtension(extensionImportMetaUrl);
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };

  return {
    packageName: packageJson.name ?? "pi-claude-subscription",
    packageVersion: packageJson.version ?? "0.0.0",
    changelogPath: join(packageRoot, "CHANGELOG.md"),
  };
}

export function getExtensionChangelogForDisplay(options: ExtensionChangelogOptions): string | undefined {
  const statePath = options.statePath ?? getDefaultExtensionChangelogStatePath();
  const state = readStoredChangelogState(statePath);
  const entries = parseVersionedChangelogEntries(options.changelogPath)
    .sort((a, b) => compareSemver(b.version, a.version));
  const currentEntry = entries.find((entry) => entry.version === options.packageVersion) ?? entries[0];
  const currentState = {
    lastVersion: options.packageVersion,
    lastEntrySignature: currentEntry ? getChangelogEntrySignature(currentEntry) : undefined,
  };

  if (!state.lastVersion) {
    writeStoredChangelogState(statePath, currentState);
    return undefined;
  }

  const packageVersionIncreased = compareSemver(options.packageVersion, state.lastVersion) > 0;
  const legacyStateWithoutEntrySignature = !state.lastEntrySignature;
  const currentEntryChanged = !!currentState.lastEntrySignature
    && currentState.lastEntrySignature !== state.lastEntrySignature;

  if (!packageVersionIncreased && !legacyStateWithoutEntrySignature && !currentEntryChanged) return undefined;

  writeStoredChangelogState(statePath, currentState);

  const newEntries = packageVersionIncreased
    ? entries.filter((entry) => compareSemver(entry.version, state.lastVersion ?? "0.0.0") > 0)
    : currentEntry ? [currentEntry] : [];

  if (newEntries.length === 0) {
    return `Updated ${options.packageName} to v${options.packageVersion}. No versioned changelog entries found.`;
  }

  return [`Updated ${options.packageName} to v${options.packageVersion}:`, ...newEntries.map((entry) => entry.content)].join("\n\n");
}

function readStoredChangelogState(statePath: string): StoredChangelogState {
  try {
    if (!existsSync(statePath)) return {};
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StoredChangelogState;
    return typeof parsed.lastVersion === "string"
      ? {
        lastVersion: parsed.lastVersion,
        lastEntrySignature: typeof parsed.lastEntrySignature === "string" ? parsed.lastEntrySignature : undefined,
      }
      : {};
  } catch {
    return {};
  }
}

function getChangelogEntrySignature(entry: ChangelogEntry): string {
  const hash = createHash("sha256").update(entry.content).digest("hex");
  return `${entry.version}:${hash}`;
}

function writeStoredChangelogState(statePath: string, state: StoredChangelogState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
