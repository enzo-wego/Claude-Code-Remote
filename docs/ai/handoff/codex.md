# Handoff — Codex MCP `installMcp` review

**Reviewer**: Claude Opus 4.7 (1M context)
**Reviewed at**: 2026-05-26
**Branch/HEAD**: `release` @ `168f8d8` (after `9b17bba` "Enable reliable Codex Slack questions over MCP" and `168f8d8` "Keep Codex hook setup compatible with current feature flags")
**Files in scope**:
- `src/cli/codex-adapter.js`
- `tests/cli/codex-adapter-hooks.test.js`
- `tests/cli/codex-adapter-mcp.test.js`
- `bin/mcp-stdio-proxy.js` (relevant — see §3)
- `docs/mcp-ask-user.md:212–216`

---

## Verdict

**Code is mergeable, but Codex is not green yet.** The original §3.1 concurrent-session test failed: Source A's prompt appeared in the Source B thread, confirming the global config race. The implementation has since switched Codex MCP from global `~/.codex/config.toml` URL rewrites to per-launch `-c mcp_servers.slackask.url=...` overrides, and also serializes Codex launch startup as a secondary guard. A fresh post-restart §3.1 rerun showed the corrected launch commands, but could not complete because one Codex session hit the current Codex usage-limit banner and fell back to Claude.

Implementation matches the architectural intent in `docs/ai/tasks/mcp-installmcp-codex.md` with one important divergence: **the stdio proxy path was abandoned in favor of Codex's native streamable HTTP MCP**. That's a fine choice — simpler — but it makes `bin/mcp-stdio-proxy.js` a fallback utility rather than active Codex wiring. Either keep it clearly documented as fallback or delete it later.

---

## 1. Status

| Capability | Status | Where |
|---|---|---|
| `supportsAskUser: true` | ✅ | `codex-adapter.js:159` |
| `askUserGuidance()` returns nudge text | ✅ | `codex-adapter.js:160-180` |
| `installMcp({sessionKey, mcpServerUrl})` returns per-launch `-c` config | ✅ | `codex-adapter.js:360-380` |
| `uninstallMcp()` returns `false` | ✅ | `codex-adapter.js:382-387` |
| Idempotent re-install replaces the block | ✅ | `ensureMcpServerBlockInConfig` regex pattern |
| Legacy global MCP config cleanup | ✅ | removes stale `[mcp_servers.slackask]` and `[mcp_servers.slack-ask]` blocks before launch |
| Hook feature flag setup | ✅ | fresh installs write `[features] hooks = true`; legacy `codex_hooks = true` is still recognized |
| Tests | ✅ | 10/10 focused Codex hook/MCP/serialized-launch cases pass |
| Slack §3.1 E2E | 🟡 | routing race fix deployed; final two-Codex rerun blocked by Codex usage limit |
| Docs matrix updated | ✅ | `docs/mcp-ask-user.md` includes `[mcp_servers.slackask]` and `mcp__slackask__.ask_user` |

---

## 2. What I liked

1. **Native HTTP, no proxy** — Codex's recent MCP support means we can pass the URL directly with `-c mcp_servers.slackask.url=...` and skip the stdio bridge entirely. Simpler than the originally-planned proxy approach. Removes one moving part.
2. **Legacy block cleanup** — install removes stale global `[mcp_servers.slackask]` and `[mcp_servers.slack-ask]` blocks so old installs do not boot a second stale/broken MCP server.
3. **`tomlString()` helper** — escapes backslashes and double-quotes correctly. Future-proof if URLs ever contain those characters.
4. **Test coverage** — 5 MCP cases cover the happy path, TOML preservation, idempotency, slash normalization, and the `supportsAskUser` flag; 3 hook cases cover fresh installs, `hooks=false` upgrade, and legacy `codex_hooks=true` tolerance. Mocked `os.homedir()` so tests don't touch real `~/.codex/`.
5. **Hook compatibility follow-up** — `installHooks()` now writes current Codex `hooks = true`, avoiding the deprecation warning from `codex_hooks` on fresh installs while still recognizing older configs.
6. **Race fixed at source** — the failed §3.1 run proved global URL rewrites were unsafe; per-launch `-c` overrides remove that shared-state dependency.

---

## 3. Concerns

### 🟡 3.1 — Concurrent-session global config race reproduced and fixed, final green blocked by quota

The original implementation rewrote global `~/.codex/config.toml` per tmux session:

```
[mcp_servers.slackask]
url = "http://127.0.0.1:9998/mcp/<sessionKey>"
```

Two `@EnzoBot start codex` mentions arriving close together could both:
1. Read `config.toml`
2. Splice in their own URL (overwriting whatever the other session just wrote)
3. Spawn Codex, which reads the file again

This failed in live Slack:

- Thread A: `1779801630.685949`
- Thread B: `1779801631.381409`
- Failure evidence: Source A's `ask_user` prompt appeared in Thread B, and the other session reported `mcp__slackask__.ask_user is not available`.

Chosen fix: pass the session URL as a per-launch Codex override:

```sh
codex --dangerously-bypass-approvals-and-sandbox \
  -c 'mcp_servers.slackask.url=http://127.0.0.1:9998/mcp/<sessionKey>'
```

The global config blocks are removed as cleanup only; the active URL now lives in the launch command. Codex launches also serialize while MCP startup completes, which avoids startup paste/config overlap during rapid duplicate `start codex` requests.

Post-restart rerun on 2026-05-26 verified the launch shape:

- Thread A: `1779802348.116279`
- Thread B: `1779802350.916879`
- Both launch logs included distinct per-launch overrides:
  - `-c 'mcp_servers.slackask.url=http://127.0.0.1:9998/mcp/C0AJ3JPRA9L-1779802348.116279'`
  - `-c 'mcp_servers.slackask.url=http://127.0.0.1:9998/mcp/C0AJ3JPRA9L-1779802350.916879'`
- The second Codex launch waited for the first MCP startup.
- The run could not prove answer routing because Thread A hit `codex usage limit reached` and EnzoBot fell back to Claude before the `ask_user` prompts could be run in two Codex sessions.

**Final verification to do after restart**:

1. Wait until the bot is mostly idle.
2. From Slack, send `@EnzoBot start codex` in two threads within ~3 seconds of each other.
3. In each thread, send a different `ask_user` prompt with a distinguishable id:
   ```
   @EnzoBot Immediately call mcp__slackask__.ask_user with
   { "questions": [ { "id":"sourceA", "type":"confirm", "question":"Source A — Yes?" } ] }
   ```
   …and:
   ```
   @EnzoBot Immediately call mcp__slackask__.ask_user with
   { "questions": [ { "id":"sourceB", "type":"confirm", "question":"Source B — Yes?" } ] }
   ```
4. Wait for both modals to appear in their respective threads. Tap **Yes** in thread A.
5. **Check**: thread A's Codex echoes `sourceA=yes`. Thread B is still waiting on a tap. Tap Yes in thread B. B echoes `sourceB=yes`.
6. **Cross-failure mode**: if A echoes `sourceB` (or vice versa), or if either MCP tool call returns garbage, the race is still real.
7. Watch `journalctl -u claude-remote --since '5 minutes ago' | grep -iE 'AskUserTool|McpServer'` — confirm each `ask_user: posted question <uuid> for session <key>` log matches the right session id.

### 🟡 3.2 — Tool-name convention is verified but easy to regress

The guidance string at `codex-adapter.js:164,168` uses `mcp__slackask__.ask_user` — with NO dash AND a literal `.` between the server prefix and the tool name.

- `slackask` (no dash) — likely chosen because the TOML key would otherwise need quoting (`[mcp_servers."slack-ask"]`)
- The `.ask_user` (dot separator) — this is **Codex's own convention** for exposing MCP tools to the agent; different from Claude and Gemini, both of which use the double-underscore form `mcp__slack-ask__ask_user`

Verified empirically after switching the live config to a fresh smoke session URL:

```sh
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  --cd /var/go/src/github.com/Claude-Code-Remote \
  "Report whether the MCP tool mcp__slackask__.ask_user is available. Do not call it."
```

Output confirmed:

```text
Yes.
Slackask tools I see:
- mcp__slackask__.ask_user
```

Keep this check in the runbook because it catches future Codex tool-name convention changes.

### 🟡 3.3 — `bin/mcp-stdio-proxy.js` is dead code

The proxy was the originally-planned bridge for Codex (per `docs/ai/tasks/mcp-installmcp-codex.md`). Codex's native HTTP MCP made it unnecessary. The file is still in `bin/`, full implementation, but nothing imports or executes it.

Options:
- **Delete it** — cleanest. Removes ~90 LOC of maintenance surface.
- **Keep with a banner comment** — *"Unused since Codex gained streamable HTTP MCP support (commit 9b17bba). Kept for future stdio fallback if any client drops HTTP transport."* — defensible.
- **Wire it up as a fallback** — only if 3.1 verification fails and we need per-session routing.

I lean toward **delete** unless 3.1 surfaces a real issue.

### 🟡 3.4 — `MCP_SERVER_NAME` is a constant but lives in this file only

`codex-adapter.js:25` defines `const MCP_SERVER_NAME = 'slackask';`. Used at line 369 for the config block. The `askUserGuidance` string at lines 164 and 168 hardcodes `mcp__slackask__.ask_user` instead of deriving from this constant. If the name ever changes, three places need updating.

Tighter:

```js
askUserGuidance() {
    const toolName = `mcp__${MCP_SERVER_NAME}__.ask_user`;
    return [
        '[INTERACTIVE QUESTIONS — IMPORTANT]',
        `When you need to ask the user a clarifying question, invoke the MCP tool \`${toolName}\``,
        // ...
    ].join('\n');
}
```

Or — better — surface `adapter.askUserToolName()` as a separate method and have the prompt-injection layer in `socket.js` use it. Lets `socket.js` log the exact tool name in diagnostic output, and unifies the three adapters' name surface. (See the onboarding plan's "Out of scope" §8 — already flagged as future work.)

---

## 4. Verification checklist (do these before signing off)

- [ ] §3.1 final rerun after Codex usage limit clears — two parallel Codex sessions, confirm answers don't cross-pollinate
- [x] §3.2 tool name — fresh `codex exec` confirmed `mcp__slackask__.ask_user`
- [x] Sanity check that Codex supports per-launch config:
  ```sh
  codex --help
  ```
  Expect `-c, --config <key=value>` to be accepted by the interactive CLI.
- [x] `npx jest tests/channels/slack/serialized-launch.test.js tests/cli/codex-adapter-hooks.test.js tests/cli/codex-adapter-mcp.test.js --runInBand` — 10/10 pass.

---

## 5. Recommended polish (optional, low priority)

| Item | Effort | Value |
|---|---|---|
| Derive `askUserGuidance` tool name from `MCP_SERVER_NAME` | 5 min | Single source of truth |
| Delete `bin/mcp-stdio-proxy.js` or banner-comment it as unused | 2 min | Removes dead code confusion |
| Add `adapter.askUserToolName()` accessor across all three adapters (Claude/Codex/Gemini) | 30 min | Eliminates the tool-name-string footgun called out in §3.5 and the gemini handoff |

---

## 6. Open questions for the implementer

- [x] Was the §3.1 race ever observed in practice, or just argued away? Observed in Slack on 2026-05-26; fixed with per-launch `-c`.
- [ ] Why was the proxy abandoned mid-flight? (Just curiosity — if it was a feature/perf trade-off, document it; if Codex's HTTP MCP just landed and made it moot, that's also fine to note in a comment.)
- [ ] Should `uninstallMcp` ever do anything? Today it's a no-op. The onboarding plan introduces `uninstallMcpGlobal` for full removal — read that file (`docs/ai/tasks/mcp-onboarding-on-fresh-install.md`) before adding a parallel method.
