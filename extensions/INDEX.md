# extensions index

Pi extension entry points.

- `minimalcc-pi/index.ts` — default Pi extension. The directory-with-`index.ts` layout makes Pi label it `minimalcc-pi` instead of a bare filename. It attempts a best-effort unregister of the built-in `anthropic` provider (not relied on for safety), registers `claude-subscription` on the isolated API id `claude-subscription-native` with native `streamSimple`, blocks known non-subscription Claude provider selections in the input path, applies system-block shaping on the fallback provider-request path, and registers `/claude-subscription-status`, `/claude-subscription-accounts`, and `/claude-subscription-import`.

Pi discovers this directory through `package.json` under `pi.extensions`.
