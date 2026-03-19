# kai

A streamText replacement built on the AI SDK primitives. Owns the tool loop, streams to Redis, handles stop signals and message queuing mid-generation — without the forced `maxSteps`/`stopCondition` from the AI SDK.

Uses [Effect-TS](https://effect.website) for typed errors, dependency injection, and concurrent stream management.

## Install

```bash
bun add @kairos-computer/core
# Redis adapter (optional)
bun add @kairos-computer/redis
```

## Quick Start

```typescript
import { Agent } from "@kairos-computer/core"
import { tool, zodSchema } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { z } from "zod"

const agent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a helpful assistant.",
  tools: {
    weather: tool({
      description: "Get the weather",
      inputSchema: zodSchema(z.object({ city: z.string() })),
      execute: async (input) => ({ temp: 72, city: input.city }),
    }),
  },
})

const result = await agent.runPromise("conversation-1", [
  { id: "msg-1", role: "user", parts: [{ type: "text", text: "Weather in SF?" }] },
])

console.log(result.finishReason) // "stop"
console.log(result.steps)        // [{ toolCalls: [...] }, { text: "It's 72°F in SF" }]
```

## How It Works

kai calls `model.doStream()` directly in a loop. Each iteration:

1. Convert `UIMessage[]` → `LanguageModelV3Prompt` (using AI SDK's own conversion)
2. Stream one LLM call, publish chunks to the Streaming service
3. On `tool-calls` → execute tools (parallel), append results, continue
4. On `stop` → check message queue for new user messages, continue if any
5. On `length` → call `onContextOverflow` hook or fail
6. On abort → normalize partial results, break

No `maxSteps`. No `stopCondition`. The loop runs until the model says stop, the user sends a stop signal, or an error occurs.

## Core Concepts

### Messages: `UIMessage`

kai uses the AI SDK's `UIMessage` type for all messages. This is the same type the frontend uses — no conversion needed between backend and frontend.

### Tools: `ToolSet`

Define tools with `tool()` from the `ai` package. kai passes them to `model.doStream()` using the AI SDK's own `prepareToolsAndToolChoice`.

```typescript
import { tool, zodSchema } from "ai"
import { z } from "zod"

const tools = {
  search: tool({
    description: "Search the web",
    inputSchema: zodSchema(z.object({ query: z.string() })),
    execute: async (input) => fetchResults(input.query),
  }),
}
```

### `executeTools`

Controls whether kai executes tool calls or returns them for the caller to handle.

```typescript
// Default: true — auto-execute all tools
executeTools: true

// Handoff pattern: stop at tool calls, let another system execute them
executeTools: false

// Custom: you control execution
executeTools: (toolCalls, tools, abortSignal) =>
  Effect.succeed(toolCalls.map(tc => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    input: tc.input,
    output: myExecute(tc),
    isError: false,
    durationMs: 0,
  })))
```

### `prepareStep`

Called before each LLM call. Override the model, tools, or system prompt per step.

```typescript
prepareStep: (ctx) => {
  if (ctx.stepNumber > 5) {
    return { tools: { ...baseTools, ...advancedTools } }
  }
  return {}
}
```

### Streaming: `StreamChunk`

Every chunk published to the Streaming service is wrapped in a `StreamChunk`:

```typescript
interface StreamChunk {
  conversationId: string
  responseId: string       // correlate streaming with persisted message
  chunk: UIMessageChunk    // text-delta, tool-input-available, finish, etc.
  seq: number              // monotonic, for dedup and ordering
}
```

The `responseId` correlates streaming chunks with the persisted message. Each assistant message in `result.messages` carries its `responseId` in `metadata.responseId`. If the loop absorbs queued user messages and generates multiple responses in one run, each response gets its own `responseId` — a `finish` chunk is emitted between them.

## Services

kai uses four optional Effect services. Provide them via layers, or use the noop defaults.

### Streaming

Publishes `StreamChunk` for real-time frontend updates.

```typescript
import { Streaming } from "@kairos-computer/core"
import { Layer, Effect } from "effect"

const myStreamingLayer = Layer.succeed(Streaming, {
  publish: (chunk) => Effect.promise(() => redis.publish(channel, JSON.stringify(chunk))),
})
```

### MessageQueue

User messages arriving mid-generation. The loop drains these between steps.

```typescript
import { MessageQueue } from "@kairos-computer/core"

const myMqLayer = Layer.succeed(MessageQueue, {
  drain: () => Effect.promise(() => readAllPendingMessages()),
  wait: () => Effect.promise(() => blockForNextMessage()),
})
```

### StopSignal

External stop requests. Aborts both streaming and tool execution.

```typescript
import { StopSignal } from "@kairos-computer/core"

const myStopLayer = Layer.succeed(StopSignal, {
  check: () => Effect.promise(() => redis.getdel("stop-key").then(v => v !== null)),
  wait: () => Effect.async((resume) => {
    subscriber.subscribe("stop-channel")
    subscriber.on("message", () => resume(Effect.void))
  }),
})
```

### Persistence

Save/load messages. Called by the `Agent` class before and after the loop.

```typescript
import { Persistence } from "@kairos-computer/core"

const myPersistenceLayer = Layer.succeed(Persistence, {
  saveMessages: (convId, msgs) => Effect.promise(() => db.save(convId, msgs)),
  loadMessages: (convId) => Effect.promise(() => db.load(convId)),
})
```

## Redis Adapter

`@kairos-computer/redis` provides ready-made implementations using ioredis.

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

## Using `runLoop` Directly

The `Agent` class is a thin wrapper. For full control, use `runLoop`:

```typescript
import { runLoop } from "@kairos-computer/core"
import { anthropic } from "@ai-sdk/anthropic"
import { Effect, Layer } from "effect"

const result = await runLoop({
  model: anthropic("claude-sonnet-4-20250514"),
  conversationId: "conv-1",
  responseId: "resp-abc",
  system: "You are helpful.",
  tools: myTools,
  initialMessages: messages,
  callSettings: { maxOutputTokens: 4096, temperature: 0.7 },
  prepareStep: (ctx) => ({ /* per-step overrides */ }),
  onContextOverflow: (msgs) => Effect.succeed(compactMessages(msgs)),
  hooks: {
    onStepStart: (n) => Effect.log(`Step ${n}`),
    onStepFinish: (r) => Effect.log(`Finished: ${r.finishReason}`),
    onToolCall: (tc) => Effect.log(`Calling ${tc.toolName}`),
    onToolResult: (tr) => Effect.log(`${tr.toolName}: ${tr.isError ? "error" : "ok"}`),
  },
}).pipe(
  Effect.provide(Layer.mergeAll(streamingLayer, mqLayer, stopLayer)),
  Effect.runPromise,
)
```

## Stop Signal Behavior

Stop aborts at every level:

- **Between steps**: `check()` polls before each LLM call
- **Mid-stream**: `wait()` fires → AbortController aborts → stream interrupted
- **Mid-tool-execution**: same AbortController passed to `tool.execute()` — tools that respect `abortSignal` bail out

Aborted tools get `output: "Stopped by user"` so the model knows not to retry them on the next turn.

## MCP Support

MCP tools work out of the box — they're just `ToolSet` entries. Load them from `@ai-sdk/mcp` and pass to kai:

```typescript
import { createMCPClient } from "@ai-sdk/mcp"

const mcp = await createMCPClient({ transport: myTransport })
const mcpTools = await mcp.tools()

const agent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { ...localTools, ...mcpTools },
})
```

For dynamic tool discovery per step:

```typescript
prepareStep: async () => {
  const mcpTools = await mcp.tools()
  return { tools: { ...localTools, ...mcpTools } }
}
```

## API Reference

### Types

| Type | Description |
|------|-------------|
| `UIMessage` | AI SDK message type (re-exported) |
| `ToolSet` | AI SDK tool set (re-exported) |
| `StreamChunk` | Chunk + routing metadata (conversationId, responseId, seq) |
| `LoopResult` | Final result: messages, steps, totalUsage, finishReason, responseId |
| `StepResult` | Per-step: finishReason, text, toolCalls, usage, durationMs |
| `ParsedToolCall` | Tool call extracted from model response |
| `ToolCallResult` | Result of executing a tool call |
| `AgentConfig` | Configuration for the Agent class |
| `LoopConfig` | Configuration for runLoop |
| `CallSettings` | Model call settings (temperature, maxOutputTokens, etc.) |

### `LoopFinishReason`

| Value | Meaning |
|-------|---------|
| `"stop"` | Model finished naturally |
| `"tool-calls"` | Model wants tool execution but `executeTools` is `false` |
| `"aborted"` | Stopped by external signal |
| `"error"` | Model returned an error finish reason |

### Errors

| Error | When |
|-------|------|
| `StreamError` | `model.doStream()` fails |
| `ContextOverflowError` | `finishReason: "length"` with no `onContextOverflow` handler |
| `PersistenceError` | Persistence service fails to save/load |
| `ToolExecutionError` | Available for custom `ExecuteToolsFn` implementations |
