import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import type {
  FinishReason,
  LanguageModelUsage,
  ToolSet,
  UIMessage,
  UIMessageChunk,
} from "ai"
import { Deferred, Effect, Option, pipe, Ref, Stream } from "effect"
import { cleanupPrompt } from "./cleanup.js"
import {
  addUsage,
  buildAssistantMessage,
  EMPTY_USAGE,
  extractText,
  extractToolCalls,
  prepareTools,
  toFinishReason,
  toUIChunk,
  v3UsageToUsage,
} from "./convert.js"
import { ContextOverflowError, StreamError } from "./errors.js"
import { toLanguageModelPrompt } from "./prompt.js"
import { MessageQueue } from "./services/MessageQueue.js"
import { StopSignal } from "./services/StopSignal.js"
import { Streaming } from "./services/Streaming.js"
import { fromReadableStream } from "./stream.js"
import { executeToolCalls } from "./tools.js"
import type {
  AgentHooks,
  CallSettings,
  ExecuteToolsFn,
  LoopFinishReason,
  LoopResult,
  PrepareStepFn,
  StepConfig,
  StepContext,
  StepResult,
} from "./types.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LoopConfig {
  model: LanguageModelV3
  /** Identifies the conversation. Included in every StreamChunk. */
  conversationId: string
  /** Correlates streaming chunks with the persisted message. Auto-generated if omitted. */
  responseId?: string
  system?: string
  tools?: ToolSet
  executeTools?: boolean | ExecuteToolsFn
  initialMessages: UIMessage[]
  callSettings?: CallSettings
  prepareStep?: PrepareStepFn
  onContextOverflow?: (
    messages: UIMessage[],
    usage: LanguageModelUsage,
  ) => Effect.Effect<UIMessage[]>
  /**
   * If true, queue ACK is deferred to the caller (e.g. Agent after persistence).
   * Default false: runLoop ACKs immediately on successful completion.
   */
  deferQueueAck?: boolean
  /**
   * When not deferring ACKs, also ACK queue entries on `finishReason="aborted"`.
   * Useful for stop/interception flows where the triggering message was consumed.
   * Default: true.
   */
  ackQueueOnAbort?: boolean
  hooks?: AgentHooks
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface LoopState {
  messages: UIMessage[]
  steps: StepResult[]
  totalUsage: LanguageModelUsage
}

interface StepResponse {
  parts: LanguageModelV3StreamPart[]
  finishReason: FinishReason
  usage: LanguageModelUsage
  aborted: boolean
}

/** Wraps UIMessageChunk publishing with conversationId, responseId, and seq. */
interface ChunkPublisher {
  publish: (chunk: UIMessageChunk) => Effect.Effect<void, StreamError>
}

// ---------------------------------------------------------------------------
// The tool loop
// ---------------------------------------------------------------------------

export function runLoop(
  config: LoopConfig,
): Effect.Effect<
  LoopResult,
  StreamError | ContextOverflowError,
  Streaming | MessageQueue | StopSignal
> {
  return Effect.gen(function* () {
    const streamingService = yield* Effect.serviceOption(Streaming)
    const messageQueue = yield* Effect.serviceOption(MessageQueue)
    const stopSignal = yield* Effect.serviceOption(StopSignal)

    let responseId =
      config.responseId ??
      `kai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    let seq = 0

    function newResponseId(): string {
      responseId = `kai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      seq = 0
      return responseId
    }

    // Build a publisher that wraps each UIMessageChunk in a StreamChunk
    const publisher: ChunkPublisher | null = Option.isSome(streamingService)
      ? {
          publish: (chunk: UIMessageChunk) =>
            streamingService.value.publish({
              conversationId: config.conversationId,
              responseId,
              chunk,
              seq: seq++,
            }),
        }
      : null

    const state = yield* Ref.make<LoopState>({
      messages: config.initialMessages,
      steps: [],
      totalUsage: EMPTY_USAGE,
    })

    // Abort controller shared across streaming + tool execution per turn.
    // When the stop signal fires, this aborts both the model stream AND any running tools.
    const turnAbort = new AbortController()

    // Wire stop signal to the turn abort controller.
    // Fire-and-forget: the fiber lives for the duration of the loop.
    if (Option.isSome(stopSignal)) {
      yield* pipe(
        stopSignal.value.wait(),
        Effect.tap(() => Effect.sync(() => turnAbort.abort())),
        Effect.fork,
      )
    }

    let loopFinishReason: LoopFinishReason = "stop"
    let running = true
    let lastToolCallIds = new Set<string>() // stall detection
    let streamErrored = false // track if any step had a stream error
    let nudgeAttempts = 0 // max 1 nudge for premature stops
    const MAX_NUDGE_ATTEMPTS = 1

    while (running) {
      const currentState = yield* Ref.get(state)
      const stepNumber = currentState.steps.length

      // Check stop signal (persistent check between turns)
      if (Option.isSome(stopSignal)) {
        const stopped = yield* stopSignal.value.check()
        if (stopped) {
          loopFinishReason = "aborted"
          break
        }
      }

      // Check if abort was triggered during a previous tool execution
      if (turnAbort.signal.aborted) {
        loopFinishReason = "aborted"
        break
      }

      // Resolve per-step config
      const stepConfig = config.prepareStep
        ? yield* resolveStepConfig(config.prepareStep, {
            stepNumber,
            steps: currentState.steps,
            messages: currentState.messages,
          })
        : undefined

      const stepModel = stepConfig?.model ?? config.model
      const tools = stepConfig?.tools ?? config.tools ?? {}
      const system = stepConfig?.system ?? config.system

      if (config.hooks?.onStepStart) yield* config.hooks.onStepStart(stepNumber)

      // Stream one LLM call
      const stepStart = Date.now()
      const response = yield* streamStepWithRetry(
        stepModel,
        system,
        tools,
        currentState.messages,
        config.callSettings,
        turnAbort,
        publisher,
      )
      const stepDuration = Date.now() - stepStart

      yield* Ref.update(state, (s) => ({
        ...s,
        totalUsage: addUsage(s.totalUsage, response.usage),
      }))

      if (response.aborted) {
        loopFinishReason = "aborted"
        break
      }

      // Track if any step had errors (for watchdog nudge)
      if (response.parts.some((p) => p.type === "error")) {
        streamErrored = true
      }

      const text = extractText(response.parts)
      const toolCalls = extractToolCalls(response.parts)
      const { finishReason } = response

      // -- Tool calls ---------------------------------------------------------

      if (finishReason === "tool-calls" || toolCalls.length > 0) {
        // Stall detection: if the model returns the exact same tool call IDs
        // as the previous step, it's stuck in an infinite loop
        const currentIds = new Set(toolCalls.map((tc) => tc.toolCallId))
        if (
          stepNumber > 0 &&
          currentIds.size > 0 &&
          currentIds.size === lastToolCallIds.size &&
          [...currentIds].every((id) => lastToolCallIds.has(id))
        ) {
          loopFinishReason = "error"
          break
        }
        lastToolCallIds = currentIds

        const mode = config.executeTools ?? true

        if (mode === false) {
          const step = makeStep(
            stepNumber,
            finishReason,
            text,
            [],
            response.usage,
            stepDuration,
          )
          yield* finishStepAndUpdate(state, step, config.hooks)
          // Append assistant message with pending tool calls so the
          // handoff receiver has the full conversation history
          yield* Ref.update(state, (s) => ({
            ...s,
            messages: [
              ...s.messages,
              buildAssistantMessage(text, toolCalls, undefined, responseId),
            ],
          }))
          loopFinishReason = "tool-calls"
          break
        }

        // Execute tools with the shared abort signal so stop cancels tools too
        let toolResults =
          typeof mode === "function"
            ? yield* mode(toolCalls, tools, turnAbort.signal)
            : yield* executeToolCalls(
                tools,
                toolCalls,
                currentState.messages,
                turnAbort.signal,
              )

        // If abort fired during tool execution, normalize abort errors
        // so the model sees "Stopped by user" instead of raw DOMException
        if (turnAbort.signal.aborted) {
          toolResults = toolResults.map((tr) =>
            tr.isError && isAbortError(tr.output)
              ? { ...tr, output: "Stopped by user" }
              : tr,
          )
        }

        // Publish tool results so frontend sees them in real-time
        if (publisher) {
          for (const tr of toolResults) {
            yield* publisher.publish(
              tr.isError
                ? {
                    type: "tool-output-error",
                    toolCallId: tr.toolCallId,
                    errorText: String(tr.output),
                  }
                : {
                    type: "tool-output-available",
                    toolCallId: tr.toolCallId,
                    output: tr.output,
                  },
            )
          }
        }

        if (config.hooks) {
          for (const tc of toolCalls) {
            if (config.hooks.onToolCall) yield* config.hooks.onToolCall(tc)
          }
          for (const tr of toolResults) {
            if (config.hooks.onToolResult) yield* config.hooks.onToolResult(tr)
          }
        }

        const step = makeStep(
          stepNumber,
          finishReason,
          text,
          toolResults,
          response.usage,
          stepDuration,
        )
        yield* finishStepAndUpdate(state, step, config.hooks)
        yield* Ref.update(state, (s) => ({
          ...s,
          messages: [
            ...s.messages,
            buildAssistantMessage(text, toolCalls, toolResults, responseId),
          ],
        }))

        // If aborted during tools, stop the loop
        if (turnAbort.signal.aborted) {
          loopFinishReason = "aborted"
          break
        }

        yield* drainQueuedMessages(messageQueue, state)
        continue
      }

      // -- Stop ---------------------------------------------------------------

      if (finishReason === "stop") {
        const step = makeStep(
          stepNumber,
          finishReason,
          text,
          [],
          response.usage,
          stepDuration,
        )
        yield* finishStepAndUpdate(state, step, config.hooks)
        yield* Ref.update(state, (s) => ({
          ...s,
          messages: [
            ...s.messages,
            buildAssistantMessage(text, [], undefined, responseId),
          ],
        }))

        if (Option.isSome(messageQueue)) {
          const queued = yield* messageQueue.value.drain()
          if (queued.length > 0) {
            // Finish the current response before starting the next
            if (publisher) {
              yield* publisher.publish({ type: "finish", finishReason: "stop" })
            }
            // New responseId for the next assistant message
            newResponseId()

            yield* Ref.update(state, (s) => ({
              ...s,
              messages: [...s.messages, ...queued],
            }))
            continue
          }
        }

        // Watchdog nudge: if a previous step had errors and the model
        // stopped without tool calls, it may have given up prematurely.
        // Inject a nudge message and retry once.
        if (
          streamErrored &&
          toolCalls.length === 0 &&
          nudgeAttempts < MAX_NUDGE_ATTEMPTS
        ) {
          nudgeAttempts++
          yield* Ref.update(state, (s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: `kai_nudge_${Date.now()}`,
                role: "user" as const,
                parts: [
                  {
                    type: "text" as const,
                    text: "You were interrupted and may have stopped prematurely. If the task is not complete, continue working. If you have genuinely finished, confirm the result.",
                  },
                ],
              } satisfies UIMessage,
            ],
          }))
          continue
        }

        loopFinishReason = "stop"
        running = false

        // -- Context overflow ---------------------------------------------------
      } else if (finishReason === "length") {
        if (config.onContextOverflow) {
          const s = yield* Ref.get(state)
          const compacted = yield* config.onContextOverflow(
            s.messages,
            response.usage,
          )
          yield* Ref.update(state, (s) => ({ ...s, messages: compacted }))
          continue
        }
        yield* Effect.fail(new ContextOverflowError({ usage: response.usage }))

        // -- Error / other ------------------------------------------------------
      } else {
        const step = makeStep(
          stepNumber,
          finishReason,
          text,
          [],
          response.usage,
          stepDuration,
        )
        yield* finishStepAndUpdate(state, step, config.hooks)
        if (text) {
          yield* Ref.update(state, (s) => ({
            ...s,
            messages: [
              ...s.messages,
              buildAssistantMessage(text, [], undefined, responseId),
            ],
          }))
        }
        loopFinishReason = "error"
        running = false
      }
    }

    // Emit finish chunk so frontend knows the stream is done and can
    // expect the persisted message in Convex with this responseId.
    if (publisher && loopFinishReason !== "aborted") {
      yield* publisher.publish({
        type: "finish",
        finishReason: loopFinishReason,
      })
    }

    // ACK queue entries only after a successful loop completion.
    // Callers can defer this (e.g. to ACK only after persistence succeeds).
    const shouldAckQueue =
      loopFinishReason === "stop" ||
      loopFinishReason === "tool-calls" ||
      (loopFinishReason === "aborted" && (config.ackQueueOnAbort ?? true))
    if (
      shouldAckQueue &&
      !config.deferQueueAck &&
      Option.isSome(messageQueue) &&
      messageQueue.value.ack
    ) {
      yield* messageQueue.value.ack()
    }

    const final = yield* Ref.get(state)
    return {
      responseId,
      messages: final.messages,
      steps: final.steps,
      totalUsage: final.totalUsage,
      finishReason: loopFinishReason,
    } satisfies LoopResult
  })
}

// ---------------------------------------------------------------------------
// Stream a single LLM call with stop signal support
// ---------------------------------------------------------------------------

function streamStepWithRetry(
  model: LanguageModelV3,
  system: string | undefined,
  tools: ToolSet,
  messages: UIMessage[],
  callSettings: CallSettings | undefined,
  abortController: AbortController,
  publisher: ChunkPublisher | null,
): Effect.Effect<StepResponse, StreamError> {
  return Effect.gen(function* () {
    const maxAttempts = Math.max(1, callSettings?.streamRetry?.maxAttempts ?? 3)
    const baseDelayMs = Math.max(
      0,
      callSettings?.streamRetry?.baseDelayMs ?? 750,
    )
    const maxDelayMs = Math.max(
      baseDelayMs,
      callSettings?.streamRetry?.maxDelayMs ?? 5000,
    )

    let attempt = 1

    while (true) {
      const result = yield* Effect.either(
        streamStep(
          model,
          system,
          tools,
          messages,
          callSettings,
          abortController,
          publisher,
        ),
      )

      if (result._tag === "Right") {
        return result.right
      }

      const error = result.left
      const shouldRetry =
        !abortController.signal.aborted &&
        attempt < maxAttempts &&
        isTransientStreamError(error)

      if (!shouldRetry) {
        return yield* Effect.fail(error)
      }

      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      yield* Effect.promise(() =>
        sleepWithAbort(delayMs, abortController.signal),
      )
      attempt++
    }
  })
}

/**
 * Stream a single LLM call. Aborts immediately when `abortController` is signaled.
 * The same AbortController is shared with tool execution at the loop level,
 * so a stop signal cancels both streaming and tools.
 */
function streamStep(
  model: LanguageModelV3,
  system: string | undefined,
  tools: ToolSet,
  messages: UIMessage[],
  callSettings: CallSettings | undefined,
  abortController: AbortController,
  publisher: ChunkPublisher | null,
): Effect.Effect<StepResponse, StreamError> {
  return Effect.gen(function* () {
    const prompt = yield* Effect.promise(() =>
      toLanguageModelPrompt(system, messages),
    )
    // Fix corrupted history before sending to model
    cleanupPrompt(prompt)

    const { tools: modelTools, toolChoice } = yield* Effect.promise(() =>
      prepareTools(tools),
    )

    // If abort fires during the HTTP request setup, doStream rejects.
    // Treat that as an abort, not an error.
    const streamResult = yield* Effect.tryPromise({
      try: () =>
        model.doStream({
          prompt,
          tools: modelTools,
          toolChoice,
          abortSignal: abortController.signal,
          maxOutputTokens: callSettings?.maxOutputTokens,
          temperature: callSettings?.temperature,
          topP: callSettings?.topP,
          topK: callSettings?.topK,
          stopSequences: callSettings?.stopSequences,
        }),
      catch: (e) => new StreamError({ cause: e }),
    }).pipe(
      Effect.catchAll((err) => {
        if (abortController.signal.aborted) {
          return Effect.succeed(null)
        }
        return Effect.fail(err)
      }),
    )

    if (streamResult === null) {
      return {
        parts: [],
        finishReason: toFinishReason("other"),
        usage: EMPTY_USAGE,
        aborted: true,
      }
    }

    const { stream } = streamResult

    // Use a Deferred that resolves when the abort signal fires.
    // Stream.interruptWhen will stop consuming the stream.
    const abortDeferred = yield* Deferred.make<void>()
    if (abortController.signal.aborted) {
      yield* Deferred.succeed(abortDeferred, undefined)
    } else {
      abortController.signal.addEventListener(
        "abort",
        () => {
          Effect.runSync(Deferred.succeed(abortDeferred, undefined))
        },
        { once: true },
      )
    }

    const parts: LanguageModelV3StreamPart[] = []
    let finishReason: FinishReason = "other"
    let usage: LanguageModelUsage = EMPTY_USAGE

    const consume = pipe(
      fromReadableStream(stream),
      Stream.tap((part) =>
        Effect.gen(function* () {
          parts.push(part)
          if (part.type === "finish") {
            finishReason = toFinishReason(part.finishReason.unified)
            usage = v3UsageToUsage(part.usage)
          }
          if (publisher) {
            const chunk = toUIChunk(part)
            if (chunk) yield* publisher.publish(chunk)
          }
        }),
      ),
      Stream.interruptWhen(Deferred.await(abortDeferred)),
      Stream.runDrain,
    )

    yield* pipe(
      consume,
      Effect.catchAllCause(() => Effect.void),
    )

    const wasAborted = abortController.signal.aborted

    return {
      parts,
      finishReason: wasAborted ? toFinishReason("other") : finishReason,
      usage,
      aborted: wasAborted,
    }
  })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function resolveStepConfig(
  prepareStep: PrepareStepFn,
  ctx: StepContext,
): Effect.Effect<StepConfig> {
  const result = prepareStep(ctx)
  return Effect.isEffect(result) ? result : Effect.succeed(result)
}

function makeStep(
  stepNumber: number,
  finishReason: FinishReason,
  text: string,
  toolCalls: StepResult["toolCalls"],
  usage: LanguageModelUsage,
  durationMs: number,
): StepResult {
  return { stepNumber, finishReason, text, toolCalls, usage, durationMs }
}

function finishStepAndUpdate(
  state: Ref.Ref<LoopState>,
  step: StepResult,
  hooks: AgentHooks | undefined,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (hooks?.onStepFinish) yield* hooks.onStepFinish(step)
    yield* Ref.update(state, (s) => ({ ...s, steps: [...s.steps, step] }))
  })
}

function isAbortError(value: unknown): boolean {
  if (value instanceof DOMException && value.name === "AbortError") return true
  if (value instanceof Error && value.name === "AbortError") return true
  if (value instanceof Error && value.message.includes("aborted")) return true
  return false
}

function isTransientStreamError(error: StreamError): boolean {
  const candidates = collectErrorCandidates(error.cause)

  for (const candidate of candidates) {
    const statusCode = getStatusCode(candidate)
    if (
      statusCode &&
      [408, 409, 425, 429, 500, 502, 503, 504].includes(statusCode)
    ) {
      return true
    }

    if (isRetryableFlag(candidate)) return true

    const message = getMessage(candidate).toLowerCase()
    if (
      message.includes("internal server error") ||
      message.includes("rate limit") ||
      message.includes("temporarily unavailable") ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("overloaded")
    ) {
      return true
    }
  }

  return false
}

function collectErrorCandidates(cause: unknown): unknown[] {
  const out: unknown[] = []
  const stack: unknown[] = [cause]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || current === null) continue
    if (typeof current === "object") {
      if (seen.has(current)) continue
      seen.add(current)
    }

    out.push(current)

    if (!isRecord(current)) continue

    if (current.cause !== undefined) {
      stack.push(current.cause)
    }
    if (Array.isArray(current.errors)) {
      for (const nested of current.errors) stack.push(nested)
    }
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      const nested = (current as Record<symbol, unknown>)[symbol]
      if (nested !== undefined) stack.push(nested)
    }
  }

  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getStatusCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const statusCode = value.statusCode
  if (typeof statusCode === "number") return statusCode
  const status = value.status
  if (typeof status === "number") return status
  return undefined
}

function isRetryableFlag(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.isRetryable === true
}

function getMessage(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message
  if (!isRecord(value)) return ""
  const message = value.message
  if (typeof message === "string") return message
  return ""
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)

    const onAbort = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function drainQueuedMessages(
  messageQueue: Option.Option<MessageQueue["Type"]>,
  state: Ref.Ref<LoopState>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (Option.isNone(messageQueue)) return
    const queued = yield* messageQueue.value.drain()
    if (queued.length === 0) return
    yield* Ref.update(state, (s) => ({
      ...s,
      messages: [...s.messages, ...queued],
    }))
  })
}
