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
| Backend | Vercel Functions — Edge Runtime (`chat-stream`, `tts`, `stt`, `realtime-session`, `eleven-session`, `eleven-llm`) |
| AI | Anthropic Claude API (claude-sonnet-4-6), prompt caching on the system block — same model/params on both voice stacks |
| Voice (default: `elevenlabs`) | ElevenLabs Agents platform over one WebSocket (their ASR + turn-taking + barge-in + TTS, `eleven_flash_v2`, PCM 16k up / 24k down), custom LLM pointed at `/api/eleven-llm` |
| Voice (control: `current`) | TTS: OpenAI (`tts-1`, `shimmer`) streamed as raw PCM, MP3 fallback. STT primary: OpenAI Realtime over WebRTC (`gpt-4o-mini-transcribe`, server VAD, hands-free); fallbacks: native Web Speech API, then MediaRecorder → `/api/stt` (Groq `whisper-large-v3-turbo` when only `GROQ_API_KEY` is set) |
| Hosting | Vercel |
| Styling | Vanilla CSS (light theme only) |

## Project Structure

```
feelunderstood-sandbox/
├── api/                       # Vercel serverless endpoints (all Edge Runtime)
│   ├── chat-stream.js        # Streaming Claude API; relays array-form system
│   │                         #   prompt unchanged; logs cache usage per turn
│   ├── realtime-session.js   # Mints ephemeral OpenAI Realtime client secrets
│   ├── eleven-session.js     # Ensures/configures the ElevenLabs agent and
│   │                         #   mints a signed conversation WebSocket URL
│   ├── eleven-llm.js         # OpenAI-compatible custom-LLM endpoint the
│   │                         #   ElevenLabs agent calls; relays to Claude
│   ├── tts.js                # OpenAI TTS — PCM streaming or MP3
│   └── stt.js                # Audio transcription (OpenAI; Groq fallback)
├── vendor/                    # Vendored, pinned React 18.3.1 UMD builds
├── images/                    # favicon-64.png, icon-avatar.svg — nothing else
├── docs/
│   └── SoT_V2.md             # Source text of the Deep variant's SoT block
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

- `SOT_VARIANTS` in `index.html`: `A → light`, `B → deep` — **blind mapping,
  never shown to testers**, who only see the `Coach: A | B` pill in the
  Helpline banner.
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
- **Prompt caching is load-bearing**: the client sends `system` as
  `[{ type: 'text', text, cache_control: { type: 'ephemeral' } }]` so the
  ~47k-char Deep prompt doesn't add a first-token delay Light never pays.
  `api/chat-stream.js` relays it unchanged and logs
  `cache_creation_input_tokens` / `cache_read_input_tokens` per turn — turn 1
  creation, turn 2+ reads > 0 is the proof it works.

## Voice Stacks (v0.2 bake-off)

Two stacks, selected by `VOICE_STACK` in `index.html` (default
`elevenlabs`): persisted in `localStorage` (`fu_voice_stack`), forced via
`?vs=elevenlabs` / `?vs=current` (also `?vs=e` / `?vs=c`), and switchable
from the small `voice: <stack>` footer link (always a fresh conversation +
page reload — stacks never mix within one transcript, and a saved
conversation stamped with the other stack is never resumed). Both stacks
share the identical brain: same model, params, variant system prompt and
prompt caching — only the ears and mouth differ.

### `elevenlabs` (default)

```
User taps mic ONCE → POST /api/eleven-session
  (finds-or-creates the "feelunderstood-sandbox" agent, re-asserts its
   config — custom-LLM URL derived from the request host — and mints a
   signed WebSocket URL; agent auth is enabled so the signed URL is the
   only way in)
  → browser opens wss to ElevenLabs (raw protocol, no SDK), sends the
    variant prompt + prior history via conversation overrides /
    custom_llm_extra_body; mic PCM16@16k streams up via ScriptProcessor
  → ElevenLabs runs ASR, end-of-turn and barge-in server-side, and calls
    our /api/eleven-llm (OpenAI chat-completions shape) for every turn
  → /api/eleven-llm rebuilds the exact chat-stream Claude call (fu_system
    verbatim + cache_control; fu_history + session turns merged), streams
    back OpenAI-format SSE, and strips the [[VISUAL]] channel so it is
    never spoken (known delta: no VisualAid cards on this stack)
  → agent PCM16@24k streams down and is spliced gaplessly onto the shared
    AudioContext timeline; user_transcript / agent_response events mirror
    into the conversation state
```

The agent speaks the on-screen greeting itself on the first tap
(`first_message` override); typed messages go into a live session as
`user_message` events, or fall back to `/api/chat-stream` with TTS
suppressed when no session is open (so no OpenAI voice pollutes the stack).

### `current` (control condition — unchanged from the live app)

```
User taps mic ONCE → continuous hands-free session
  → WebRTC direct to OpenAI Realtime (ephemeral secret from /api/realtime-session)
  → server VAD ends the turn after ~1.2s silence
  → POST /api/chat-stream (SSE, unbuffered)
  → sentence buffer fires TTS at natural breaks (first chunk ~28 chars)
  → POST /api/tts format:'pcm' — 24kHz PCM spliced gaplessly onto the
    AudioContext timeline; barge-in cancels playback + stream
  → back to LISTENING
```

Fallbacks: native `SpeechRecognition` tap-to-talk, then MediaRecorder →
`/api/stt`. Self-healing hands-free session (reconnect budget, visibility
rebuild, mic-track death detection, 8-min proactive rotation) — the same
lifecycle drives the ElevenLabs stack via `openSessionRef`. A header
toggle (`fu_voice_muted`) turns voice replies off entirely. See the inline
comments in `index.html` for the reliability knobs — they are all deliberate.

### Two-Channel Replies (spoken vs shown)

Assistant replies split on a literal `[[VISUAL]]` marker: prose before it is
spoken via TTS; markdown after it renders silently as a `VisualAid` card.
The streaming client holds back partial markers (`[[VIS` is never voiced),
stores messages as `{ content, visual }`, and reassembles
`content + [[VISUAL]] + visual` when sending history back to Claude.
`sanitizeForSpeech` strips residual markdown before TTS.

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat-stream` | Streams Claude as simplified SSE (`data: {text}`, `data: [DONE]`); clamps `max_tokens` to 1000; logs cache usage |
| `POST /api/realtime-session` | Mints 10-min OpenAI Realtime client secret (server VAD, 1.2s end-of-turn) |
| `POST /api/eleven-session` | Ensures + configures the ElevenLabs agent (idempotent by name; always re-patched so the custom-LLM URL tracks the deployment host), mints a signed conversation WebSocket URL |
| `POST /api/eleven-llm` | OpenAI-compatible `/chat/completions` for the ElevenLabs agent (rewrite maps `/api/eleven-llm/chat/completions` here); auth via `x-fu-proxy-token`, an SHA-256 derivation of `ELEVENLABS_API_KEY` set on the agent config; relays to Claude with the same params + caching as chat-stream and logs usage as `[eleven-llm]` |
| `POST /api/tts` | Text → audio: raw PCM stream (primary) or MP3; 8s upstream timeout → clean 504 |
| `POST /api/stt` | Transcribes uploaded audio; OpenAI when `OPENAI_API_KEY` is set, else Groq |

All endpoints are same-origin only (no CORS headers — deliberate), except
`/api/eleven-llm`, which is called server-to-server by ElevenLabs and gated
by the shared-secret header instead.

## State & Storage

React `useState`/`useRef` only. localStorage keys: `fu_conversations` (capped
at 50, each stamped with `variant`, `variantName`, `sandboxVersion`,
`voiceStack`), `fu_active_conversation`, `fu_profile` (`{ name }`),
`fu_voice_muted`, `fu_sot_variant`, `fu_voice_stack`. Greeting-only
conversations are never
persisted. There is no history UI — transcripts are read from localStorage
via DevTools when needed.

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...   # Required — Claude (chat-stream, eleven-llm)
ELEVENLABS_API_KEY=...         # Required for the elevenlabs stack (default)
OPENAI_API_KEY=sk-...          # Required for the current stack — TTS, Realtime STT, upload STT
GROQ_API_KEY=gsk_...           # Optional — STT fallback only
ELEVENLABS_VOICE_ID=...        # Optional — overrides the default voice
```

## Development Notes

- No build step — edit `index.html` / `styles.css` and deploy.
- The visible version label is `SANDBOX_VERSION` in `index.html`
  (`sandbox-0.1`), hardcoded.
- **Do not** reintroduce per-turn-dynamic content into the system prompt
  builders (timestamps, counters) — it would kill every prompt-cache hit and
  contaminate the A/B latency comparison.
- v0.2 status: the ElevenLabs stack ships (Agents platform + `/api/eleven-llm`
  custom-LLM proxy, per the brief §3) and is the default; `current` remains
  the control via `?vs=current`. The A/B prompt toggle sits behind the proxy,
  so prompts × voice stacks cross-combine without either knowing about the
  other. Hume (EVI, same custom-LLM pattern) is still to come.
- The ElevenLabs agent is created/updated programmatically by
  `api/eleven-session.js` — don't hand-edit it in the ElevenLabs dashboard;
  the next session mint re-asserts the coded config.
