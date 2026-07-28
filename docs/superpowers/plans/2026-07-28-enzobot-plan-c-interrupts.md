# EnzoBot Plan C — Tiered Interrupts + One-Mind Glue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the Entity speak the moment something matters (filtered so it rarely does), keep the companion aware of its own hands, and let it introspect live sessions.

**Repository:** `Claude-Code-Remote` (Node.js). No other repo.

**Provider APIs:** **ONE cheap call.** The Tier-2 classifier is a per-event LLM call using the EXISTING `@anthropic-ai/claude-agent-sdk` dependency (the same one `daily-summary.js` uses), authenticated by Claude Code (no `ANTHROPIC_API_KEY`, no new SDK). Use a small model (`claude-haiku-4-5`). It only runs on the ~10% of events that survive the free Tier-1 heuristic, and a per-hour cap bounds cost. Tier-1 and the glue features make NO provider calls.

**Depends on:** Plan B (companion + `_injectCompanionPrompt`). Tier-3 (companion judgment) is v1.5.

**Architecture:** A funnel in the existing `message` listener — Tier-1 pure heuristics kill ~90%, Tier-2 cheap classifier kills ~9%, survivors DM the owner (v1) or inject into the companion (v1.5). Plus lifecycle whispers (session start/stop → companion) and an introspection skill (companion reads its own live panes).

**Read first:** `src/channels/slack/socket.js` `_setupListeners` (the `message` handler ~1608), `src/services/daily-summary.js` (`summarizeWithClaude` — the Agent SDK usage pattern to copy), `src/cli/*-adapter.js` (`workingIndicators`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/services/interrupt-tier1.js` (new) | Pure heuristics: event → keep/kill + reason |
| `src/services/interrupt-tier2.js` (new) | Cheap classifier via Agent SDK (the one provider call) |
| `src/services/interrupt-cap.js` (new) | Per-hour DM cap (in-memory ring) |
| `src/channels/slack/socket.js` (modify) | Wire the funnel into the message listener; lifecycle whispers |
| `companion/skills/introspect/SKILL.md` (new) | Companion reads its own live panes |
| `.env.example` (modify) | `INTERRUPTS_ENABLED`, `INTERRUPT_MAX_PER_HOUR`, `INTERRUPT_MODEL` |

---

### Task 1: Tier-1 heuristics (pure, free)

**Files:** Create `src/services/interrupt-tier1.js`; Test `tests/services/interrupt-tier1.test.js`

- [ ] **Step 1: Failing test**

```js
// tests/services/interrupt-tier1.test.js
const { tier1 } = require('../../src/services/interrupt-tier1');
const OWNER = 'U0OWNER';
const cfg = { ownerUserId: OWNER, ownPrRepos: [], incidentChannels: ['C0INC'], watchedTopics: ['tax'] };
describe('tier1', () => {
  test('keeps a message mentioning the owner', () => {
    const r = tier1({ text: `<@${OWNER}> can you look?`, channel: 'C0X', user: 'U0A' }, cfg);
    expect(r.keep).toBe(true); expect(r.reason).toMatch(/mention/i);
  });
  test('keeps a message in an incident channel', () => {
    expect(tier1({ text: 'db down', channel: 'C0INC', user: 'U0A' }, cfg).keep).toBe(true);
  });
  test('keeps a watched-topic hit', () => {
    expect(tier1({ text: 'EG tax rounding is off', channel: 'C0X', user: 'U0A' }, cfg).keep).toBe(true);
  });
  test('kills ordinary chatter', () => {
    expect(tier1({ text: 'lunch?', channel: 'C0X', user: 'U0A' }, cfg).keep).toBe(false);
  });
  test('kills the owner’s own messages', () => {
    expect(tier1({ text: 'anything', channel: 'C0X', user: OWNER }, cfg).keep).toBe(false);
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/services/interrupt-tier1.js`

```js
/**
 * Tier-1 interrupt heuristics — pure, free, kills ~90%. Returns {keep, reason}.
 * Only events that pass here reach the (paid) Tier-2 classifier.
 */
function tier1(event, cfg) {
  const { text = '', channel, user } = event;
  if (!user || user === cfg.ownerUserId) return { keep: false, reason: 'self/no-user' };
  if (new RegExp(`<@${cfg.ownerUserId}>`).test(text)) return { keep: true, reason: 'mentions you' };
  if ((cfg.incidentChannels || []).includes(channel)) return { keep: true, reason: 'incident channel' };
  const topics = cfg.watchedTopics || [];
  const hit = topics.find(t => t && text.toLowerCase().includes(t.toLowerCase()));
  if (hit) return { keep: true, reason: `watched topic: ${hit}` };
  // (own-PR state changes arrive as GitHub events, handled by Plan D's sweep, not here)
  return { keep: false, reason: 'no signal' };
}
module.exports = { tier1 };
```

- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 2: Tier-2 classifier (the one provider call)

**Files:** Create `src/services/interrupt-tier2.js`; Test `tests/services/interrupt-tier2.test.js` (mock the SDK).

- [ ] **Step 1: Failing test** (inject a fake `query` so no real API call in tests)

```js
// tests/services/interrupt-tier2.test.js
const { classify } = require('../../src/services/interrupt-tier2');
describe('classify', () => {
  test('parses a YES verdict from the model', async () => {
    const fakeQuery = async function* () { yield { type: 'result', result: 'YES — blocks the CKO release' }; };
    const r = await classify({ text: 'release blocked', context: '' }, { query: fakeQuery, model: 'm' });
    expect(r.needsOwner).toBe(true);
    expect(r.why).toContain('CKO');
  });
  test('parses a NO verdict', async () => {
    const fakeQuery = async function* () { yield { type: 'result', result: 'NO' }; };
    const r = await classify({ text: 'fyi', context: '' }, { query: fakeQuery, model: 'm' });
    expect(r.needsOwner).toBe(false);
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `src/services/interrupt-tier2.js` (copy the SDK call shape from `daily-summary.js` `summarizeWithClaude`)

```js
/**
 * Tier-2 interrupt classifier. ONE cheap LLM call via @anthropic-ai/claude-agent-sdk
 * (Claude Code auth, no API key). Small model. Only runs on Tier-1 survivors.
 * `deps.query` is injectable for tests.
 */
const PROMPT = (text, context) => `You decide if a Slack message needs Enzo's attention
BEFORE his next scheduled brief, or if it can wait. Answer "YES — <5-word reason>" or "NO".
Message: ${text}
Context: ${context || '(none)'}`;

async function classify({ text, context }, deps = {}) {
  const query = deps.query || require('@anthropic-ai/claude-agent-sdk').query;
  const model = deps.model || process.env.INTERRUPT_MODEL || 'claude-haiku-4-5';
  let out = '';
  for await (const m of query({ prompt: PROMPT(text, context),
      options: { model, permissionMode: 'bypassPermissions', maxTurns: 1 } })) {
    if (m.type === 'result') out = m.result || '';
  }
  const yes = /^\s*YES/i.test(out);
  return { needsOwner: yes, why: out.replace(/^\s*(YES|NO)\s*[—-]?\s*/i, '').trim() };
}
module.exports = { classify };
```

- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 3: Per-hour cap

**Files:** Create `src/services/interrupt-cap.js`; Test `tests/services/interrupt-cap.test.js`

- [ ] **Step 1: Failing test**

```js
// tests/services/interrupt-cap.test.js
const { InterruptCap } = require('../../src/services/interrupt-cap');
describe('InterruptCap', () => {
  test('allows up to N per hour then blocks', () => {
    let now = 1_000_000;
    const cap = new InterruptCap(2, () => now);
    expect(cap.allow()).toBe(true);
    expect(cap.allow()).toBe(true);
    expect(cap.allow()).toBe(false);
    now += 3_600_001;
    expect(cap.allow()).toBe(true);
  });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (a timestamp ring; `now` injectable):

```js
class InterruptCap {
  constructor(maxPerHour, nowFn = Date.now) { this.max = maxPerHour; this.now = nowFn; this.ts = []; }
  allow() {
    const cut = this.now() - 3_600_000;
    this.ts = this.ts.filter(t => t > cut);
    if (this.ts.length >= this.max) return false;
    this.ts.push(this.now()); return true;
  }
}
module.exports = { InterruptCap };
```

- [ ] **Step 4:** Run → PASS. Commit.

---

### Task 4: Wire the funnel + lifecycle whispers into socket.js

**Files:** Modify `src/channels/slack/socket.js`.

- [ ] **Step 1:** Require the three modules; construct `this._interruptCap = new InterruptCap(Number(process.env.INTERRUPT_MAX_PER_HOUR||6))` in the constructor.
- [ ] **Step 2:** In the `message` listener (~1608), after existing handling, add (guarded by `process.env.INTERRUPTS_ENABLED === 'true'` and only for non-owner, non-DM channel messages):

```js
        if (process.env.INTERRUPTS_ENABLED === 'true') {
          try {
            const t1 = tier1(event, {
              ownerUserId: this.config.ownerUserId,
              incidentChannels: (this.alertMonitor?.channelIds) || [],
              watchedTopics: (process.env.INTERRUPT_TOPICS || '').split(',').map(s => s.trim()).filter(Boolean),
            });
            if (t1.keep && this._interruptCap.allow()) {
              const t2 = await classify({ text: event.text || '', context: t1.reason });
              if (t2.needsOwner) {
                const dm = await this.app.client.conversations.open({ users: this.config.ownerUserId });
                const link = await this._getPermalink(event.channel, event.ts).catch(() => null);
                await this.app.client.chat.postMessage({
                  channel: dm.channel.id, unfurl_links: false, unfurl_media: false,
                  text: `:zap: ${t2.why || t1.reason}${link ? ` — ${link}` : ''}`,
                });
              }
            }
          } catch (err) { this.logger.warn(`interrupt funnel: ${err.message}`); }
        }
```

- [ ] **Step 3:** Lifecycle whispers — in `_saveSession` (session created) and `_deleteSession` (session ended), if `companionEnabled`, fire-and-forget a one-line inject into the companion:

```js
        if (process.env.COMPANION_ENABLED === 'true' && !isCompanionKey(sessionKey)) {
          this._injectCompanionPrompt(`(whisper) Hand update: session ${sessionName} ${verb} in ${repoOrChannel}.`)
            .catch(() => {}); // never block session lifecycle on a whisper
        }
```

(Guard against recursion: never whisper about the companion's own key.)

- [ ] **Step 4:** `npm test` → green. Commit.

---

### Task 5: Introspection skill

**Files:** Create `companion/skills/introspect/SKILL.md`. No code — the companion already runs on the VPS alongside the tmux sessions and can reach the Mac's herdr over the agreed link (Plan D's herdr, or via a job).

- [ ] **Step 1:** Write the skill:

```markdown
---
name: introspect
description: Answer "how's X going?" from the live pane of a hand, mid-task
---
# Introspect a live hand
When Enzo asks how a running job/session is going:
1. Find the session: VPS tmux → `tmux list-sessions`; the target's name is in the
   agenda/job it came from. Mac herdr jobs → `node $ENZOBOT_REPO/scripts/jobs-cli.js list`.
2. Read the live pane:
   - VPS tmux: `tmux capture-pane -pt <session> -S -80`
   - Mac herdr: the job's pane id → `herdr pane read <id> --source recent-unwrapped --lines 80`
     (only if the herdr link is available; otherwise report last known job status).
3. Summarize what it's doing RIGHT NOW in one or two lines — not the whole log.
   Never inject into or disturb the pane; read-only.
```

- [ ] **Step 2:** Commit.

---

### Task 6: Env + live verification

**Files:** Modify `.env.example`.

- [ ] **Step 1:** Add:

```bash
# ── Entity Plan C: interrupts ───────────────────────────────
INTERRUPTS_ENABLED=false
INTERRUPT_MAX_PER_HOUR=6
INTERRUPT_MODEL=claude-haiku-4-5
INTERRUPT_TOPICS=tax,settlement,cko
```

- [ ] **Step 2: Precision gate before going live.** Collect ~50 recent real channel messages, label them (would you want a ping? yes/no), run them through `tier1`→`classify`, and measure precision (pings sent that you'd have wanted). **Do not enable pings in production until precision ≥ 80%** — tune `INTERRUPT_TOPICS` and the Tier-2 prompt first. Record the number in the commit message.
- [ ] **Step 3:** Live: enable, make your own test PR go CI-red or post a watched-topic message from another account → a single DM ping arrives within ~1 min with the reason + permalink. Ask the companion "what are you doing?" during a live job → introspect skill quotes the pane.
- [ ] **Step 4:** Commit + push.

---

## Self-review notes
- Provider APIs: exactly one — the Tier-2 classifier, reusing the existing Agent SDK dep, small model, Tier-1-gated + per-hour-capped. Everything else is pure code.
- The precision gate (Task 6 Step 2) is a hard prerequisite to avoid noise — the design's whole promise is "rarely, with intent."
- Type consistency: `tier1` returns `{keep, reason}`; `classify` returns `{needsOwner, why}`; the funnel uses `reason` as `classify` context and `why` as the ping text.
