import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QuickAddModelsModal } from './QuickAddModelsModal'
import {
  extractEndpoints,
  generateModelConfigKey,
  fetchRemoteModels,
} from '../lib/quickAddModels'
import type { CustomModelConfig } from '../api/types'
import { useToastStore } from '../store/toast'

const transportMock = vi.hoisted(() => ({
  upsertCustomModel: vi.fn(async () => ({ ok: true })),
  listCustomModels: vi.fn(async () => []),
}))

vi.mock('../api/client', () => ({ transport: transportMock }))

import { transport } from '../api/client'

describe('QuickAddModelsModal helpers', () => {
  it('extractEndpoints correctly deduplicates and counts base_urls', () => {
    const models: CustomModelConfig[] = [
      { id: 'm1', model: 'deepseek-chat', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-1' },
      { id: 'm2', model: 'deepseek-coder', base_url: 'https://api.deepseek.com/v1' },
      { id: 'm3', model: 'llama3', base_url: 'http://localhost:11434/v1' },
      { id: 'm4', model: 'invalid' }, // no base_url
    ]
    const endpoints = extractEndpoints(models)
    expect(endpoints).toHaveLength(2)
    expect(endpoints[0]).toEqual({
      key: 'https://api.deepseek.com/v1',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-1',
      apiBackend: undefined,
      count: 2,
    })
    expect(endpoints[1].baseUrl).toBe('http://localhost:11434/v1')
    expect(endpoints[1].count).toBe(1)
  })

  it('generateModelConfigKey creates safe slugs and avoids collisions', () => {
    const existing = new Set(['gpt-4o', 'gpt-4o-2'])
    expect(generateModelConfigKey('deepseek-chat', existing)).toBe('deepseek-chat')
    expect(generateModelConfigKey('deepseek-ai/DeepSeek-V3', existing)).toBe('deepseek-v3')
    expect(generateModelConfigKey('gpt-4o', existing)).toBe('gpt-4o-3')
  })

  describe('fetchRemoteModels', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('successfully parses standard OpenAI data format', async () => {
      globalThis.fetch = vi.fn(async (url) => {
        expect(String(url)).toBe('https://api.example.com/v1/models')
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'model-a', name: 'Model A' },
              { id: 'model-b', name: 'Model B' },
            ],
          }),
        } as Response
      })

      const models = await fetchRemoteModels('https://api.example.com/v1', 'test-key')
      expect(models).toHaveLength(2)
      expect(models[0].id).toBe('model-a')
      expect(models[1].id).toBe('model-b')
    })

    it('successfully parses Ollama models format', async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3:latest', model: 'llama3:latest' },
          ],
        }),
      } as Response))

      const models = await fetchRemoteModels('http://localhost:11434')
      expect(models).toHaveLength(1)
      expect(models[0].id).toBe('llama3:latest')
    })

    it('sends Authorization header when apiKey provided', async () => {
      let seenHeaders: HeadersInit | undefined
      globalThis.fetch = vi.fn(async (_url, init) => {
        seenHeaders = init?.headers
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'm1' }] }),
        } as Response
      })

      await fetchRemoteModels('https://api.example.com/v1', 'sk-my-secret')
      expect(seenHeaders).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer sk-my-secret',
        }),
      )
    })
  })
})

describe('QuickAddModelsModal component', () => {
  const existingModels: CustomModelConfig[] = [
    {
      id: 'existing-ds',
      model: 'deepseek-chat',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-ds-key',
      name: 'DeepSeek Chat',
    },
  ]

  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.mocked(transport.upsertCustomModel).mockReset()
  })

  it('renders modal with extracted endpoint and allows fetching models', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            deepseek: {
              models: {
                'deepseek-chat': {
                  id: 'deepseek-chat',
                  name: 'DeepSeek V3',
                  description: 'Flagship reasoning model',
                  reasoning: true,
                  limit: { context: 128000, output: 8192 },
                },
                'deepseek-reasoner': {
                  id: 'deepseek-reasoner',
                  name: 'DeepSeek R1',
                  reasoning: true,
                  limit: { context: 128000, output: 8192 },
                },
              },
            },
          }),
        } as Response
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'deepseek-chat' },
            { id: 'deepseek-reasoner' },
          ],
        }),
      } as Response
    })

    const onAdded = vi.fn()
    const onClose = vi.fn()

    render(
      <QuickAddModelsModal
        isOpen={true}
        onClose={onClose}
        existingModels={existingModels}
        onAdded={onAdded}
      />,
    )

    // Check title and pre-filled endpoint
    expect(screen.getByText('快速拉取并添加模型')).toBeDefined()
    expect(screen.getByDisplayValue('https://api.deepseek.com/v1')).toBeDefined()

    // Click "获取模型列表"
    const fetchBtn = screen.getByRole('button', { name: '获取模型列表' })
    fireEvent.click(fetchBtn)

    // Wait for models to load
    await waitFor(() => {
      expect(screen.getByText('DeepSeek R1')).toBeDefined()
    })

    // deepseek-chat was existing, deepseek-reasoner was new
    expect(screen.getByText('已配置')).toBeDefined() // for deepseek-chat
    expect(screen.getAllByText('128k 上下文')).toHaveLength(2)

    // Unadded model (deepseek-reasoner) should be selected by default
    const addBtn = screen.getByRole('button', { name: /添加所选模型 \(1\)/ })
    expect(addBtn).toBeDefined()

    // Click add selected
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(transport.upsertCustomModel).toHaveBeenCalledTimes(1)
      const callArg = vi.mocked(transport.upsertCustomModel).mock.calls[0][0]
      expect(callArg).not.toHaveProperty('description')
      expect(callArg).toEqual(
        expect.objectContaining({
          id: 'deepseek-reasoner',
          model: 'deepseek-reasoner',
          base_url: 'https://api.deepseek.com/v1',
          api_key: 'sk-ds-key',
          name: 'DeepSeek R1',
          context_window: 128000,
          supports_reasoning_effort: true,
        }),
      )
      expect(onAdded).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })

    globalThis.fetch = originalFetch
  })
})
