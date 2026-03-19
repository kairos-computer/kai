import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  toFinishReason,
  addUsage,
  v3UsageToUsage,
  EMPTY_USAGE,
  extractText,
  extractToolCalls,
  toUIChunk,
  buildAssistantMessage,
} from "../src/convert.js"

// ---------------------------------------------------------------------------
// toFinishReason
// ---------------------------------------------------------------------------

describe("toFinishReason", () => {
  test("maps valid reasons", () => {
    expect(toFinishReason("stop")).toBe("stop")
    expect(toFinishReason("length")).toBe("length")
    expect(toFinishReason("tool-calls")).toBe("tool-calls")
    expect(toFinishReason("content-filter")).toBe("content-filter")
    expect(toFinishReason("error")).toBe("error")
    expect(toFinishReason("other")).toBe("other")
  })

  test("maps unknown reasons to other", () => {
    expect(toFinishReason("end_turn")).toBe("other")
    expect(toFinishReason("max_tokens")).toBe("other")
    expect(toFinishReason("")).toBe("other")
    expect(toFinishReason("garbage")).toBe("other")
  })
})

// ---------------------------------------------------------------------------
// addUsage
// ---------------------------------------------------------------------------

describe("addUsage", () => {
  test("adds two empty usages", () => {
    const result = addUsage(EMPTY_USAGE, EMPTY_USAGE)
    expect(result.inputTokens).toBeUndefined()
    expect(result.outputTokens).toBeUndefined()
    expect(result.totalTokens).toBeUndefined()
  })

  test("adds defined + undefined", () => {
    const a = { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const result = addUsage(a, EMPTY_USAGE)
    expect(result.inputTokens).toBe(10)
    expect(result.outputTokens).toBe(5)
    expect(result.totalTokens).toBe(15)
  })

  test("adds two defined usages", () => {
    const a = { ...EMPTY_USAGE, inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const b = { ...EMPTY_USAGE, inputTokens: 20, outputTokens: 10, totalTokens: 30 }
    const result = addUsage(a, b)
    expect(result.inputTokens).toBe(30)
    expect(result.outputTokens).toBe(15)
    expect(result.totalTokens).toBe(45)
  })
})

// ---------------------------------------------------------------------------
// v3UsageToUsage
// ---------------------------------------------------------------------------

describe("v3UsageToUsage", () => {
  test("converts V3 usage to SDK usage", () => {
    const v3 = {
      inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: undefined },
      outputTokens: { total: 50, text: 40, reasoning: 10 },
    }
    const result = v3UsageToUsage(v3)
    expect(result.inputTokens).toBe(100)
    expect(result.outputTokens).toBe(50)
    expect(result.totalTokens).toBe(150)
    expect(result.inputTokenDetails?.noCacheTokens).toBe(80)
    expect(result.inputTokenDetails?.cacheReadTokens).toBe(20)
    expect(result.outputTokenDetails?.textTokens).toBe(40)
    expect(result.outputTokenDetails?.reasoningTokens).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
  test("extracts text from text-delta parts", () => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "text-start", id: "t1", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: "Hello ", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: "world", providerMetadata: undefined },
      { type: "text-end", id: "t1", providerMetadata: undefined },
    ]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("returns empty string when no text parts", () => {
    expect(extractText([])).toBe("")
  })

  test("ignores non-text parts", () => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "reasoning-start", id: "r1", providerMetadata: undefined },
      { type: "reasoning-delta", id: "r1", delta: "thinking...", providerMetadata: undefined },
      { type: "reasoning-end", id: "r1", providerMetadata: undefined },
    ]
    expect(extractText(parts)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// extractToolCalls
// ---------------------------------------------------------------------------

describe("extractToolCalls", () => {
  test("extracts from tool-call part (complete)", () => {
    const parts: LanguageModelV3StreamPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "weather",
        input: JSON.stringify({ city: "SF" }),
        providerMetadata: undefined,
      } as unknown as LanguageModelV3StreamPart,
    ]
    const calls = extractToolCalls(parts)
    expect(calls).toHaveLength(1)
    expect(calls[0].toolCallId).toBe("tc1")
    expect(calls[0].toolName).toBe("weather")
    expect(calls[0].input).toEqual({ city: "SF" })
  })

  test("extracts from streaming tool-input parts", () => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "tc2", toolName: "search", providerMetadata: undefined },
      { type: "tool-input-delta", id: "tc2", delta: '{"q', providerMetadata: undefined },
      { type: "tool-input-delta", id: "tc2", delta: 'uery":"test"}', providerMetadata: undefined },
      { type: "tool-input-end", id: "tc2", providerMetadata: undefined },
    ]
    const calls = extractToolCalls(parts)
    expect(calls).toHaveLength(1)
    expect(calls[0].toolCallId).toBe("tc2")
    expect(calls[0].toolName).toBe("search")
    expect(calls[0].input).toEqual({ query: "test" })
  })

  test("handles multiple tool calls", () => {
    const parts: LanguageModelV3StreamPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc1",
        toolName: "a",
        input: "{}",
        providerMetadata: undefined,
      } as unknown as LanguageModelV3StreamPart,
      {
        type: "tool-call",
        toolCallId: "tc2",
        toolName: "b",
        input: "{}",
        providerMetadata: undefined,
      } as unknown as LanguageModelV3StreamPart,
    ]
    expect(extractToolCalls(parts)).toHaveLength(2)
  })

  test("returns empty for no tool parts", () => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "text-start", id: "t1", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: "hi", providerMetadata: undefined },
      { type: "text-end", id: "t1", providerMetadata: undefined },
    ]
    expect(extractToolCalls(parts)).toHaveLength(0)
  })

  test("handles malformed JSON in tool input", () => {
    const parts: LanguageModelV3StreamPart[] = [
      { type: "tool-input-start", id: "tc3", toolName: "bad", providerMetadata: undefined },
      { type: "tool-input-delta", id: "tc3", delta: "not json", providerMetadata: undefined },
      { type: "tool-input-end", id: "tc3", providerMetadata: undefined },
    ]
    const calls = extractToolCalls(parts)
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe("not json") // safeParse fallback
  })
})

// ---------------------------------------------------------------------------
// toUIChunk
// ---------------------------------------------------------------------------

describe("toUIChunk", () => {
  test("converts text parts", () => {
    expect(toUIChunk({ type: "text-start", id: "t1", providerMetadata: undefined }))
      .toEqual({ type: "text-start", id: "t1" })
    expect(toUIChunk({ type: "text-delta", id: "t1", delta: "hi", providerMetadata: undefined }))
      .toEqual({ type: "text-delta", id: "t1", delta: "hi" })
    expect(toUIChunk({ type: "text-end", id: "t1", providerMetadata: undefined }))
      .toEqual({ type: "text-end", id: "t1" })
  })

  test("converts reasoning parts", () => {
    expect(toUIChunk({ type: "reasoning-start", id: "r1", providerMetadata: undefined }))
      .toEqual({ type: "reasoning-start", id: "r1" })
    expect(toUIChunk({ type: "reasoning-delta", id: "r1", delta: "think", providerMetadata: undefined }))
      .toEqual({ type: "reasoning-delta", id: "r1", delta: "think" })
  })

  test("converts tool streaming parts", () => {
    expect(toUIChunk({ type: "tool-input-start", id: "tc1", toolName: "weather", providerMetadata: undefined }))
      .toEqual({ type: "tool-input-start", toolCallId: "tc1", toolName: "weather" })
    expect(toUIChunk({ type: "tool-input-delta", id: "tc1", delta: "{", providerMetadata: undefined }))
      .toEqual({ type: "tool-input-delta", toolCallId: "tc1", inputTextDelta: "{" })
  })

  test("converts tool-call to tool-input-available", () => {
    const part = {
      type: "tool-call",
      toolCallId: "tc1",
      toolName: "weather",
      input: { city: "SF" },
      providerMetadata: undefined,
    } as unknown as LanguageModelV3StreamPart
    expect(toUIChunk(part)).toEqual({
      type: "tool-input-available",
      toolCallId: "tc1",
      toolName: "weather",
      input: { city: "SF" },
    })
  })

  test("returns null for finish (loop emits its own)", () => {
    const part: LanguageModelV3StreamPart = {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    }
    expect(toUIChunk(part)).toBeNull()
  })

  test("returns null for unknown part types", () => {
    expect(toUIChunk({ type: "raw", rawValue: {} } as LanguageModelV3StreamPart)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildAssistantMessage
// ---------------------------------------------------------------------------

describe("buildAssistantMessage", () => {
  test("text-only message", () => {
    const msg = buildAssistantMessage("Hello world", [])
    expect(msg.role).toBe("assistant")
    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0]).toEqual({ type: "text", text: "Hello world" })
  })

  test("empty text is not included", () => {
    const msg = buildAssistantMessage("", [])
    expect(msg.parts).toHaveLength(0)
  })

  test("tool calls without results (executeTools=false)", () => {
    const toolCalls = [
      { type: "tool-call" as const, toolCallId: "tc1", toolName: "weather", input: { city: "SF" } },
    ]
    const msg = buildAssistantMessage("Let me check", toolCalls)
    expect(msg.parts).toHaveLength(2)
    const toolPart = msg.parts[1] as Record<string, unknown>
    expect(toolPart.type).toBe("tool-weather")
    expect(toolPart.state).toBe("input-available")
    expect(toolPart.toolCallId).toBe("tc1")
  })

  test("tool calls with successful results", () => {
    const toolCalls = [
      { type: "tool-call" as const, toolCallId: "tc1", toolName: "weather", input: { city: "SF" } },
    ]
    const toolResults = [
      { toolCallId: "tc1", toolName: "weather", input: { city: "SF" }, output: { temp: 72 }, isError: false, durationMs: 100 },
    ]
    const msg = buildAssistantMessage("", toolCalls, toolResults)
    const toolPart = msg.parts[0] as Record<string, unknown>
    expect(toolPart.state).toBe("output-available")
    expect(toolPart.output).toEqual({ temp: 72 })
  })

  test("tool calls with error results", () => {
    const toolCalls = [
      { type: "tool-call" as const, toolCallId: "tc1", toolName: "weather", input: {} },
    ]
    const toolResults = [
      { toolCallId: "tc1", toolName: "weather", input: {}, output: "Stopped by user", isError: true, durationMs: 0 },
    ]
    const msg = buildAssistantMessage("", toolCalls, toolResults)
    const toolPart = msg.parts[0] as Record<string, unknown>
    expect(toolPart.state).toBe("output-error")
    expect(toolPart.errorText).toBe("Stopped by user")
  })

  test("generates unique ids", () => {
    const msg1 = buildAssistantMessage("a", [])
    const msg2 = buildAssistantMessage("b", [])
    expect(msg1.id).not.toBe(msg2.id)
  })
})
