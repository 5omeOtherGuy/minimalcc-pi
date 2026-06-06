const AUTHORIZATION_HEADER_VALUE = /Authorization\s*:\s*Bearer\s+[^\s,;]+/gi;
const BEARER_TOKEN_VALUE = /Bearer\s+[^\s,;]+/gi;
const API_KEY_HEADER_VALUE = /(x-api-key|anthropic-api-key)\s*:\s*[^\s,;]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redacts credential material from strings before they are surfaced in errors.
 *
 * This intentionally targets request/header-shaped secrets and exact known
 * request secrets. Upstream messages are untrusted and may echo token material
 * outside normal header syntax.
 */
export function redactSensitiveText(text: string, knownSecrets: readonly string[] = []): string {
  let redacted = text
    .replace(AUTHORIZATION_HEADER_VALUE, "Authorization: [REDACTED]")
    .replace(BEARER_TOKEN_VALUE, "Bearer [REDACTED]")
    .replace(API_KEY_HEADER_VALUE, (_match, headerName: string) => `${headerName}: [REDACTED]`);

  for (const secret of knownSecrets) {
    if (secret.trim().length === 0) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }

  return redacted;
}
