import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { LocalTransport } from './localTransport'
import { clearHostRegistryHandoff } from './rpc/hosts'

/**
 * 启动探测（detectMode / probeAccess）与「重挂载清理」的竞态回归。
 *
 * Vite HMR 改 App.tsx 会让 App 重新跑一次 boot()，同时**上一轮** AppShell 的
 * 卸载清理还在执行 `transport.disconnect()`（store/chat/actions/init.ts）。
 * disconnect 曾把新一轮在飞的 `GET /api/hosts` 一起 abort 掉，detectMode 的
 * catch 把这个自伤读成网络故障 → `mode: null` → 整屏「无法连接到服务」。
 * 探测请求因此单列一桶（probeInflight），谁都不许 abort。
 */

/** listHosts 走的是普通 hub 级队列（无 authProbe），清理时照旧该被作废。 */
type HostsRpc = {
  listHosts(): Promise<{ hosts: unknown[] }>
}

type Probe = LocalTransport & HostsRpc

function makeTransport(): Probe {
  return new LocalTransport('', '') as Probe
}

const HOST_HUB_BODY = {
  hosts: [{ hostId: 'mba', hostName: 'MacBook Air', local: true }],
  hostId: 'mba',
  authRequired: true,
  mode: 'hub',
  hubUrl: 'https://hub.example',
  port: 8765,
}

/**
 * 挂起的 fetch：请求发出后不自动应答，只有 flush() 才落地。signal 被 abort
 * 时按浏览器语义抛 AbortError——这正是能复现旧 bug 的那一环。
 */
function hangingFetch(
  responder: (url: string) => { status: number; body: unknown },
) {
  const pending: Array<() => void> = []
  const urls: string[] = []
  const impl = vi.fn((input: string, init: RequestInit = {}) => {
    const url = String(input)
    urls.push(url)
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal
      const abort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      pending.push(() => {
        const { status, body } = responder(url)
        resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        )
      })
    })
  })
  return { impl, flush: () => pending.splice(0).forEach((f) => f()), urls }
}

describe('启动探测不被重挂载清理打断', () => {
  beforeEach(() => {
    clearHostRegistryHandoff()
    localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('detectMode 在飞时 disconnect()：结论照常返回，不退成 mode: null', async () => {
    const t = makeTransport()
    const { impl, flush } = hangingFetch(() => ({ status: 200, body: HOST_HUB_BODY }))
    vi.stubGlobal('fetch', impl)

    const p = t.detectMode()
    t.disconnect()
    flush()

    await expect(p).resolves.toMatchObject({
      mode: 'hub',
      hubUrl: 'https://hub.example',
      localHostId: 'mba',
    })
  })

  it('detectMode 在飞时 setConnectionMode("local")：同样打不断它', async () => {
    const t = makeTransport()
    const { impl, flush } = hangingFetch(() => ({ status: 200, body: HOST_HUB_BODY }))
    vi.stubGlobal('fetch', impl)

    const p = t.detectMode()
    t.setConnectionMode('local', '')
    flush()

    await expect(p).resolves.toMatchObject({ mode: 'hub' })
  })

  it('probeAccess 在飞时 disconnect()：401 仍答 need_token，不塌成 error（否则会跳过门禁）', async () => {
    const t = makeTransport()
    const { impl, flush } = hangingFetch(() => ({
      status: 401,
      body: { error: '需要有效的访问 token', ok: false },
    }))
    vi.stubGlobal('fetch', impl)

    const p = t.probeAccess()
    t.disconnect()
    flush()

    await expect(p).resolves.toBe('need_token')
  })

  it('反向保护：普通 hub 级请求（listHosts）在飞时 disconnect() 照样作废', async () => {
    const t = makeTransport()
    const { impl, flush } = hangingFetch(() => ({
      status: 200,
      body: { hosts: [], defaultHostId: '' },
    }))
    vi.stubGlobal('fetch', impl)

    const p = t.listHosts()
    t.disconnect()
    flush()

    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})
