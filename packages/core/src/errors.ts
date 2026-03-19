import type { LanguageModelUsage } from "ai"
import { Data } from "effect"

export class StreamError extends Data.TaggedError("StreamError")<{
  readonly cause: unknown
}> {}

export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly toolName: string
  readonly toolCallId: string
  readonly cause: unknown
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly cause: unknown
}> {}

export class ContextOverflowError extends Data.TaggedError(
  "ContextOverflowError",
)<{
  readonly usage: LanguageModelUsage
}> {}
