import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { UIMessage } from "ai"
import { tool, zodSchema } from "ai"
import { z } from "zod"
import { runLoop } from "../src/loop.js"
import { Streaming, NoopStreamingLayer } from "../src/services/Streaming.js"
import {
  MessageQueue,
  NoopMessageQueueLayer,
} from "../src/services/MessageQueue.js"
import { StopSignal, NoopStopSignalLayer } from "../src/services/StopSignal.js"
import {
  mockModel,
  slowMockModel,
  textResponse,
  toolCallResponse,
  lengthResponse,
  longTextResponse,
} from "./mock-model.js"
import type { StreamChunk } from "../src/types.js"

const noopLayer = Layer.mergeAll(
  NoopStreamingLayer,
  NoopMessageQueueLayer,
  NoopStopSignalLayer,
)

const CONV_ID = "test-conv"

function userMessage(text: string): UIMessage {
  return {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
}

const weatherTool = tool({
  description: "Get the weather",
  inputSchema: zodSchema(z.object({ city: z.string() })),
  execute: async (input) => ({ temp: 72, city: input.city }),
})

// ---------------------------------------------------------------------------
// Basic text response
// ---------------------------------------------------------------------------

describe("basic text response", () => {
  test("returns text and finishReason stop", async () => {
    const model = mockModel([textResponse("Hello world")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].text).toBe("Hello world")
    expect(result.steps[0].finishReason).toBe("stop")
    expect(model.callCount).toBe(1)
  })

  test("returns a responseId", async () => {
    const model = mockModel([textResponse("Hello")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.responseId).toBeDefined()
    expect(typeof result.responseId).toBe("string")
  })

  test("uses caller-provided responseId", async () => {
    const model = mockModel([textResponse("Hello")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      responseId: "my-custom-id",
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.responseId).toBe("my-custom-id")
  })

  test("messages include the assistant response", async () => {
    const model = mockModel([textResponse("Hello")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].role).toBe("assistant")
    // Assistant message carries responseId in metadata
    const meta = result.messages[1].metadata as Record<string, unknown> | undefined
    expect(meta?.responseId).toBe(result.responseId)
  })
})

// ---------------------------------------------------------------------------
// Tool execution loop
// ---------------------------------------------------------------------------

describe("tool execution", () => {
  test("executes tool and continues to next step", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("The weather in SF is 72°F"),
    ])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("What's the weather in SF?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].finishReason).toBe("tool-calls")
    expect(result.steps[0].toolCalls).toHaveLength(1)
    expect(result.steps[0].toolCalls[0].output).toEqual({
      temp: 72,
      city: "SF",
    })
    expect(result.steps[1].text).toBe("The weather in SF is 72°F")
    expect(model.callCount).toBe(2)
  })

  test("executeTools=false stops at tool calls (handoff)", async () => {
    const model = mockModel([toolCallResponse("weather", { city: "NYC" })])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      executeTools: false,
      initialMessages: [userMessage("Weather in NYC?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("tool-calls")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].toolCalls).toHaveLength(0) // not executed
    expect(model.callCount).toBe(1)

    // Messages must include the assistant response with pending tool calls
    // so the handoff receiver has the full conversation history
    expect(result.messages).toHaveLength(2) // user + assistant
    expect(result.messages[1].role).toBe("assistant")
    const toolPart = result.messages[1].parts.find(
      (p: Record<string, unknown>) => typeof p.type === "string" && (p.type as string).startsWith("tool-"),
    )
    expect(toolPart).toBeDefined()
    expect((toolPart as Record<string, unknown>).state).toBe("input-available")
  })

  test("custom executeTools function", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "LA" }),
      textResponse("Custom result applied"),
    ])

    const customExecute = (
      toolCalls: { toolCallId: string; toolName: string; input: unknown }[],
    ) =>
      Effect.succeed(
        toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
          output: { custom: true },
          isError: false,
          durationMs: 0,
        })),
      )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      executeTools: customExecute,
      initialMessages: [userMessage("Weather in LA?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps[0].toolCalls[0].output).toEqual({ custom: true })
  })

  test("multi-step tool loop (tool → tool → text)", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      toolCallResponse("weather", { city: "NYC" }),
      textResponse("SF is 72°F, NYC is 72°F"),
    ])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather in SF and NYC?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0].finishReason).toBe("tool-calls")
    expect(result.steps[1].finishReason).toBe("tool-calls")
    expect(result.steps[2].finishReason).toBe("stop")
    expect(model.callCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Stop signal
// ---------------------------------------------------------------------------

describe("stop signal", () => {
  test("stops before first step if signal already set", async () => {
    const model = mockModel([textResponse("Should not see this")])

    const stopLayer = Layer.succeed(StopSignal, {
      check: () => Effect.succeed(true),
      wait: () => Effect.never,
    })
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      NoopMessageQueueLayer,
      stopLayer,
    )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("aborted")
    expect(result.steps).toHaveLength(0)
    expect(model.callCount).toBe(0)
  })

  test("stops between tool steps when signal fires", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("Should not reach this"),
    ])

    // Signal is false on first check, true on second (after tool execution)
    let checkCount = 0
    const stopLayer = Layer.succeed(StopSignal, {
      check: () => Effect.succeed(++checkCount > 1),
      wait: () => Effect.never,
    })
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      NoopMessageQueueLayer,
      stopLayer,
    )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather?")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("aborted")
    expect(result.steps).toHaveLength(1) // tool step completed
    expect(model.callCount).toBe(1) // only one model call
  })

  test("no finish chunk emitted on abort", async () => {
    const model = mockModel([textResponse("Hello")])
    const chunks: StreamChunk[] = []

    const stopLayer = Layer.succeed(StopSignal, {
      check: () => Effect.succeed(true),
      wait: () => Effect.never,
    })
    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(
      streamingLayer,
      NoopMessageQueueLayer,
      stopLayer,
    )

    await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    const types = chunks.map((c) => c.chunk.type)
    expect(types).not.toContain("finish")
  })

  test("stops mid-stream when signal fires during doStream", async () => {
    // Slow model: 20 chunks with 20ms delay each = ~400ms total
    const model = slowMockModel([longTextResponse(20)], 20)
    const chunks: StreamChunk[] = []

    // Stop signal: check() returns false (don't stop before step),
    // wait() resolves after 100ms (mid-stream)
    const stopLayer = Layer.succeed(StopSignal, {
      check: () => Effect.succeed(false),
      wait: () => Effect.promise(() => new Promise((r) => setTimeout(r, 100))),
    })
    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(
      streamingLayer,
      NoopMessageQueueLayer,
      stopLayer,
    )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("aborted")
    // Should have received SOME chunks but not all 20
    const textDeltas = chunks.filter((c) => c.chunk.type === "text-delta")
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(textDeltas.length).toBeLessThan(20)
    // No finish chunk on abort
    expect(chunks.map((c) => c.chunk.type)).not.toContain("finish")
  })
})

// ---------------------------------------------------------------------------
// Message absorption (queuing)
// ---------------------------------------------------------------------------

describe("message absorption", () => {
  test("absorbs queued messages between tool steps", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("Done with both"),
    ])

    // Returns one queued message on first drain, empty after
    const mqLayer = Layer.effect(
      MessageQueue,
      Effect.gen(function* () {
        const drained = yield* Ref.make(false)
        return {
          drain: () =>
            Effect.gen(function* () {
              if (yield* Ref.get(drained)) return []
              yield* Ref.set(drained, true)
              return [userMessage("Also check NYC")]
            }),
          wait: () => Effect.never,
        }
      }),
    )
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      mqLayer,
      NoopStopSignalLayer,
    )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather in SF?")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2)
  })

  test("absorbs queued messages on stop before ending", async () => {
    const model = mockModel([
      textResponse("First response"),
      textResponse("Second response"),
    ])

    const mqLayer = Layer.effect(
      MessageQueue,
      Effect.gen(function* () {
        const drained = yield* Ref.make(false)
        return {
          drain: () =>
            Effect.gen(function* () {
              if (yield* Ref.get(drained)) return []
              yield* Ref.set(drained, true)
              return [userMessage("Follow up")]
            }),
          wait: () => Effect.never,
        }
      }),
    )
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      mqLayer,
      NoopStopSignalLayer,
    )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(2)
    expect(model.callCount).toBe(2)
  })

  test("multiple queued messages absorbed at once", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("Here's everything"),
    ])

    const mqLayer = Layer.effect(
      MessageQueue,
      Effect.gen(function* () {
        const drained = yield* Ref.make(false)
        return {
          drain: () =>
            Effect.gen(function* () {
              if (yield* Ref.get(drained)) return []
              yield* Ref.set(drained, true)
              return [userMessage("Also NYC"), userMessage("And LA")]
            }),
          wait: () => Effect.never,
        }
      }),
    )
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      mqLayer,
      NoopStopSignalLayer,
    )

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather?")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(3)
  })

  test("no absorption when queue is empty", async () => {
    const model = mockModel([textResponse("Hello")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    // Just the original user message + assistant response
    expect(result.messages).toHaveLength(2)
    expect(result.steps).toHaveLength(1)
    expect(model.callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Streaming chunks
// ---------------------------------------------------------------------------

describe("streaming", () => {
  test("publishes StreamChunks with conversationId, responseId, seq", async () => {
    const model = mockModel([textResponse("Hello")])
    const chunks: StreamChunk[] = []

    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(
      streamingLayer,
      NoopMessageQueueLayer,
      NoopStopSignalLayer,
    )

    const result = await runLoop({
      model,
      conversationId: "conv-123",
      responseId: "resp-456",
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // All chunks have correct metadata
    for (const chunk of chunks) {
      expect(chunk.conversationId).toBe("conv-123")
      expect(chunk.responseId).toBe("resp-456")
      expect(typeof chunk.seq).toBe("number")
    }

    // Seq is monotonically increasing
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].seq).toBeGreaterThan(chunks[i - 1].seq)
    }

    // Contains text chunks and finish
    const types = chunks.map((c) => c.chunk.type)
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    expect(types).toContain("finish")

    expect(result.responseId).toBe("resp-456")
  })

  test("publishes tool-output-available after tool execution", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("Done"),
    ])
    const chunks: StreamChunk[] = []

    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(
      streamingLayer,
      NoopMessageQueueLayer,
      NoopStopSignalLayer,
    )

    await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather?")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    const types = chunks.map((c) => c.chunk.type)
    expect(types).toContain("tool-input-available")
    expect(types).toContain("tool-output-available")
  })

  test("finish chunk is the last chunk emitted", async () => {
    const model = mockModel([textResponse("Hello")])
    const chunks: StreamChunk[] = []

    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(
      streamingLayer,
      NoopMessageQueueLayer,
      NoopStopSignalLayer,
    )

    await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[chunks.length - 1].chunk.type).toBe("finish")
  })
})

// ---------------------------------------------------------------------------
// Context overflow
// ---------------------------------------------------------------------------

describe("context overflow", () => {
  test("calls onContextOverflow and continues", async () => {
    const model = mockModel([lengthResponse(), textResponse("Recovered")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Long prompt")],
      onContextOverflow: (messages) => Effect.succeed(messages.slice(-1)),
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(1)
    expect(model.callCount).toBe(2)
  })

  test("fails with ContextOverflowError if no handler", async () => {
    const model = mockModel([lengthResponse()])

    const exit = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Long prompt")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromiseExit)

    expect(exit._tag).toBe("Failure")
  })
})

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

describe("hooks", () => {
  test("calls onStepStart and onStepFinish", async () => {
    const model = mockModel([textResponse("Hello")])
    const events: string[] = []

    await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
      hooks: {
        onStepStart: (n) => {
          events.push(`start:${n}`)
          return Effect.void
        },
        onStepFinish: (r) => {
          events.push(`finish:${r.stepNumber}`)
          return Effect.void
        },
      },
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(events).toEqual(["start:0", "finish:0"])
  })

  test("calls onToolCall and onToolResult", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("Done"),
    ])
    const events: string[] = []

    await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather?")],
      hooks: {
        onToolCall: (tc) => {
          events.push(`call:${tc.toolName}`)
          return Effect.void
        },
        onToolResult: (tr) => {
          events.push(`result:${tr.toolName}:${tr.isError}`)
          return Effect.void
        },
      },
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(events).toEqual(["call:weather", "result:weather:false"])
  })
})

// ---------------------------------------------------------------------------
// prepareStep
// ---------------------------------------------------------------------------

describe("prepareStep", () => {
  test("called before each step with current context", async () => {
    const model = mockModel([
      toolCallResponse("weather", { city: "SF" }),
      textResponse("Done"),
    ])
    const stepNumbers: number[] = []

    await runLoop({
      model,
      conversationId: CONV_ID,
      system: "original",
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Hi")],
      prepareStep: (ctx) => {
        stepNumbers.push(ctx.stepNumber)
        return {}
      },
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(stepNumbers).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// Stall prevention
// ---------------------------------------------------------------------------

describe("stall prevention", () => {
  test("breaks on zero-progress tool-calls loop", async () => {
    // Model keeps returning the SAME tool call ID — stall detection triggers
    const USAGE = {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    }
    const stalledResponse = [
      {
        type: "tool-call",
        toolCallId: "stuck_call_1", // same ID every time
        toolName: "weather",
        input: JSON.stringify({ city: "SF" }),
        providerMetadata: undefined,
      } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamPart,
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: USAGE,
      } as import("@ai-sdk/provider").LanguageModelV3StreamPart,
    ]

    const model = mockModel([
      stalledResponse,
      stalledResponse, // same tool call ID → stall
      stalledResponse,
    ])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      initialMessages: [userMessage("Weather?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("error")
    expect(model.callCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Watchdog nudge
// ---------------------------------------------------------------------------

describe("watchdog nudge", () => {
  test("nudges model to continue after premature stop with error", async () => {
    // First response: has an error part, then model stops
    // Second response (after nudge): model confirms it's done
    const errorResponse = [
      { type: "text-start", id: "t1", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: "partial", providerMetadata: undefined },
      { type: "text-end", id: "t1", providerMetadata: undefined },
      { type: "error", error: "something went wrong" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
      },
    ] as import("@ai-sdk/provider").LanguageModelV3StreamPart[]

    const model = mockModel([
      errorResponse,
      textResponse("I have finished the task."),
    ])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Do something")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(model.callCount).toBe(2) // original + nudge retry
    // The nudge message should be in the conversation
    const nudgeMsg = result.messages.find(
      (m) => m.role === "user" && m.parts.some(
        (p: Record<string, unknown>) => typeof p.text === "string" && (p.text as string).includes("interrupted"),
      ),
    )
    expect(nudgeMsg).toBeDefined()
  })

  test("only nudges once", async () => {
    // Model keeps erroring and stopping
    const errorResponse = [
      { type: "text-start", id: "t1", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: "oops", providerMetadata: undefined },
      { type: "text-end", id: "t1", providerMetadata: undefined },
      { type: "error", error: "bad" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
      },
    ] as import("@ai-sdk/provider").LanguageModelV3StreamPart[]

    const model = mockModel([
      errorResponse,
      errorResponse, // nudge retry also errors
      errorResponse, // would be third attempt but nudge limit is 1
    ])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Do something")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(model.callCount).toBe(2) // original + 1 nudge, then gives up
  })

  test("does not nudge on clean stop without errors", async () => {
    const model = mockModel([textResponse("All done")])

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(model.callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Response ID correctness
// ---------------------------------------------------------------------------

describe("responseId correctness", () => {
  test("new responseId when absorbing queued messages on stop", async () => {
    const model = mockModel([
      textResponse("First response"),
      textResponse("Second response"),
    ])
    const chunks: StreamChunk[] = []

    const mqLayer = Layer.effect(
      MessageQueue,
      Effect.gen(function* () {
        const drained = yield* Ref.make(false)
        return {
          drain: () =>
            Effect.gen(function* () {
              if (yield* Ref.get(drained)) return []
              yield* Ref.set(drained, true)
              return [userMessage("Follow up")]
            }),
          wait: () => Effect.never,
        }
      }),
    )
    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(streamingLayer, mqLayer, NoopStopSignalLayer)

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      responseId: "resp-first",
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    // Should have a finish chunk for the first response
    const finishChunks = chunks.filter((c) => c.chunk.type === "finish")
    expect(finishChunks.length).toBeGreaterThanOrEqual(1)

    // First response's chunks use "resp-first"
    const firstResponseChunks = chunks.filter((c) => c.responseId === "resp-first")
    expect(firstResponseChunks.length).toBeGreaterThan(0)

    // Second response's chunks use a DIFFERENT responseId
    const secondResponseChunks = chunks.filter((c) => c.responseId !== "resp-first")
    expect(secondResponseChunks.length).toBeGreaterThan(0)

    // The final result uses the LAST responseId (for the most recent message)
    expect(result.responseId).not.toBe("resp-first")
  })
})

// ---------------------------------------------------------------------------
// Finish chunk correctness
// ---------------------------------------------------------------------------

describe("finish chunk correctness", () => {
  test("finish chunk has error finishReason on model error", async () => {
    const errorResponse = [
      { type: "text-start", id: "t1", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: "partial", providerMetadata: undefined },
      { type: "text-end", id: "t1", providerMetadata: undefined },
      {
        type: "finish",
        finishReason: { unified: "error", raw: "error" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
      },
    ] as import("@ai-sdk/provider").LanguageModelV3StreamPart[]

    const model = mockModel([errorResponse])
    const chunks: StreamChunk[] = []

    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(streamingLayer, NoopMessageQueueLayer, NoopStopSignalLayer)

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("error")

    // The finish chunk should say "error", NOT "stop"
    const finishChunk = chunks.find((c) => c.chunk.type === "finish")
    expect(finishChunk).toBeDefined()
    expect((finishChunk!.chunk as { finishReason: string }).finishReason).toBe("error")
  })

  test("finish chunk has tool-calls finishReason on handoff", async () => {
    const model = mockModel([toolCallResponse("weather", { city: "SF" })])
    const chunks: StreamChunk[] = []

    const streamingLayer = Layer.succeed(Streaming, {
      publish: (chunk: StreamChunk) => {
        chunks.push(chunk)
        return Effect.void
      },
    })
    const layer = Layer.mergeAll(streamingLayer, NoopMessageQueueLayer, NoopStopSignalLayer)

    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      tools: { weather: weatherTool },
      executeTools: false,
      initialMessages: [userMessage("Weather?")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("tool-calls")

    const finishChunk = chunks.find((c) => c.chunk.type === "finish")
    expect(finishChunk).toBeDefined()
    expect((finishChunk!.chunk as { finishReason: string }).finishReason).toBe("tool-calls")
  })
})

// ---------------------------------------------------------------------------
// MessageQueue.drain() must be non-blocking
// ---------------------------------------------------------------------------

describe("drain() non-blocking behavior", () => {
  test("drain returns empty immediately when no messages", async () => {
    const model = mockModel([textResponse("Hello")])
    let drainCallCount = 0

    const mqLayer = Layer.succeed(MessageQueue, {
      drain: () => {
        drainCallCount++
        // Simulate non-blocking: returns immediately with empty
        return Effect.succeed([])
      },
      wait: () => Effect.never,
    })
    const layer = Layer.mergeAll(NoopStreamingLayer, mqLayer, NoopStopSignalLayer)

    const start = Date.now()
    const result = await runLoop({
      model,
      conversationId: CONV_ID,
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    const elapsed = Date.now() - start

    expect(result.finishReason).toBe("stop")
    // drain was called (between steps and on stop)
    expect(drainCallCount).toBeGreaterThan(0)
    // Should complete fast — if drain blocked, this would take 30s+
    expect(elapsed).toBeLessThan(5000)
  })
})
