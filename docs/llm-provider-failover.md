# LLM Provider Failover (OpenRouter ↔ Google Gemini)

Claude-Code-Remote's LLM calls (the 3 Slack helpers in `src/channels/slack/socket.js`:
file/image describe, thread-context summary, project-path detection) run through
`src/utils/openrouter.js`, which is a **provider dispatcher**. It supports two
backends, chosen by the `LLM_PROVIDER` env var:

| Provider | Env value | Key env var | API |
|---|---|---|---|
| OpenRouter (default) | `openrouter` | `OPENROUTER_API_KEY` (`sk-or…`) | OpenAI-compatible `chat/completions` |
| Google Gemini | `google` | `GOOGLE_API_KEY` (`AIza…`) | direct Gemini API (`@google/generative-ai`) |

Both use **`gemini-2.5-flash`**. The public function signature is unchanged, so the
call sites don't care which backend is active.

## When to fail over

Switch to Google when OpenRouter is out of quota / credits (calls start failing
with `OpenRouter 402/429`), or during an OpenRouter outage.

## How to switch — Google (failover)

On the VPS (`/var/go/src/github.com/Claude-Code-Remote`), edit `.env`:

```dotenv
LLM_PROVIDER=google
GOOGLE_API_KEY=AIza...your-google-key...
# GOOGLE_MODEL=gemini-2.5-flash   # optional; this is the default
```

Then restart the bot:

```bash
npm run restart          # = sudo systemctl restart claude-remote
```

`.env` is read only at process boot, so the restart is required for the change to
take effect. A normal (safe) restart is enough — the LLM calls happen in the bot
process, not in spawned CLI sessions, so `restart:hard` is not needed.

## How to switch back — OpenRouter (default)

```dotenv
LLM_PROVIDER=openrouter
# OPENROUTER_API_KEY stays as-is
```

```bash
npm run restart
```

## Verify

After restart, check the service is healthy and exercise a helper:

```bash
systemctl is-active claude-remote          # -> active
sudo journalctl -u claude-remote -n 20 --no-pager
```

Then in Slack, mention the bot with a file/image attached (exercises the describe
path) or in a thread (exercises the summary path). A missing key surfaces as a
clear error: `OPENROUTER_API_KEY not set` or `GOOGLE_API_KEY not set`.

## Notes

- **Pre-set both keys** so failover is a one-line `.env` flip + restart, not a
  scramble to find a key.
- No data migration is involved — CCR's LLM calls are stateless (no embeddings /
  vector store here). Switching providers is purely a request-routing change.
- The sibling project **agent-mem** has the same toggle, but there it's in the
  dashboard **Settings → Gemini → Provider** (no `.env` edit needed).
