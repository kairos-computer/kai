import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { UIMessage } from "ai"
import { tool, zodSchema } from "ai"
import { z } from "zod"
import { executeTool, executeToolCalls } from "../src/tools.js"

const weatherTool = tool({
  description: "Get the weather",
  inputSchema: zodSchema(z.object({ city: z.string() })),
  execute: async (input) => ({ temp: 72, city: input.city }),
})

const failingTool = tool({
  description: "Always fails",
  inputSchema: zodSchema(z.object({ msg: z.string() })),
  execute: async () => {
    throw new Error("Boom!")
  },
})

const noExecTool = tool({
  description: "No execute function",
  inputSchema: zodSchema(z.object({})),
})

const EMPTY_MESSAGES: UIMessage[] = []

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe("executeTool", () => {
  test("executes a tool and returns result", async () => {
    const result = await executeTool(
      { weather: weatherTool },
      { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: { city: "SF" } },
      [],
    ).pipe(Effect.runPromise)

    expect(result.toolCallId).toBe("tc1")
    expect(result.toolName).toBe("weather")
    expect(result.output).toEqual({ temp: 72, city: "SF" })
    expect(result.isError).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("returns error for unknown tool", async () => {
    const result = await executeTool(
      { weather: weatherTool },
      { type: "tool-call", toolCallId: "tc1", toolName: "nonexistent", input: {} },
      [],
    ).pipe(Effect.runPromise)

    expect(result.isError).toBe(true)
    expect(result.output).toContain("not found")
  })

  test("returns error for tool without execute", async () => {
    const result = await executeTool(
      { noExec: noExecTool },
      { type: "tool-call", toolCallId: "tc1", toolName: "noExec", input: {} },
      [],
    ).pipe(Effect.runPromise)

    expect(result.isError).toBe(true)
  })

  test("catches tool execution errors", async () => {
    const result = await executeTool(
      { fail: failingTool },
      { type: "tool-call", toolCallId: "tc1", toolName: "fail", input: { msg: "test" } },
      [],
    ).pipe(
      Effect.catchAll((e) =>
        Effect.succeed({
          toolCallId: "tc1",
          toolName: "fail",
          input: { msg: "test" },
          output: e.cause,
          isError: true,
          durationMs: 0,
        }),
      ),
      Effect.runPromise,
    )

    expect(result.isError).toBe(true)
  })

  test("passes abort signal to tool", async () => {
    let receivedSignal: AbortSignal | undefined
    const signalTool = tool({
      description: "Captures abort signal",
      inputSchema: zodSchema(z.object({})),
      execute: async (_input, { abortSignal }) => {
        receivedSignal = abortSignal
        return "ok"
      },
    })

    const controller = new AbortController()
    await executeTool(
      { signalTool },
      { type: "tool-call", toolCallId: "tc1", toolName: "signalTool", input: {} },
      [],
      controller.signal,
    ).pipe(Effect.runPromise)

    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// executeToolCalls
// ---------------------------------------------------------------------------

describe("executeToolCalls", () => {
  test("executes multiple tools concurrently", async () => {
    const results = await executeToolCalls(
      { weather: weatherTool },
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: { city: "SF" } },
        { type: "tool-call", toolCallId: "tc2", toolName: "weather", input: { city: "NYC" } },
      ],
      EMPTY_MESSAGES,
    ).pipe(Effect.runPromise)

    expect(results).toHaveLength(2)
    expect(results[0].output).toEqual({ temp: 72, city: "SF" })
    expect(results[1].output).toEqual({ temp: 72, city: "NYC" })
  })

  test("catches individual tool errors without failing the batch", async () => {
    const results = await executeToolCalls(
      { weather: weatherTool, fail: failingTool },
      [
        { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: { city: "SF" } },
        { type: "tool-call", toolCallId: "tc2", toolName: "fail", input: { msg: "test" } },
      ],
      EMPTY_MESSAGES,
    ).pipe(Effect.runPromise)

    expect(results).toHaveLength(2)
    expect(results[0].isError).toBe(false)
    expect(results[1].isError).toBe(true)
  })

  test("handles empty tool calls", async () => {
    const results = await executeToolCalls(
      { weather: weatherTool },
      [],
      EMPTY_MESSAGES,
    ).pipe(Effect.runPromise)

    expect(results).toHaveLength(0)
  })
})
