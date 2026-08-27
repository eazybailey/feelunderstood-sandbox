# Feel Understood — Sandbox v0.1

A test rig for A/B testing two versions of the coach's Source of Truth, built
per `Feel_Understood_Sandbox_Build_Brief_V1.1.md` and then **stripped to the
bare product**: Landing Gate → first name → Communication Helpline, and
nothing else. Everything outside that path has been deleted from the codebase
(not hidden behind a flag — the earlier `SANDBOX = true` rig is gone).
**Nothing here is production**; the live beta lives in
`eazybailey/chatbot-demo` and is untouched by this repo.

## What the app is

1. **Landing Gate** — "Sandbox — testing two versions of the coach." → Start.
2. **Name screen** — first name only. No questionnaire.
3. **Helpline chat** — the full voice pipeline (hands-free realtime STT,
   streamed gapless TTS, barge-in, tap-to-talk/text fallbacks) plus the
   `[[VISUAL]]` two-channel replies. Header: voice-replies toggle, New Chat.
   Footer: version label + a small `start over` link that wipes the device
   (profile + conversations) for hand-off to the next tester.

## The A/B toggle

- Testers see neutral labels only: a `Coach: A | B` pill in the Helpline
  banner. **The blind mapping (do not share with testers): A → `light`,
  B → `deep`.**
  - `light` = the live app's coach prompt. The stripped builder emits
    **byte-identical** output to the live `buildCoachSystemPrompt` for the
    name-only Helpline path (verified against a pre-strip snapshot).
  - `deep` = the same builder with one surgical change: the span between
    `THE DIALOGUE SYSTEM — YOUR SOURCE OF TRUTH:` and `HOW YOU INTERACT:` is
    replaced by SoT V2 Part A + Part B (`docs/SoT_V2.md`, embedded verbatim
    as `SOT_V2_PART_A` / `SOT_V2_PART_B` in `index.html`). The splice runs on
    Light's *output*, so everything outside the spliced span is byte-identical
    between variants by construction.
- Switching mid-conversation always starts a fresh session (clean A/B), with
  a confirm if the current conversation has user turns.
- The choice persists in `localStorage` (`fu_sot_variant`); `?v=a` / `?v=b`
  forces (and persists) the variant, so two links can be sent to two testers
  and each test attributed afterwards.
- Measured sizes (named profile): Light 8,476 chars (~2.1k tokens),
  Deep 46,978 chars (~11.7k tokens). Both clear Anthropic's 1024-token
  prompt-cache minimum.

## Prompt caching

`index.html` sends `system` as a content-block array with
`cache_control: { type: 'ephemeral' }` — required for a fair A/B, since the
Deep block would otherwise add a first-token delay to every Deep reply that
Light never pays. `api/chat-stream.js` relays the array unchanged and logs the
`usage` object from each turn's `message_start` event
(`cache_creation_input_tokens` / `cache_read_input_tokens` — turn 1 should
show creation, turn 2+ reads > 0). Check the Vercel function logs to verify.

## The voice-stack toggle (v0.2)

Two interchangeable voice stacks, cross-combining with the A/B prompt
toggle (2 prompts × 2 stacks). Selected once per page load; the small
`voice: <stack>` footer link switches (fresh conversation + reload), and
`?vs=elevenlabs` / `?vs=current` (or `?vs=e` / `?vs=c`) forces and persists
the choice (`fu_voice_stack`) — same two-links pattern as `?v=`.

- **`elevenlabs` (default)** — ElevenLabs Agents platform over one
  WebSocket: their ASR, end-of-turn detection, barge-in and TTS. The
  agent's LLM is a *custom LLM* pointed at our `/api/eleven-llm` proxy,
  which makes the identical Claude call as `/api/chat-stream` (same model,
  params, variant prompt, prompt caching — check Vercel logs for
  `[eleven-llm] usage:`), so the stacks differ only in ears and mouth.
  `/api/eleven-session` creates/updates the agent programmatically (named
  `feelunderstood-sandbox` in the ElevenLabs workspace — don't hand-edit
  it) and mints the signed WebSocket URL. Known deltas on this stack: the
  `[[VISUAL]]` channel is stripped before TTS and not rendered (no
  VisualAid cards), and the greeting is spoken by the agent on the first
  mic tap rather than on arrival.
- **`current` (control)** — the live app's pipeline, untouched: OpenAI
  Realtime hands-free STT → `/api/chat-stream` → OpenAI TTS.

Conversations are stamped with the active stack in `voiceStack`, and a
saved conversation is never resumed under a different stack (same clean-
test rule as the prompt variant).

## Transcripts

Conversations persist in `localStorage` under `fu_conversations`, each stamped
with `variant`, `variantName`, `sandboxVersion`, and `voiceStack` so blind
tests can be attributed afterwards. There is no in-app export UI — read the
key from DevTools (`localStorage.getItem('fu_conversations')`) on the tester's
device if a transcript is needed.

## What was deleted

The questionnaire flow, Lessons path, Facilitator mode, Basecamp, About &
Insights, the history drawer, dark mode, the dev panel, the service worker and
all PWA scaffolding (manifest, icons), the icon/version scripts, and the
legacy docs (`plan.md`, `docs/SYSTEM_PROMPTS.md`). The original voice
pipeline was left untouched — it is the control condition (`current`) for
the v0.2 voice-stack bake-off, which now ships its first challenger stack
(`elevenlabs`, the default — see "The voice-stack toggle" above).

## Deploying

Import this repo as a **new Vercel project** (own preview URL) with the same
env keys as the live app: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, optional
`GROQ_API_KEY` — plus `ELEVENLABS_API_KEY` for the (default) ElevenLabs
voice stack, and optional `ELEVENLABS_VOICE_ID` to change its voice from
the default (Rachel). No build step. The ElevenLabs agent needs no manual
setup: the first session mint creates and configures it via the API, and
re-points its custom-LLM URL at whatever host served the request.

## Versioning note

The visible version label is `sandbox-0.1`, hardcoded as `SANDBOX_VERSION` in
`index.html`.
