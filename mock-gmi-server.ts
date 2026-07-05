const PORT = 19870
const VARIANTS = ["usage-no-choices", "empty-choices", "no-delta", "choices-null", "delta-null", "bare-usage-string", "no-choices-empty-object", "usage-before-content", "null-choice-entry"] as const
type Variant = (typeof VARIANTS)[number]

let failureCount = 0
const maxFailures = 5

const encoder = new TextEncoder()

function sse(writer: WritableStreamDefaultWriter<Uint8Array>, data: string) {
  writer.write(encoder.encode(data + "\n"))
}

function sseChunk(writer: WritableStreamDefaultWriter<Uint8Array>, obj: Record<string, unknown>) {
  sse(writer, `data: ${JSON.stringify(obj)}`)
}

function baseChunk(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "chatcmpl-mock-001",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "glm-5.2-fp8",
    ...overrides,
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ==========================================================================
// Variant generators
// ==========================================================================
const generators: Record<string, (w: WritableStreamDefaultWriter<Uint8Array>) => Promise<void>> = {
  // --- Standard OpenAI-compatible response (control) ---
  async standard(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: " world" } }] }))
    await delay(20)
    sseChunk(
      w,
      baseChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    sse(w, "data: [DONE]")
  },

  // --- Anomalous variants ---

  // A: GLM sends a chunk with usage data but no choices array
  async "usage-no-choices"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // THE ANOMALOUS CHUNK: usage but no choices
    sseChunk(w, { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
    await delay(20)
    sse(w, "data: [DONE]")
  },

  // B: Empty choices array []
  async "empty-choices"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // Empty choices with usage
    sseChunk(
      w,
      baseChunk({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    await delay(20)
    sse(w, "data: [DONE]")
  },

  // C: choices[0] has finish_reason but NO delta
  async "no-delta"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // Choice exists but has no delta field
    sseChunk(
      w,
      baseChunk({
        choices: [{ index: 0, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    sse(w, "data: [DONE]")
  },

  // D: choices is null
  async "choices-null"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // choices is null (Zod looseObject should reject this)
    sseChunk(
      w,
      baseChunk({
        choices: null as unknown as Record<string, unknown>,
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    sse(w, "data: [DONE]")
  },

  // E: delta is null
  async "delta-null"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // delta is null inside choices[0]
    sseChunk(
      w,
      baseChunk({
        choices: [{ index: 0, delta: null as unknown as Record<string, unknown>, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    sse(w, "data: [DONE]")
  },

  // F: usage field is present but as a bare string (non-object)
  async "bare-usage-string"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // usage is a string instead of object
    sseChunk(
      w,
      baseChunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: "string-instead-of-object" as unknown as Record<string, unknown>,
      }),
    )
    sse(w, "data: [DONE]")
  },

  // H: Totally empty object (no choices, no usage)
  async "no-choices-empty-object"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // Empty object - no choices at all
    sseChunk(w, { id: "chatcmpl-mock-001", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "glm-5.2-fp8" })
    sse(w, "data: [DONE]")
  },

  // Variant: usage ONLY chunk sent BEFORE any content chunks
  async "usage-before-content"(w) {
    // THE ANOMALOUS CHUNK FIRST: usage but no choices before any delta
    sseChunk(w, { model: "glm-5.2-fp8", usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
    sse(w, "data: [DONE]")
  },

  // I: choices array with a null entry
  async "null-choice-entry"(w) {
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
    await delay(20)
    sseChunk(w, baseChunk({ choices: [{ index: 0, delta: { content: "Hello world" } }] }))
    await delay(20)
    // choices[0] is null
    sseChunk(
      w,
      baseChunk({
        choices: [null],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    sse(w, "data: [DONE]")
  },
}

// ==========================================================================
// Server
// ==========================================================================

Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 })
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return new Response(JSON.stringify({ error: { message: "Not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }

    let body: { stream?: boolean; stream_options?: { include_usage?: boolean }; messages?: unknown[] }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: { message: "Invalid JSON" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }

    const variant = (url.searchParams.get("variant") || "usage-no-choices") as Variant

    console.log(`[mock-gmi] request variant=${variant} stream=${body.stream} stream_options_includeUsage=${body.stream_options?.includeUsage ?? false} messages=${body.messages?.length ?? 0}`)

    if (!body.stream) {
      // Non-streaming: return a simple JSON response
      return new Response(
        JSON.stringify({
          id: "chatcmpl-mock-001",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "glm-5.2-fp8",
          choices: [{ index: 0, message: { role: "assistant", content: "Mock response for variant: " + variant }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }

    // Streaming response
    const gen = generators[variant]
    if (!gen) {
      return new Response(JSON.stringify({ error: { message: "Unknown variant: " + variant } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    }

    // ReadableStreamDefaultController has enqueue() directly (no getWriter())
    const stream = new ReadableStream({
      async start(controller: ReadableStreamDefaultController<Uint8Array>) {
        // Wrap controller as a writer-like interface for generators
        const writerLike: WritableStreamDefaultWriter<Uint8Array> = {
          get desiredSize() { return controller.desiredSize ?? 1 },
          get closed() { return Promise.resolve(undefined) },
          get ready() { return Promise.resolve(undefined) },
          write(chunk) { controller.enqueue(chunk); return Promise.resolve() },
          close() { try { controller.close() } catch {} return Promise.resolve() },
          abort(reason?) { try { controller.error(reason) } catch {} return Promise.resolve() },
          releaseLock() {},
        } as WritableStreamDefaultWriter<Uint8Array>
        try {
          await gen(writerLike)
        } catch (err) {
          console.error("[mock-gmi] generator error:", err)
        } finally {
          try { writerLike.close() } catch {}
        }
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  },
})

console.log(`[mock-gmi] listening on http://localhost:${PORT}/v1/chat/completions`)
console.log(`[mock-gmi] health check: http://localhost:${PORT}/health`)
console.log(`[mock-gmi] variants: ${VARIANTS.join(", ")}`)
console.log(`[mock-gmi] usage: POST /v1/chat/completions?variant=<name>`)
