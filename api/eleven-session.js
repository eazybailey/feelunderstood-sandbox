export const config = { runtime: 'edge' };

// ElevenLabs voice-stack session mint (v0.2 bake-off).
//
// The ElevenLabs stack runs on their Agents platform: one agent, configured
// here on every mint, whose LLM is a *custom LLM* pointed back at our own
// /api/eleven-llm proxy. That keeps Claude, the Anthropic key, and the A/B
// Source-of-Truth logic behind our own endpoint — ElevenLabs only ever sees
// OpenAI-format chat traffic — so prompt variants and voice stacks
// cross-combine without either knowing about the other (build brief §3).
//
// This endpoint (same-origin only, like the others — no CORS headers):
//   1. Finds-or-creates this deployment's agent by name, then PATCHes its
//      config on every call. Always-patch is deliberate self-healing: the
//      custom-LLM URL is derived from *this request's* host, so a fresh
//      preview URL repoints its own agent at itself, and config drift after
//      a code change (or a dashboard edit) fixes itself on the next session.
//   2. Mints a signed WebSocket URL the browser connects to directly.
//
// The agent requires auth (enable_auth) so a leaked agent_id alone can't
// start conversations on our ElevenLabs quota; only this endpoint can.

const XI_ORIGIN = 'https://api.elevenlabs.io';
const AGENT_BASE_NAME = 'feelunderstood-sandbox';

// One agent per deployment, not one shared agent. The agent's custom-LLM
// URL is re-pointed at whichever host minted the last session, so with a
// single agent a mic tap on a preview deployment silently hijacked
// production's brain (and vice versa) until the other side tapped again.
// Production keeps the original bare name (its existing agent carries on);
// each preview branch gets its own, named after the branch. Agents cost
// nothing, and every one is (re)configured by the same code path.
const agentNameFor = (host) => {
  if (process.env.VERCEL_ENV === 'production') return AGENT_BASE_NAME;
  const ref = process.env.VERCEL_GIT_COMMIT_REF || host;
  return `${AGENT_BASE_NAME} [preview: ${ref}]`;
};

// The coach's voice, chosen by ear for this bake-off. This constant is
// the single source of truth — no env override (one silently winning
// over the code made voice changes look like they didn't take), and the
// per-mint agent PATCH re-asserts it over any dashboard edit.
const VOICE_ID = 'ImnfuV8oxhB7ya99oJfc';

// Speaking rate, 0.7 (slowest) – 1.2 (fastest); 1.0 is the voice's natural
// pace. Pinned here for the same reason as VOICE_ID: the per-mint PATCH
// merges, so a tts field the code does NOT name survives a dashboard
// "publish" forever (a dashboard speed edit once garbled speech mid-
// greeting) — and one the code DOES name reverts within a mic tap. Change
// it here, never in the dashboard.
const VOICE_SPEED = 1.0;

// Raw PCM in both directions: 16kHz mic upload (their ASR native rate) and
// 24kHz agent audio down, which the client splices onto the same gapless
// AudioContext timeline the control stack already uses.
const INPUT_FORMAT = 'pcm_16000';
const OUTPUT_FORMAT = 'pcm_24000';

// Shared secret for /api/eleven-llm, derived from the ElevenLabs key so no
// extra env var is needed. It is configured on the agent as a request
// header (server-to-server only) and verified by the proxy; it never
// reaches the browser.
const proxyToken = async () => {
  const data = new TextEncoder().encode(`fu-eleven-llm:${process.env.ELEVENLABS_API_KEY}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// Preview deployments sit behind Vercel Deployment Protection, which
// ElevenLabs' servers can't log in to — the custom-LLM callback got a login
// page instead of Claude, so the agent heard the user and never answered.
// "Protection Bypass for Automation" (project → Settings → Deployment
// Protection) fixes that: Vercel injects the secret as this env var on
// every deployment, and requests carrying it in this header pass through.
// Harmless on production, where nothing is protected.
const bypassHeaders = () => {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { 'x-vercel-protection-bypass': secret } : {};
};

const desiredAgentConfig = (llmUrl, token) => ({
  conversation_config: {
    agent: {
      language: 'en',
      // Real first messages are supplied per-session via override (the
      // app's own greeting for a fresh conversation, '' on a resume).
      first_message: '',
      prompt: {
        // Placeholder only: every session overrides the prompt AND sends
        // the built variant prompt in custom_llm_extra_body, which the
        // proxy prefers verbatim (byte-identical → prompt cache hits).
        prompt: 'You are a warm conversation coach. (Placeholder — the real prompt is supplied per session.)',
        llm: 'custom-llm',
        custom_llm: {
          url: llmUrl,
          model_id: 'claude-sonnet-4-6',
          api_type: 'chat_completions',
          request_headers: { 'x-fu-proxy-token': token, ...bypassHeaders() },
        },
      },
    },
    tts: {
      // English-only agents must use the v2 English models ("English
      // Agents must use turbo or flash v2" — their create-time validator);
      // flash_v2_5 is the multilingual variant.
      model_id: 'eleven_flash_v2',
      voice_id: VOICE_ID,
      agent_output_audio_format: OUTPUT_FORMAT,
      speed: VOICE_SPEED,
    },
    asr: { user_input_audio_format: INPUT_FORMAT },
    conversation: {
      max_duration_seconds: 1800,
      client_events: [
        'conversation_initiation_metadata',
        'ping',
        'audio',
        'interruption',
        'user_transcript',
        'tentative_user_transcript',
        'agent_response',
        'agent_response_correction',
        'internal_tentative_agent_response',
        'vad_score',
      ],
    },
  },
  platform_settings: {
    auth: { enable_auth: true },
    overrides: {
      custom_llm_extra_body: true,
      conversation_config_override: {
        agent: { first_message: true, prompt: { prompt: true } },
      },
    },
  },
});

const xi = (path, init = {}) => fetch(`${XI_ORIGIN}${path}`, {
  ...init,
  headers: {
    'xi-api-key': process.env.ELEVENLABS_API_KEY,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers || {}),
  },
});

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return new Response(JSON.stringify({ error: 'ElevenLabs voice stack not configured (missing ELEVENLABS_API_KEY)' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // The deployment's own public host — x-forwarded-host on Vercel.
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    if (!host || host.startsWith('localhost') || host.startsWith('127.')) {
      // ElevenLabs' servers must be able to reach the custom-LLM URL.
      return new Response(JSON.stringify({ error: 'ElevenLabs stack needs a publicly reachable deployment (custom-LLM callback)' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const llmUrl = `https://${host}/api/eleven-llm`;
    const agentName = agentNameFor(host);
    const agentConfig = desiredAgentConfig(llmUrl, await proxyToken());

    // Find the agent by name… (a failed list must NOT fall through to
    // create — that would mint a duplicate agent on every blip)
    const listRes = await xi(`/v1/convai/agents?page_size=100&search=${encodeURIComponent(agentName)}`);
    if (!listRes.ok) {
      const detail = (await listRes.text()).slice(0, 300);
      console.error('[eleven-session] agent list failed:', listRes.status, detail);
      return new Response(JSON.stringify({ error: 'Could not reach ElevenLabs', upstream_status: listRes.status, detail }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const list = await listRes.json();
    let agentId = (list.agents || []).find(a => a.name === agentName)?.agent_id || null;

    // …create it if missing, else re-assert the desired config.
    if (!agentId) {
      const createRes = await xi('/v1/convai/agents/create', {
        method: 'POST',
        body: JSON.stringify({ name: agentName, tags: [AGENT_BASE_NAME], ...agentConfig }),
      });
      if (!createRes.ok) {
        const detail = (await createRes.text()).slice(0, 300);
        console.error('[eleven-session] agent create failed:', createRes.status, detail);
        return new Response(JSON.stringify({ error: 'Could not create ElevenLabs agent', upstream_status: createRes.status, detail }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      agentId = (await createRes.json()).agent_id;
    } else {
      const patchRes = await xi(`/v1/convai/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify(agentConfig),
      });
      if (!patchRes.ok) {
        // Config drift is survivable (the last good config still works) —
        // log it loudly but keep minting the session.
        console.error('[eleven-session] agent patch failed:', patchRes.status, (await patchRes.text()).slice(0, 500));
      }
    }

    const signedRes = await xi(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
    if (!signedRes.ok) {
      const detail = (await signedRes.text()).slice(0, 300);
      console.error('[eleven-session] signed url failed:', signedRes.status, detail);
      return new Response(JSON.stringify({ error: 'Could not create ElevenLabs session', upstream_status: signedRes.status, detail }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { signed_url } = await signedRes.json();

    return new Response(JSON.stringify({
      signed_url,
      agent_id: agentId,
      agent_name: agentName,
      input_sample_rate: 16000,
      output_sample_rate: 24000,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[eleven-session] error:', error?.message || error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
