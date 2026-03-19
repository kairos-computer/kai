import { Effect, Stream } from "effect"
import { StreamError } from "./errors.js"

/**
 * Convert a ReadableStream into an Effect Stream.
 * Bridge between Web Streams API and Effect's stream processing.
 */
export function fromReadableStream<A>(
  rs: ReadableStream<A>,
): Stream.Stream<A, StreamError> {
  return Stream.async<A, StreamError>((emit) => {
    const reader = rs.getReader()

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            emit.end()
            return
          }
          emit.single(value)
        }
      } catch (e) {
        emit.fail(new StreamError({ cause: e }))
      } finally {
        reader.releaseLock()
      }
    }

    pump().catch((e) => {
      emit.fail(new StreamError({ cause: e }))
    })

    return Effect.sync(() => {
      reader.cancel().catch(() => {})
    })
  })
}
