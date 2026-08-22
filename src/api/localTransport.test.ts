import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { LocalTransport } from './localTransport'
import type { HubPrefsDoc } from './types'

/**
 * prefsOrigin 决定置顶/待办回写目的地：
 * - hub 模式 + 显式 hubUrl / lastHubUrl → 该地址；
 * - hub 模式 + 双空（部署版与 hub 同源，base 为空串）→ 页面 origin；
 * - local 模式 → 空串（仅 localStorage，不写 hub）。
 */
// rpcMixins 经 Object.assign 挂在原型上，类类型上不可见——补上测试用面。
type PrefsRpc = {
  getPrefs(): Promise<{ prefs: HubPrefsDoc; version?: number }>
  putPrefs(prefs: HubPrefsDoc, baseVersion?: number): Promise<{ version?: number }>
}

function makeTransport(): LocalTransport & PrefsRpc {
  return new LocalTransport() as LocalTransport & PrefsRpc
}

describe('prefsOrigin', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认 local 模式 → 空串', () => {
    const t = makeTransport()
    expect(t.prefsOrigin()).toBe('')
  })

  it('hub 模式 + 显式 hubUrl → 返回 hubUrl', () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    expect(t.prefsOrigin()).toBe('https://hub.example')
  })

  it('hub 模式 + 空 hubUrl + lastHubUrl 有值（localStorage 遗留）→ lastHubUrl', () => {
    localStorage.setItem('capri-fe.hubUrl', 'https://hub.example')
    const t = makeTransport()
    t.setConnectionMode('hub', '')
    expect(t.prefsOrigin()).toBe('https://hub.example')
  })

  it('hub 模式 + 双空（同源部署）→ 回退页面 origin', () => {
    const t = makeTransport()
    t.setConnectionMode('hub', '')
    expect(t.prefsOrigin()).toBe(location.origin)
  })

  it('切回 local 模式 → 清空并返回空串', () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    t.setConnectionMode('local', '')
    expect(t.getConnectionMode()).toBe('local')
    expect(t.prefsOrigin()).toBe('')
  })

  it('同源部署下 putPrefs 请求打到页面 origin 的 /api/prefs', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', '')
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      await t.putPrefs({ pinnedWorkspaces: ['/x'], pinnedSessions: [], todos: {}, fePrefs: {} })
      expect(fetchMock).toHaveBeenCalledWith(
        `${location.origin}/api/prefs`,
        expect.objectContaining({ method: 'PUT' }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// 补一个 getPrefs 同源路径（上面 putPrefs 已覆盖 fetch 拼 URL 逻辑，
// 这里验证读取侧返回文档解析结果）。
describe('getPrefs (same-origin)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hub 模式 + 空 hubUrl → 从页面 origin 拉取', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: true, prefs: { pinnedWorkspaces: ['/x'] }, version: 7 }),
          { status: 200 },
        ),
      ),
    )
    const { prefs, version } = await t.getPrefs()
    expect(prefs).toEqual({ pinnedWorkspaces: ['/x'] })
    expect(version).toBe(7)
  })

  it('putPrefs 带 baseVersion 时写入请求体（条件写）', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, version: 8 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await t.putPrefs({ pinnedWorkspaces: [] }, 7)
      expect(res.version).toBe(8)
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        prefs?: unknown
        baseVersion?: number
      }
      expect(body.baseVersion).toBe(7)
      expect(body.prefs).toEqual({ pinnedWorkspaces: [] })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})