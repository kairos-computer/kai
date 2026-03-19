import type { ModelMessage, ToolSet, UIMessage } from "ai"
import { convertToModelMessages } from "ai"
import { Effect } from "effect"
import { ToolExecutionError } from "./errors.js"
import type { ParsedToolCall, ToolCallResult } from "./types.js"

/**
 * Execute a single tool call against the ToolSet.
 */
export function executeTool(
  tools: ToolSet,
  toolCall: ParsedToolCall,
  modelMessages: ModelMessage[],
  abortSignal?: AbortSignal,
): Effect.Effect<ToolCallResult, ToolExecutionError> {
  return Effect.gen(function* () {
    const tool = tools[toolCall.toolName]
    const start = Date.now()

    if (!tool?.execute) {
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output: `Tool "${toolCall.toolName}" not found or has no execute function`,
        isError: true,
        durationMs: Date.now() - start,
      }
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        tool.execute!(toolCall.input, {
          toolCallId: toolCall.toolCallId,
          messages: modelMessages,
          abortSignal: abortSignal ?? new AbortController().signal,
        }),
      catch: (cause) =>
        new ToolExecutionError({
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          cause,
        }),
    })

    return {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      output: result,
      isError: false,
      durationMs: Date.now() - start,
    }
  })
}

/**
 * Execute all tool calls concurrently. Errors are caught per-tool
 * and returned as `isError: true` results.
 */
export function executeToolCalls(
  tools: ToolSet,
  toolCalls: ParsedToolCall[],
  messages: UIMessage[],
  abortSignal?: AbortSignal,
): Effect.Effect<ToolCallResult[]> {
  return Effect.gen(function* () {
    const modelMessages = yield* Effect.promise(() =>
      convertToModelMessages(messages),
    )

    return yield* Effect.forEach(
      toolCalls,
      (tc) =>
        executeTool(tools, tc, modelMessages, abortSignal).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
              output: error.cause,
              isError: true,
              durationMs: 0,
            }),
          ),
        ),
      { concurrency: "unbounded" },
    )
  })
}
