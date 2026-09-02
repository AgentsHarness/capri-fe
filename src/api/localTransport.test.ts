import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { LocalTransport } from './localTransport'
import { clearHostRegistryHandoff, rememberHostRegistry } from './rpc/hosts'
import type { HubPrefsDoc } from './types'

/** 注册表交接快照是模块级缓存（按 URL 键）：每个用例前清一次，否则上一条
 *  detectMode/probeAccess 存下的快照会被后一条的 listHosts 消费掉。 */
beforeEach(() => {
  clearHostRegistryHandoff()
})

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

describe('detectMode 认模式', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  /**
   * 新版 host：免鉴权的 /api/hosts 自己就带 mode/hubUrl/hostId，一次请求定
   * 模式，**不再问需鉴权的 /api/status**。这是「局域网 IP 打开内嵌页、浏览器
   * 手里还没有 host 那把」也能升 hub 的前提。
   */
  it('host 直连 + authRequired：只看 /api/hosts 就升到 hub，不问 status', async () => {
    const t = new LocalTransport('', 'secret-token')
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/status')) {
        throw new Error('status must not be requested — /api/hosts already carries mode')
      }
      return new Response(
        JSON.stringify({
          hosts: [{ hostId: 'mba', local: true }],
          authRequired: true,
          mode: 'hub',
          hubUrl: 'https://hub.example',
          hostId: 'mba',
          port: 8765,
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
      authRequired: true,
    })
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/hosts'])
  })

  /** 纯 local（host 没配 HUB_URL）：锁本机，hostId 照样带回来。 */
  it('host 直连 + 未配 HUB_URL → local 模式', async () => {
    const t = makeTransport()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            hosts: [{ hostId: 'mba', local: true }],
            authRequired: false,
            mode: 'local',
            hostId: 'mba',
          }),
          { status: 200 },
        ),
      ),
    )
    expect(await t.detectMode()).toEqual({
      mode: 'local',
      hubUrl: '',
      localHostId: 'mba',
      authRequired: false,
    })
  })

  /**
   * 降级路径：旧版本 host 的 /api/hosts 不带 mode，只能去问 status。
   * 串行仍然必要（先 hosts 才知道这是台 host），且手里有密钥就带上。
   */
  it('旧 host（无 mode）：回退问一次 /api/status，并带上已有密钥', async () => {
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
      authRequired: true,
    })
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/hosts', '/api/status'])
  })

  /**
   * 关键回归（曾经的事故）：探测请求被网络打断时**不能**盲判 local ——
   * 那会连带把 hub 模式与刚输入的密钥一起丢掉。mode:null = 不可知，
   * 调用方（App）留在原地让用户重试。
   */
  it('网络失败 → mode:null，不改模式也不动密钥', async () => {
    localStorage.setItem('capri-fe.token', 'hub-secret')
    const t = new LocalTransport('', 'hub-secret')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await t.detectMode()).toEqual({ mode: null, hubUrl: '' })
    // 什么都没被改动：模式没被切成 local（仍是探测前的默认态），hub 槽那把还在
    expect(localStorage.getItem('capri-fe.token')).toBe('hub-secret')
    expect(t.getConnectionMode()).toBe('local')
    // 槽没被抹的证据：认定成 hub 模式后，门禁那把立刻就是它
    t.setConnectionMode('hub', 'https://hub.example')
    expect(t.getAccessToken()).toBe('hub-secret')
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

  /** capri-host 在 127.0.0.1:<port> 上的应答形状（单 host + local:true）。 */
  function hostBody(hostId: string, authRequired = false) {
    return {
      authRequired,
      hosts: [{ hostId, hostName: hostId, local: true, online: true }],
    }
  }

  /**
   * 按端口号编排本机应答；返回被探过的端口序列，供「探了几次」断言。
   * 没编排到的端口一律 404（等价于该端口无服务）。
   */
  function stubLocalPorts(byPort: Record<number, unknown>) {
    const probed: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/api\/hosts$/.exec(String(input))
        if (!m) return new Response(JSON.stringify({ hosts: [] }), { status: 200 })
        const port = Number(m[1])
        probed.push(port)
        const body = byPort[port]
        if (body === undefined) return new Response('nope', { status: 404 })
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    return probed
  }

  /** 本机 SSE 实例（jsdom 无 EventSource，桩出来供测试灌事件）。 */
  const sseInstances: Array<{
    url: string
    self: { onmessage: ((m: MessageEvent) => void) | null }
  }> = []
  function stubEventSource() {
    sseInstances.length = 0
    vi.stubGlobal(
      'EventSource',
      class {
        static readonly OPEN = 1
        static readonly CLOSED = 2
        readyState = 1
        onopen: (() => void) | null = null
        onmessage: ((m: MessageEvent) => void) | null = null
        onerror: (() => void) | null = null
        constructor(url: string) {
          sseInstances.push({ url, self: this })
        }
        close() {}
      },
    )
  }

  it('本机 SSE 上的 hello 自报了别的 hostId：近路立即作废，回落 hub 中继', async () => {
    const t = makeTransport()
    stubEventSource()
    // 编排本机应答：以前这几条用例没 stub fetch，实际是打到开发机上真在跑的
    // 8765 —— 那台设了 FE_TOKEN 就会让近路停在 pending，用例随环境漂移。
    stubLocalPorts({ 8765: hostBody('mba') })
    t.setConnectionMode('hub', 'https://hub.example')
    await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    t.setHost('mba')
    expect(t.isLocalDirect()).toBe(true)
    const sse = sseInstances[sseInstances.length - 1]
    expect(sse?.url).toBe('http://127.0.0.1:8765/events')
    // 端口被另一台 host 接管：应答者自报 mbp
    sse!.self.onmessage?.({
      data: JSON.stringify({ type: 'hello', hostId: 'mbp', ready: true }),
    } as MessageEvent)
    expect(t.getLocalRoute('mba')).toBeNull()
    expect(t.isLocalDirect()).toBe(false)
    expect(t.apiUrl('/api/sessions')).toBe('https://hub.example/api/sessions?host=mba')
  })

  it('本机 SSE 上自报身份一致的 hello 不影响近路', async () => {
    const t = makeTransport()
    stubEventSource()
    stubLocalPorts({ 8765: hostBody('mba') })
    t.setConnectionMode('hub', 'https://hub.example')
    await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    t.setHost('mba')
    const sse = sseInstances[sseInstances.length - 1]
    sse!.self.onmessage?.({
      data: JSON.stringify({ type: 'hello', hostId: 'mba', ready: true }),
    } as MessageEvent)
    expect(t.isLocalDirect()).toBe(true)
  })

  it('多台 host 共用默认端口：近路认给端口上真正应答的那台', async () => {
    // 实测形状：hub 注册表 mba 与 mbp 都报 port 8765（各自机器上的默认端口），
    // 浏览器在 mbp 上。按「候选 hostId 期待应答者」的旧逻辑，8765 被列表首位的
    // mba 认领 → 应答者 mbp 被判不匹配 → 一台也探不到 → 全程 hub 中继。
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    const probed = stubLocalPorts({ 8765: hostBody('mbp') })
    const id = await t.discoverLocalHost([
      { hostId: 'mba', port: 8765, online: true },
      { hostId: 'mbp', port: 8765, online: true },
    ])
    expect(probed).toEqual([8765])
    expect(id).toBe('mbp')
    expect(t.getLocalRoute('mbp')?.base).toBe('http://127.0.0.1:8765')
    expect(t.getLocalRoute('mba')).toBeNull()
    // 旧访问器（store 的挑选链与 TopBar 兼容用）指向同一条近路
    expect(t.getLocalHostId()).toBe('mbp')
    expect(t.getLocalBase()).toBe('http://127.0.0.1:8765')
  })

  it('同机多台 host（各自端口）全部登记近路，不止第一条', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    stubLocalPorts({ 8765: hostBody('a'), 8766: hostBody('b') })
    await t.discoverLocalHost([
      { hostId: 'a', port: 8765, online: true },
      { hostId: 'b', port: 8766, online: true },
    ])
    t.setHost('b')
    expect(t.isLocalDirect()).toBe(true)
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:8766/api/sessions')
    t.setHost('a')
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:8765/api/sessions')
    t.setHost('remote')
    expect(t.isLocalDirect()).toBe(false)
    expect(t.apiUrl('/api/sessions')).toBe('https://hub.example/api/sessions?host=remote')
  })

  it('端口上应答的 host 不在 hub 注册表里则不绑', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    stubLocalPorts({ 8765: hostBody('stranger') })
    const id = await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    expect(id).toBeNull()
    expect(t.getLocalRoute('stranger')).toBeNull()
  })

  it('已验证的端口不再重复探测；探不到的端口进重试冷却', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    const probed = stubLocalPorts({ 8765: hostBody('mba') })
    const hosts = [
      { hostId: 'mba', port: 8765, online: true },
      { hostId: 'ghost', port: 9999, online: true },
    ]
    await t.discoverLocalHost(hosts)
    expect(probed).toEqual([8765, 9999])
    // hosts_changed 反复驱动：命中的 8765 与刚失败的 9999 都不再探
    await t.discoverLocalHost(hosts)
    expect(probed).toEqual([8765, 9999])
    expect(t.getLocalHostId()).toBe('mba')
  })

  it('hub 未下发端口时回退默认端口，身份仍以应答者为准', async () => {
    const t = makeTransport()
    t.setConnectionMode('hub', 'https://hub.example')
    const probed = stubLocalPorts({ 8765: hostBody('old-host') })
    const id = await t.discoverLocalHost([{ hostId: 'old-host', online: true }])
    expect(probed).toEqual([8765])
    expect(id).toBe('old-host')
  })

  it('host 换了端口：作废旧近路并重探新端口', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    const probed = stubLocalPorts({ 8765: hostBody('mba'), 9001: hostBody('mba') })
    await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    t.setHost('mba')
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:8765/api/sessions')
    // hub 心跳把端口更新成 9001（PORT 改了 / 重启换端口）
    await t.discoverLocalHost([{ hostId: 'mba', port: 9001 }])
    expect(probed).toEqual([8765, 9001])
    expect(t.getLocalRoute('mba')?.base).toBe('http://127.0.0.1:9001')
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:9001/api/sessions')
  })

  it('端口被别的 host 接管：旧近路作废，回落 hub 中继', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    // mba 原来在 8765；现在 8765 上应答的是别人（mbp 重启后占了这台机器的端口）
    const probed = stubLocalPorts({ 8765: hostBody('mbp') })
    await t.discoverLocalHost([
      { hostId: 'mba', port: 8765 },
      { hostId: 'mbp', port: 8765 },
    ])
    expect(t.getLocalRoute('mba')).toBeNull()
    t.setHost('mba')
    // 选中 mba 时定点探测：8765 应答的不是 mba → 不建近路，走 hub 中继
    await t.verifyLocalRoute('mba')
    expect(probed).toEqual([8765, 8765])
    expect(t.isLocalDirect()).toBe(false)
    expect(t.apiUrl('/api/sessions')).toBe('https://hub.example/api/sessions?host=mba')
  })

  it('verifyLocalRoute：切 host 时只探它那一个端口，且身份必须逐字匹配', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    const probed = stubLocalPorts({ 8765: hostBody('mba'), 8766: hostBody('other') })
    await t.discoverLocalHost([
      { hostId: 'mba', port: 8765 },
      { hostId: 'mbp', port: 8766 },
    ])
    expect(t.getLocalRoute('mbp')).toBeNull()
    t.setHost('mbp')
    await t.verifyLocalRoute('mbp')
    // 只为 mbp 探了 8766（应答者是 other → 不是它，不建近路）
    expect(probed).toEqual([8765, 8766, 8766])
    expect(t.isLocalDirect()).toBe(false)
    // 已验证的 mba 再切回去不产生任何探测
    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    expect(probed).toEqual([8765, 8766, 8766])
    expect(t.isLocalDirect()).toBe(true)
  })

  it('近路 host 从注册表消失（unpair）：近路随之作废', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    stubLocalPorts({ 8765: hostBody('mba') })
    await t.discoverLocalHost([{ hostId: 'mba', port: 8765 }])
    t.setHost('mba')
    expect(t.isLocalDirect()).toBe(true)
    await t.discoverLocalHost([{ hostId: 'mbp', port: 8765 }])
    expect(t.getLocalRoute('mba')).toBeNull()
  })

  it('无参 discoverLocalHost 吃注册表交接快照，不再多问一次 hub /api/hosts', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    // detectMode / probeAccess 刚问过的那个 URL 的同一份应答
    rememberHostRegistry('https://hub.example/api/hosts', {
      hosts: [{ hostId: 'mba', hostName: 'mba', online: true, port: 8765 }],
    })
    const asked: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input)
        asked.push(url)
        if (url.includes('127.0.0.1:8765/api/hosts')) {
          return new Response(JSON.stringify(hostBody('mba')), { status: 200 })
        }
        return new Response(JSON.stringify({ hosts: [] }), { status: 200 })
      }),
    )
    expect(await t.discoverLocalHost()).toBe('mba')
    expect(asked.filter((u) => u === 'https://hub.example/api/hosts')).toHaveLength(0)
    expect(asked.some((u) => u.includes('127.0.0.1:8765'))).toBe(true)
    expect(t.getLocalRoute('mba')?.base).toBe('http://127.0.0.1:8765')
  })

  it('端口探不到（浏览器拒绝本地网络访问 / 无服务）→ 冷却期内不再撞第二次', async () => {
    const t = makeTransport()
    stubEventSource()
    t.setConnectionMode('hub', 'https://hub.example')
    const probed: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input)
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/api\/hosts$/.exec(url)
        if (m) {
          probed.push(Number(m[1]))
          throw new TypeError('Failed to fetch')
        }
        return new Response(
          JSON.stringify({
            hosts: [
              { hostId: 'mba', hostName: 'mba', online: true, port: 8765 },
              { hostId: 'mbp', hostName: 'mbp', online: true, port: 8767 },
            ],
          }),
          { status: 200 },
        )
      }),
    )
    await t.discoverLocalHost([
      { hostId: 'mba', port: 8765, online: true },
      { hostId: 'mbp', port: 8767, online: true },
    ])
    expect(probed).toEqual([8765, 8767])
    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    // 两个端口都刚探不到 → 进冷却，切 host 的定点验证不再撞
    expect(probed).toEqual([8765, 8767])
    expect(t.isLocalDirect()).toBe(false)
    expect(t.apiUrl('/api/sessions')).toBe('https://hub.example/api/sessions?host=mba')
    t.setHost('mbp')
    await t.verifyLocalRoute('mbp')
    expect(probed).toEqual([8765, 8767])
    expect(t.isLocalDirect()).toBe(false)
  })
})

/**
 * 部署版前端与 hub 同源（detectMode 给出 hubUrl: ''，apiBase() 回落到
 * base）。此时 base 必须一直是 hub 的 origin：本机近路只能写在 localBase
 * 上，否则 listHosts 会打到 capri-host（它永远只报自己一个 host），host
 * 列表塌成一台、也切不到 Hub 中继的节点。
 */
describe('本机近路与 hub base 隔离（同源部署）', () => {
  const HUB_HOSTS = [
    { hostId: 'mba', hostName: 'MBA', online: true, local: false, port: 8765 },
    { hostId: 'vps', hostName: 'VPS', online: true, local: false, port: 0 },
  ]

  type HubRpc = {
    listHosts(): Promise<{ hosts: Array<{ hostId: string }>; defaultHostId?: string }>
  }
  function makeHubTransport(base = '', token = ''): LocalTransport & HubRpc {
    return new LocalTransport(base, token) as LocalTransport & HubRpc
  }

  function stub(hubHosts: unknown[]) {
    const calls: Array<{ url: string; auth: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({
          url,
          auth: new Headers(init?.headers).get('Authorization'),
        })
        if (url === 'http://127.0.0.1:8765/api/hosts') {
          return new Response(
            JSON.stringify({
              hosts: [{ hostId: 'mba', hostName: 'MBA', local: true, online: true }],
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ hosts: hubHosts }), { status: 200 })
      }),
    )
    return calls
  }

  /** jsdom 无 EventSource：记下每条本机 SSE 的 URL 供断言。 */
  let sseUrls: string[] = []
  let wsUrls: string[] = []
  beforeEach(() => {
    sseUrls = []
    wsUrls = []
    vi.stubGlobal(
      'EventSource',
      class {
        static readonly OPEN = 1
        readyState = 1
        onopen: (() => void) | null = null
        onmessage: ((m: MessageEvent) => void) | null = null
        onerror: (() => void) | null = null
        constructor(url: string) {
          sseUrls.push(url)
        }
        close() {}
      },
    )
    vi.stubGlobal(
      'WebSocket',
      class {
        static readonly OPEN = 1
        readyState = 1
        binaryType = 'blob'
        onopen: (() => void) | null = null
        onmessage: ((m: MessageEvent) => void) | null = null
        onclose: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor(url: string) {
          wsUrls.push(url)
        }
        close() {}
        send() {}
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('发现近路后 hub 级请求仍打 hub，只有选中本机才走 127.0.0.1', async () => {
    const t = makeHubTransport()
    t.setConnectionMode('hub', '')
    const calls = stub(HUB_HOSTS)
    const id = await t.discoverLocalHost(HUB_HOSTS)
    expect(id).toBe('mba')
    expect(t.getLocalBase()).toBe('http://127.0.0.1:8765')

    // 注册表来自 hub：两台都在（本机应答只有一台，pre-fix 会塌成 ['mba']）。
    const { hosts } = await t.listHosts()
    expect(hosts.map((h) => h.hostId)).toEqual(['mba', 'vps'])
    expect(calls[calls.length - 1]?.url).toBe('/api/hosts')

    t.setHost('mba')
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:8765/api/sessions')
    // 本机 SSE 近路同样落在 127.0.0.1
    expect(sseUrls).toContain('http://127.0.0.1:8765/events')
    t.setHost('vps')
    expect(t.apiUrl('/api/sessions')).toBe('/api/sessions?host=vps')
    // hub 的 live WS 必须连 hub，不能被本机近路顶掉（否则远程 host 永不推送）
    t.connect()
    await new Promise((r) => setTimeout(r, 0)) // connectWS 换 ticket 后才建连
    expect(wsUrls).toHaveLength(1)
    expect(wsUrls[0]).toMatch(/^ws:\/\/[^/]+\/ws\/fe/)
    t.disconnect()
  })

  it('hub 需要密钥、本机开放：近路请求剥 Bearer，hub 级请求照带', async () => {
    const t = makeHubTransport('', 'hub-secret')
    t.setConnectionMode('hub', '')
    const calls = stub(HUB_HOSTS)
    await t.discoverLocalHost(HUB_HOSTS)
    t.setHost('mba')
    await t.apiFetch('/api/sessions')
    await t.listHosts()
    const local = calls.find((c) => c.url === 'http://127.0.0.1:8765/api/sessions')
    const hub = calls[calls.length - 1]
    expect(local?.auth).toBeNull()
    expect(hub?.url).toBe('/api/hosts')
    expect(hub?.auth).toBe('Bearer hub-secret')
  })

  it('切回 local 模式后近路不再生效（回落到页面 origin）', async () => {
    const t = makeHubTransport()
    t.setConnectionMode('hub', '')
    stub(HUB_HOSTS)
    await t.discoverLocalHost(HUB_HOSTS)
    t.setHost('mba')
    t.setConnectionMode('local', '')
    expect(t.apiUrl('/api/sessions')).toBe('/api/sessions')
  })
})
