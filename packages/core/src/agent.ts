import type { UIMessage } from "ai"
import { Effect, Layer, Option } from "effect"
import type {
  ContextOverflowError,
  PersistenceError,
  StreamError,
} from "./errors.js"
import { runLoop } from "./loop.js"
import { MessageQueue, NoopMessageQueueLayer } from "./services/MessageQueue.js"
import { NoopPersistenceLayer, Persistence } from "./services/Persistence.js"
import { NoopStopSignalLayer, type StopSignal } from "./services/StopSignal.js"
import { NoopStreamingLayer, type Streaming } from "./services/Streaming.js"
import type { AgentConfig, LoopResult } from "./types.js"

export class Agent {
  constructor(private config: AgentConfig) {}

  /**
   * Run a conversation turn. Returns an Effect that requires
   * the relevant services to be provided via layers.
   */
  run(
    conversationId: string,
    messages: UIMessage[],
  ): Effect.Effect<
    LoopResult,
    StreamError | ContextOverflowError | PersistenceError,
    Streaming | Persistence | MessageQueue | StopSignal
  > {
    const config = this.config

    return Effect.gen(function* () {
      const persistence = yield* Effect.serviceOption(Persistence)
      const messageQueue = yield* Effect.serviceOption(MessageQueue)
      const history = Option.isSome(persistence)
        ? yield* persistence.value.loadMessages(conversationId)
        : []

      const allMessages = [...history, ...messages]

      const system =
        typeof config.system === "function"
          ? config.system({ stepNumber: 0, steps: [], messages: allMessages })
          : config.system

      const result = yield* runLoop({
        model: config.model,
        conversationId,
        system,
        tools: config.tools,
        executeTools: config.executeTools,
        initialMessages: allMessages,
        callSettings: config.callSettings,
        prepareStep: config.prepareStep,
        onContextOverflow: config.onContextOverflow,
        deferQueueAck: true,
        ackQueueOnAbort: config.ackQueueOnAbort,
        hooks: config.hooks,
      })

      if (Option.isSome(persistence)) {
        yield* persistence.value.saveMessages(
          conversationId,
          result.messages,
          result.totalUsage,
        )
      }

      const shouldAckQueue =
        result.finishReason === "stop" ||
        result.finishReason === "tool-calls" ||
        (result.finishReason === "aborted" && (config.ackQueueOnAbort ?? true))
      if (
        shouldAckQueue &&
        Option.isSome(messageQueue) &&
        messageQueue.value.ack
      ) {
        yield* messageQueue.value.ack()
      }

      return result
    })
  }

  /**
   * Convenience: run with provided layers, returns a Promise.
   */
  runPromise(
    conversationId: string,
    messages: UIMessage[],
    layers?: {
      streaming?: Layer.Layer<Streaming>
      persistence?: Layer.Layer<Persistence>
      messageQueue?: Layer.Layer<MessageQueue>
      stopSignal?: Layer.Layer<StopSignal>
    },
  ): Promise<LoopResult> {
    const layer = Layer.mergeAll(
      layers?.streaming ?? NoopStreamingLayer,
      layers?.persistence ?? NoopPersistenceLayer,
      layers?.messageQueue ?? NoopMessageQueueLayer,
      layers?.stopSignal ?? NoopStopSignalLayer,
    )

    return this.run(conversationId, messages).pipe(
      Effect.provide(layer),
      Effect.runPromise,
    )
  }
}
