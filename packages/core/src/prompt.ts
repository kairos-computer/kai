import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { UIMessage } from "ai"
import { convertToModelMessages } from "ai"
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal"
import type { SystemPrompt } from "./types.js"

/**
 * Convert UIMessage[] → LanguageModelV3Prompt using the AI SDK's own
 * conversion chain. This is the same path that streamText() uses internally:
 *
 *   UIMessage[] → ModelMessage[] → StandardizedPrompt → LanguageModelV3Prompt
 *
 * The `system` parameter accepts strings, SystemModelMessage, or
 * SystemModelMessage[] — all are passed through to standardizePrompt()
 * which handles each variant natively.
 */
export async function toLanguageModelPrompt(
  system: SystemPrompt | undefined,
  messages: UIMessage[],
): Promise<LanguageModelV3Prompt> {
  const modelMessages = await convertToModelMessages(messages)
  const standardized = await standardizePrompt({
    system,
    messages: modelMessages,
  })
  return convertToLanguageModelPrompt({
    prompt: standardized,
    supportedUrls: {},
    download: undefined,
  })
}
