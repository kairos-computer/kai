/**
 * Message cleanup utilities that run before each doStream call.
 * Fixes corrupted conversation history from interrupted streams,
 * race conditions, or partial tool execution.
 */

import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

/**
 * Patch missing tool results in the prompt to prevent provider errors.
 * When a stream is interrupted while a tool call is pending, the history
 * has an assistant tool-call with no matching tool-result. This injects
 * a synthetic error result so the model can see what happened.
 */
export function patchMissingToolResults(prompt: LanguageModelV3Prompt): void {
  // Collect all tool-call IDs from assistant messages
  const toolCallIds = new Map<string, string>() // id → toolName
  for (const msg of prompt) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (
        "type" in part &&
        part.type === "tool-call" &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string"
      ) {
        toolCallIds.set(
          part.toolCallId,
          "toolName" in part && typeof part.toolName === "string"
            ? part.toolName
            : "unknown",
        )
      }
    }
  }

  // Remove IDs that have matching tool-result
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (
        "type" in part &&
        part.type === "tool-result" &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string"
      ) {
        toolCallIds.delete(part.toolCallId)
      }
    }
  }

  if (toolCallIds.size === 0) return

  // Insert synthetic tool-result messages after assistant messages with orphaned calls
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue

    const orphans: { id: string; name: string }[] = []
    for (const part of msg.content) {
      if (
        "type" in part &&
        part.type === "tool-call" &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string" &&
        toolCallIds.has(part.toolCallId)
      ) {
        orphans.push({
          id: part.toolCallId,
          name: toolCallIds.get(part.toolCallId)!,
        })
      }
    }

    if (orphans.length === 0) continue

    prompt.splice(i + 1, 0, {
      role: "tool",
      content: orphans.map(({ id, name }) => ({
        type: "tool-result" as const,
        toolCallId: id,
        toolName: name,
        output: {
          type: "text" as const,
          value: "Tool execution was interrupted.",
        },
      })),
    })
  }
}

/**
 * Deduplicate tool-call IDs in the prompt to prevent provider errors.
 * Corrupted history can leave duplicate toolUse blocks (e.g., from
 * saving after API errors). Renames duplicates with a suffix.
 */
export function deduplicateToolIds(prompt: LanguageModelV3Prompt): void {
  const seenIds = new Set<string>()
  const renames = new Map<string, string[]>()
  let counter = 0

  // Pass 1: rename duplicate tool-call IDs in assistant messages
  for (const msg of prompt) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue

    for (const part of msg.content) {
      if (
        !("type" in part) ||
        part.type !== "tool-call" ||
        !("toolCallId" in part) ||
        typeof part.toolCallId !== "string"
      ) {
        continue
      }

      if (seenIds.has(part.toolCallId)) {
        const originalId = part.toolCallId
        const newId = `${originalId}-dedup-${++counter}`
        ;(part as { toolCallId: string }).toolCallId = newId

        if (!renames.has(originalId)) renames.set(originalId, [])
        renames.get(originalId)!.push(newId)
      } else {
        seenIds.add(part.toolCallId)
      }
    }
  }

  if (renames.size === 0) return

  // Pass 2: rename matching tool-result IDs
  const resultCounts = new Map<string, number>()
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue

    for (const part of msg.content) {
      if (
        !("type" in part) ||
        part.type !== "tool-result" ||
        !("toolCallId" in part) ||
        typeof part.toolCallId !== "string"
      ) {
        continue
      }

      const originalId = part.toolCallId
      const newIds = renames.get(originalId)
      if (!newIds) continue

      const count = resultCounts.get(originalId) ?? 0
      resultCounts.set(originalId, count + 1)

      // First occurrence is the original (kept as-is), subsequent match renames
      if (count > 0 && count - 1 < newIds.length) {
        ;(part as { toolCallId: string }).toolCallId = newIds[count - 1]
      }
    }
  }
}

/**
 * Run all cleanup steps on a prompt before sending to the model.
 */
export function cleanupPrompt(prompt: LanguageModelV3Prompt): void {
  deduplicateToolIds(prompt)
  patchMissingToolResults(prompt)
}
