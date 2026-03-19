import { Context, Effect, Layer } from "effect"
import type { StreamError } from "../errors.js"
import type { StreamChunk } from "../types.js"

export class Streaming extends Context.Tag("kai/Streaming")<
  Streaming,
  {
    readonly publish: (chunk: StreamChunk) => Effect.Effect<void, StreamError>
  }
>() {}

export const NoopStreamingLayer = Layer.succeed(Streaming, {
  publish: () => Effect.void,
})
