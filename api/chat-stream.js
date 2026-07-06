export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { messages, system, max_tokens } = await req.json();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        // claude-sonnet-4-20250514 was retired by Anthropic on 2026-06-15;
        // requests to it now 404, which is why voice "stopped working" (the
        // chat call failed, so no reply was ever generated or spoken). This
        // is its documented drop-in successor. thinking is disabled and
        // effort kept low so per-sentence streaming stays as snappy as the
        // old Sonnet 4 — Sonnet 4.6 otherwise defaults to high effort.
        model: 'claude-sonnet-4-6',
        // Clamp server-side: this endpoint is public and unauthenticated,
        // and the app only ever needs short spoken replies — don't let
        // arbitrary callers buy huge completions on our key.
        max_tokens: Math.min(Number(max_tokens) || 1000, 1000),
        stream: true,
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: system,
        messages: messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return new Response(err, {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Transform Claude's SSE stream into our simplified SSE format
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      // Prime the connection so the first bytes flush immediately and no
      // intermediary buffers while waiting for output. This is an SSE
      // comment line (starts with ':'), which clients ignore.
      await writer.write(encoder.encode(': stream-open\n\n'));

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
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
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`));
              }
              if (parsed.type === 'message_stop') {
                await writer.write(encoder.encode(`data: [DONE]\n\n`));
              }
            } catch (e) {}
          }
        }
        await writer.write(encoder.encode(`data: [DONE]\n\n`));
      } catch (e) {}
      await writer.close();
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        // no-transform stops proxies from compressing/buffering the stream;
        // X-Accel-Buffering: no disables nginx-style proxy buffering. Both
        // ensure deltas reach the client as they're produced, so voice can
        // start on the first sentence instead of after the whole reply.
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
