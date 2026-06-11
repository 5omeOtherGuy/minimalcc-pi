/**
 * Installed-vs-lockfile dependency drift checker.
 *
 * The lockstep checks in `tests/dependency-drift.test.ts` compare the declared
 * ranges in `package.json` against `package-lock.json`. They do NOT read the
 * installed `node_modules` tree, so a stale install — for example a freshly
 * added `dependencies` entry that was never `npm ci`-ed — passes those checks
 * yet still blows up at import time with `ERR_MODULE_NOT_FOUND`.
 *
 * This module provides a pure function that compares each declared dependency
 * against the version recorded in the lockfile AND the version actually present
 * on disk. It is deliberately I/O-free: callers inject the parsed manifests and
 * a `readInstalledVersion` accessor, which keeps it deterministic and unit
 * testable against fixtures with no filesystem or network.
 */

export type LockPackageEntry = {
  version?: string;
};

export type DriftInput = {
  /** Declared dependency name -> semver range, e.g. from package.json `dependencies`. */
  declared: Record<string, string>;
  /** Lockfile `packages` map keyed by `""` and `node_modules/<name>` paths. */
  lockPackages: Record<string, LockPackageEntry>;
  /** Returns the installed version for `name`, or null when it is absent on disk. */
  readInstalledVersion: (name: string) => string | null;
};

export type Drift =
  | { name: string; kind: "missing-from-lock" }
  | { name: string; kind: "not-installed"; expected: string }
  | { name: string; kind: "version-mismatch"; expected: string; installed: string };

/**
 * Returns the list of dependencies whose installed state drifts from the
 * lockfile. An empty array means the installed tree matches the lockfile for
 * every declared dependency.
 */
export function checkDependencyDrift(input: DriftInput): Drift[] {
  const drifts: Drift[] = [];

  for (const name of Object.keys(input.declared)) {
    const lockEntry = input.lockPackages[`node_modules/${name}`];
    if (!lockEntry?.version) {
      drifts.push({ name, kind: "missing-from-lock" });
      continue;
    }

    const expected = lockEntry.version;
    const installed = input.readInstalledVersion(name);
    if (installed === null) {
      drifts.push({ name, kind: "not-installed", expected });
      continue;
    }

    if (installed !== expected) {
      drifts.push({ name, kind: "version-mismatch", expected, installed });
    }
  }

  return drifts;
}

/** Human-readable one-line summary of a single drift, for assertion messages. */
export function describeDrift(drift: Drift): string {
  switch (drift.kind) {
    case "missing-from-lock":
      return `${drift.name}: declared in package.json but absent from package-lock.json`;
    case "not-installed":
      return `${drift.name}: lockfile expects ${drift.expected} but it is not installed in node_modules (run \`npm ci\`)`;
    case "version-mismatch":
      return `${drift.name}: lockfile expects ${drift.expected} but ${drift.installed} is installed (run \`npm ci\`)`;
  }
}
