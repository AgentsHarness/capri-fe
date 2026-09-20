import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomModelConfig } from '../api/types'
import {
  compareCustomModels,
  extractEndpoints,
  fetchRemoteModels,
  generateModelConfigKey,
  getEffortCandidates,
  getLimitCandidates,
  getModelsDevMap,
  resetModelsDevCacheForTest,
} from './quickAddModels'

const model = (patch: Partial<CustomModelConfig>): CustomModelConfig =>
  ({ id: 'm', name: 'M', base_url: 'https://api.example/v1', ...patch }) as CustomModelConfig

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: status === 500 ? 'Internal Server Error' : 'Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/**
 * 类型化的 fetch 替身：`vi.fn(async () => …)` 的参数元组是空的，
 * 断言 `mock.calls[i][0]`（请求 URL）会被 tsc 判为越界，所以显式声明签名。
 */
function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetModelsDevCacheForTest()
})

describe('compareCustomModels', () => {
  it('name 为空时回落到 id 比较', () => {
    const a = model({ id: 'aaa', name: '   ' })
    const b = model({ id: 'bbb', name: '' })
    expect(compareCustomModels(a, b)).toBeLessThan(0)
  })

  it('显示名相同（忽略大小写）时按 id 兜底', () => {
    const a = model({ id: 'a-1', name: 'Same' })
    const b = model({ id: 'b-2', name: 'same' })
    expect(compareCustomModels(a, b)).toBeLessThan(0)
    expect(compareCustomModels(b, a)).toBeGreaterThan(0)
  })
})

describe('extractEndpoints', () => {
  it('按 base_url 去重并累加计数', () => {
    const out = extractEndpoints([
      model({ id: 'a', base_url: 'https://api.example/v1' }),
      model({ id: 'b', base_url: 'https://api.example/v1' }),
      model({ id: 'c', base_url: 'https://other.example/v1' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ baseUrl: 'https://api.example/v1', count: 2 })
    expect(out[1]).toMatchObject({ baseUrl: 'https://other.example/v1', count: 1 })
  })

  it('后续条目补上首个条目缺失的 apiKey / apiBackend', () => {
    const out = extractEndpoints([
      model({ id: 'a', base_url: 'https://api.example/v1' }),
      model({
        id: 'b',
        base_url: 'https://api.example/v1',
        api_key: 'sk-later',
        api_backend: 'chat_completions',
      }),
    ])
    expect(out[0]).toMatchObject({ apiKey: 'sk-later', apiBackend: 'chat_completions' })
  })

  it('已有 apiKey 不被后续条目覆盖', () => {
    const out = extractEndpoints([
      model({ id: 'a', base_url: 'https://api.example/v1', api_key: 'sk-first' }),
      model({ id: 'b', base_url: 'https://api.example/v1', api_key: 'sk-second' }),
    ])
    expect(out[0]).toMatchObject({ apiKey: 'sk-first' })
  })

  it('空 / 只有空白的 base_url 被跳过；base_url 首尾空白先 trim', () => {
    const out = extractEndpoints([
      model({ id: 'a', base_url: '' }),
      model({ id: 'b', base_url: '   ' }),
      model({ id: 'c', base_url: '  https://api.example/v1  ' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ baseUrl: 'https://api.example/v1' })
  })

  it('计数相同的端点按 baseUrl 字母序', () => {
    const out = extractEndpoints([
      model({ id: 'a', base_url: 'https://zeta.example/v1' }),
      model({ id: 'b', base_url: 'https://alpha.example/v1' }),
    ])
    expect(out.map((e) => e.baseUrl)).toEqual([
      'https://alpha.example/v1',
      'https://zeta.example/v1',
    ])
  })

  it('没有任何合法端点时返回空数组', () => {
    expect(extractEndpoints([model({ id: 'a', base_url: undefined })])).toEqual([])
  })
})

describe('generateModelConfigKey', () => {
  it('带 provider 前缀时优先用未占用的短名', () => {
    expect(generateModelConfigKey('anthropic/claude-3', new Set())).toBe('claude-3')
  })

  it('短名被占用 → 回落到完整 slug', () => {
    const key = generateModelConfigKey('anthropic/claude-3', new Set(['claude-3']))
    expect(key).toBe('anthropic-claude-3')
  })

  it('短名与完整 slug 都被占用 → 递增后缀', () => {
    const taken = new Set(['claude-3', 'anthropic-claude-3'])
    expect(generateModelConfigKey('anthropic/claude-3', taken)).toBe(
      'anthropic-claude-3-2',
    )
    taken.add('anthropic-claude-3-2')
    expect(generateModelConfigKey('anthropic/claude-3', taken)).toBe(
      'anthropic-claude-3-3',
    )
  })

  it('非法字符归一成 -（不落成空键）', () => {
    expect(generateModelConfigKey('My Model!', new Set())).toBe('my-model-')
    expect(generateModelConfigKey('@@@', new Set())).toBe('---')
  })

  it('归一后为空（空串 / 纯空白）才回落 "model"', () => {
    expect(generateModelConfigKey('', new Set())).toBe('model')
    expect(generateModelConfigKey('   ', new Set())).toBe('model')
    expect(generateModelConfigKey('', new Set(['model']))).toBe('model-2')
  })
})

describe('fetchRemoteModels — 成功路径', () => {
  it('baseUrl 以 /v1 结尾时只请求 <base>/models', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([{ id: 'gpt-x' }]))
    const out = await fetchRemoteModels('https://api.example/v1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example/v1/models')
    expect(out.map((m) => m.id)).toEqual(['gpt-x'])
  })

  it('不以 /v1 结尾时逐个试候选，首个成功即返回', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([{ id: 'm1' }]))
    const out = await fetchRemoteModels('https://api.example')
    expect(out.map((m) => m.id)).toEqual(['m1'])
    // 首个候选就成功 → 不再试第二个
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.example/v1/models',
    ])
  })

  it('首个候选失败时继续试第二个（/models）', async () => {
    const fetchMock = stubFetch(async (url) =>
      String(url).endsWith('/v1/models')
        ? jsonResponse('nope', { status: 404 })
        : jsonResponse([{ id: 'second-wins' }]),
    )
    const out = await fetchRemoteModels('https://api.example')
    expect(out.map((m) => m.id)).toEqual(['second-wins'])
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.example/v1/models',
      'https://api.example/models',
    ])
  })

  it('末尾斜杠先剥掉，不产生双斜杠', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([]))
    await fetchRemoteModels('https://api.example/v1///')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.example/v1/models')
  })

  it('baseUrl 为空或纯空白 → 抛「请输入有效的 Base URL」且不发请求', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([]))
    await expect(fetchRemoteModels('   ')).rejects.toThrow('请输入有效的 Base URL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('apiKey 非空白才带 Bearer；空白 apiKey 不带 Authorization', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([]))
    await fetchRemoteModels('https://api.example', '  sk-key  ')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-key')

    fetchMock.mockClear()
    await fetchRemoteModels('https://api.example', '   ')
    const headers2 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers2.Authorization).toBeUndefined()
  })

  it('接受裸数组 / { data } / { models } 三种形状', async () => {
    for (const body of [
      [{ id: 'bare' }],
      { data: [{ id: 'wrapped-data' }] },
      { models: [{ id: 'wrapped-models' }] },
    ]) {
      stubFetch(async () => jsonResponse(body))
      const out = await fetchRemoteModels('https://api.example/v1')
      expect(out).toHaveLength(1)
    }
  })

  it('字符串条目转成 { id }；对象条目读 id / name / model', async () => {
    stubFetch(async () =>
      jsonResponse(['plain-id', { name: 'Only Name' }, { model: 'via-model' }]),
    )
    const out = await fetchRemoteModels('https://api.example/v1')
    expect(out.map((m) => m.id)).toEqual(['plain-id', 'Only Name', 'via-model'])
  })

  it('context_window 与 contextWindow 两种拼写都收，缺失则 undefined', async () => {
    stubFetch(async () =>
      jsonResponse([
        { id: 'snake', context_window: 1000 },
        { id: 'camel', contextWindow: 2000 },
        { id: 'none' },
      ]),
    )
    const out = await fetchRemoteModels('https://api.example/v1')
    expect(out.map((m) => m.context_window)).toEqual([1000, 2000, undefined])
  })

  it('无 id 的对象条目读 name 兜底；非对象条目被滤掉', async () => {
    stubFetch(async () => jsonResponse([{ name: 'no id' }, 42, null, { id: 'keep' }]))
    const out = await fetchRemoteModels('https://api.example/v1')
    // id 缺失时按 `obj.id || obj.name || obj.model` 回落，name 会被当作 id
    expect(out.map((m) => m.id)).toEqual(['no id', 'keep'])
  })

  it('id / name / model 全空的对象条目被滤掉；数字与 null 也不进结果', async () => {
    stubFetch(async () => jsonResponse([{ name: '' }, { model: '' }, 7, undefined, { id: 'ok' }]))
    const out = await fetchRemoteModels('https://api.example/v1')
    expect(out.map((m) => m.id)).toEqual(['ok'])
  })
})

describe('fetchRemoteModels — 失败路径', () => {
  it('形状无法识别 → 抛「不包含可识别的模型列表」', async () => {
    stubFetch(async () => jsonResponse({ nope: 1 }))
    await expect(fetchRemoteModels('https://api.example/v1')).rejects.toThrow(
      '不包含可识别的模型列表',
    )
  })

  it('HTTP 非 2xx 抛出带状态码的错误，正文有内容时用正文', async () => {
    stubFetch(async () => jsonResponse('bad gateway', { status: 502 }))
    await expect(fetchRemoteModels('https://api.example/v1')).rejects.toThrow('HTTP 502: bad gateway')
  })

  it('HTTP 非 2xx 且正文读取失败 → 回落到 statusText', async () => {
    stubFetch(async () => {
      const res = jsonResponse('', { status: 500 })
      ;(res as unknown as { text: () => Promise<string> }).text = async () => {
        throw new Error('stream broken')
      }
      return res
    })
    await expect(fetchRemoteModels('https://api.example/v1')).rejects.toThrow(
      'HTTP 500: Internal Server Error',
    )
  })

  it('第一个候选失败后继续试第二个；都失败则抛最后一个错误', async () => {
    const fetchMock = stubFetch(async (url) => {
      if (String(url).endsWith('/v1/models')) return jsonResponse('first down', { status: 404 })
      return jsonResponse('second down', { status: 503 })
    })
    await expect(fetchRemoteModels('https://api.example')).rejects.toThrow('HTTP 503: second down')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('非 Error 抛出物被包成 Error', async () => {
    stubFetch(async () => {
      throw 'plain string failure'
    })
    await expect(fetchRemoteModels('https://api.example/v1')).rejects.toThrow(
      'plain string failure',
    )
  })

  it('网络异常（TypeError）也被收集为 lastError 后抛出', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchRemoteModels('https://api.example/v1')).rejects.toThrow('Failed to fetch')
  })
})

describe('getModelsDevMap / 缓存与候选查询', () => {
  const devPayload = {
    'provider-a': {
      models: {
        'claude-3-5': {
          id: 'anthropic/claude-3-5',
          name: 'Claude 3.5',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          limit: { context: 200000, output: 8192 },
        },
      },
    },
    'provider-b': {
      models: {
        'claude-3-5': {
          id: 'anthropic/claude-3-5',
          name: 'Claude 3.5',
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          limit: { context: 200000, output: 8192 },
        },
      },
    },
  }

  beforeEach(() => {
    resetModelsDevCacheForTest()
  })

  it('响应 ok → 建索引，同一 id 被多家 provider 收录时按 provider 数聚合', async () => {
    stubFetch(async () => jsonResponse(devPayload))
    const map = await getModelsDevMap()
    expect(map.get('anthropic/claude-3-5')?.name).toBe('Claude 3.5')

    const efforts = getEffortCandidates('anthropic/claude-3-5')
    expect(efforts?.groups[0]).toMatchObject({ values: ['low', 'high'] })
    expect(efforts?.groups[0].providers).toEqual(['provider-a', 'provider-b'])

    const limits = getLimitCandidates('anthropic/claude-3-5')
    expect(limits?.groups[0]).toMatchObject({ context: 200000, output: 8192 })
  })

  it('响应非 ok → 返回空 Map', async () => {
    stubFetch(async () => jsonResponse({}, { status: 503 }))
    expect((await getModelsDevMap()).size).toBe(0)
  })

  it('fetch 抛错 → 返回空 Map（不向上抛）', async () => {
    stubFetch(async () => {
      throw new TypeError('offline')
    })
    expect((await getModelsDevMap()).size).toBe(0)
  })

  it('结果被缓存，第二次不再发请求', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(devPayload))
    await getModelsDevMap()
    await getModelsDevMap()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('并发调用共享同一个在飞 Promise', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(devPayload))
    const [a, b] = await Promise.all([getModelsDevMap(), getModelsDevMap()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('未加载前候选查询返回 undefined', () => {
    expect(getEffortCandidates('anything')).toBeUndefined()
    expect(getLimitCandidates('anything')).toBeUndefined()
  })

  it('候选查询支持完整 id 与去前缀 slug 两种键', async () => {
    stubFetch(async () => jsonResponse(devPayload))
    await getModelsDevMap()
    expect(getEffortCandidates('anthropic/claude-3-5')).toBeDefined()
    expect(getEffortCandidates('claude-3-5')).toBeDefined()
    expect(getEffortCandidates('ANTHROPIC/CLAUDE-3-5')).toBeDefined()
  })

  it('provider 没有 models 字段时跳过，不抛', async () => {
    stubFetch(async () =>
      jsonResponse({ empty: {}, good: { models: { x: { id: 'x', name: 'X' } } } }),
    )
    const map = await getModelsDevMap()
    expect(map.get('x')?.name).toBe('X')
  })

  it('缺 id 的模型条目被跳过', async () => {
    stubFetch(async () =>
      jsonResponse({ p: { models: { bad: { name: 'no id' }, ok: { id: 'ok', name: 'OK' } } } }),
    )
    const map = await getModelsDevMap()
    expect(map.has('ok')).toBe(true)
    expect([...map.values()].every((m) => !!m.id)).toBe(true)
  })

  it('没有 limit 的模型不产生 limit 候选组', async () => {
    stubFetch(async () =>
      jsonResponse({ p: { models: { m: { id: 'plain', name: 'Plain' } } } }),
    )
    await getModelsDevMap()
    expect(getLimitCandidates('plain')).toBeUndefined()
    expect(getEffortCandidates('plain')).toBeUndefined()
  })

  it('reasoning_options 里没有 effort 类型时不产生 effort 组', async () => {
    stubFetch(async () =>
      jsonResponse({
        p: {
          models: {
            m: {
              id: 'other-opt',
              name: 'Other',
              reasoning_options: [{ type: 'budget', values: ['1'] }],
            },
          },
        },
      }),
    )
    await getModelsDevMap()
    expect(getEffortCandidates('other-opt')).toBeUndefined()
  })

  it('同一 provider 重复上报同一组时不重复计入 providers', async () => {
    stubFetch(async () =>
      jsonResponse({
        p: {
          models: {
            a: { id: 'dup/model', name: 'A', limit: { context: 100 } },
            b: { id: 'dup/model', name: 'A', limit: { context: 100 } },
          },
        },
      }),
    )
    await getModelsDevMap()
    const limits = getLimitCandidates('dup/model')
    expect(limits?.groups[0].providers).toEqual(['p'])
  })
})
