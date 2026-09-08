export const config = { runtime: 'edge' };

import { systemBlockFor } from './_prompts.js';

// Custom-LLM endpoint for the ElevenLabs agent (v0.2 bake-off).
//
// ElevenLabs POSTs OpenAI-format chat completions here (it appends
// /chat/completions to the base URL configured on the agent — vercel.json
// rewrites that path back onto this function) and expects an OpenAI-format
// SSE stream back. We translate to the Anthropic API and stream Claude's
// reply through, so the conversational brain — model, variant system
// prompt, prompt caching, max_tokens clamp — is EXACTLY the same as the
// typed-fallback path's /api/chat-stream. Only the ears and mouth differ.
//
// The inputs to the A/B Source of Truth ride in `custom_llm_extra_body`,
// set by the client at session start and attached by ElevenLabs to every
// LLM call:
//   fu_profile    — the tester's profile ({ name }).
//   fu_variant    — the neutral variant key ('A' | 'B').
//                   The prompt itself is built here from these two
//                   (api/_prompts.js) — it is never sent by the client, so
//                   the Source of Truth never passes through the browser
//                   or ElevenLabs. The system message ElevenLabs sends (the
//                   agent's placeholder, possibly with platform text
//                   appended) is ignored, which also keeps the cache prefix
//                   byte-identical turn to turn: same inputs → same bytes
//                   → same ephemeral cache entry.
//   fu_history    — turns from BEFORE this ElevenLabs session (resumed
//                   conversations, text-fallback turns). ElevenLabs only
//                   knows the turns of the live session; we prepend ours.
//   fu_max_tokens — the client's usual 700 (clamped to 1000 here).
//
// Auth: ElevenLabs sends x-fu-proxy-token (configured on the agent by
// /api/eleven-session, server-to-server only). Without it this would be a
// free cross-site Claude proxy — same concern the missing CORS headers
// cover on the other endpoints, which can't help here because the caller
// is ElevenLabs' backend, not a browser.

const VISUAL_MARKER = '[[VISUAL]]';

const expectedToken = async () => {
  const data = new TextEncoder().encode(`fu-eleven-llm:${process.env.ELEVENLABS_API_KEY}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};

// OpenAI message content may be a string or a parts array — flatten to text.
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => (p && typeof p === 'object') ? (p.text || '') : String(p ?? ''))
      .join(' ');
  }
  return '';
};

// Anthropic wants strictly alternating roles; barge-ins and re-engages can
// produce consecutive same-role turns, so merge them (the client does the
// same for its own history).
const normalizeMessages = (raw) => {
  const out = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = textOf(m.content).trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n${content}`;
    else out.push({ role: m.role, content });
  }
  return out;
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!process.env.ELEVENLABS_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'Not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (req.headers.get('x-fu-proxy-token') !== await expectedToken()) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    // The extra body has appeared both merged top-level and nested under
    // elevenlabs_extra_body across platform versions — accept either.
    const extra = (body.elevenlabs_extra_body && typeof body.elevenlabs_extra_body === 'object')
      ? { ...body, ...body.elevenlabs_extra_body }
      : body;

    if (!extra.fu_profile || typeof extra.fu_profile !== 'object') {
      // A session opened by a stale client (pre-server-side prompts) or a
      // bare re-engagement: still answer, just without the profile block.
      console.warn('[eleven-llm] no fu_profile in extra body — prompt built without a profile');
    }
    const { system, variant } = systemBlockFor({ profile: extra.fu_profile, variant: extra.fu_variant });

    const history = Array.isArray(extra.fu_history) ? extra.fu_history : [];
    const sessionMessages = Array.isArray(body.messages) ? body.messages : [];
    // Cap the window like the client does (24 + headroom for the merge) so
    // long sessions don't slow Claude's first token every turn.
    const messages = normalizeMessages([...history, ...sessionMessages]).slice(-24);
    if (messages.length === 0) {
      // ElevenLabs can ask for a re-engagement with no user turn yet.
      messages.push({ role: 'user', content: '(The user has joined and is listening.)' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Mirror /api/chat-stream exactly — the brain (model, effort,
        // clamp, caching) must not differ between the agent path and the
        // typed fallback.
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(Number(extra.fu_max_tokens) || 700, 1000),
        stream: true,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[eleven-llm] anthropic error:', response.status, err.slice(0, 500));
      return new Response(JSON.stringify({ error: 'Upstream LLM error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const chatId = `chatcmpl-fu-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || 'claude-sonnet-4-6';
    const openAiChunk = (delta, finishReason = null) => `data: ${JSON.stringify({
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Two-channel replies: everything after [[VISUAL]] is the on-screen
      // markdown card, which must never reach TTS — and ElevenLabs speaks
      // whatever we stream, so the visual channel is dropped here (a known
      // delta of this stack: no VisualAid cards; the prompt is untouched
      // to keep the A/B byte-identical). Hold back a partial trailing
      // marker so a chunk ending in '[[VIS' is never voiced.
      let full = '';
      let sent = 0;
      let visualSeen = false;
      const speakableEnd = () => {
        const idx = full.indexOf(VISUAL_MARKER);
        if (idx !== -1) { visualSeen = true; return idx; }
        for (let k = VISUAL_MARKER.length - 1; k > 0; k--) {
          if (full.endsWith(VISUAL_MARKER.slice(0, k))) return full.length - k;
        }
        return full.length;
      };

      try {
        await writer.write(encoder.encode(openAiChunk({ role: 'assistant', content: '' })));

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'message_start') {
                // Cache verification readout, tagged per stack — turn 1
                // creation, turn 2+ reads > 0, exactly like chat-stream.
                console.log('[eleven-llm] variant', variant, 'usage:', JSON.stringify(parsed.message?.usage || null));
              }
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                full += parsed.delta.text;
                const end = speakableEnd();
                if (end > sent) {
                  await writer.write(encoder.encode(openAiChunk({ content: full.slice(sent, end) })));
                  sent = end;
                }
              }
              if (parsed.type === 'error') {
                console.error('[eleven-llm] in-stream error:', parsed.error?.message);
              }
            } catch (e) { /* skip malformed line */ }
          }
        }

        // Release any partial-marker holdback that never completed.
        if (!visualSeen && sent < full.length) {
          await writer.write(encoder.encode(openAiChunk({ content: full.slice(sent) })));
        }
        if (visualSeen) {
          console.log('[eleven-llm] visual channel dropped:', full.length - full.indexOf(VISUAL_MARKER), 'chars');
        }
        await writer.write(encoder.encode(openAiChunk({}, 'stop')));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('[eleven-llm] stream error:', e?.message || e);
        try {
          await writer.write(encoder.encode(openAiChunk({}, 'stop')));
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (e2) {}
      }
      try { await writer.close(); } catch (e) {}
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    console.error('[eleven-llm] error:', error?.message || error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
