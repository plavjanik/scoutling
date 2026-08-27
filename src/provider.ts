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

export interface ListModelsOptions {
  baseUrl: string
  apiKey: string
  /** Injectable so tests never need a reachable provider. */
  fetch?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_LIST_MODELS_TIMEOUT_MS = 3000

/**
 * `GET <baseUrl>/models` — the live model list, so a missing `--model` error
 * can name what actually exists on this machine instead of leaving the user
 * to guess (DESIGN.md §9). Plain `fetch`, not the provider SDK: this is a
 * one-off lookup, not a model call.
 */
export async function listModels(options: ListModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_LIST_MODELS_TIMEOUT_MS)

  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`GET /models returned ${response.status}`)
    }

    const body = (await response.json()) as { data?: Array<{ id: string }> }
    return (body.data ?? []).map((model) => model.id)
  } finally {
    clearTimeout(timeout)
  }
}
