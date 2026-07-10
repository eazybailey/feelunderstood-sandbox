export const config = { runtime: 'edge' };

// Mints a short-lived client secret for an OpenAI Realtime *transcription*
// session. The browser uses it to open a WebRTC connection directly to
// OpenAI — mic audio streams there, live transcripts stream back, and
// server-side VAD decides end-of-turn (~1.2s of silence; long enough to
// pause and think without being cut off). The real API key never leaves
// this function.

// Same-origin only: the app calls this with a relative URL, so no CORS
// headers are needed — and a wildcard would let any website mint realtime
// client secrets (live STT minutes) on our OpenAI key.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: 'Realtime STT not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          type: 'transcription',
          audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
              // silence_duration_ms is the end-of-turn knob for the
              // hands-free path. 1200ms leaves room for a thoughtful
              // mid-sentence pause without feeling laggy at turn end.
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 1200,
              },
              noise_reduction: { type: 'near_field' },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ error: err.error?.message || 'Could not create realtime session' }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data = await response.json();
    return new Response(
      JSON.stringify({ value: data.value, expires_at: data.expires_at }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
