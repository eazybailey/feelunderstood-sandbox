export const config = { runtime: 'edge' };

// Provider selection.
// Prefer OpenAI (gpt-4o-mini-transcribe). Falls back to Groq
// (whisper-large-v3-turbo) if only GROQ_API_KEY is set.
function pickProvider() {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: 'openai',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      key: process.env.OPENAI_API_KEY,
      model: 'gpt-4o-mini-transcribe',
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: process.env.GROQ_API_KEY,
      model: 'whisper-large-v3-turbo',
    };
  }
  return null;
}

// Same-origin only: the app calls this with a relative URL, so no CORS
// headers are sent — a wildcard just offered our STT quota to any site.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provider = pickProvider();
  if (!provider) {
    return new Response(JSON.stringify({ error: 'No STT provider configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const incoming = await req.formData();
    const audio = incoming.get('audio');
    if (!audio || typeof audio === 'string') {
      return new Response(JSON.stringify({ error: 'No audio file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const filename = (audio.name && /\.(webm|mp4|m4a|mp3|wav|ogg|mpga|mpeg)$/i.test(audio.name))
      ? audio.name
      : 'audio.webm';

    const outgoing = new FormData();
    outgoing.append('file', audio, filename);
    outgoing.append('model', provider.model);
    outgoing.append('language', 'en');
    outgoing.append('response_format', 'json');
    outgoing.append('temperature', '0');

    const response = await fetch(provider.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${provider.key}` },
      body: outgoing,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({ error: err.error?.message || 'Transcription failed' }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify({ text: (data.text || '').trim(), provider: provider.name }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
