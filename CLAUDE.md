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
| Backend | Vercel Functions — Edge Runtime (`chat-stream`, `tts`, `stt`, `realtime-session`) |
| AI | Anthropic Claude API (claude-sonnet-4-6), prompt caching on the system block |
| TTS | OpenAI TTS API (`tts-1`, `shimmer` voice) — streamed as raw PCM for gapless playback, MP3 fallback |
| STT | **Primary**: OpenAI Realtime API over WebRTC (`gpt-4o-mini-transcribe`, server VAD, hands-free). Fallbacks: native Web Speech API, then MediaRecorder → `/api/stt` (`gpt-4o-mini-transcribe`; Groq `whisper-large-v3-turbo` when only `GROQ_API_KEY` is set) |
| Hosting | Vercel |
| Styling | Vanilla CSS (light theme only) |

## Project Structure

```
feelunderstood-sandbox/
├── api/                       # Vercel serverless endpoints (all Edge Runtime)
│   ├── chat-stream.js        # Streaming Claude API; relays array-form system
│   │                         #   prompt unchanged; logs cache usage per turn
│   ├── realtime-session.js   # Mints ephemeral OpenAI Realtime client secrets
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

## Voice Pipeline (unchanged from the live app — v0.2 control condition)

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
rebuild, mic-track death detection, 8-min proactive rotation). A header
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
| `POST /api/tts` | Text → audio: raw PCM stream (primary) or MP3; 8s upstream timeout → clean 504 |
| `POST /api/stt` | Transcribes uploaded audio; OpenAI when `OPENAI_API_KEY` is set, else Groq |

All endpoints are same-origin only (no CORS headers — deliberate).

## State & Storage

React `useState`/`useRef` only. localStorage keys: `fu_conversations` (capped
at 50, each stamped with `variant`, `variantName`, `sandboxVersion`,
`voiceStack`), `fu_active_conversation`, `fu_profile` (`{ name }`),
`fu_voice_muted`, `fu_sot_variant`. Greeting-only conversations are never
persisted. There is no history UI — transcripts are read from localStorage
via DevTools when needed.

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...   # Required — Claude (chat-stream)
OPENAI_API_KEY=sk-...          # Required — TTS, Realtime STT, upload STT
GROQ_API_KEY=gsk_...           # Optional — STT fallback only
```

## Development Notes

- No build step — edit `index.html` / `styles.css` and deploy.
- The visible version label is `SANDBOX_VERSION` in `index.html`
  (`sandbox-0.1`), hardcoded.
- **Do not** reintroduce per-turn-dynamic content into the system prompt
  builders (timestamps, counters) — it would kill every prompt-cache hit and
  contaminate the A/B latency comparison.
- v0.2 (staged next, per the brief): abstract the voice layer behind one
  interface and add ElevenLabs / Hume adapters; the A/B prompt toggle stays
  behind the custom-LLM proxy so prompts × voice stacks cross-combine.
