# Feel Understood — Sandbox Build Brief V1.1

**For:** Claude Code, working in the `chatbot-demo` repo
**From:** Eazy Bailey / Claude (AI collaborator)
**Goal:** a stripped-back test environment, live in ~40 minutes, for A/B testing two versions of the Source of Truth — with the voice layer staged for stack comparisons next.

**Changed in V1.1:** variant mapping corrected (Light = current prompt; Deep = the new SoT V2 document, supplied); Deep splice instructions added; prompt caching promoted from v0.2 into this build — it is required for a fair A/B, not an optimisation.

---

## 1. What this is

A fork of the current web app (v2.5.x), reduced to a single path: **name → Helpline**, with a switch that toggles the coach between two system-prompt variants. Testers are Eazy (developer) and the client (Adrian, Andrew). Nothing here is production; it is a rig for listening to the difference between prompts and, in v0.2, between voice stacks.

**Do not rebuild anything.** The existing **Landing Gate beta path already does 80% of this** — name-only entry, straight into Helpline, questionnaire skipped, no-questionnaire appendix applied. Start from it.

---

## 2. Sandbox v0.1 — build now (~40 min)

### 2.1 Fork, don't branch the live app

- Duplicate the repo (or a `sandbox/` Vercel project from a branch) so the sandbox deploys to its **own Vercel preview URL** with the same env keys. The live beta must be untouched.
- **Disable the service worker** in the sandbox (comment out registration) or bump the cache name to `sandbox-v1` — stale-cache confusion mid-test is the classic time thief.
- Bump the visible version string to `sandbox-0.1` so every screenshot self-identifies.
- Commit the supplied SoT V2 document into the repo as `docs/SoT_V2.md` for traceability.

### 2.2 Strip list

Remove or hide (prefer hiding via a `SANDBOX = true` const over deleting — easier to diff later):

- Basecamp, Lessons path, Facilitator path, mode cards, questionnaire flow
- Casebook / progress, About & Insights pages, drawer modes section
- PWA install prompts

Keep: Landing Gate (reworded lede is fine: *"Sandbox — testing two versions of the coach."*), the Helpline chat screen, the full voice pipeline, transcript storage.

### 2.3 The A/B Source of Truth toggle

**The two variants:**

- **LIGHT** = the current `buildCoachSystemPrompt` **verbatim, untouched**. Wrap or rename it `buildCoachSystemPromptLight`; change zero characters of its text. This is the incumbent.
- **DEEP** = a copy of the same builder with one surgical change — the SoT V2 splice below. Everything outside the spliced span must remain byte-identical to Light. **The test must isolate the Source of Truth block and nothing else.**

**The Deep splice** (source: `docs/SoT_V2.md`, which carries its own placement notes):

1. Embed the V2 text as two constants, `SOT_V2_PART_A` and `SOT_V2_PART_B` (JS template literals — scan the text for backticks or `${` before pasting; none are expected, but one stray backtick costs ten minutes).
2. **Part A** replaces everything between the line `THE DIALOGUE SYSTEM — YOUR SOURCE OF TRUTH:` and the line `HOW YOU INTERACT:` in the current builder.
3. **Part B** is inserted **immediately before `HOW YOU INTERACT:`**, directly after Part A. (The doc's intro also mentions "after KEY PRINCIPLES" — both placement notes agree on the before-HOW-YOU-INTERACT anchor, so splice on that anchor and verify against whatever the live builder actually contains between those markers. If anything between the markers looks like it should survive — flag it, don't guess.)
4. The V2 text is deliberately **plain text, voice-first** — no markdown, hyphens and numbers only. Paste as-is, preserve line breaks, do not reformat or "tidy".

**Mechanism.** In `index.html`, next to the builders:

```js
const SOT_VARIANTS = {
  A: { name: 'A', build: /* one of the two */ },
  B: { name: 'B', build: /* the other */ },
};
```

`buildSystemPrompt` dispatch reads the active variant from state and calls its `build`. Everything else (per-turn rebuild, 24-message window, `max_tokens: 700`, `[[VISUAL]]` history reassembly) stays exactly as is.

**UI.** A small pill in the mode banner: `Coach: A | B`.

- **Neutral labels only.** Testers see A and B — never "Light"/"Deep". The A↔variant mapping lives in code and in the dev-only readout (2.5). This keeps the client test blind.
- Switching mid-conversation prompts: *"Switch to Version B? This starts a fresh conversation."* Default = fresh session (clean A/B). A dev-only "keep transcript" override is allowed, since the prompt is rebuilt every turn anyway — occasionally useful, never the default.
- Persist choice in `localStorage`; also honour a URL param **`?v=a` / `?v=b`** so Eazy can send Adrian and Andrew two links and know exactly what each of them tested.

**Stamping.** Every stored/exported transcript gets a header: variant label, resolved variant name, sandbox version, voice stack id, timestamp. Blind tests are worthless if we can't attribute them afterwards.

### 2.4 Prompt caching — required in this build

The Deep block is ~5,000 words (~7k tokens) resent on **every turn**. Uncached, that does two things: burns tokens, and — the one that actually matters — adds a first-token delay to every Deep reply that Light never pays. In a voice product, testers will hear that as "the Deep coach is slower" and attribute it to the writing. **Caching removes the confound. Without it, the A/B is contaminated before it starts.** (It is also already flagged as a pre-ship priority for the real app — this build is the rehearsal.)

How it works, in one paragraph: Anthropic caches the *processed* system block for a rolling 5-minute window, refreshed on every hit. The prefix must be byte-identical between requests — ours is, since the builder is deterministic per profile. Cache hits bill at ~10% of input price and return first tokens materially faster; the first turn pays a 1.25× write surcharge. Minimum cacheable size is 1024 tokens — both variants clear it (if one didn't, it silently doesn't cache; no error).

Implementation:

1. Send `system` as a content-block array, not a string:
   ```js
   system: [{ type: 'text', text: systemString, cache_control: { type: 'ephemeral' } }]
   ```
   No beta header needed — prompt caching is GA.
2. Verify `/api/chat-stream` relays the array-form `system` to Anthropic unchanged (it passes the body through today; confirm nothing coerces it to a string).
3. Confirm **nothing per-turn-dynamic lives inside the builder output** (timestamps, turn counters). If anything does, move it after the cached block or into the first user message — dynamic content anywhere in the prefix kills every cache hit.
4. Each variant caches independently (different prefixes, different cache entries). Switching variants = one fresh cache write. Expected, fine.
5. **Verification readout:** in `chat-stream.js`, `console.log` the `usage` object from the stream's `message_start` event (`cache_creation_input_tokens`, `cache_read_input_tokens`). Turn 1 should show creation; turn 2 onwards should show reads > 0. This is the proof the whole thing is working.

### 2.5 Voice in v0.1

**No changes.** Current cascade stands: SpeechRecognition / `/api/stt` → `/api/chat-stream` → `/api/tts` (OpenAI `tts-1`, `shimmer`). It is the control condition for the stack bake-off later. The realtime/hands-free path stays on whatever it currently uses.

### 2.6 Dev panel

Reuse the hidden `· dev ·` link pattern from the Landing Gate. Dev view shows: A/B → variant mapping, active voice stack, model id, prompt character count for each variant (Deep should read ≈30k characters heavier than Light — instant sanity check on the splice), cache status from the last turn if surfaced, and a "copy transcript with header" button.

### 2.7 v0.1 acceptance checklist

1. Sandbox URL loads Landing Gate; name entry lands directly in Helpline.
2. No route into Basecamp, Lessons, Facilitator, Casebook, or questionnaire.
3. A/B pill visible; switching offers fresh start; choice survives reload.
4. `?v=a` and `?v=b` links force the variant.
5. Light variant char count matches the live app's prompt exactly.
6. Deep variant char count ≈ Light + ~30k chars; spot-check the splice boundaries (`...YOUR SOURCE OF TRUTH:` opens Part A; Part B ends immediately before `HOW YOU INTERACT:`).
7. Server logs show cache creation on turn 1, cache reads > 0 from turn 2, for **both** variants.
8. Voice round-trip works as on live.
9. Transcript export carries the stamp header.
10. Live beta app untouched and still deployed; service worker disabled / cache renamed in the sandbox.

---

## 3. Sandbox v0.2 — staged next (not today)

Per the voice research (§10): abstract the voice layer behind **one internal interface** — `startSession / stopSession / sendUserAudio / onText / onAudio / onEvent` — then implement adapters:

1. **`current`** — today's cascade, wrapped first (proves the interface).
2. **`elevenlabs`** — Agents platform, custom-LLM endpoint pointed at our own Claude proxy so the Dialogue System prompt, key and A/B logic stay server-side.
3. **`hume`** — EVI, same custom-LLM pattern.

The A/B prompt toggle must sit **behind** the custom-LLM proxy so prompt variants and voice stacks cross-combine (2 prompts × N stacks) without either knowing about the other. Add a second dev-panel selector: `Voice: current | elevenlabs | hume`. Same 10-minute scripted scenario across all cells; blind-test axes from the research: warmth, feeling heard, latency comfort, method adherence, measured cost/session.

(Prompt caching was the other no-regret item from the research — it ships in v0.1 above.)

---

## 4. Out of scope — do not build

Accounts, Casebook, questionnaire, syllabus/lesson content, Facilitator, payments/allowance, app-store anything, analytics beyond the transcript stamp, visual redesign. The sandbox looks like the current app with bits missing. That is correct.

---

## 5. Order of work (target: ~40 min)

1. Fork/deploy sandbox project, kill service worker, bump version, commit `docs/SoT_V2.md` — *5 min*
2. `SANDBOX` flag + strip list — *5 min*
3. Deep builder: embed Part A/B constants, splice, verify boundaries — *10 min*
4. `SOT_VARIANTS` + dispatch + A/B pill, fresh-session switch, `localStorage`, `?v=` param — *10 min*
5. Prompt caching: array-form system + relay check + usage logging — *5 min*
6. Transcript stamp + dev panel readout — *5 min*
7. Run the acceptance checklist. Ship the preview URL.
