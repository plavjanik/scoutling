import { describe, expect, it } from 'vitest'
import { generateText } from 'ai'

import { createProvider, listModels } from '../src/provider.js'

/** Captures the request the provider makes without a provider being reachable. */
function recordingFetch(): { calls: Array<{ url: string; init: RequestInit }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        id: 'chat-1',
        object: 'chat.completion',
        created: 0,
        model: 'a-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { calls, fetch: fetchImpl }
}

describe('createProvider', () => {
  it('talks to the chat completions endpoint under the configured base URL', async () => {
    const recorder = recordingFetch()
    const model = createProvider({
      baseUrl: 'http://localhost:4321/v1',
      apiKey: 'not-needed',
      fetch: recorder.fetch,
    }).chatModel('a-model')

    await generateText({ model, prompt: 'hello' })

    expect(recorder.calls[0]?.url).toBe('http://localhost:4321/v1/chat/completions')
  })

  it('authenticates with the configured api key', async () => {
    const recorder = recordingFetch()
    const model = createProvider({
      baseUrl: 'http://localhost:4321/v1',
      apiKey: 'sk-test',
      fetch: recorder.fetch,
    }).chatModel('a-model')

    await generateText({ model, prompt: 'hello' })

    const headers = new Headers(recorder.calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('names the model it was asked for', () => {
    const model = createProvider({ baseUrl: 'http://localhost:4321/v1', apiKey: 'x' }).chatModel(
      'qwen/qwen3-coder-next',
    )

    expect(model.modelId).toBe('qwen/qwen3-coder-next')
  })
})

describe('listModels', () => {
  it('returns the model ids from GET /models', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://localhost:4321/v1/models')
      return new Response(
        JSON.stringify({ data: [{ id: 'qwen/qwen3-coder-next' }, { id: 'qwen/qwen3-next-80b' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const models = await listModels({ baseUrl: 'http://localhost:4321/v1', apiKey: 'x', fetch: fetchImpl })

    expect(models).toEqual(['qwen/qwen3-coder-next', 'qwen/qwen3-next-80b'])
  })

  it('rejects when the provider is unreachable, rather than hanging', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    await expect(
      listModels({ baseUrl: 'http://localhost:4321/v1', apiKey: 'x', fetch: fetchImpl }),
    ).rejects.toThrow()
  })

  it('rejects on a non-OK response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    await expect(
      listModels({ baseUrl: 'http://localhost:4321/v1', apiKey: 'x', fetch: fetchImpl }),
    ).rejects.toThrow()
  })
})
