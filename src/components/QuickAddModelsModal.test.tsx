import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QuickAddModelsModal } from './QuickAddModelsModal'
import {
  extractEndpoints,
  generateModelConfigKey,
  fetchRemoteModels,
  resetModelsDevCacheForTest,
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
    resetModelsDevCacheForTest()
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

  it('shows per-provider effort groups, defaults to majority group, and lets user pick another', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            // providerA×2 上报 low/high/max（多数组）；requesty 上报 none/low/medium/high/max
            canonical: {
              models: {
                'glm-5.3': {
                  id: 'glm-5.3',
                  name: 'GLM-5.3',
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
                  limit: { context: 1000000, output: 131072 },
                },
              },
            },
            zai: {
              models: {
                'glm-5.3': {
                  id: 'glm-5.3',
                  name: 'GLM-5.3',
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
                },
              },
            },
            requesty: {
              models: {
                'glm-5.3': {
                  id: 'glm-5.3',
                  name: 'GLM-5.3 (R)',
                  reasoning: true,
                  reasoning_options: [
                    { type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] },
                  ],
                },
              },
            },
          }),
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'glm-5.3' }] }),
      } as Response
    })

    render(
      <QuickAddModelsModal
        isOpen={true}
        onClose={vi.fn()}
        existingModels={[]}
        onAdded={vi.fn()}
      />,
    )

    // 无已有端点时需手填 Base URL
    fireEvent.change(screen.getByPlaceholderText('https://api.deepseek.com/v1'), {
      target: { value: 'https://api.example.com/v1' },
    })

    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }))

    // 下拉框渲染出两组候选；默认选中多数组 low/high/max（×2 家 provider）
    await waitFor(() => {
      expect(screen.getByText('思考强度：')).toBeDefined()
    })
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    expect(select.value).toBe('0')
    const optionTexts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(optionTexts).toEqual(['low/high/max ×2', 'none/low/medium/high/max ×1'])

    // 用户改选 requesty 上报的那组（含 medium）
    fireEvent.change(select, { target: { value: '1' } })

    fireEvent.click(screen.getByRole('button', { name: /添加所选模型 \(1\)/ }))

    await waitFor(() => {
      expect(transport.upsertCustomModel).toHaveBeenCalledTimes(1)
      const callArg = vi.mocked(transport.upsertCustomModel).mock.calls[0][0]
      expect(callArg.reasoning_efforts).toEqual(
        ['none', 'low', 'medium', 'high', 'max'].map((v) =>
          expect.objectContaining({ value: v }),
        ),
      )
    })

    globalThis.fetch = originalFetch
  })

  it('shows per-provider limit groups, defaults to majority, and lets user pick another', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('models.dev')) {
        return {
          ok: true,
          json: async () => ({
            // canonical×2 上报 1M/128k（多数组）；crof 只报 256k/16k（裁剪版）
            canonical: {
              models: {
                'glm-5.2': {
                  id: 'glm-5.2',
                  name: 'GLM-5.2',
                  reasoning: true,
                  limit: { context: 1000000, output: 131072 },
                },
              },
            },
            zai: {
              models: {
                'glm-5.2': {
                  id: 'glm-5.2',
                  name: 'GLM-5.2',
                  limit: { context: 1000000, output: 131072 },
                },
              },
            },
            crof: {
              models: {
                'glm-5.2': {
                  id: 'glm-5.2',
                  name: 'GLM-5.2 (C)',
                  limit: { context: 256000, output: 16384 },
                },
              },
            },
          }),
        } as Response
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'glm-5.2' }] }),
      } as Response
    })

    render(
      <QuickAddModelsModal
        isOpen={true}
        onClose={vi.fn()}
        existingModels={[]}
        onAdded={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('https://api.deepseek.com/v1'), {
      target: { value: 'https://api.example.com/v1' },
    })

    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }))

    // 默认取多数组：下拉渲染且默认选中 1000k/131k ×2
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeDefined()
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('0')
    const optionTexts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(optionTexts).toEqual(['1000k / 131k ×2', '256k / 16k ×1'])

    // 用户改选 crof 上报的裁剪版
    fireEvent.change(select, { target: { value: '1' } })
    expect(select.value).toBe('1')

    fireEvent.click(screen.getByRole('button', { name: /添加所选模型 \(1\)/ }))

    await waitFor(() => {
      expect(transport.upsertCustomModel).toHaveBeenCalledTimes(1)
      const callArg = vi.mocked(transport.upsertCustomModel).mock.calls[0][0]
      expect(callArg.context_window).toBe(256000)
      expect(callArg.max_completion_tokens).toBe(16384)
    })

    globalThis.fetch = originalFetch
  })

  it('selecting a model on the endpoint fills its saved api key and backend', async () => {
    // 同一端点下两个模型各带不同的 key
    const models: CustomModelConfig[] = [
      {
        id: 'a',
        model: 'glm-5.3',
        base_url: 'https://api.example.com/v1',
        api_key: 'sk-glm',
        api_backend: 'chat_completions',
      },
      {
        id: 'b',
        model: 'kimi-k3',
        base_url: 'https://api.example.com/v1',
        api_key: 'sk-kimi',
        api_backend: 'messages',
      },
    ]

    render(
      <QuickAddModelsModal
        isOpen={true}
        onClose={vi.fn()}
        existingModels={models}
        onAdded={vi.fn()}
      />,
    )

    // 第一步：选 baseUrl（端点下拉）
    fireEvent.change(screen.getByDisplayValue('https://api.example.com/v1'), {
      target: { value: 'https://api.example.com/v1' },
    })

    // 第二步：该端点下的模型下拉出现，选中 kimi-k3
    const modelSelect = await screen.findByRole('combobox', {
      name: /该端点已配置的模型/,
    }) as HTMLSelectElement
    expect(Array.from(modelSelect.querySelectorAll('option')).map((o) => o.value)).toEqual(
      expect.arrayContaining(['', 'glm-5.3', 'kimi-k3']),
    )
    fireEvent.change(modelSelect, { target: { value: 'kimi-k3' } })

    // 第三步：apiKey/backend 自动回填为 kimi-k3 条目的值
    await waitFor(() => {
      expect(screen.getByDisplayValue('sk-kimi')).toBeDefined()
    })
  })
})
