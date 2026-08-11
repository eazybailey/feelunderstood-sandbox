# Feel Understood — Sandbox v0.1

A fork of the live app (v2.5.3), reduced to a single path — **name → Helpline** —
with an A/B toggle between two system-prompt variants. Built per
`Feel_Understood_Sandbox_Build_Brief_V1.1.md`. **Nothing here is production**;
it is a rig for listening to the difference between prompts (and, in v0.2,
between voice stacks). The live beta lives in `eazybailey/chatbot-demo` and is
untouched by this repo.

## The A/B toggle

- Testers see neutral labels only: a `Coach: A | B` pill in the mode banner.
- **The blind mapping (do not share with testers): A → `light`, B → `deep`.**
  - `light` = the live app's `buildCoachSystemPrompt`, renamed
    `buildCoachSystemPromptLight`, zero characters of its text changed.
  - `deep` = the same builder with one surgical change: the span between
    `THE DIALOGUE SYSTEM — YOUR SOURCE OF TRUTH:` and `HOW YOU INTERACT:` is
    replaced by SoT V2 Part A + Part B (`docs/SoT_V2.md`, embedded verbatim as
    `SOT_V2_PART_A` / `SOT_V2_PART_B` in `index.html`). The splice runs on
    Light's *output*, so everything outside the spliced span is byte-identical
    between variants by construction.
- Switching mid-conversation starts a fresh session by default (clean A/B).
  The dev panel has a dev-only "keep transcript" override.
- The choice persists in `localStorage` (`fu_sot_variant`); `?v=a` / `?v=b`
  forces (and persists) the variant, so two links can be sent to two testers
  and each test attributed afterwards.
- Measured sizes (helpline profile): Light ≈ 8.9k chars (~2.2k tokens),
  Deep ≈ 47.4k chars (~11.9k tokens), Δ ≈ +38.5k chars. (The brief's "~30k"
  came from the SoT doc's word-count estimate; the embed is verbatim, and the
  dev panel shows the live numbers.) Both variants clear Anthropic's
  1024-token cache minimum.

## Prompt caching

`index.html` sends `system` as a content-block array with
`cache_control: { type: 'ephemeral' }` — required for a fair A/B, since the
Deep block would otherwise add a first-token delay to every Deep reply that
Light never pays. `api/chat-stream.js` relays the array unchanged and logs the
`usage` object from each turn's `message_start` event
(`cache_creation_input_tokens` / `cache_read_input_tokens` — turn 1 should
show creation, turn 2+ reads > 0). The same numbers are forwarded to the
client and shown in the dev panel.

## Dev panel

Hidden `· dev ·` links (Landing Gate footer, and the menu drawer footer) open
it. Shows the A/B mapping, active variant, voice stack (`current`), model id,
per-variant prompt char counts, the last turn's cache readout, the
keep-transcript override, and **Copy transcript with header** (variant label +
resolved name, sandbox version, voice stack, model, timestamp). Stored
conversations in `localStorage` carry the same stamp fields
(`variant`, `variantName`, `sandboxVersion`, `voiceStack`).

## What's stripped (hidden via `const SANDBOX = true`, not deleted)

Basecamp, Lessons path, Facilitator path, mode cards/drawer modes,
questionnaire flow, About & Insights, the full-app route from the gate, and
the service worker (registration replaced with an unregister; `sw.js` cache
renamed `sandbox-v0.1` as belt-and-braces). Kept: Landing Gate (reworded),
Helpline chat, the full voice pipeline (unchanged — the v0.2 control
condition), transcript storage.

## Deploying

Import this repo as a **new Vercel project** (own preview URL) with the same
env keys as the live app: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, optional
`GROQ_API_KEY`. No build step.

## Versioning note

The visible version label is `sandbox-0.1` (hardcoded, since it no longer
follows the live app's `vX.Y.Z` scheme). `scripts/bump-version.mjs` expects
the live label format and should not be used in this repo without adjusting it.
