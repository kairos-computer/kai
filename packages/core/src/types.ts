import type { LanguageModelV3 } from "@ai-sdk/provider"
import type {
  FinishReason,
  LanguageModelUsage,
  ToolSet,
  UIMessage,
  UIMessageChunk,
} from "ai"
import type { Effect } from "effect"

// Re-export AI SDK types for convenience
export type {
  FinishReason,
  LanguageModelUsage,
  LanguageModelV3,
  ToolSet,
  UIMessage,
  UIMessageChunk,
}

// -- Stream chunk (what flows through Redis → WebSocket → frontend) ---------

/**
 * A streaming chunk wrapped with routing metadata.
 * The Streaming service publishes these. The frontend groups by responseId.
 */
export interface StreamChunk {
  conversationId: string
  responseId: string
  chunk: UIMessageChunk
  /** Monotonic sequence number for dedup and ordering. */
  seq: number
}

// -- Tool call results ------------------------------------------------------

/** Result of executing a single tool call. */
export interface ToolCallResult {
  toolCallId: string
  toolName: string
  input: unknown
  output: unknown
  isError: boolean
  durationMs: number
}

/** A tool call parsed from the model response. */
export interface ParsedToolCall {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: unknown
}

// -- Step results -----------------------------------------------------------

/** Result of a single LLM call + any tool execution that followed. */
export interface StepResult {
  stepNumber: number
  finishReason: FinishReason
  text: string
  toolCalls: ToolCallResult[]
  usage: LanguageModelUsage
  durationMs: number
}

// -- Step config (returned by prepareStep) ----------------------------------

/** Passed to `prepareStep`, hooks, and system prompt functions. */
export interface StepContext {
  stepNumber: number
  steps: StepResult[]
  messages: UIMessage[]
}

/** Override model, tools, or system prompt for a single step. */
export interface StepConfig {
  model?: LanguageModelV3
  tools?: ToolSet
  system?: string
}

// -- Loop result ------------------------------------------------------------

/**
 * - `"stop"`: model finished naturally
 * - `"tool-calls"`: model wants tool execution but `executeTools` is `false`
 * - `"aborted"`: stopped by external signal
 * - `"error"`: model returned an error finish reason
 */
export type LoopFinishReason = "stop" | "aborted" | "error" | "tool-calls"

/** Final result of a complete agent run. */
export interface LoopResult {
  responseId: string
  messages: UIMessage[]
  steps: StepResult[]
  totalUsage: LanguageModelUsage
  finishReason: LoopFinishReason
}

// -- Agent config -----------------------------------------------------------

/**
 * Called before each LLM step. Return a partial config to override
 * the model, tools, or system prompt for that step.
 */
export type PrepareStepFn = (
  ctx: StepContext,
) => Effect.Effect<StepConfig> | StepConfig

export interface CallSettings {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: string[]
  providerOptions?: Record<string, Record<string, unknown>>
}

/**
 * Controls how tool calls are handled:
 * - `true` (default): auto-execute all tools, continue the loop
 * - `false`: stop the loop and return with pending tool call parts in messages
 * - function: you provide custom execution logic, loop continues with your results
 */
export type ExecuteToolsFn = (
  toolCalls: ParsedToolCall[],
  tools: ToolSet,
  abortSignal?: AbortSignal,
) => Effect.Effect<ToolCallResult[]>

export interface AgentConfig {
  /** Any AI SDK LanguageModelV3 provider (Anthropic, OpenAI, Bedrock, etc.). */
  model: LanguageModelV3
  /** Static string or dynamic function called once at the start. */
  system?: string | ((ctx: StepContext) => string)
  /** Tools available to the model. Define with `tool()` from `ai`. */
  tools?: ToolSet
  /** How to handle tool calls. Default: `true` (auto-execute). */
  executeTools?: boolean | ExecuteToolsFn
  /** Override model/tools/system per step. */
  prepareStep?: PrepareStepFn
  /** Model call settings (temperature, max tokens, etc.). */
  callSettings?: CallSettings
  /** Called when `finishReason` is `"length"`. Return compacted messages to continue. */
  onContextOverflow?: (messages: UIMessage[], usage: LanguageModelUsage) => Effect.Effect<UIMessage[]>
  /** Lifecycle hooks. */
  hooks?: AgentHooks
}

export interface AgentHooks {
  onStepStart?: (stepNumber: number) => Effect.Effect<void>
  onStepFinish?: (result: StepResult) => Effect.Effect<void>
  onToolCall?: (toolCall: ParsedToolCall) => Effect.Effect<void>
  onToolResult?: (result: ToolCallResult) => Effect.Effect<void>
}
