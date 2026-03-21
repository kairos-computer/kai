import type { UIMessage } from "ai"
import { Context, Effect, Layer } from "effect"

export class MessageQueue extends Context.Tag("kai/MessageQueue")<
  MessageQueue,
  {
    /** Non-blocking: return all queued messages (empty array if none). */
    readonly drain: () => Effect.Effect<UIMessage[]>
    /** Blocking: wait for the next message. */
    readonly wait: () => Effect.Effect<UIMessage>
    /**
     * Optional deferred ACK hook for queue adapters that support at-least-once
     * delivery. Implementations should ACK messages consumed by drain()/wait().
     */
    readonly ack?: () => Effect.Effect<void>
  }
>() {}

export const NoopMessageQueueLayer = Layer.succeed(MessageQueue, {
  drain: () => Effect.succeed([]),
  wait: () => Effect.never, // blocks forever (no messages)
})
