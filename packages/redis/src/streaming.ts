import type { StreamChunk } from "@kairos-computer/core"
import { StreamError, Streaming } from "@kairos-computer/core"
import { Effect, Layer } from "effect"
import type Redis from "ioredis"

/**
 * Redis pub/sub implementation of the Streaming service.
 * Publishes each StreamChunk as JSON to a user-scoped channel.
 *
 * Channel pattern: `{prefix}:{userId}:chunks`
 */
export function RedisStreamingLayer(config: {
  redis: Redis
  userId: string
  /** Key prefix. Default: `"kai"` */
  prefix?: string
}): Layer.Layer<Streaming> {
  const channel = `${config.prefix ?? "kai"}:${config.userId}:chunks`

  return Layer.succeed(Streaming, {
    publish: (chunk: StreamChunk) =>
      Effect.tryPromise({
        try: () => {
          const payload = JSON.stringify(chunk)
          return config.redis.publish(channel, payload)
        },
        catch: (cause) => new StreamError({ cause }),
      }).pipe(Effect.asVoid),
  })
}
