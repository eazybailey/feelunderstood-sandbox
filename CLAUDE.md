# Feel Understood — Sandbox

> **Read `SANDBOX_NOTES.md` first.** This repo is the Sandbox v0.1 A/B test
> rig (see `Feel_Understood_Sandbox_Build_Brief_V1.1.md`), stripped to the
> bare product: Landing Gate → first name → Communication Helpline, with a
> blind A/B toggle between two coach system prompts (`light` vs `deep`).
> Nothing here is production; the live app lives in `eazybailey/chatbot-demo`.

A voice-first web app for practicing better conversations through AI coaching,
built on the "Dialogue System" framework by Gerard Egan and Andrew Bailey —
reduced to the single Helpline path needed to compare Source-of-Truth prompts.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18.3.1 (vendored UMD builds in `/vendor` — no CDN, no build step; app code is plain `React.createElement`, no JSX/Babel) |
| Backend | Vercel Functions — Edge Runtime (`chat-stream`, `eleven-session`, `eleven-llm`) |
| AI | Anthropic Claude API (claude-sonnet-4-6), prompt caching on the system block — same model/params behind the agent and the text fallback |
| Voice | ElevenLabs Agents platform over one WebSocket (their ASR + turn-taking + barge-in + TTS, `eleven_flash_v2`, PCM 16k up / 24k down), custom LLM pointed at `/api/eleven-llm`. The only voice pipeline — the earlier OpenAI control stack has been removed |
| Hosting | Vercel |
| Styling | Vanilla CSS (light theme only) |

## Project Structure

```
feelunderstood-sandbox/
├── api/                       # Vercel serverless endpoints (all Edge Runtime)
│   ├── _prompts.js           # THE SOURCE OF TRUTH — both variants' prompt
│   │                         #   builders. Underscore = not an endpoint;
│   │                         #   imported by chat-stream and eleven-llm.
│   │                         #   Never in index.html (that file is public)
│   ├── chat-stream.js        # Streaming Claude API for the typed no-session
│   │                         #   fallback; builds the system prompt server-
│   │                         #   side from { profile, variant }; logs cache
│   │                         #   usage per turn
│   ├── eleven-session.js     # Ensures/configures the ElevenLabs agent and
│   │                         #   mints a signed conversation WebSocket URL
│   └── eleven-llm.js         # OpenAI-compatible custom-LLM endpoint the
│                             #   ElevenLabs agent calls; relays to Claude
├── vendor/                    # Vendored, pinned React 18.3.1 UMD builds
├── images/                    # favicon-64.png, icon-avatar.svg — nothing else
├── docs/
│   └── SoT_V2.md             # Source text of the Deep variant's SoT block
│                             #   (not served — the SPA rewrite catches it)
├── index.html                # Entire app — single-page React
├── styles.css                # Global styles (light theme)
├── vercel.json               # Clean URLs + SPA rewrites
├── SANDBOX_NOTES.md          # What this rig is and how the A/B works
└── Feel_Understood_Sandbox_Build_Brief_V1.1.md   # Original build brief
```

There is no service worker, no PWA manifest, no build step, and no npm
dependencies. `package.json` exists only to name the project.

## App Flow

```
Landing Gate ("Sandbox — testing two versions of the coach") → Start
  → Name screen (first name only)
  → Helpline chat (greeting spoken via gapless PCM; mic off until first tap)
```

Returning visitors (saved profile/conversation in localStorage) skip the gate
straight into the chat. The footer `start over` link wipes profile +
conversations for hand-off between testers.

## The A/B Source of Truth toggle

- **The prompt text lives only on the server**, in `api/_prompts.js`. The
  browser sends `{ profile: { name }, variant: 'A' | 'B' }` to
  `/api/chat-stream`, and `fu_profile` + `fu_variant` in the ElevenLabs
  extra body to `/api/eleven-llm`; both build the prompt there. Nothing in
  `index.html` or in any network request carries the Source of Truth, so it
  can't be read with View Source or the network tab. Keep it that way: never
  move prompt prose back into `index.html`.
- `SOT_VARIANTS` in `api/_prompts.js`: `A → light`, `B → deep` — **blind
  mapping, never shown to testers**, who only see the `Coach: A | B` pill in
  the Helpline banner. The client knows only the keys (`SOT_VARIANT_KEYS`).
- `light` = `buildCoachSystemPromptLight` — emits byte-identical output to the
  live app's `buildCoachSystemPrompt` for the name-only Helpline path.
- `deep` = `buildCoachSystemPromptDeep` — runs Light, then replaces the span
  between `THE DIALOGUE SYSTEM — YOUR SOURCE OF TRUTH:` and
  `HOW YOU INTERACT:` with `SOT_V2_PART_A` + `SOT_V2_PART_B` (embedded
  verbatim from `docs/SoT_V2.md`). Everything outside the spliced span is
  byte-identical between variants by construction — **the test isolates the
  Source of Truth block and nothing else. Preserve this invariant in any
  change to the prompt code.**
- Switching variants always starts a fresh conversation (confirm shown if the
  chat has user turns). Choice persists in `localStorage`; `?v=a` / `?v=b`
  forces and persists it (send two links, attribute tests afterwards).
- **Prompt caching is load-bearing**: `systemBlockFor` in `api/_prompts.js`
  returns the prompt as
  `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]` so the
  ~47k-char Deep prompt doesn't add a first-token delay Light never pays.
  Both endpoints send that block and log
  `cache_creation_input_tokens` / `cache_read_input_tokens` per turn — turn 1
  creation, turn 2+ reads > 0 is the proof it works.

## Voice Stack

There is one voice pipeline: the ElevenLabs Agents stack. `VOICE_STACK`
in `index.html` is a fixed `'elevenlabs'` stamp on transcripts (a saved
conversation stamped by the retired OpenAI stack is never resumed). The
earlier v0.2 bake-off's OpenAI control stack (`current`: Realtime STT →
`/api/chat-stream` → OpenAI TTS, with Web Speech / MediaRecorder
fallbacks) and its endpoints (`tts`, `stt`, `realtime-session`) have been
removed, along with the footer switch and the `?vs=` param.

### How a session runs

```
User taps mic ONCE → POST /api/eleven-session
  (finds-or-creates this deployment's agent — "feelunderstood-sandbox"
   on production, "feelunderstood-sandbox [preview: <branch>]" on a
   preview — re-asserts its config — custom-LLM URL derived from the
   request host — and mints a signed WebSocket URL; agent auth is enabled
   so the signed URL is the only way in)
  → browser opens wss to ElevenLabs (raw protocol, no SDK), sends the
    profile + variant key + prior history via custom_llm_extra_body
    (fu_profile / fu_variant / fu_history — never the prompt text) and
    the greeting via first_message; mic PCM16@16k streams up via
    ScriptProcessor
  → ElevenLabs runs ASR, end-of-turn and barge-in server-side, and calls
    our /api/eleven-llm (OpenAI chat-completions shape) for every turn
  → /api/eleven-llm rebuilds the exact chat-stream Claude call (the variant
    prompt built from fu_profile + fu_variant by api/_prompts.js, with
    cache_control; fu_history + session turns merged), streams
    back OpenAI-format SSE, and strips the [[VISUAL]] channel so it is
    never spoken (known delta: no VisualAid cards on this stack)
  → agent PCM16@24k streams down and is spliced gaplessly onto the shared
    AudioContext timeline; user_transcript / agent_response events mirror
    into the conversation state
```

The agent speaks the on-screen greeting itself on the first tap
(`first_message` override); typed messages go into a live session as
`user_message` events, or — when no session is open — fall back to a
text-only turn through `/api/chat-stream` (nothing is spoken; the turn
reaches the agent on the next session via `fu_history`).

The hands-free session self-heals (reconnect budget with backoff,
visibility rebuild, mic-track death detection). A header toggle
(`fu_voice_muted`) drops the agent's audio so replies land as text only.
See the inline comments in `index.html` for the reliability knobs — they
are all deliberate.

### Two-Channel Replies (spoken vs shown)

Claude's replies split on a literal `[[VISUAL]]` marker: prose before it is
the spoken channel; markdown after it is a `VisualAid` card. On the agent
path `/api/eleven-llm` strips the visual channel so it is never spoken (no
cards). The text fallback renders it: the streaming client holds back
partial markers (`[[VIS` never flashes as text), stores messages as
`{ content, visual }`, and reassembles `content + [[VISUAL]] + visual`
when sending history back to Claude.

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat-stream` | Streams Claude as simplified SSE (`data: {text}`, `data: [DONE]`) for the typed no-session fallback; body is `{ messages, profile, variant, max_tokens }` — the system prompt is built server-side (a client-sent `system` is ignored); clamps `max_tokens` to 1000; logs cache usage |
| `POST /api/eleven-session` | Ensures + configures this deployment's ElevenLabs agent (one per production / preview branch, idempotent by name; always re-patched so the custom-LLM URL tracks the deployment host), mints a signed conversation WebSocket URL |
| `POST /api/eleven-llm` | OpenAI-compatible `/chat/completions` for the ElevenLabs agent (rewrite maps `/api/eleven-llm/chat/completions` here); auth via `x-fu-proxy-token`, an SHA-256 derivation of `ELEVENLABS_API_KEY` set on the agent config; builds the variant prompt from `fu_profile` + `fu_variant` in the extra body (the system message ElevenLabs sends is ignored) and relays to Claude with the same params + caching as chat-stream, logging usage as `[eleven-llm]` |

All endpoints are same-origin only (no CORS headers — deliberate), except
`/api/eleven-llm`, which is called server-to-server by ElevenLabs and gated
by the shared-secret header instead.

## State & Storage

React `useState`/`useRef` only. localStorage keys: `fu_conversations` (capped
at 50, each stamped with `variant` (the neutral key only — the mapping is
server-side), `sandboxVersion`, `voiceStack`), `fu_active_conversation`, `fu_profile` (`{ name }`),
`fu_voice_muted`, `fu_sot_variant`. Greeting-only conversations are never
persisted. There is no history UI — transcripts are read from localStorage
via DevTools when needed.

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...   # Required — Claude (chat-stream, eleven-llm)
ELEVENLABS_API_KEY=...         # Required — the voice stack
VERCEL_AUTOMATION_BYPASS_SECRET=...   # Injected by Vercel when "Protection Bypass
                               #   for Automation" is on — lets ElevenLabs reach
                               #   /api/eleven-llm on protected preview deployments
```

The agent's voice is the `VOICE_ID` constant in `api/eleven-session.js` —
deliberately not an env var (a forgotten override made voice changes look
like they didn't take).

## Development Notes

- No build step — edit `index.html` / `styles.css` and deploy.
- **`index.html` is public; `api/` is not.** Anything that must stay private
  (the Source of Truth, the A/B mapping) lives under `api/` — `_prompts.js`
  is the only place prompt prose belongs. `api/_prompts.js` is a shared
  module (underscore-prefixed files in `api/` are not deployed as functions)
  imported by the two Claude endpoints.
- The visible version label is `SANDBOX_VERSION` in `index.html`
  (`sandbox-0.1`), hardcoded.
- **Do not** reintroduce per-turn-dynamic content into the system prompt
  builders (timestamps, counters) — it would kill every prompt-cache hit and
  contaminate the A/B latency comparison.
- v0.2 status: the ElevenLabs stack (Agents platform + `/api/eleven-llm`
  custom-LLM proxy, per the brief §3) is the only voice stack; the OpenAI
  control stack was removed after the bake-off. The A/B prompt toggle sits
  behind the proxy, so it knows nothing about the voice layer. Hume (EVI,
  same custom-LLM pattern) is still to come.
- The ElevenLabs agents are created/updated programmatically by
  `api/eleven-session.js` — don't hand-edit them in the ElevenLabs
  dashboard; the next session mint re-asserts the coded config (the PATCH
  merges, so every tts field the code cares about — voice, speed — must be
  named there to hold). Production and each preview branch get their own
  agent, so testing a preview never re-points production's brain.
- Preview deployments are behind Vercel Deployment Protection, which
  ElevenLabs' servers can't pass; enable "Protection Bypass for
  Automation" in the Vercel project settings and the session mint adds the
  bypass header to the agent's custom-LLM callback automatically.
