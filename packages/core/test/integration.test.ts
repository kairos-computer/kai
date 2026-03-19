/**
 * Integration tests against a real LLM.
 *
 * Run with:
 *   ANTHROPIC_API_KEY=sk-... bun test packages/core/test/integration.test.ts
 *
 * These are skipped by default if no API key is set.
 */

import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { UIMessage } from "ai"
import { tool, zodSchema } from "ai"
import { z } from "zod"
import { createAnthropic } from "@ai-sdk/anthropic"
import { runLoop } from "../src/loop.js"
import { Streaming, NoopStreamingLayer } from "../src/services/Streaming.js"
import { NoopMessageQueueLayer } from "../src/services/MessageQueue.js"
import { StopSignal, NoopStopSignalLayer } from "../src/services/StopSignal.js"
import type { StreamChunk } from "../src/types.js"

const apiKey = process.env.ANTHROPIC_API_KEY
const skip = !apiKey

const anthropic = apiKey
  ? createAnthropic({ apiKey })
  : undefined

const noopLayer = Layer.mergeAll(
  NoopStreamingLayer,
  NoopMessageQueueLayer,
  NoopStopSignalLayer,
)

function userMessage(text: string): UIMessage {
  return {
    id: `user_${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
}

describe.skipIf(skip)("integration: real LLM", () => {
  test("basic text response", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")

    const result = await runLoop({
      model,
      conversationId: "int-test-text",
      system: "You are a helpful assistant. Respond in one short sentence.",
      initialMessages: [userMessage("What is 2 + 2?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].text).toContain("4")
    expect(result.steps[0].usage.inputTokens).toBeGreaterThan(0)
    expect(result.steps[0].usage.outputTokens).toBeGreaterThan(0)
    expect(result.messages.length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  test("tool call and execution", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")

    const weatherTool = tool({
      description: "Get the current weather for a city",
      inputSchema: zodSchema(z.object({
        city: z.string().describe("The city name"),
      })),
      execute: async (input) => ({
        city: input.city,
        temperature: 72,
        conditions: "sunny",
      }),
    })

    const result = await runLoop({
      model,
      conversationId: "int-test-tool",
      system: "You are a helpful assistant. Use the weather tool when asked about weather.",
      tools: { weather: weatherTool },
      initialMessages: [userMessage("What's the weather in San Francisco?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps.length).toBeGreaterThanOrEqual(2)

    // First step should have tool calls
    const toolStep = result.steps.find((s) => s.toolCalls.length > 0)
    expect(toolStep).toBeDefined()
    expect(toolStep!.toolCalls[0].toolName).toBe("weather")
    expect(toolStep!.toolCalls[0].isError).toBe(false)

    // Final step should reference the weather
    const lastStep = result.steps[result.steps.length - 1]
    expect(lastStep.finishReason).toBe("stop")
    expect(lastStep.text.length).toBeGreaterThan(0)
  }, 30_000)

  test("executeTools=false stops at tool calls", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")

    const weatherTool = tool({
      description: "Get the current weather for a city",
      inputSchema: zodSchema(z.object({ city: z.string() })),
    })

    const result = await runLoop({
      model,
      conversationId: "int-test-handoff",
      system: "Always use the weather tool when asked about weather.",
      tools: { weather: weatherTool },
      executeTools: false,
      initialMessages: [userMessage("What's the weather in NYC?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("tool-calls")
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].toolCalls).toHaveLength(0) // not executed
  }, 30_000)

  test("streaming publishes chunks with correct metadata", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")
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
      conversationId: "int-test-stream",
      responseId: "resp-integration",
      system: "Say hello in one word.",
      initialMessages: [userMessage("Hi")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(chunks.length).toBeGreaterThan(0)

    // All chunks have correct metadata
    for (const chunk of chunks) {
      expect(chunk.conversationId).toBe("int-test-stream")
      expect(chunk.responseId).toBe("resp-integration")
      expect(typeof chunk.seq).toBe("number")
    }

    // Seq is monotonically increasing
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].seq).toBeGreaterThan(chunks[i - 1].seq)
    }

    // Should contain text streaming chunks
    const types = chunks.map((c) => c.chunk.type)
    expect(types).toContain("text-delta")

    // Last chunk should be finish
    expect(chunks[chunks.length - 1].chunk.type).toBe("finish")

    expect(result.responseId).toBe("resp-integration")
  }, 30_000)

  test("multi-turn conversation with tool loop", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")

    const calcTool = tool({
      description: "Calculate a math expression",
      inputSchema: zodSchema(z.object({
        expression: z.string().describe("The math expression to evaluate"),
      })),
      execute: async (input) => {
        const result = Function(`"use strict"; return (${input.expression})`)()
        return { expression: input.expression, result }
      },
    })

    const result = await runLoop({
      model,
      conversationId: "int-test-multitool",
      system: "You are a calculator assistant. Use the calc tool for any math. Be concise.",
      tools: { calc: calcTool },
      initialMessages: [userMessage("What is (15 * 7) + (22 * 3)?")],
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    // Should have at least 2 steps (tool call + final response)
    expect(result.steps.length).toBeGreaterThanOrEqual(2)
    // The answer should be 171
    const lastStep = result.steps[result.steps.length - 1]
    expect(lastStep.text).toContain("171")
  }, 30_000)

  test("prepareStep can change system prompt per step", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")
    const systemPrompts: string[] = []

    const result = await runLoop({
      model,
      conversationId: "int-test-preparestep",
      system: "You are helpful.",
      initialMessages: [userMessage("Say the word 'banana'")],
      prepareStep: (ctx) => {
        const sys = `You are helpful. This is step ${ctx.stepNumber}.`
        systemPrompts.push(sys)
        return { system: sys }
      },
    }).pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(systemPrompts).toHaveLength(1)
    expect(systemPrompts[0]).toContain("step 0")
  }, 30_000)

  test("stop signal aborts mid-stream", async () => {
    const model = anthropic!("claude-haiku-4-5-20251001")

    // Stop after 500ms
    const stopLayer = Layer.succeed(StopSignal, {
      check: () => Effect.succeed(false),
      wait: () => Effect.promise(() => new Promise((r) => setTimeout(r, 500))),
    })
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      NoopMessageQueueLayer,
      stopLayer,
    )

    const result = await runLoop({
      model,
      conversationId: "int-test-stop",
      system: "Write a very long essay about the history of computing. Be extremely detailed and verbose. Write at least 2000 words.",
      initialMessages: [userMessage("Go")],
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.finishReason).toBe("aborted")
    // Should have partial or no steps depending on how fast abort fires
    expect(result.steps.length).toBeLessThanOrEqual(1)
  }, 30_000)
})
