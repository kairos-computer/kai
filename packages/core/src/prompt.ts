import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import type { UIMessage } from "ai"
import { convertToModelMessages } from "ai"
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal"

/**
 * Convert UIMessage[] → LanguageModelV3Prompt using the AI SDK's own
 * conversion chain. This is the same path that streamText() uses internally:
 *
 *   UIMessage[] → ModelMessage[] → StandardizedPrompt → LanguageModelV3Prompt
 */
export async function toLanguageModelPrompt(
  system: string | undefined,
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
