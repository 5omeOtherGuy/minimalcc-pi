# extensions index

Pi extension entry points.

- `minimalcc-pi/index.ts` — default Pi extension. The directory-with-`index.ts` layout exists so Pi's loaded-extensions list compacts the label to `minimalcc-pi` instead of a bare filename. It attempts a best-effort unregister of the built-in `anthropic` provider (not relied on for safety), registers `claude-subscription` on isolated API id `claude-subscription-native` with native `streamSimple`, blocks known non-subscription Claude provider selections in the normal input path, applies system-block shaping for fallback provider-request paths, and adds `/claude-subscription-status`, `/claude-subscription-usage`, and `/claude-subscription-cache-diagnostics`.

The extension still registers as the `claude-subscription` provider id; the rename here is purely a packaging change so that `pi` displays the extension as `minimalcc-pi` (matching the repository name) rather than `claude-subscription.ts`.

Pi discovers this directory through `package.json` under `pi.extensions`.
