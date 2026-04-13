/**
 * Conversion utilities between AI SDK provider types (V3) and
 * the higher-level AI SDK types (LanguageModelUsage, FinishReason, UIMessage, UIMessageChunk).
 *
 * These bridge the gap between model.doStream() output and what kai exposes.
 */

import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type {
  FinishReason,
  LanguageModelUsage,
  ToolSet,
  UIMessage,
  UIMessageChunk,
} from "ai"
import { prepareToolsAndToolChoice } from "ai/internal"
import type { ParsedToolCall, ToolCallResult } from "./types.js"

// -- FinishReason -----------------------------------------------------------

const FINISH_REASON_MAP: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  "content-filter": "content-filter",
  "tool-calls": "tool-calls",
  error: "error",
  other: "other",
}

export function toFinishReason(raw: string): FinishReason {
  return FINISH_REASON_MAP[raw] ?? "other"
}

// -- Usage ------------------------------------------------------------------

export const EMPTY_USAGE: LanguageModelUsage = {
  inputTokens: undefined,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: undefined,
  outputTokenDetails: {
    textTokens: undefined,
    reasoningTokens: undefined,
  },
  totalTokens: undefined,
}

export function addUsage(
  a: LanguageModelUsage,
  b: LanguageModelUsage,
): LanguageModelUsage {
  const add = addOptionalNumbers
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: add(
        a.inputTokenDetails?.noCacheTokens,
        b.inputTokenDetails?.noCacheTokens,
      ),
      cacheReadTokens: add(
        a.inputTokenDetails?.cacheReadTokens,
        b.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: add(
        a.inputTokenDetails?.cacheWriteTokens,
        b.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokens: add(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: add(
        a.outputTokenDetails?.textTokens,
        b.outputTokenDetails?.textTokens,
      ),
      reasoningTokens: add(
        a.outputTokenDetails?.reasoningTokens,
        b.outputTokenDetails?.reasoningTokens,
      ),
    },
    totalTokens: add(a.totalTokens, b.totalTokens),
  }
}

export function v3UsageToUsage(v3: LanguageModelV3Usage): LanguageModelUsage {
  const add = addOptionalNumbers
  return {
    inputTokens: v3.inputTokens.total,
    inputTokenDetails: {
      noCacheTokens: v3.inputTokens.noCache,
      cacheReadTokens: v3.inputTokens.cacheRead,
      cacheWriteTokens: v3.inputTokens.cacheWrite,
    },
    outputTokens: v3.outputTokens.total,
    outputTokenDetails: {
      textTokens: v3.outputTokens.text,
      reasoningTokens: v3.outputTokens.reasoning,
    },
    totalTokens: add(v3.inputTokens.total, v3.outputTokens.total),
  }
}

function addOptionalNumbers(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

// -- ToolSet → model tools (uses AI SDK's own conversion) -------------------

/** Convert ToolSet to the model tool format using AI SDK internals. */
export async function prepareTools(tools: ToolSet) {
  return prepareToolsAndToolChoice({
    tools,
    toolChoice: undefined,
    activeTools: undefined,
  })
}

// -- Stream part extraction -------------------------------------------------

export function extractText(parts: LanguageModelV3StreamPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === "text-delta") chunks.push(part.delta)
  }
  return chunks.join("")
}

export function extractReasoning(parts: LanguageModelV3StreamPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === "reasoning-delta") chunks.push(part.delta)
  }
  return chunks.join("")
}

export function extractToolCalls(
  parts: LanguageModelV3StreamPart[],
): ParsedToolCall[] {
  // Deduplicate: providers may emit both streaming (tool-input-start/delta/end)
  // AND a final tool-call part for the same call. We keep one per toolCallId,
  // preferring the tool-call part (has fully parsed input from the provider).
  const byId = new Map<string, ParsedToolCall>()
  const pending = new Map<string, { toolName: string; chunks: string[] }>()

  for (const part of parts) {
    if (part.type === "tool-input-start") {
      pending.set(part.id, { toolName: part.toolName, chunks: [] })
    } else if (part.type === "tool-input-delta") {
      pending.get(part.id)?.chunks.push(part.delta)
    } else if (part.type === "tool-input-end") {
      const entry = pending.get(part.id)
      if (entry && !byId.has(part.id)) {
        byId.set(part.id, {
          type: "tool-call",
          toolCallId: part.id,
          toolName: entry.toolName,
          input: safeParse(entry.chunks.join("")),
        })
      }
      pending.delete(part.id)
    } else if (part.type === "tool-call") {
      // Overwrite streaming version — tool-call has provider-parsed input
      byId.set(part.toolCallId, {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input:
          typeof part.input === "string" ? safeParse(part.input) : part.input,
      })
    }
  }
  return Array.from(byId.values())
}

// -- V3 stream part → UIMessageChunk ---------------------------------------

export function toUIChunk(
  part: LanguageModelV3StreamPart,
): UIMessageChunk | null {
  switch (part.type) {
    case "text-start":
      return { type: "text-start", id: part.id }
    case "text-delta":
      return { type: "text-delta", id: part.id, delta: part.delta }
    case "text-end":
      return { type: "text-end", id: part.id }
    case "reasoning-start":
      return { type: "reasoning-start", id: part.id }
    case "reasoning-delta":
      return { type: "reasoning-delta", id: part.id, delta: part.delta }
    case "reasoning-end":
      return { type: "reasoning-end", id: part.id }
    case "tool-input-start":
      return {
        type: "tool-input-start",
        toolCallId: part.id,
        toolName: part.toolName,
      }
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: part.id,
        inputTextDelta: part.delta,
      }
    case "tool-call":
      return {
        type: "tool-input-available",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      }
    // `finish` is NOT emitted here — the loop emits a message-level finish
    // after the full turn completes (including tool execution). The per-step
    // finish from doStream() is an internal signal, not a frontend event.
    default:
      return null
  }
}

// -- Build UIMessage from step results --------------------------------------

let msgCounter = 0

/**
 * Build a UIMessage for an assistant response. Tool calls and results
 * are represented as ToolUIPart entries (type: `tool-${name}`).
 *
 * Note: UIMessage.parts is generic over the ToolSet, so we can't
 * statically verify tool part shapes without the concrete tool types.
 * The objects we build match the ToolUIPart runtime contract.
 */
export function buildAssistantMessage(
  text: string,
  toolCalls: ParsedToolCall[],
  toolResults?: ToolCallResult[],
  responseId?: string,
  reasoning?: string,
): UIMessage {
  const resultMap = new Map(
    (toolResults ?? []).map((tr) => [tr.toolCallId, tr]),
  )

  // Build parts as a plain array — tool parts match ToolUIPart at runtime
  // but can't be statically verified without the generic ToolSet parameter.
  const parts: Record<string, unknown>[] = []

  // Reasoning first (shown above text in the UI)
  if (reasoning) {
    parts.push({ type: "reasoning", text: reasoning })
  }

  if (text) {
    parts.push({ type: "text", text })
  }

  for (const tc of toolCalls) {
    const result = resultMap.get(tc.toolCallId)
    if (result?.isError) {
      parts.push({
        type: `tool-${tc.toolName}`,
        toolCallId: tc.toolCallId,
        state: "output-error",
        input: tc.input,
        errorText: String(result.output),
      })
    } else if (result) {
      parts.push({
        type: `tool-${tc.toolName}`,
        toolCallId: tc.toolCallId,
        state: "output-available",
        input: tc.input,
        output: result.output,
      })
    } else {
      parts.push({
        type: `tool-${tc.toolName}`,
        toolCallId: tc.toolCallId,
        state: "input-available",
        input: tc.input,
      })
    }
  }

  // UIMessage accepts parts as the generic UIMessagePart[] union.
  // Our plain objects satisfy the runtime contract.
  return {
    id: `kai_${Date.now()}_${++msgCounter}`,
    role: "assistant",
    parts,
    ...(responseId ? { metadata: { responseId } } : {}),
  } as UIMessage
}

// -- Helpers ----------------------------------------------------------------

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}
