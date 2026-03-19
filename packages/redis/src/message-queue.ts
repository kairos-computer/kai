import { MessageQueue } from "@kairos-computer/core"
import type { UIMessage } from "ai"
import { Effect, Layer } from "effect"
import type Redis from "ioredis"

/**
 * Redis Streams implementation of the MessageQueue service.
 * Uses XREADGROUP with consumer groups for durable message queuing.
 *
 * Stream key: `{prefix}:{conversationId}:messages`
 * Consumer group: `{groupName}` (default: `"kai-agent"`)
 *
 * Entries are XACKed after parsing. Call `ensureConsumerGroup` before use.
 */
export function RedisMessageQueueLayer(config: {
  redis: Redis
  conversationId: string
  consumerId: string
  /** Key prefix. Default: `"kai"` */
  prefix?: string
  /** Consumer group name. Default: `"kai-agent"` */
  groupName?: string
  /** Block timeout in ms for `wait()`. Default: `30000` (30s) */
  blockMs?: number
  /** Parse a raw stream entry into a UIMessage. You provide this. */
  parseMessage: (data: Record<string, string>) => UIMessage | null
}): Layer.Layer<MessageQueue> {
  const streamKey = `${config.prefix ?? "kai"}:${config.conversationId}:messages`
  const group = config.groupName ?? "kai-agent"
  const blockMs = config.blockMs ?? 30_000

  return Layer.succeed(MessageQueue, {
    // Non-blocking: read all available entries without waiting.
    // No BLOCK argument = returns immediately with whatever is available.
    drain: () =>
      Effect.promise(async () => {
        const results = await config.redis.xreadgroup(
          "GROUP",
          group,
          config.consumerId,
          "COUNT",
          "100",
          "STREAMS",
          streamKey,
          ">",
        )
        if (!results) return []
        const { messages, entryIds } = parseAndCollectIds(
          results as XReadGroupResult,
          config.parseMessage,
        )
        // ACK processed entries so they don't accumulate in the pending list
        if (entryIds.length > 0) {
          await config.redis.xack(streamKey, group, ...entryIds)
        }
        return messages
      }),

    // Blocking: wait for the next message, up to blockMs.
    // Retries on timeout until a message arrives.
    wait: () =>
      Effect.promise(async () => {
        while (true) {
          const results = await config.redis.xreadgroup(
            "GROUP",
            group,
            config.consumerId,
            "COUNT",
            "1",
            "BLOCK",
            String(blockMs),
            "STREAMS",
            streamKey,
            ">",
          )
          if (!results) continue

          const { messages, entryIds } = parseAndCollectIds(
            results as XReadGroupResult,
            config.parseMessage,
          )
          if (entryIds.length > 0) {
            await config.redis.xack(streamKey, group, ...entryIds)
          }
          if (messages.length > 0) return messages[0]
        }
      }),
  })
}

/**
 * Ensure the consumer group exists for a stream.
 * Idempotent — ignores BUSYGROUP error if group already exists.
 */
export async function ensureConsumerGroup(
  redis: Redis,
  conversationId: string,
  options?: { prefix?: string; groupName?: string },
): Promise<void> {
  const streamKey = `${options?.prefix ?? "kai"}:${conversationId}:messages`
  const group = options?.groupName ?? "kai-agent"
  try {
    await redis.xgroup("CREATE", streamKey, group, "0", "MKSTREAM")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes("BUSYGROUP")) throw err
  }
}

// ioredis XREADGROUP returns: [streamKey, [entryId, [field, value, ...]]][]
type XReadGroupResult = [string, [string, string[]][]][]

function parseAndCollectIds(
  results: XReadGroupResult,
  parseMessage: (data: Record<string, string>) => UIMessage | null,
): { messages: UIMessage[]; entryIds: string[] } {
  const messages: UIMessage[] = []
  const entryIds: string[] = []

  for (const [, entries] of results) {
    for (const [entryId, fields] of entries) {
      entryIds.push(entryId)
      const data: Record<string, string> = {}
      for (let i = 0; i < fields.length; i += 2) {
        data[fields[i]] = fields[i + 1]
      }
      const msg = parseMessage(data)
      if (msg) messages.push(msg)
    }
  }

  return { messages, entryIds }
}
