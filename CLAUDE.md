# The Conversation Coach

A voice-first Progressive Web App for practicing better conversations through AI coaching, built on the "Dialogue System" framework by Gerard Egan and Andrew Bailey.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18.3.1 (vendored UMD builds in `/vendor` — no CDN, no build step; app code is plain `React.createElement`, no JSX/Babel) |
| Backend | Vercel Functions — Edge Runtime (`chat-stream`, `tts`, `stt`, `realtime-session`) |
| AI | Anthropic Claude API (claude-sonnet-4-6) |
| TTS | OpenAI TTS API (`tts-1` model, `shimmer` voice) — streamed as raw PCM for gapless playback, MP3 fallback |
| STT | **Primary**: OpenAI Realtime API over WebRTC (`gpt-4o-mini-transcribe`, server VAD, hands-free). Fallbacks: native Web Speech API (`SpeechRecognition`), then MediaRecorder → `/api/stt` (Whisper) |
| Hosting | Vercel |
| Styling | Vanilla CSS, Google Fonts (Inter, Patrick Hand) |
| PWA | Service Worker, Web App Manifest |

## Project Structure

```
chatbot-demo/
├── api/                       # Vercel serverless endpoints (all Edge Runtime)
│   ├── chat-stream.js        # Streaming Claude API (primary)
│   ├── realtime-session.js   # Mints ephemeral OpenAI Realtime client secrets for hands-free STT
│   ├── tts.js                # OpenAI TTS endpoint — PCM streaming or MP3
│   └── stt.js                # Speech-to-text endpoint — OpenAI Whisper, Groq fallback
├── vendor/                    # Vendored, pinned React 18.3.1 UMD builds (no CDN dependency)
│   ├── react.production.min.js
│   └── react-dom.production.min.js
├── images/                    # Icons, logos, doodle-style SVGs
│   ├── favicon.svg
│   ├── logo.svg
│   ├── icon-app.svg          # Master SVG for PWA icons
│   ├── icon-192.png / icon-512.png  # Generated PWA icons
│   ├── apple-touch-icon.png
│   ├── icon-avatar.svg       # Chat assistant avatar
│   ├── icon-learn.svg        # Feature icon (onboarding)
│   ├── icon-coach.svg        # Feature icon (onboarding)
│   └── icon-practice.svg     # Feature icon (onboarding)
├── scripts/
│   ├── generate-icons.mjs    # Sharp-based icon generation
│   └── bump-version.mjs      # Single-source-of-truth version bumper (see Versioning)
├── index.html                # Entire app — single-page React PWA
├── styles.css                # Global styles (dark theme, animations)
├── sw.js                     # Service Worker (cache-first assets, network-first API)
├── manifest.json             # PWA manifest
├── vercel.json               # Vercel deployment config
├── plan.md                   # Original implementation plan (historical — see its status note)
└── package.json              # Dev dep: sharp for icon gen; "version" is the release source of truth
```

## Architecture

### Voice Pipeline (Hands-Free Realtime — primary)

```
User taps mic ONCE → continuous hands-free session begins
  → Browser opens a WebRTC session directly to OpenAI's Realtime API
    (ephemeral client secret minted by POST /api/realtime-session)
  → Mic streams continuously; transcript deltas render as interim text
  → Server-side VAD ends the turn after ~1.2s of silence (no tap needed)
  → POST /api/chat-stream (SSE stream to Claude, sent unbuffered)
  → Sentence buffer fires TTS at natural breaks (first chunk ~28 chars
    so audio starts ASAP; whole sentences after, for natural prosody)
  → Each chunk → POST /api/tts with format:'pcm' — raw 24kHz PCM is
    spliced onto the AudioContext timeline as bytes arrive, so speech
    starts on the first network chunk and chunks join gaplessly
  → Mic stays open while the assistant speaks (echo cancellation):
    the user can BARGE IN — speech_started cancels playback + the stream
  → After the reply, the session drops straight back to LISTENING
```

**Fallback (tap-to-talk)** — used when WebRTC/realtime setup fails (and automatically for the rest of the visit after one failure) or isn't supported: native `SpeechRecognition`, or MediaRecorder → `/api/stt` (Whisper) on iOS third-party browsers; ~2.2s client-side silence debounce; buffered MP3 TTS when no AudioContext is running.

### Voice State Machine

```
Hands-free:  IDLE → (tap mic) → LISTENING ⇄ PROCESSING ⇄ SPEAKING
             (loops without taps; barge-in returns to LISTENING;
              tap during LISTENING ends the session → IDLE)
Tap-to-talk: IDLE → (tap mic) → LISTENING → PROCESSING → SPEAKING → IDLE
```

Users interrupt during SPEAKING by just talking (hands-free) or tapping the mic (both paths). A tap during SPEAKING flows straight into LISTENING when the realtime path is available (no second tap needed). A new user turn always hard-cancels any still-playing TTS (`cancelSpeak()` at the top of `sendToClaude`) so a superseded reply can never keep talking underneath the new one, and `voiceStateRef` is synced synchronously at every transition the barge-in handler reads (the `useEffect` mirror lags a render).

**Voice replies toggle**: a header button (persisted as `fu_voice_muted`) turns TTS off entirely — replies stream as text only, the greeting renders silently, and muting mid-reply cancels playback immediately. STT/mic is unaffected.

### API Endpoints

| Endpoint | Runtime | Purpose |
|----------|---------|---------|
| `POST /api/chat-stream` | Edge | Primary. Streams Claude responses as simplified SSE (`data: { text }`, then `data: [DONE]`). Sent unbuffered (`X-Accel-Buffering: no`, `no-transform`) so deltas arrive as produced. Clamps client-supplied `max_tokens` to 1000 |
| `POST /api/realtime-session` | Edge | Mints a short-lived (10 min) OpenAI Realtime client secret for a hands-free transcription session (server VAD, 1.2s end-of-turn). The browser then talks WebRTC directly to OpenAI |
| `POST /api/tts` | Edge | Converts text → audio via OpenAI TTS: raw PCM stream (`format: 'pcm'`, primary) or MP3 (default). Aborts a slow upstream after 8s and returns a clean `504` so the client can retry |
| `POST /api/stt` | Edge | Transcribes uploaded audio (tap-to-talk fallback path). Prefers OpenAI `gpt-4o-mini-transcribe`; falls back to Groq `whisper-large-v3-turbo` if only `GROQ_API_KEY` is set |

Endpoints are same-origin only — the app calls them with relative URLs, so no CORS headers are sent (a wildcard would offer the API keys' quota to any website). The legacy non-streaming `api/chat.js` was removed.

### Request Formats

**chat-stream**: JSON `{ messages: [{role, content}], system: string, max_tokens: number }`
**realtime-session**: empty POST → JSON `{ value: 'ek_...', expires_at }`
**tts**: JSON `{ input: string, voice: string, format?: 'pcm' }` → `audio/pcm; rate=24000` stream (or `audio/mpeg` by default)
**stt**: `multipart/form-data` with an `audio` file → JSON `{ text, provider }`

## Frontend Architecture

Single-page React app rendered entirely in `index.html` (no build tooling).

### Key Components

- **`App`** — Root. Manages conversation state, voice state machine, streaming pipeline
- **Feel Understood onboarding** — A short questionnaire (`FEEL_UNDERSTOOD_SCREENS`) builds a profile, then offers three next-step paths (see Coaching Modes). **Beta mode skips the questionnaire**: "Try the Beta" → name input → straight into the Helpline (the system prompt gets a slim no-questionnaire profile). The greeting is spoken via the gapless PCM path; the mic stays off until the user's first "Tap to talk", which opens the hands-free session
- **`MessageBubble`** — Chat bubbles (user = yellow right-aligned, assistant = gray left-aligned). Assistant bubbles can carry a `visual` field, rendered by **`VisualAid`** as a card (light markdown subset: bullets, numbered lists, **bold**)
- **`TypingIndicator`** — Animated dots during processing
- **`WaveVisualizer`** — Animated bars during listening; reacts to live mic level on the Whisper path

### Custom Hooks

- **`useRealtimeSTT`** — Primary. Hands-free continuous STT via OpenAI Realtime over WebRTC: live transcript deltas, server-VAD turn detection, `speech_started` barge-in events, `getLevel` for the visualizer. Returns `{ supported, startSession, endSession, isActive, getLevel }`
- **`useSpeechRecognition`** — Tap-to-talk fallback. Wraps native `SpeechRecognition`; manages its own ~2.2s silence debounce. Returns `{ start, stop, abort, supported }`
- **`useMediaRecorderSTT`** — Tap-to-talk fallback for browsers without usable `SpeechRecognition` (iOS Chrome/Firefox/Edge). Records via `MediaRecorder`, does its own RMS-based silence detection, posts audio to `/api/stt`. Same interface plus `getLevel` for the visualizer
- **`useSpeechSynthesis`** — Manages the TTS pipeline. Returns `{ speak, speakStreaming, cancel, getLastError }`. `speakStreaming` streams raw PCM gaplessly onto the AudioContext timeline (buffered MP3 fallback when no context). `getLastError` surfaces real TTS failures as a banner instead of masking them with a robotic browser voice

### State (React useState/useRef, no external library)

- `started` — boolean, onboarding → chat transition
- `profile` — the Feel Understood profile + selected `mode`/`goal`/`path`
- `messages` — array of `{ role, content }`, full conversation history
- `voiceState` — `'idle' | 'listening' | 'processing' | 'speaking'`
- `interimText` / `transcribing` — real-time transcription preview / Whisper-path "transcribing" state
- `textInput` — fallback text input value
- `voiceMuted` — voice-replies-off toggle (persisted; TTS skipped, text still streams)
- `error` — error message (voice failures persist ~10s; others auto-clear faster)

Conversations are persisted to localStorage only once they contain a user message — greeting-only chats (every New Chat / mode switch) are not saved, so the history list stays clean.

## Coaching Framework

The system prompt implements the **Dialogue System** by Gerard Egan & Andrew Bailey:

- **4 Characteristics** of effective dialogue
- **3 Roles** the coach can play
- **6 Skill Sets** for communication
- Frameworks: SAME, MRI, PRE, CRITIC

### Coaching Modes

After the Feel Understood questionnaire, the user picks one of three paths, which map onto a system-prompt **mode** the chat AI uses to tailor its opening turn:

1. **Lessons** (`mode: coach`, goal `learn`) — short teaching sessions on communication skills
2. **Helpline** (`mode: coach`, goal `helpline`) — talk through a specific conversation or an aspect of yourself you want seen; can role-play approaches
3. **Facilitator** (`mode: facilitator`) — the AI acts as a neutral third party in a conversation between the user and another person, making sure both are heard

System prompts are built by `buildCoachSystemPrompt` and `buildFacilitatorSystemPrompt`. Responses are optimized for voice: concise (2–4 sentences), warm, no markdown/bullets.

### Two-Channel Replies (spoken vs shown)

Assistant replies have two channels separated by a literal `[[VISUAL]]` marker:

- **Spoken** (before the marker) — plain conversational prose, streamed to TTS as it arrives
- **Shown** (after the marker) — optional markdown bullets/structure, rendered silently as a `VisualAid` card, never spoken

The streaming client splits the channels live (holding back partial markers so `[[VIS` is never voiced), stores assistant messages as `{ content, visual }`, and reassembles `content + [[VISUAL]] + visual` when sending history back to Claude so the model remembers what it displayed. `sanitizeForSpeech` strips any residual markdown/bullets/markers before text reaches TTS — the "reading asterisks aloud" failure mode is fenced at both ends.

## Styling

- Dark theme: `#0f0f1a` background, `#1a1a2e` surfaces
- Accent: `#ffd21f` (yellow)
- Hand-drawn doodle iconography (SVG)
- Animations: `fadeInUp`, `pulse`, `dotPulse`, `waveBar`
- Mobile-first, responsive, safe-area-inset aware

## Environment Variables

```
ANTHROPIC_API_KEY=sk-ant-...   # Required — Claude API (chat-stream, chat)
OPENAI_API_KEY=sk-...          # Required — OpenAI TTS, Realtime STT (hands-free), Whisper STT
GROQ_API_KEY=gsk_...           # Optional — STT fallback only (whisper-large-v3-turbo)
```

If `OPENAI_API_KEY` is set, STT uses OpenAI; Groq is only used when OpenAI isn't configured.

## Deployment

Hosted on **Vercel**. Config in `vercel.json`:
- Clean URLs (no `.html` extensions)
- SPA rewrites (all non-API routes → `/index.html`)
- Service Worker headers (no-cache, Service-Worker-Allowed `/`)

## PWA

- Service Worker (`sw.js`) with cache name `feel-understood-v<app-version>` (bumped automatically per release — see Versioning)
- Static assets (including the vendored React builds) cached on install — fully offline-capable, no CDN
- API calls always network-first, passed straight through (never cached/cloned, so streaming isn't buffered)
- Offline fallback to cached `/index.html`
- Installable to home screen (standalone display mode)

## Voice Reliability & Tuning

Key knobs and behaviors that keep the voice experience smooth (all in `index.html` unless noted):

- **End-of-turn silence (hands-free)**: `silence_duration_ms: 1200` in `api/realtime-session.js` — server-VAD pause length before a turn ends. The dominant latency knob on the primary path: lower = snappier turn-taking, higher = more room to pause and think mid-sentence.
- **End-of-turn silence (tap-to-talk)**: `SILENCE_MS = 2200` in both fallback STT paths — how long to wait through a pause before treating the user as done. Tap the mic to end immediately.
- **Barge-in**: while the assistant speaks, `input_audio_buffer.speech_started` aborts the reply stream and playback. Relies on `echoCancellation: true` so the mic doesn't hear the assistant's own voice — verify on speakerphone-style devices.
- **Self-healing hands-free session**: a dropped WebRTC session (screen off, app switch, network blip, upstream expiry) is rebuilt silently — up to 3 reconnect attempts (budget resets on each successful turn), a rebuild-on-return `visibilitychange` handler for backgrounded PWAs, and proactive rotation of sessions older than 8 min at turn-capture time. Only hard failures (permission denied, no mic, setup rejected) fall back to tap-to-talk.
- **TTS model**: `tts-1` (not `tts-1-hd`) in `api/tts.js` — much faster to generate, which matters for per-sentence streaming on an edge function.
- **TTS timeout**: `api/tts.js` aborts a slow OpenAI call after 8s → clean `504`, so the client retry fires fast instead of waiting for the platform gateway.
- **TTS retry**: `fetchTTSBuffer` (MP3 path) and `fetchPCMStream` (PCM streaming path) both retry once on `429` (rate limit, longer backoff) or `5xx`/network errors. Other `4xx` are not retried.
- **Resilient playback**: a single failed/slow sentence never silences the rest — `speak()` and `speakStreaming()` log the error (surfaced via the "Voice failed" banner) and keep going.
- **Unbuffered streaming**: `api/chat-stream.js` sets `X-Accel-Buffering: no` + `Cache-Control: no-transform` and primes the connection so deltas reach the browser as Claude produces them. The client also carries incomplete SSE lines across reads so chunks split mid-line don't drop words.

## Dependencies

**Runtime**: None in package.json — React 18.3.1 + ReactDOM 18.3.1 UMD builds are vendored in `/vendor` (pinned; refresh by extracting `umd/*.production.min.js` from the npm tarballs)

**Dev**: `sharp@^0.34.5` (icon generation only)

**External APIs**: Anthropic Claude (chat), OpenAI (TTS + primary Whisper STT), Groq (optional STT fallback)

## Browser Support

- **Hands-free realtime (primary)**: any browser with WebRTC + getUserMedia — Chrome, Edge, Safari, Firefox, iOS browsers, the home-screen PWA
- **Tap-to-talk fallback (native SpeechRecognition)**: Chrome, Edge, Safari, and the home-screen PWA
- **Tap-to-talk fallback (MediaRecorder → /api/stt)**: iOS Chrome (CriOS), iOS Firefox (FxiOS), iOS Edge (EdgiOS) and other browsers without usable `SpeechRecognition`
- **No mic support at all**: text input fallback is always available

## Versioning

`package.json` `version` is the **single source of truth**. The version appears
in three places that must stay in sync: `package.json`, the on-screen label in
`index.html` (`'vX.Y.Z'`), and the `CACHE_NAME` in `sw.js` (bumping it busts the
PWA cache on each release).

Never hand-edit these individually. Use the bumper, which updates all three at
once and **refuses to ever go backwards** (the guard against version
regressions):

```
npm run bump          # patch:  2.1.0 -> 2.1.1
npm run bump minor    #         2.1.0 -> 2.2.0
npm run bump major    #         2.1.0 -> 3.0.0
npm run bump 2.5.0    # set an explicit (higher) version
```

Bump as part of any change you intend to deploy, then commit the result.

## Development Notes

- No build step — edit `index.html` and deploy
- API functions in `api/` are auto-deployed as Vercel serverless functions
- `scripts/generate-icons.mjs` regenerates PWA PNGs from `images/icon-app.svg` (run with `node scripts/generate-icons.mjs`)
- Conversation history grows per session (client asks for `max_tokens: 700` per response; the server clamps any request to 1000)
- Original plan (`plan.md`) called for a separate `voice.html` and browser `SpeechSynthesis`/`SpeechRecognition` — the implementation diverged significantly (consolidated into a single `index.html`, OpenAI TTS + Whisper STT fallback, streaming pipeline). See `plan.md`'s status note for details.
