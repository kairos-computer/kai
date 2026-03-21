# @kairos-computer/redis

Redis adapter for [kai](https://github.com/kairos-computer/kai) — provides ready-made implementations of kai's Streaming, MessageQueue, and StopSignal services using [ioredis](https://github.com/redis/ioredis).

## Install

```bash
bun add @kairos-computer/redis
```

## Usage

```typescript
import { RedisStreamingLayer, RedisMessageQueueLayer, RedisStopSignalLayer } from "@kairos-computer/redis"
import Redis from "ioredis"

const redis = new Redis()
const subscriber = new Redis()

const streamingLayer = RedisStreamingLayer({ redis, userId: "user-123" })
const mqLayer = RedisMessageQueueLayer({
  redis,
  conversationId: "conv-1",
  consumerId: "agent-1",
  parseMessage: (data) => JSON.parse(data.payload),
})
const stopLayer = RedisStopSignalLayer({ redis, subscriber, conversationId: "conv-1" })
```

### Streaming

Publishes `StreamChunk` as JSON to a Redis Pub/Sub channel (`{prefix}:{userId}:chunks`).

### MessageQueue

Uses Redis Streams (`XREADGROUP`/`XACK`) for durable message queuing. `drain()` is non-blocking, `wait()` blocks until a message arrives, and `ack()` confirms messages after successful processing.

```typescript
import { ensureConsumerGroup } from "@kairos-computer/redis"

// Create consumer group (idempotent)
await ensureConsumerGroup(redis, "conv-1")
```

### StopSignal

Dual mechanism for reliable stop detection:
1. Persistent key (`GETDEL`) — survives pub/sub misses between turns
2. Pub/Sub channel — instant notification during streaming

```typescript
import { publishStopSignal } from "@kairos-computer/redis"

// Signal a conversation to stop
await publishStopSignal(redis, "conv-1")
```

See the [kai documentation](https://github.com/kairos-computer/kai) for full details.
