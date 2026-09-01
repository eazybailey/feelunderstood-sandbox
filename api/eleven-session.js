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
//   1. Finds-or-creates the agent by name, then PATCHes its config on every
//      call. Always-patch is deliberate self-healing: the custom-LLM URL is
//      derived from *this request's* host, so preview and production
//      deployments each repoint the agent at themselves, and config drift
//      after a code change fixes itself on the next session.
//   2. Mints a signed WebSocket URL the browser connects to directly.
//
// The agent requires auth (enable_auth) so a leaked agent_id alone can't
// start conversations on our ElevenLabs quota; only this endpoint can.

const XI_ORIGIN = 'https://api.elevenlabs.io';
const AGENT_NAME = 'feelunderstood-sandbox';

// The coach's voice, chosen by ear for this bake-off. This constant is
// the single source of truth — no env override (one silently winning
// over the code made voice changes look like they didn't take), and the
// per-mint agent PATCH re-asserts it over any dashboard edit.
const VOICE_ID = 'jkSXBeN4g5pNelNQ3YWw';

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
          request_headers: { 'x-fu-proxy-token': token },
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
    const agentConfig = desiredAgentConfig(llmUrl, await proxyToken());

    // Find the agent by name… (a failed list must NOT fall through to
    // create — that would mint a duplicate agent on every blip)
    const listRes = await xi(`/v1/convai/agents?page_size=100&search=${encodeURIComponent(AGENT_NAME)}`);
    if (!listRes.ok) {
      const detail = (await listRes.text()).slice(0, 300);
      console.error('[eleven-session] agent list failed:', listRes.status, detail);
      return new Response(JSON.stringify({ error: 'Could not reach ElevenLabs', upstream_status: listRes.status, detail }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const list = await listRes.json();
    let agentId = (list.agents || []).find(a => a.name === AGENT_NAME)?.agent_id || null;

    // …create it if missing, else re-assert the desired config.
    if (!agentId) {
      const createRes = await xi('/v1/convai/agents/create', {
        method: 'POST',
        body: JSON.stringify({ name: AGENT_NAME, tags: ['feelunderstood-sandbox'], ...agentConfig }),
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
