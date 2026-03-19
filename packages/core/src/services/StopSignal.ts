import { Context, Effect, Layer } from "effect"

export class StopSignal extends Context.Tag("kai/StopSignal")<
  StopSignal,
  {
    /** Poll once: true if stop has been requested. */
    readonly check: () => Effect.Effect<boolean>
    /** Block until a stop signal is received. */
    readonly wait: () => Effect.Effect<void>
  }
>() {}

export const NoopStopSignalLayer = Layer.succeed(StopSignal, {
  check: () => Effect.succeed(false),
  wait: () => Effect.never, // never stops
})
