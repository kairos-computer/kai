import { StopSignal } from "@kairos-computer/core"
import { Effect, Layer } from "effect"
import type Redis from "ioredis"

/**
 * Redis implementation of the StopSignal service.
 * Dual mechanism:
 *   1. Persistent key (GETDEL) — survives pub/sub misses between turns
 *   2. Pub/Sub channel — instant notification during streaming
 *
 * Key/channel pattern: `{prefix}:{conversationId}:stop`
 */
export function RedisStopSignalLayer(config: {
  /** Command client for GET/DEL operations. */
  redis: Redis
  /** Subscriber client (dedicated connection for pub/sub). */
  subscriber: Redis
  conversationId: string
  /** Key prefix. Default: `"kai"` */
  prefix?: string
}): Layer.Layer<StopSignal> {
  const key = `${config.prefix ?? "kai"}:${config.conversationId}:stop`

  return Layer.succeed(StopSignal, {
    check: () =>
      Effect.promise(async () => {
        const val = await config.redis.getdel(key)
        return val !== null
      }),

    wait: () =>
      Effect.async<void>((resume) => {
        let resolved = false
        const resolve = () => {
          if (resolved) return
          resolved = true
          // Remove listener before resuming to prevent leaks
          config.subscriber.removeListener("message", onMessage)
          resume(Effect.void)
        }

        // Named handler so we can remove it on cleanup
        function onMessage(channel: string) {
          if (channel === key) resolve()
        }

        // Attach listener BEFORE subscribing to avoid missing signals
        config.subscriber.on("message", onMessage)

        config.subscriber.subscribe(key).catch(() => {
          // If subscribe fails, check the persistent key as fallback
          config.redis.getdel(key).then((val) => {
            if (val !== null) resolve()
          })
        })

        // Also check persistent key immediately — signal may have
        // arrived before we subscribed
        config.redis.getdel(key).then((val) => {
          if (val !== null) resolve()
        })

        // Cleanup: remove listener and unsubscribe on Effect interruption
        return Effect.sync(() => {
          config.subscriber.removeListener("message", onMessage)
          config.subscriber.unsubscribe(key).catch(() => {})
        })
      }),
  })
}

/**
 * Publish a stop signal for a conversation.
 * Sets persistent key (30s TTL) + publishes to pub/sub channel.
 */
export async function publishStopSignal(
  redis: Redis,
  conversationId: string,
  options?: { prefix?: string },
): Promise<void> {
  const key = `${options?.prefix ?? "kai"}:${conversationId}:stop`
  await redis.set(key, "1", "EX", 30)
  await redis.publish(key, "stop")
}
