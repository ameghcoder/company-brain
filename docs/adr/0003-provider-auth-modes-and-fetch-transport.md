# Model provider calls use a narrow fetch transport with explicit auth modes

The app reaches the model provider through a small server-side `fetch` adapter
(`src/provider/openai-transport.ts`) rather than an SDK. `OPENAI_AUTH_MODE` is our setting:
`network_secret` sends no Authorization header because the Claude Code cloud egress proxy attaches it
for `api.openai.com` (no key is readable in the VM); `api_key` sends server-only `OPENAI_API_KEY` for
ordinary hosting. SDKs typically refuse to start without a readable key, so wrapping one would mean
faking a key. Node only honours `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`, which the provider scripts set.

## Consequences

- Provider errors report only HTTP status and the structured error code, since provider messages can
  echo part of a credential.
- Model IDs and embedding dimensions are configuration with no defaults; they are set only after
  `pnpm check:provider` verifies them.
