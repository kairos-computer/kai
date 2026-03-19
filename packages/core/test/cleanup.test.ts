import { describe, expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import {
  cleanupPrompt,
  patchMissingToolResults,
  deduplicateToolIds,
} from "../src/cleanup.js"

describe("patchMissingToolResults", () => {
  test("injects synthetic result for orphaned tool call", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: { city: "SF" } },
        ],
      },
      // No tool message — tc1 is orphaned
    ]

    patchMissingToolResults(prompt)

    expect(prompt).toHaveLength(3) // user + assistant + injected tool
    expect(prompt[2].role).toBe("tool")
    const toolContent = prompt[2].content as Array<Record<string, unknown>>
    expect(toolContent[0].toolCallId).toBe("tc1")
    expect(toolContent[0].type).toBe("tool-result")
  })

  test("does nothing when all tool calls have results", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "weather", output: { type: "text", value: "72F" } },
        ],
      },
    ]

    const before = prompt.length
    patchMissingToolResults(prompt)
    expect(prompt).toHaveLength(before)
  })

  test("handles multiple orphaned calls in one message", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
          { type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} },
        ],
      },
    ]

    patchMissingToolResults(prompt)

    expect(prompt).toHaveLength(2)
    const toolContent = prompt[1].content as Array<Record<string, unknown>>
    expect(toolContent).toHaveLength(2)
    expect(toolContent[0].toolCallId).toBe("tc1")
    expect(toolContent[1].toolCallId).toBe("tc2")
  })
})

describe("deduplicateToolIds", () => {
  test("renames duplicate tool-call IDs", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "weather", output: { type: "text", value: "ok" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "weather", input: {} }, // duplicate!
        ],
      },
    ]

    deduplicateToolIds(prompt)

    const firstCall = (prompt[0].content as Array<Record<string, unknown>>)[0]
    const secondCall = (prompt[2].content as Array<Record<string, unknown>>)[0]
    expect(firstCall.toolCallId).toBe("tc1") // original kept
    expect(secondCall.toolCallId).not.toBe("tc1") // renamed
    expect((secondCall.toolCallId as string).startsWith("tc1-dedup-")).toBe(true)
  })

  test("does nothing when no duplicates", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
          { type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} },
        ],
      },
    ]

    deduplicateToolIds(prompt)

    const content = prompt[0].content as Array<Record<string, unknown>>
    expect(content[0].toolCallId).toBe("tc1")
    expect(content[1].toolCallId).toBe("tc2")
  })
})

describe("cleanupPrompt", () => {
  test("runs both dedup and patch", () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc1", toolName: "a", output: { type: "text", value: "ok" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "a", input: {} }, // duplicate
          { type: "tool-call", toolCallId: "tc2", toolName: "b", input: {} }, // orphan
        ],
      },
    ]

    cleanupPrompt(prompt)

    // tc1 duplicate renamed
    const secondAssistant = prompt[2].content as Array<Record<string, unknown>>
    expect(secondAssistant[0].toolCallId).not.toBe("tc1")
    // Both the renamed tc1 duplicate AND tc2 are orphans (no matching tool results).
    // Patch inserts a tool message after the second assistant message.
    expect(prompt).toHaveLength(4) // original 3 + injected tool message
    const injected = prompt[3].content as Array<Record<string, unknown>>
    // Should have 2 orphans patched: renamed tc1 + tc2
    expect(injected).toHaveLength(2)
    const patchedIds = injected.map((p) => p.toolCallId)
    expect(patchedIds).toContain("tc2")
    // The renamed tc1 should also be patched
    expect(patchedIds.some((id) => typeof id === "string" && id.startsWith("tc1-dedup-"))).toBe(true)
  })
})
