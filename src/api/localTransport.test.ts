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

describe('detectMode 鉴权顺序', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('直连 + authRequired：先 hosts 再 status，且 status 带 Bearer', async () => {
    const t = new LocalTransport('', 'secret-token')
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/status')) {
        const h = new Headers(init?.headers)
        expect(h.get('Authorization')).toBe('Bearer secret-token')
        return new Response(
          JSON.stringify({ mode: 'hub', hubUrl: 'https://hub.example', hostId: 'mba' }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          hosts: [{ hostId: 'mba', local: true }],
          authRequired: true,
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await t.detectMode()
    expect(r).toEqual({
      mode: 'hub',
      hubUrl: 'https://hub.example',
      localHostId: 'mba',
    })
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    // 必须串行：hosts 返回并置 localAuthRequired 之后才发 status，
    // 否则默认 mode=local 会剥掉 Bearer → status 401 → 盲判 local。
    expect(urls).toEqual(['/api/hosts', '/api/status'])
  })

  it('非直连 hub：只打 hosts，不发 status', async () => {
    const t = makeTransport()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/status')) {
        throw new Error('status must not be requested for multi-host hub')
      }
      return new Response(
        JSON.stringify({ hosts: [{ hostId: 'h-a', local: false }], defaultHostId: 'h-a' }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await t.detectMode()
    expect(r).toEqual({ mode: 'hub', hubUrl: '' })
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/hosts'])
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

describe('discoverLocalHost', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('按 hub 下发的 port 探测本机，命中则写入 localBase + localHostId', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input)
        if (url.includes('127.0.0.1:8765/api/hosts')) {
          return new Response(
            JSON.stringify({
              authRequired: true,
              hosts: [{ hostId: 'mba', hostName: 'MBA', local: true, online: true }],
            }),
            { status: 200 },
          )
        }
        return new Response('nope', { status: 404 })
      }),
    )
    const id = await t.discoverLocalHost([
      { hostId: 'mba', port: 8765, online: true },
      { hostId: 'other', port: 9000, online: true },
    ])
    expect(id).toBe('mba')
    expect(t.getLocalHostId()).toBe('mba')
    expect(t.getLocalBase()).toBe('http://127.0.0.1:8765')
  })

  it('本机应答的 hostId 与 hub 条目不一致则跳过', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            hosts: [{ hostId: 'someone-else', local: true }],
          }),
          { status: 200 },
        ),
      ),
    )
    const id = await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    expect(id).toBeNull()
    expect(t.getLocalHostId()).toBeNull()
    expect(t.getLocalBase()).toBe('')
  })

  it('本机无服务时保持未发现', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const id = await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    expect(id).toBeNull()
  })
})
