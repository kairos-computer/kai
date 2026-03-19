import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"

interface MockModel extends LanguageModelV3 {
  callCount: number
}

/**
 * Mock LanguageModelV3 that returns pre-defined stream part sequences.
 * Each call to doStream() pops the next response. If exhausted, repeats the last.
 */
export function mockModel(
  responses: LanguageModelV3StreamPart[][],
): MockModel {
  let callIndex = 0
  let count = 0

  const model: MockModel = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    defaultObjectGenerationMode: undefined,
    supportsImageUrls: false,
    supportsStructuredOutputs: false,
    supportedUrls: {},
    get callCount() { return count },

    doGenerate() {
      throw new Error("doGenerate not implemented")
    },

    doStream(
      _options: LanguageModelV3CallOptions,
    ): PromiseLike<LanguageModelV3StreamResult> {
      count++
      const parts = responses[callIndex] ?? responses[responses.length - 1]!
      callIndex++

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part)
          }
          controller.close()
        },
      })

      return Promise.resolve({ stream })
    },
  } as MockModel

  return model
}

/**
 * Mock model that streams parts with a delay between each.
 * Useful for testing mid-stream stop signals.
 */
export function slowMockModel(
  responses: LanguageModelV3StreamPart[][],
  delayMs: number,
): MockModel {
  let callIndex = 0
  let count = 0

  const model: MockModel = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "slow-mock-model",
    defaultObjectGenerationMode: undefined,
    supportsImageUrls: false,
    supportsStructuredOutputs: false,
    supportedUrls: {},
    get callCount() { return count },

    doGenerate() {
      throw new Error("doGenerate not implemented")
    },

    doStream(
      _options: LanguageModelV3CallOptions,
    ): PromiseLike<LanguageModelV3StreamResult> {
      count++
      const parts = responses[callIndex] ?? responses[responses.length - 1]!
      callIndex++

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          for (const part of parts) {
            await new Promise((r) => setTimeout(r, delayMs))
            controller.enqueue(part)
          }
          controller.close()
        },
      })

      return Promise.resolve({ stream })
    },
  } as MockModel

  return model
}

// -- Response helpers -------------------------------------------------------

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

/** Simple text response that ends with "stop". */
export function textResponse(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1", providerMetadata: undefined },
    { type: "text-delta", id: "t1", delta: text, providerMetadata: undefined },
    { type: "text-end", id: "t1", providerMetadata: undefined },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: USAGE,
    },
  ]
}

/** Response with a tool call. */
export function toolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
  text = "",
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = []
  if (text) {
    parts.push(
      { type: "text-start", id: "t1", providerMetadata: undefined },
      { type: "text-delta", id: "t1", delta: text, providerMetadata: undefined },
      { type: "text-end", id: "t1", providerMetadata: undefined },
    )
  }
  parts.push(
    {
      type: "tool-call",
      toolCallId: `call_${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      toolName,
      input: JSON.stringify(input),
      providerMetadata: undefined,
    } as unknown as LanguageModelV3StreamPart,
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: USAGE,
    },
  )
  return parts
}

/** Response that triggers context overflow (finishReason: length). */
export function lengthResponse(): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1", providerMetadata: undefined },
    { type: "text-delta", id: "t1", delta: "truncated...", providerMetadata: undefined },
    { type: "text-end", id: "t1", providerMetadata: undefined },
    {
      type: "finish",
      finishReason: { unified: "length", raw: "max_tokens" },
      usage: USAGE,
    },
  ]
}

/** Long text response with many delta chunks (for mid-stream stop testing). */
export function longTextResponse(chunks: number): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1", providerMetadata: undefined },
  ]
  for (let i = 0; i < chunks; i++) {
    parts.push({
      type: "text-delta",
      id: "t1",
      delta: `chunk${i} `,
      providerMetadata: undefined,
    })
  }
  parts.push(
    { type: "text-end", id: "t1", providerMetadata: undefined },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: USAGE,
    },
  )
  return parts
}
