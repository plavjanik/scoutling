import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from '@ai-sdk/openai-compatible'

export interface ProviderOptions {
  /** OpenAI-compatible endpoint, e.g. LM Studio's `http://localhost:1234/v1`. */
  baseUrl: string
  apiKey: string
  /** Injectable so tests never need a reachable provider. */
  fetch?: typeof fetch
}

/**
 * The provider a run uses. Scoutling speaks only plain OpenAI-compatible HTTP
 * and has no opinion about what is behind the base URL (ADR 0003).
 */
export function createProvider(options: ProviderOptions): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: 'scoutling',
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
    // Endpoints that ignore it degrade gracefully; those that honour it give
    // far more reliable tool calls from small local models.
    supportsStructuredOutputs: true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}
