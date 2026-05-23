# extensions index

Pi extension entry points.

- `claude-subscription.ts` — default Pi extension. It attempts a best-effort unregister of the built-in `anthropic` provider (not relied on for safety), registers `claude-subscription` on isolated API id `claude-subscription-native` with native `streamSimple`, blocks known non-subscription Claude provider selections in the normal input path, applies system-block shaping for fallback provider-request paths, and adds `/claude-subscription-status`, `/claude-subscription-usage`, and `/claude-subscription-cache-diagnostics`.

Pi discovers this directory through `package.json` under `pi.extensions`.
