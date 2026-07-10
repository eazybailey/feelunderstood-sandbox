export const config = { runtime: 'edge' };

// Same-origin only: the app always calls its own /api/* with relative
// URLs, so no CORS headers are sent — a wildcard here just invited other
// websites to spend our OpenAI quota from their visitors' browsers.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { input, voice, format } = await req.json();

    if (!input || !input.trim()) {
      return new Response(JSON.stringify({ error: 'No input text provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 'pcm' = raw 24kHz 16-bit mono samples. Unlike mp3, PCM can be played
    // by the client progressively as bytes arrive, so speech starts on the
    // first network chunk instead of after the whole file is generated.
    const usePCM = format === 'pcm';

    // Abort a slow upstream ourselves (8s) so we return a clean 504 the
    // client can retry quickly, instead of hanging until the platform
    // gateway kills the request (~25s). tts-1 generates these short
    // sentence chunks in ~1-3s, so 8s only triggers on a genuinely stuck
    // call — and the client's retry usually lands fast.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          // tts-1 (not tts-1-hd): the standard model is much faster to
          // generate, which matters for per-sentence streaming on an edge
          // function — the HD model's latency was causing gateway 504s.
          model: 'tts-1',
          input: input,
          voice: voice || 'shimmer',
          response_format: usePCM ? 'pcm' : 'mp3',
          speed: 1.04,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: err.error?.message || 'TTS request failed' }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stream audio directly from OpenAI to client
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': usePCM ? 'audio/pcm; rate=24000' : 'audio/mpeg',
      },
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return new Response(
      JSON.stringify({ error: aborted ? 'TTS upstream timed out' : 'Internal server error' }),
      { status: aborted ? 504 : 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
