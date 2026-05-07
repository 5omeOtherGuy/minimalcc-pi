# Why system blocks are required

The Claude Code subscription/OAuth route is shape-sensitive. This package preserves a system-block shape that has been observed to route Sonnet/Opus requests through the Claude Code OAuth lane.

Compatibility notes:

| Shape | Observed Sonnet/Opus OAuth result |
|---|---|
| Minimal OAuth request | Haiku works; Sonnet/Opus can fail with a generic 429 |
| Claude Code identity prepended into one system string | Can fail with a generic 429 |
| Claude Code identity as a separate first `system` text block | 200 OK |
| Separate first identity block plus tools | 200 OK |

Required shape:

```json
"system": [
  { "type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude." },
  { "type": "text", "text": "<Pi system prompt>" }
]
```

Implementation notes:

1. The `claude-subscription` provider uses the isolated `claude-subscription-native` API id and native `streamSimple` path.
2. Native request construction applies the identity-first system-block shape before sending Anthropic Messages requests.
3. The identity must stay a separate first text block. Do not concatenate it with the Pi system prompt.
4. Do not duplicate the identity if the prompt already contains it.
