/**
 * Redis adapter integration tests.
 * Skipped automatically if Redis is not available on localhost:6379.
 *
 * Run with: bun test packages/redis/test/redis.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import Redis from "ioredis"
import { Effect } from "effect"
import type { UIMessage } from "ai"
import { Streaming, MessageQueue, StopSignal } from "@kairos-computer/core"
import type { StreamChunk } from "@kairos-computer/core"
import { RedisStreamingLayer } from "../src/streaming.js"
import {
  RedisMessageQueueLayer,
  ensureConsumerGroup,
} from "../src/message-queue.js"
import { RedisStopSignalLayer, publishStopSignal } from "../src/stop-signal.js"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"
const PREFIX = "kai-test"

// Check if Redis is available before running tests
let redisAvailable = false
try {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 1000 })
  await probe.connect()
  await probe.ping()
  await probe.quit()
  redisAvailable = true
} catch {
  redisAvailable = false
}

let redis: Redis
let subscriber: Redis

beforeAll(async () => {
  if (!redisAvailable) return
  redis = new Redis(REDIS_URL)
  subscriber = new Redis(REDIS_URL)
})

afterAll(async () => {
  if (!redisAvailable) return
  await redis.quit()
  await subscriber.quit()
})

beforeEach(async () => {
  // Clean up test keys
  const keys = await redis.keys(`${PREFIX}:*`)
  if (keys.length > 0) {
    await redis.del(...keys)
  }
})

function userMessage(text: string): UIMessage {
  return {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe.skipIf(!redisAvailable)("RedisStreamingLayer", () => {
  test("publishes StreamChunk as JSON to pub/sub channel", async () => {
    const userId = "test-user-1"
    const channel = `${PREFIX}:${userId}:chunks`

    // Subscribe before publishing
    const received: string[] = []
    await subscriber.subscribe(channel)
    subscriber.on("message", (ch, msg) => {
      if (ch === channel) received.push(msg)
    })

    // Small delay to ensure subscription is active
    await new Promise((r) => setTimeout(r, 100))

    const layer = RedisStreamingLayer({ redis, userId, prefix: PREFIX })

    await Streaming.pipe(
      Effect.flatMap((s) =>
        s.publish({
          conversationId: "conv-1",
          responseId: "resp-1",
          chunk: { type: "text-delta", id: "t1", delta: "hello" },
          seq: 0,
        }),
      ),
      Effect.provide(layer),
      Effect.runPromise,
    )

    // Wait for pub/sub delivery
    await new Promise((r) => setTimeout(r, 100))

    expect(received).toHaveLength(1)
    const parsed = JSON.parse(received[0]) as StreamChunk
    expect(parsed.conversationId).toBe("conv-1")
    expect(parsed.responseId).toBe("resp-1")
    expect(parsed.chunk.type).toBe("text-delta")
    expect(parsed.seq).toBe(0)

    await subscriber.unsubscribe(channel)
  })
})

// ---------------------------------------------------------------------------
// MessageQueue
// ---------------------------------------------------------------------------

describe.skipIf(!redisAvailable)("RedisMessageQueueLayer", () => {
  const convId = "test-conv-mq"
  const streamKey = `${PREFIX}:${convId}:messages`
  const groupName = "kai-test-group"

  beforeEach(async () => {
    // Delete stream and recreate group
    await redis.del(streamKey)
    await ensureConsumerGroup(redis, convId, { prefix: PREFIX, groupName })
  })

  test("drain() returns empty immediately when no messages", async () => {
    const layer = RedisMessageQueueLayer({
      redis,
      conversationId: convId,
      consumerId: "consumer-1",
      prefix: PREFIX,
      groupName,
      parseMessage: (data) => JSON.parse(data.payload),
    })

    const start = Date.now()
    const messages = await MessageQueue.pipe(
      Effect.flatMap((mq) => mq.drain()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    const elapsed = Date.now() - start

    expect(messages).toEqual([])
    // Non-blocking: should complete in under 1 second
    expect(elapsed).toBeLessThan(1000)
  })

  test("drain() reads all queued messages", async () => {
    // Add messages to the stream
    const msg1 = userMessage("Hello")
    const msg2 = userMessage("World")
    await redis.xadd(streamKey, "*", "payload", JSON.stringify(msg1))
    await redis.xadd(streamKey, "*", "payload", JSON.stringify(msg2))

    const layer = RedisMessageQueueLayer({
      redis,
      conversationId: convId,
      consumerId: "consumer-1",
      prefix: PREFIX,
      groupName,
      parseMessage: (data) => JSON.parse(data.payload),
    })

    const messages = await MessageQueue.pipe(
      Effect.flatMap((mq) => mq.drain()),
      Effect.provide(layer),
      Effect.runPromise,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("user")
    expect(messages[1].role).toBe("user")
  })

  test("drain() XACKs entries after reading", async () => {
    await redis.xadd(streamKey, "*", "payload", JSON.stringify(userMessage("test")))

    const layer = RedisMessageQueueLayer({
      redis,
      conversationId: convId,
      consumerId: "consumer-1",
      prefix: PREFIX,
      groupName,
      parseMessage: (data) => JSON.parse(data.payload),
    })

    // First drain reads the message
    const first = await MessageQueue.pipe(
      Effect.flatMap((mq) => mq.drain()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    expect(first).toHaveLength(1)

    // Second drain should be empty — message was ACKed
    const second = await MessageQueue.pipe(
      Effect.flatMap((mq) => mq.drain()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    expect(second).toEqual([])

    // Pending list should be empty
    const pending = await redis.xpending(streamKey, groupName)
    expect(pending[0]).toBe(0) // 0 pending entries
  })

  test("wait() blocks until a message arrives", async () => {
    // wait() uses BLOCK which holds the connection, so we need
    // a separate writer connection for the xadd
    const writer = new Redis(REDIS_URL)

    const layer = RedisMessageQueueLayer({
      redis,
      conversationId: convId,
      consumerId: "consumer-1",
      prefix: PREFIX,
      groupName,
      blockMs: 5000,
      parseMessage: (data) => JSON.parse(data.payload),
    })

    // Add message after 200ms via separate connection
    setTimeout(async () => {
      await writer.xadd(streamKey, "*", "payload", JSON.stringify(userMessage("delayed")))
    }, 200)

    const start = Date.now()
    const message = await MessageQueue.pipe(
      Effect.flatMap((mq) => mq.wait()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    const elapsed = Date.now() - start

    expect(message.role).toBe("user")
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(2000)

    await writer.quit()
  }, 10_000)

  test("ensureConsumerGroup is idempotent", async () => {
    // Second call should not throw
    await ensureConsumerGroup(redis, convId, { prefix: PREFIX, groupName })
    await ensureConsumerGroup(redis, convId, { prefix: PREFIX, groupName })
  })
})

// ---------------------------------------------------------------------------
// StopSignal
// ---------------------------------------------------------------------------

describe.skipIf(!redisAvailable)("RedisStopSignalLayer", () => {
  const convId = "test-conv-stop"
  const key = `${PREFIX}:${convId}:stop`

  test("check() returns false when no signal", async () => {
    const layer = RedisStopSignalLayer({
      redis,
      subscriber,
      conversationId: convId,
      prefix: PREFIX,
    })

    const stopped = await StopSignal.pipe(
      Effect.flatMap((s) => s.check()),
      Effect.provide(layer),
      Effect.runPromise,
    )

    expect(stopped).toBe(false)
  })

  test("check() returns true and consumes the signal", async () => {
    // Set the stop key
    await redis.set(key, "1", "EX", 30)

    const layer = RedisStopSignalLayer({
      redis,
      subscriber,
      conversationId: convId,
      prefix: PREFIX,
    })

    // First check: true
    const first = await StopSignal.pipe(
      Effect.flatMap((s) => s.check()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    expect(first).toBe(true)

    // Second check: false (consumed by GETDEL)
    const second = await StopSignal.pipe(
      Effect.flatMap((s) => s.check()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    expect(second).toBe(false)
  })

  test("wait() resolves when stop signal is published", async () => {
    // Use a fresh subscriber to avoid interference
    const freshSub = new Redis(REDIS_URL)

    const layer = RedisStopSignalLayer({
      redis,
      subscriber: freshSub,
      conversationId: convId,
      prefix: PREFIX,
    })

    // Publish stop after 200ms
    setTimeout(async () => {
      await publishStopSignal(redis, convId, { prefix: PREFIX })
    }, 200)

    const start = Date.now()
    await StopSignal.pipe(
      Effect.flatMap((s) => s.wait()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(2000)

    await freshSub.quit()
  })

  test("wait() resolves immediately if key already set", async () => {
    const freshSub = new Redis(REDIS_URL)

    // Set key BEFORE creating the layer
    await redis.set(key, "1", "EX", 30)

    const layer = RedisStopSignalLayer({
      redis,
      subscriber: freshSub,
      conversationId: convId,
      prefix: PREFIX,
    })

    const start = Date.now()
    await StopSignal.pipe(
      Effect.flatMap((s) => s.wait()),
      Effect.provide(layer),
      Effect.runPromise,
    )
    const elapsed = Date.now() - start

    // Should resolve almost immediately (key was already set)
    expect(elapsed).toBeLessThan(500)

    await freshSub.quit()
  })

  test("publishStopSignal sets key and publishes", async () => {
    await publishStopSignal(redis, convId, { prefix: PREFIX })

    // Key should exist
    const val = await redis.get(key)
    expect(val).toBe("1")

    // Key should have TTL
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30)
  })
})
