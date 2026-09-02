import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalTransport } from './localTransport'
import {
  PAGE_SLOT,
  loadHostToken,
  loadHostTokens,
  saveHostToken,
  saveHubToken,
} from './credentials'
import { clearHostRegistryHandoff } from './rpc/hosts'

/**
 * 两把 FE_TOKEN 允许不同值之后的行为契约：开机只过 hub 门、近路默认开、
 * 先拿 hub 那把探本机、探不过才问这台的钥匙；401 按目标分流。
 *
 * （端口归属探测本身、注册表交接、事件排序等契约在 localTransport.test.ts。）
 */

const HUB = 'https://hub.example'
const HUB_KEY = 'hub-key'
const MBA_KEY = 'key-of-mba'

/** 一次测试里所有出站请求的记账。 */
type Asked = { url: string; auth: string }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** capri-host 在 127.0.0.1:<port> 上自报的身份（免鉴权端点）。 */
function hostBody(hostId: string, authRequired: boolean) {
  return {
    authRequired,
    mode: 'hub',
    hubUrl: HUB,
    hostId,
    port: 8765,
    hosts: [{ hostId, hostName: hostId, local: true, online: true }],
  }
}

/**
 * 编排好的网络：hub 注册表、本机端口的 /api/hosts、/api/probe 的 200/401。
 * `probeAnswer` 决定这台要不要浏览器手里的另一把钥匙。
 */
function stubNet(opts: {
  probeAnswer?: (auth: string) => number
  hosts?: Array<{ hostId: string; port: number }>
}) {
  const asked: Asked[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      asked.push({ url, auth })
      if (url.startsWith('http://127.0.0.1:')) {
        if (url.endsWith('/api/hosts')) {
          const port = Number(/:(\d+)\//.exec(url)?.[1])
          const host = (opts.hosts ?? [{ hostId: 'mba', port: 8765 }]).find(
            (h) => h.port === port,
          )
          if (!host) return json(404, { error: 'nope' })
          return json(200, hostBody(host.hostId, opts.probeAnswer !== undefined))
        }
        if (url.endsWith('/api/probe')) {
          return json(opts.probeAnswer ? opts.probeAnswer(auth) : 404, { hostId: 'mba' })
        }
      }
      // hub 与其余一切（中继路径）
      if (url.endsWith('/api/hosts')) {
        return json(
          200,
          {
            hosts: (opts.hosts ?? [{ hostId: 'mba', port: 8765 }]).map((h) => ({
              hostId: h.hostId,
              hostName: h.hostId,
              online: true,
              port: h.port,
            })),
            defaultHostId: 'mba',
          },
        )
      }
      return json(200, { ok: true })
    }),
  )
  return asked
}

/** 建一个 hub 模式、已带 hub 密钥、已过门禁的 transport（选中 host 由调用方给）。 */
async function bootHub(
  opts: Parameters<typeof stubNet>[0] = {},
  extra = '',
): Promise<{ t: LocalTransport; asked: Asked[] }> {
  clearHostRegistryHandoff()
  localStorage.clear()
  // jsdom 没有 EventSource：一旦有可用近路，setHost 就会开本机 SSE 那一路。
  stubEventSource()
  if (extra) saveHostToken('mba', extra)
  saveHubToken(HUB_KEY)
  const asked = stubNet(opts)
  const t = new LocalTransport('', HUB_KEY)
  t.setConnectionMode('hub', HUB)
  await t.discoverLocalHost()
  t.setHost('mba')
  await t.verifyLocalRoute('mba')
  return { t, asked }
}

/** 放干在途的探路 promise（多层 await，别只等一个微任务）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  clearHostRegistryHandoff()
})

describe('近路先探再问', () => {
  it('这台不设 FE_TOKEN → 直接开放直连，一个密钥都不问', async () => {
    const { t } = await bootHub({})
    await flush()
    expect(t.getLocalRoute('mba')?.probe).toBe('open')
    expect(t.isLocalDirect()).toBe(true)
    // 开放主机不带任何 Bearer：hub 密钥不会被写进本机端口 / 代理日志
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:8765/api/sessions')
    const asked = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    const probeAsked = asked.filter(([u]) => String(u).includes('/api/probe'))
    expect(probeAsked).toHaveLength(0)
  })

  it('这台要钥匙 + hub 那把也打得开 → hub-ok，不弹窗', async () => {
    const { t } = await bootHub({
      probeAnswer: (auth) => (auth === `Bearer ${HUB_KEY}` ? 200 : 401),
    })
    await flush()
    expect(t.getLocalRoute('mba')?.probe).toBe('hub-ok')
    expect(t.isLocalDirect()).toBe(true)
    expect(t.getHostToken('mba')).toBe('')
  })

  it('这台要钥匙 + hub 那把打不开 → 先走中继，再请这台的钥匙', async () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    stubEventSource()
        stubNet({ probeAnswer: (auth) => (auth === `Bearer ${MBA_KEY}` ? 200 : 401) })
    const askedFor: string[] = []
    const t = new LocalTransport('', HUB_KEY)
    t.setConnectionMode('hub', HUB)
    t.onHostKeyRequired((id) => askedFor.push(id))
    await t.discoverLocalHost()
    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    await flush()

    // 弹窗问了，但答案没回来之前绝不带着错钥匙直连
    expect(askedFor).toEqual(['mba'])
    expect(t.getLocalRoute('mba')?.probe).toBe('pending')
    expect(t.isLocalDirect()).toBe(false)
    expect(t.activeRouteFor('mba')).toBe('pending')
    // 请求回落 hub 中继，且带的是 hub 那把
    expect(t.apiUrl('/api/sessions')).toBe(`${HUB}/api/sessions?host=mba`)
    // 每台一次会话只问一遍
    await t.verifyLocalRoute('mba')
    await flush()
    expect(askedFor).toEqual(['mba'])
  })

  it('探路是网络失败而不是 401 → 不改任何认证状态，仍走中继', async () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    stubEventSource()
        const t = new LocalTransport('', HUB_KEY)
    t.setConnectionMode('hub', HUB)
    const askedFor: string[] = []
    t.onHostKeyRequired((id) => askedFor.push(id))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/probe')) throw new TypeError('Failed to fetch')
        if (url.includes('127.0.0.1')) return json(200, hostBody('mba', true))
        return json(200, { hosts: [{ hostId: 'mba', online: true, port: 8765 }], defaultHostId: 'mba' })
      }),
    )
    await t.discoverLocalHost()
    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    await flush()

    expect(askedFor).toEqual([]) // 连不上 ≠ 钥匙不对，不该问
    expect(t.getLocalRoute('mba')?.probe).toBe('pending')
    expect(t.getHostToken('mba')).toBe('')
    expect(t.getAccessToken()).toBe(HUB_KEY) // hub 那把完好
    expect(t.getConnectionMode()).toBe('hub') // 也没被改判成 local
    expect(t.isLocalDirect()).toBe(false)
  })

  it('tryHostKey 通过才落库：存进 host 槽，hub 槽一个字不动', async () => {
    const { t } = await bootHub({
      probeAnswer: (auth) => (auth === `Bearer ${MBA_KEY}` ? 200 : 401),
    })
    await flush()
    expect(await t.tryHostKey('mba', 'wrong-key')).toBe(false)
    expect(loadHostToken('mba')).toBe('') // 错的不留
    expect(t.isLocalDirect()).toBe(false)

    expect(await t.tryHostKey('mba', MBA_KEY)).toBe(true)
    expect(loadHostToken('mba')).toBe(MBA_KEY)
    expect(localStorage.getItem('capri-fe.token')).toBe(HUB_KEY) // 没被顶掉
    expect(t.getLocalRoute('mba')?.probe).toBe('host-ok')
    expect(t.isLocalDirect()).toBe(true)
    // 刷新页面（重读 localStorage）后仍然认得这把
    const t2 = new LocalTransport('', HUB_KEY)
    t2.setConnectionMode('hub', HUB)
    expect(t2.getHostToken('mba')).toBe(MBA_KEY)
  })

  it('用户拒填 → 这台改走中继；hub 登录与其他 host 不受影响', async () => {
    const { t } = await bootHub({
      probeAnswer: () => 401,
      hosts: [
        { hostId: 'mba', port: 8765 },
        { hostId: 'mbp', port: 8766 },
      ],
    })
    await flush()
    t.declineHostKey('mba')
    expect(t.isLocalDirect()).toBe(false)
    expect(t.getRouteChoice('mba')).toBe('relay')
    expect(t.getAccessToken()).toBe(HUB_KEY)
    expect(t.activeRouteFor('mba')).toBe('relay')
    // 另一台同机的 host 没被牵连
    expect(t.getLocalRoute('mbp')).not.toBeNull()
    // 事后在菜单里改回直连：闸门清掉，重新问一次
    t.setHost('mbp')
    await t.verifyLocalRoute('mbp')
    await flush()
    expect(t.activeRouteFor('mbp')).toBe('pending')
  })

  it('探路吃了 401 后进入冷却：注册表风暴不再反复撞 401，但该问的照问', async () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    stubEventSource()
    const askedFor: string[] = []
    const t = new LocalTransport('', HUB_KEY)
    t.setConnectionMode('hub', HUB)
    t.onHostKeyRequired((id) => askedFor.push(id))
    saveHubToken(HUB_KEY)
    stubNet({ probeAnswer: () => 401 })
    await t.discoverLocalHost()
    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    await flush()
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    const probes = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/probe')).length
    const before = probes()
    expect(before).toBeGreaterThan(0)
    // 选中这台之后才终于问了一次（discoverLocalHost 阶段还没选中，不问）
    expect(askedFor).toEqual(['mba'])

    // 模拟 hosts_changed 反复驱动发现与定点核对：不再多撞一发 401
    for (let i = 0; i < 4; i += 1) {
      await t.discoverLocalHost([
        { hostId: 'mba', port: 8765, online: true },
        { hostId: 'other', port: 8766, online: true },
      ])
      await t.verifyLocalRoute('mba')
      await flush()
    }
    expect(probes()).toBe(before)
    // 一次会话每台只问一遍：风暴也没有把弹窗刷成第二遍
    expect(askedFor).toEqual(['mba'])
  })

  it('同机两台 host 各自一把钥匙，互不共用', async () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    stubEventSource()
        saveHostToken('mbp', 'k-mbp')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const auth = new Headers(init?.headers).get('Authorization') ?? ''
        if (url.includes('127.0.0.1:8765')) {
          if (url.endsWith('/api/hosts')) return json(200, hostBody('mba', true))
          return json(auth === `Bearer k-mba` ? 200 : 401, { hostId: 'mba' })
        }
        if (url.includes('127.0.0.1:8766')) {
          if (url.endsWith('/api/hosts')) {
            return json(200, { ...hostBody('mbp', true), port: 8766 })
          }
          return json(auth === 'Bearer k-mbp' ? 200 : 401, { hostId: 'mbp' })
        }
        return json(
          200,
          {
            hosts: [
              { hostId: 'mba', online: true, port: 8765 },
              { hostId: 'mbp', online: true, port: 8766 },
            ],
            defaultHostId: 'mba',
          },
        )
      }),
    )
    const t = new LocalTransport('', HUB_KEY)
    t.setConnectionMode('hub', HUB)
    await t.discoverLocalHost()
    await flush()

    t.setHost('mbp')
    await t.verifyLocalRoute('mbp')
    await flush()
    expect(t.getLocalRoute('mbp')?.probe).toBe('host-ok')
    expect(t.isLocalDirect()).toBe(true)
    // mbp 用自己的那把，而不是 mbp 端口上失败的 hub 那把
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)

    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    await flush()
    expect(await t.tryHostKey('mba', 'k-mba')).toBe(true)
    expect(loadHostTokens()).toEqual({ mbp: 'k-mbp', mba: 'k-mba' })
  })

  /**
   * 实测过的回归：注册表每次 hosts_changed 都会重跑一遍发现流程并重新登记
   * 候选。旧实现往闭包抓住的 route 对象上写探路结论，而登记把它整个换掉了
   * ——结果「两把同值、探路已经 200」，业务请求却全程留在 hub 中继。
   */
  it('探路结论写回当前候选：注册表风暴不会把已探通的机器退回中继', async () => {
    const { t } = await bootHub({
      probeAnswer: (auth) => (auth === `Bearer ${HUB_KEY}` ? 200 : 401),
    })
    await flush()
    expect(t.getLocalRoute('mba')?.probe).toBe('hub-ok')
    expect(t.isLocalDirect()).toBe(true)

    // 再跑几轮 hosts_changed 式刷新（同端口、同 authRequired）
    for (let i = 0; i < 3; i += 1) {
      await t.discoverLocalHost([{ hostId: 'mba', port: 8765, online: true }])
      await t.verifyLocalRoute('mba')
      await flush()
      expect(t.isLocalDirect(), `第 ${i + 1} 轮刷新后`).toBe(true)
    }
    expect(t.apiUrl('/api/sessions')).toBe('http://127.0.0.1:8765/api/sessions')
  })

  it('这台改配了钥匙 → 重新登记后旧的「开放」结论作废', async () => {
    const { t } = await bootHub({})
    await flush()
    expect(t.getLocalRoute('mba')?.probe).toBe('open')

    // host 重启后配上了 FE_TOKEN：先从注册表消失（旧候选作废），
    // 再以「要钥匙」的应答重新登记 —— 不能沿用之前的开放结论。
    await t.discoverLocalHost([{ hostId: 'other', port: 8766, online: true }])
    expect(t.getLocalRoute('mba')).toBeNull()
    stubNet({ probeAnswer: () => 401 })
    await t.discoverLocalHost([{ hostId: 'mba', port: 8765, online: true }])
    await flush()
    expect(t.getLocalRoute('mba')?.probe).not.toBe('open')
    expect(t.getLocalRoute('mba')?.authRequired).toBe(true)
    expect(t.isLocalDirect()).toBe(false)
  })
})

describe('请求按目标带钥匙', () => {
  it('打 hub 用 hub 槽；走近路用这台的 host 槽', async () => {
    const { t } = await bootHub(
      { probeAnswer: (auth) => (auth === `Bearer ${MBA_KEY}` ? 200 : 401) },
      MBA_KEY,
    )
    await flush()
    expect(t.isLocalDirect()).toBe(true)
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockClear()

    await t.apiFetch('/api/sessions', { method: 'POST' })
    let call = fetchMock.mock.calls.at(-1)
    expect(String(call?.[0])).toContain('127.0.0.1:8765')
    expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(`Bearer ${MBA_KEY}`)

    // 切到没有近路的另一台 → 走 hub，带 hub 那把
    t.setHost('other')
    await t.apiFetch('/api/sessions', { method: 'POST' })
    call = fetchMock.mock.calls.at(-1)
    expect(String(call?.[0])).toContain(HUB)
    expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(`Bearer ${HUB_KEY}`)
  })

  it('开放近路绝不把 hub 密钥写进 /events?token=', async () => {
    stubEventSource()
    const { t } = await bootHub({})
    await flush()
    t.setHost('mba')
    await t.verifyLocalRoute('mba')
    t.connect()
    const url = sseUrls[sseUrls.length - 1]
    expect(url).toBe('http://127.0.0.1:8765/events')
    expect(url).not.toContain(HUB_KEY)
  })

  it('近路要钥匙时，/events?token= 用的是这台的钥匙', async () => {
    stubEventSource()
    const { t } = await bootHub(
      { probeAnswer: (auth) => (auth === `Bearer ${MBA_KEY}` ? 200 : 401) },
      MBA_KEY,
    )
    await flush()
    t.connect()
    const url = sseUrls[sseUrls.length - 1]
    expect(url).toContain('http://127.0.0.1:8765/events?token=')
    expect(url).toContain(encodeURIComponent(MBA_KEY))
    expect(url).not.toContain(HUB_KEY)
  })
})

describe('401 按目标分流', () => {
  it('hub 拒绝 → 清 hub 槽并回门禁，host 槽与近路保留', async () => {
    const { t } = await bootHub(
      { probeAnswer: (auth) => (auth === `Bearer ${MBA_KEY}` ? 200 : 401) },
      MBA_KEY,
    )
    await flush()
    expect(t.isLocalDirect()).toBe(true)
    let gate = 0
    t.onHubAuthInvalid(() => (gate += 1))
    t.setHost('remote') // 没有近路的一台 → 打 hub
    saveHubToken(HUB_KEY) // hub 槽落盘，才谈得上「被清掉」

    // hub 换了 FE_TOKEN：中继请求一律 401
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('127.0.0.1')) return json(200, { ok: true })
        return json(401, { error: '需要有效的访问 token' })
      }),
    )
    await t.apiFetch('/api/sessions', { method: 'POST' })
    expect(gate).toBe(1)
    expect(localStorage.getItem('capri-fe.token')).toBeNull()
    expect(loadHostToken('mba')).toBe(MBA_KEY) // 那台的钥匙留着
    expect(t.getRouteChoice('mba')).toBe('auto')
  })

  it('并发 hub 401 只处理一次', async () => {
    const { t } = await bootHub({})
    let gate = 0
    t.onHubAuthInvalid(() => (gate += 1))
    t.setHost('remote')
    // 让 hub 一律回 401
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: '需要有效的访问 token' })))
    await Promise.all([
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/status'),
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/sessions', { method: 'POST' }),
    ])
    expect(gate).toBe(1)
  })

  it('近路拒绝 → 只关这台直连退中继，hub 登录完全不动', async () => {
    const { t } = await bootHub({
      probeAnswer: (auth) => (auth === `Bearer ${MBA_KEY}` ? 200 : 401),
    })
    await flush()
    expect(await t.tryHostKey('mba', MBA_KEY)).toBe(true)
    expect(t.isLocalDirect()).toBe(true)
    let gate = 0
    t.onHubAuthInvalid(() => (gate += 1))

    // 这台后来换了 FE_TOKEN：近路请求开始吃 401
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('127.0.0.1')) return json(401, { error: '需要有效的访问 token' })
        return json(200, { ok: true })
      }),
    )
    await t.apiFetch('/api/sessions', { method: 'POST' })

    expect(gate).toBe(0) // 没有回门禁
    expect(t.getAccessToken()).toBe(HUB_KEY) // hub 那把没被抹
    expect(localStorage.getItem('capri-fe.token')).toBe(HUB_KEY)
    expect(t.isLocalDirect()).toBe(false) // 只有这台退了
    expect(t.getRouteChoice('mba')).toBe('relay')
    expect(t.getConnectionMode()).toBe('hub') // 模式也没被改
  })

  it('并发近路 401 只处理一次：只关这台，不再追问', async () => {
    // 先让这台处于 hub-ok（两把同值）直连状态
    const { t } = await bootHub({ probeAnswer: () => 200 })
    await flush()
    expect(t.getLocalRoute('mba')?.probe).toBe('hub-ok')
    expect(t.isLocalDirect()).toBe(true)
    const askedFor: string[] = []
    t.onHostKeyRequired((id) => askedFor.push(id))

    // 这台随后换了自己的 FE_TOKEN：近路一律 401，hub 中继照常
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('127.0.0.1')) return json(401, { error: '需要有效的访问 token' })
        return json(200, { ok: true })
      }),
    )
    await Promise.all([
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/sessions', { method: 'POST' }),
      t.apiFetch('/api/sessions', { method: 'POST' }),
    ])

    // 一批 401 只落一次决定：这台退中继，钥匙不留下、也不再弹窗追问
    expect(t.getRouteChoice('mba')).toBe('relay')
    expect(t.isLocalDirect()).toBe(false)
    expect(askedFor).toEqual([])
    expect(loadHostToken('mba')).toBe('')
    // hub 那把与模式完好无损
    expect(t.getAccessToken()).toBe(HUB_KEY)
    expect(localStorage.getItem('capri-fe.token')).toBe(HUB_KEY)
    expect(t.getConnectionMode()).toBe('hub')
  })

  it('启动探测的 401 不算「密钥失效」（detectMode / probeAccess 自己判读）', async () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    saveHubToken('stale-key')
    const t = new LocalTransport('', 'stale-key')
    let gate = 0
    t.onHubAuthInvalid(() => (gate += 1))
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: '需要有效的访问 token' })))
    expect(await t.detectMode()).toEqual({ mode: 'hub', hubUrl: '' })
    t.setConnectionMode('hub', '')
    expect(await t.probeAccess()).toBe('need_token')
    expect(gate).toBe(0)
    expect(localStorage.getItem('capri-fe.token')).toBe('stale-key')
  })
})

describe('通路选择', () => {
  it('用户选中继 → 有候选也不直连；改回 auto 又可用', async () => {
    const { t } = await bootHub({})
    await flush()
    expect(t.isLocalDirect()).toBe(true)
    t.setRouteChoice('mba', 'relay')
    expect(t.isLocalDirect()).toBe(false)
    expect(t.apiUrl('/api/sessions')).toBe(`${HUB}/api/sessions?host=mba`)
    expect(t.hasLocalCandidate('mba')).toBe(true) // 候选还在
    t.setRouteChoice('mba', 'auto')
    expect(t.isLocalDirect()).toBe(true)
  })

  /** 钥匙没就绪就不许直连；就绪后立刻放行（走的是公开判据，不测内部函数）。 */
  it('pending 的近路不允许直连，探通后允许', async () => {
    const { t } = await bootHub({ probeAnswer: () => 401 })
    await flush()
    const route = t.getLocalRoute('mba')
    expect(route?.probe).toBe('pending')
    expect(t.isLocalDirect()).toBe(false)
    if (route) {
      route.probe = 'open'
      expect(t.isLocalDirect()).toBe(true)
    }
  })
})

describe('纯 local 模式也用 host 槽', () => {
  it('门禁写进的是页面这台的 host 槽，不是 hub 槽', async () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('/api/hosts')
          ? json(200, {
              hosts: [{ hostId: 'mba', local: true }],
              authRequired: true,
              mode: 'local',
              hostId: 'mba',
            })
          : json(200, { ok: true }),
      ),
    )
    const t = new LocalTransport('')
    const r = await t.detectMode()
    expect(r.mode).toBe('local')
    t.setConnectionMode('local', '')
    t.setLocalHostId(r.localHostId ?? null, r.authRequired === true)
    expect(await t.probeAccess()).toBe('need_token')

    t.setAccessToken('the-local-host-key')
    expect(localStorage.getItem('capri-fe.token')).toBeNull() // hub 槽保持空
    expect(loadHostToken('mba')).toBe('the-local-host-key')
    expect(t.getAccessToken()).toBe('the-local-host-key')
    // 本机请求就带这把
    await t.apiFetch('/api/status')
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)
    expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(
      'Bearer the-local-host-key',
    )
  })

  it('老版本存在 hub 槽的本机钥匙：认出 hostId 后搬进 host 槽', () => {
    clearHostRegistryHandoff()
    localStorage.clear()
    localStorage.setItem('capri-fe.token', 'legacy-local-key')
    const t = new LocalTransport('', 'legacy-local-key')
    t.setConnectionMode('local', '')
    t.setLocalHostId('mba', true)
    expect(loadHostToken('mba')).toBe('legacy-local-key')
    expect(localStorage.getItem('capri-fe.token')).toBeNull()
    expect(t.getAccessToken()).toBe('legacy-local-key')
  })

  it('host 没设 FE_TOKEN 时不搬（hub 残留就该留在 hub 槽）', () => {
    localStorage.clear()
    localStorage.setItem('capri-fe.token', 'hub-leftover')
    const t = new LocalTransport('', 'hub-leftover')
    t.setConnectionMode('local', '')
    t.setLocalHostId('mba', false)
    expect(loadHostToken('mba')).toBe('')
    expect(localStorage.getItem('capri-fe.token')).toBe('hub-leftover')
  })

  it('认不出 hostId 时退到 PAGE_SLOT 保留格', () => {
    localStorage.clear()
    const t = new LocalTransport('')
    t.setConnectionMode('local', '')
    t.setLocalHostId(null)
    t.setAccessToken('k')
    expect(loadHostToken(PAGE_SLOT)).toBe('k')
  })
})

// ── 测试桩 ──────────────────────────────────────────────────────────────

const sseUrls: string[] = []
function stubEventSource() {
  sseUrls.length = 0
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
        sseUrls.push(url)
      }
      close() {}
    },
  )
}
