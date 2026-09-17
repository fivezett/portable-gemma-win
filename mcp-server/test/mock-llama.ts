/**
 * Minimal llama-server stand-in for tests.
 * Implements only /health, /props and /v1/chat/completions (plain and streaming).
 */
export type MockRequestLog = {
  path: string;
  body: Record<string, unknown> | null;
};

export type MockLlama = {
  port: number;
  requests: MockRequestLog[];
  /** Text the mock should answer with; streamed one character per chunk */
  reply: string;
  stop: () => void;
};

export function startMockLlama(): MockLlama {
  const state: { reply: string; requests: MockRequestLog[] } = {
    reply: "Hello, this is Gemma.",
    requests: [],
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        state.requests.push({ path: url.pathname, body: null });
        return Response.json({ status: "ok" });
      }

      if (url.pathname === "/props") {
        state.requests.push({ path: url.pathname, body: null });
        return Response.json({
          model_path: "/mock/gemma-4-E4B-it-Q4_K_XL.gguf",
          default_generation_settings: { n_ctx: 4096 },
        });
      }

      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        state.requests.push({ path: url.pathname, body });

        if (body.stream === true) {
          const chunks = [...state.reply];
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              for (const piece of chunks) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`),
                );
                await Bun.sleep(1);
              }
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 12, completion_tokens: chunks.length },
                    timings: { predicted_per_second: 42.5 },
                  })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          });
        }

        return Response.json({
          choices: [{ message: { role: "assistant", content: state.reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
          timings: { predicted_per_second: 42.5 },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    port: server.port,
    requests: state.requests,
    get reply() {
      return state.reply;
    },
    set reply(value: string) {
      state.reply = value;
    },
    stop: () => server.stop(true),
  };
}
