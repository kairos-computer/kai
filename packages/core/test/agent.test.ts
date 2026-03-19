import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { UIMessage } from "ai"
import { Agent } from "../src/agent.js"
import {
  NoopStreamingLayer,
  NoopMessageQueueLayer,
  NoopStopSignalLayer,
  Persistence,
  NoopPersistenceLayer,
} from "../src/services/index.js"
import { mockModel, textResponse } from "./mock-model.js"

function userMessage(text: string): UIMessage {
  return {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
}

describe("Agent", () => {
  test("run returns a LoopResult", async () => {
    const model = mockModel([textResponse("Hello")])
    const agent = new Agent({ model })

    const noopLayer = Layer.mergeAll(
      NoopStreamingLayer,
      NoopPersistenceLayer,
      NoopMessageQueueLayer,
      NoopStopSignalLayer,
    )

    const result = await agent
      .run("conv-1", [userMessage("Hi")])
      .pipe(Effect.provide(noopLayer), Effect.runPromise)

    expect(result.finishReason).toBe("stop")
    expect(result.steps).toHaveLength(1)
    expect(result.responseId).toBeDefined()
  })

  test("runPromise works without explicit layers", async () => {
    const model = mockModel([textResponse("Hello")])
    const agent = new Agent({ model })

    const result = await agent.runPromise("conv-1", [userMessage("Hi")])

    expect(result.finishReason).toBe("stop")
    expect(result.steps[0].text).toBe("Hello")
  })

  test("loads history from persistence", async () => {
    const model = mockModel([textResponse("I see your history")])
    const agent = new Agent({ model })

    const historyMessage: UIMessage = {
      id: "hist-1",
      role: "user",
      parts: [{ type: "text", text: "Previous message" }],
    }

    const persistenceLayer = Layer.succeed(Persistence, {
      saveMessages: () => Effect.void,
      loadMessages: () => Effect.succeed([historyMessage]),
    })
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      persistenceLayer,
      NoopMessageQueueLayer,
      NoopStopSignalLayer,
    )

    const result = await agent
      .run("conv-1", [userMessage("New message")])
      .pipe(Effect.provide(layer), Effect.runPromise)

    // Messages should include: history + new user message + assistant response
    expect(result.messages.filter((m) => m.role === "user")).toHaveLength(2)
  })

  test("saves messages to persistence after run", async () => {
    const model = mockModel([textResponse("Hello")])
    const agent = new Agent({ model })

    let savedConvId: string | undefined
    let savedMessages: UIMessage[] | undefined

    const persistenceLayer = Layer.succeed(Persistence, {
      saveMessages: (convId, msgs) => {
        savedConvId = convId
        savedMessages = msgs
        return Effect.void
      },
      loadMessages: () => Effect.succeed([]),
    })
    const layer = Layer.mergeAll(
      NoopStreamingLayer,
      persistenceLayer,
      NoopMessageQueueLayer,
      NoopStopSignalLayer,
    )

    await agent
      .run("conv-42", [userMessage("Hi")])
      .pipe(Effect.provide(layer), Effect.runPromise)

    expect(savedConvId).toBe("conv-42")
    expect(savedMessages).toBeDefined()
    expect(savedMessages!.length).toBeGreaterThan(0)
  })

  test("system prompt as function receives messages", async () => {
    const model = mockModel([textResponse("Hello")])
    let receivedMsgCount = 0

    const agent = new Agent({
      model,
      system: (ctx) => {
        receivedMsgCount = ctx.messages.length
        return "You are helpful"
      },
    })

    await agent.runPromise("conv-1", [userMessage("Hi")])

    expect(receivedMsgCount).toBe(1) // the user message
  })

  test("passes executeTools config through", async () => {
    const model = mockModel([textResponse("Hello")])
    const agent = new Agent({ model, executeTools: false })

    const result = await agent.runPromise("conv-1", [userMessage("Hi")])
    // No tool calls in a text response, so executeTools doesn't affect this
    expect(result.finishReason).toBe("stop")
  })
})
