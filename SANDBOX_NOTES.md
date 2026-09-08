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
3. **Helpline chat** — hands-free voice on the ElevenLabs Agents stack
   (one tap opens a continuous session: their ASR, turn-taking, barge-in
   and TTS; the LLM behind the agent is our Claude proxy), with typing as
   the fallback. Header: voice-replies toggle, New Chat.
   Footer: version label + a small `start over` link that wipes the device
   (profile + conversations) for hand-off to the next tester.

## The A/B toggle

- **Both variants' prompt text lives only on the server**, in
  `api/_prompts.js`. The browser sends the profile (`{ name }`) and the
  variant key — never the prompt — so the Source of Truth can't be read
  with View Source or from the network tab. (Before this change the
  builders sat in `index.html`, in plain text for anyone who loaded the
  page.)
- Testers see neutral labels only: a `Coach: A | B` pill in the Helpline
  banner. **The blind mapping (do not share with testers): A → `light`,
  B → `deep`.** It lives in `SOT_VARIANTS` in `api/_prompts.js`; the client
  knows only the keys.
  - `light` = the live app's coach prompt. The stripped builder emits
    **byte-identical** output to the live `buildCoachSystemPrompt` for the
    name-only Helpline path (verified against a pre-strip snapshot).
  - `deep` = the same builder with one surgical change: the span between
    `THE DIALOGUE SYSTEM — YOUR SOURCE OF TRUTH:` and `HOW YOU INTERACT:` is
    replaced by SoT V2 Part A + Part B (`docs/SoT_V2.md`, embedded verbatim
    as `SOT_V2_PART_A` / `SOT_V2_PART_B` in `api/_prompts.js`). The splice runs on
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

`systemBlockFor` in `api/_prompts.js` returns the prompt as a content-block
array with `cache_control: { type: 'ephemeral' }` — required for a fair A/B,
since the Deep block would otherwise add a first-token delay to every Deep
reply that Light never pays. `api/chat-stream.js` builds it from the
`profile` + `variant` the client sends and logs the
`usage` object from each turn's `message_start` event
(`cache_creation_input_tokens` / `cache_read_input_tokens` — turn 1 should
show creation, turn 2+ reads > 0). Check the Vercel function logs to verify.

## The voice stack (v0.2)

One voice stack, the ElevenLabs Agents platform over one WebSocket: their
ASR, end-of-turn detection, barge-in and TTS. The agent's LLM is a
*custom LLM* pointed at our `/api/eleven-llm` proxy, which makes the
identical Claude call as `/api/chat-stream` (same model, params, variant
prompt — built server-side from `fu_profile` + `fu_variant` in the extra
body — and prompt caching; check Vercel logs for `[eleven-llm] variant`), so
the A/B prompt toggle sits behind it unchanged. `/api/eleven-session`
creates/updates the agent programmatically (named `feelunderstood-sandbox`
in the ElevenLabs workspace, plus one `feelunderstood-sandbox [preview:
<branch>]` per preview branch — don't hand-edit them) and mints the signed
WebSocket URL. The `[[VISUAL]]` channel is stripped before TTS and not
rendered on this path (no VisualAid cards), and the greeting is spoken by
the agent on the first mic tap rather than on arrival. A typed message
with no session open goes through `/api/chat-stream` as a text-only turn
(nothing spoken) and reaches the agent on the next session.

The bake-off's control stack — the live app's OpenAI pipeline (`current`:
Realtime hands-free STT → `/api/chat-stream` → OpenAI TTS, with the Web
Speech / MediaRecorder fallbacks) — has been removed from this build,
along with the footer switch, the `?vs=` param and `fu_voice_stack`.
Conversations are still stamped `voiceStack: 'elevenlabs'`, and a saved
conversation stamped by the old stack is never resumed.

## Transcripts

Conversations persist in `localStorage` under `fu_conversations`, each stamped
with `variant` (the neutral key — look the name up in `api/_prompts.js`),
`sandboxVersion`, and `voiceStack` so blind tests can be attributed afterwards. There is no in-app export UI — read the
key from DevTools (`localStorage.getItem('fu_conversations')`) on the tester's
device if a transcript is needed.

## What was deleted

The questionnaire flow, Lessons path, Facilitator mode, Basecamp, About &
Insights, the history drawer, dark mode, the dev panel, the service worker and
all PWA scaffolding (manifest, icons), the icon/version scripts, and the
legacy docs (`plan.md`, `docs/SYSTEM_PROMPTS.md`). The original OpenAI
voice pipeline served as the control condition for the v0.2 voice-stack
bake-off and was removed once the ElevenLabs stack won (see "The voice
stack" above): `api/tts.js`, `api/stt.js`, `api/realtime-session.js` and
the client-side STT/TTS hooks are gone.

## Deploying

Import this repo as a **new Vercel project** (own preview URL) with two
env keys: `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` (`OPENAI_API_KEY` /
`GROQ_API_KEY` are no longer used). The agent's voice and speaking rate are
the `VOICE_ID` / `VOICE_SPEED` constants in `api/eleven-session.js` (no
env override — code is the single source of truth). No build step. The
ElevenLabs agent needs no manual setup: the first session mint creates and
configures it via the API, and re-points its custom-LLM URL at whatever
host served the request.

## Versioning note

The visible version label is `sandbox-0.1`, hardcoded as `SANDBOX_VERSION` in
`index.html`.
