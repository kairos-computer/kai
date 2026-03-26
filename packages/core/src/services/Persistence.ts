import type { LanguageModelUsage, UIMessage } from "ai"
import { Context, Effect, Layer } from "effect"
import type { PersistenceError } from "../errors.js"

export class Persistence extends Context.Tag("kai/Persistence")<
  Persistence,
  {
    readonly saveMessages: (
      conversationId: string,
      messages: UIMessage[],
      assistantUsage?: LanguageModelUsage,
    ) => Effect.Effect<void, PersistenceError>
    readonly loadMessages: (
      conversationId: string,
    ) => Effect.Effect<UIMessage[], PersistenceError>
  }
>() {}

export const NoopPersistenceLayer = Layer.succeed(Persistence, {
  saveMessages: () => Effect.void,
  loadMessages: () => Effect.succeed([]),
})
