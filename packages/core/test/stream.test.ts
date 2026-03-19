import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { fromReadableStream } from "../src/stream.js"

describe("fromReadableStream", () => {
  test("converts ReadableStream to Effect Stream", async () => {
    const rs = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a")
        controller.enqueue("b")
        controller.enqueue("c")
        controller.close()
      },
    })

    const result = await fromReadableStream(rs).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.runPromise,
    )

    expect(result).toEqual(["a", "b", "c"])
  })

  test("handles empty stream", async () => {
    const rs = new ReadableStream<string>({
      start(controller) {
        controller.close()
      },
    })

    const result = await fromReadableStream(rs).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.runPromise,
    )

    expect(result).toEqual([])
  })

  test("propagates stream errors as StreamError", async () => {
    const rs = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("ok")
        controller.error(new Error("Stream failed"))
      },
    })

    const exit = await fromReadableStream(rs).pipe(
      Stream.runCollect,
      Effect.runPromiseExit,
    )

    expect(exit._tag).toBe("Failure")
  })

  test("handles async stream with delays", async () => {
    const rs = new ReadableStream<number>({
      async start(controller) {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 10))
          controller.enqueue(i)
        }
        controller.close()
      },
    })

    const result = await fromReadableStream(rs).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.runPromise,
    )

    expect(result).toEqual([0, 1, 2, 3, 4])
  })
})
