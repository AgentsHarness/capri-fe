import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalTransport } from '../localTransport'
import type { HostInfo } from '../types'
import type { TransportCore } from '../transport'
import { clearHostRegistryHandoff, hostsRpc, rememberHostRegistry } from './hosts'

function h(hostId: string, over: Partial<HostInfo> = {}): HostInfo {
  return { hostId, hostName: hostId, online: true, ...over }
}

function core(url: string, fetchImpl: (u: string) => Promise<Response>): TransportCore {
  return {
    url: (p: string) => `${url}${p}`,
    apiBase: () => url,
    prefsOrigin: () => url,
    mode: 'hub',
    fetch: (path: string) => fetchImpl(path),
  } as unknown as TransportCore
}

function json(data: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

/** mixin 方法（Object.assign 挂上原型）对类型不可见，测试里按最小面取用。 */
function asHostApi(t: LocalTransport) {
  return t as unknown as {
    listHosts(): Promise<{ hosts: HostInfo[]; defaultHostId?: string }>
    probeAccess(): Promise<'ok' | 'need_token' | 'error'>
    setConnectionMode(mode: 'local' | 'hub', hubUrl?: string): void
  }
}

describe('listHosts 注册表交接', () => {
  beforeEach(() => {
    clearHostRegistryHandoff()
    vi.unstubAllGlobals()
  })

  it('同端点已有交接快照 → 不再发请求，直接用快照', async () => {
    const fetchMock = vi.fn()
    rememberHostRegistry('https://hub.example/api/hosts', {
      hosts: [h('mba', { local: false })],
      defaultHostId: 'mba',
      authRequired: false,
    })
    const r = await hostsRpc.listHosts.call(core('https://hub.example', fetchMock))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r).toEqual({ hosts: [expect.objectContaining({ hostId: 'mba' })], defaultHostId: 'mba' })
  })

  it('端点不同不命中（本机 host 的注册表 ≠ hub 的注册表）', async () => {
    const fetchMock = vi.fn(() => json({ hosts: [h('other')] }))
    rememberHostRegistry('/api/hosts', { hosts: [h('mba')] })
    const r = await hostsRpc.listHosts.call(core('https://hub.example', fetchMock))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.hosts[0].hostId).toBe('other')
  })

  it('快照只消费一次：下一次 listHosts 回到真实请求', async () => {
    const fetchMock = vi.fn(() => json({ hosts: [h('fresh')], defaultHostId: 'z' }))
    rememberHostRegistry('https://hub.example/api/hosts', {
      hosts: [h('stale')],
      defaultHostId: 'stale',
    })
    const c = core('https://hub.example', fetchMock)
    expect((await hostsRpc.listHosts.call(c)).hosts[0].hostId).toBe('stale')
    expect((await hostsRpc.listHosts.call(c)).hosts[0].hostId).toBe('fresh')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('renameHost 写过后交接作废：随后的 listHosts 必须问到新名字', async () => {
    // 先放一份「改名前」的快照，模拟启动期交接已经存在
    rememberHostRegistry('https://hub.example/api/hosts', { hosts: [h('mba', { hostName: '旧' })] })
    const renameFetch = vi.fn(() => json({ ok: true }))
    await hostsRpc.renameHost.call(core('https://hub.example', renameFetch), 'mba', '新名字')
    const listFetch = vi.fn(() => json({ hosts: [h('mba', { hostName: '新名字' })] }))
    const r = await hostsRpc.listHosts.call(core('https://hub.example', listFetch))
    expect(listFetch).toHaveBeenCalledTimes(1)
    expect(r.hosts[0].hostName).toBe('新名字')
  })
})

describe('probeAccess 交出自己的注册表应答', () => {
  beforeEach(() => {
    clearHostRegistryHandoff()
    localStorage.clear()
  })

  it('门禁探测问过 hub /api/hosts 后，首个 listHosts 不再重问', async () => {
    const t = asHostApi(new LocalTransport('', 'tok'))
    t.setConnectionMode('hub', 'https://hub.example')
    const hosts = [h('mba', { local: false }), h('mbp', { local: false })]
    const fetchMock = vi.fn(() => json({ hosts, defaultHostId: 'mba', authRequired: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await t.probeAccess()).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await t.listHosts()).toEqual({ hosts, defaultHostId: 'mba' })
    // 同一次启动里那份 hub 注册表只被问了一遍
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('门禁没过（需要密钥）时不交接，listHosts 仍自己问', async () => {
    const t = asHostApi(new LocalTransport('', ''))
    t.setConnectionMode('hub', 'https://hub.example')
    const fetchMock = vi.fn(() => json({ hosts: [h('mba')], authRequired: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await t.probeAccess()).toBe('need_token')
    expect(await t.listHosts()).toEqual({ hosts: [h('mba')], defaultHostId: undefined })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
