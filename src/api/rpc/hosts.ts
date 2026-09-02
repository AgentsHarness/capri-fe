import type { TransportCore } from '../transport'
import { AccessTokenError, PrefsConflictError } from '../transport'
import type { HostInfo, HubPrefsDoc } from '../types'

/**
 * 启动期注册表交接缓存。同一个 `GET {apiBase}/api/hosts` 在一次启动里要被
 * 用四处：detectMode 判模式、probeAccess 过鉴权门禁、discoverLocalHost 拿
 * 端口表、refreshHosts 选 host——都是同一个 URL 的同一份文档。谁先问到谁把
 * 应答按 URL 存下，窗口内的其余调用直接取用。
 *
 * 窗口很短（REGISTRY_HANDOFF_MS）且只服务「刚问过」这一语义：超窗一律重问，
 * 凭证变（setAccessToken）与注册表被写（rename / unpair）立即清空。所以
 * ready / hosts_changed 这类常规刷新拿不到旧数据，只有启动那一瞬能省。
 */
export type HostRegistrySnapshot = {
  hosts: HostInfo[]
  defaultHostId?: string
  authRequired?: boolean
}

/** 交接窗口：超过这个年龄的快照不再算「刚问过」。 */
const REGISTRY_HANDOFF_MS = 1500
const registryHandoff = new Map<string, { at: number; snap: HostRegistrySnapshot }>()

export function rememberHostRegistry(url: string, snap: HostRegistrySnapshot): void {
  if (registryHandoff.size > 4) registryHandoff.clear()
  registryHandoff.set(url, { at: Date.now(), snap })
}

/** 某端点「刚问过」的注册表应答（超窗或没有则 null）。同一窗口内可重复取用。 */
export function freshHostRegistry(url: string): HostRegistrySnapshot | null {
  const hit = registryHandoff.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > REGISTRY_HANDOFF_MS) {
    registryHandoff.delete(url)
    return null
  }
  return hit.snap
}

export function clearHostRegistryHandoff(): void {
  registryHandoff.clear()
}

/** host/hub 管理：host 注册表、配对码、agent 重启、置顶/待办偏好文档。 */
export const hostsRpc = {
  async listHosts(this: TransportCore): Promise<{ hosts: HostInfo[]; defaultHostId?: string }> {
    // hubLevel：host 列表是 hub 级数据（不带 ?host=），与选中 host
    // 无关——host 切换的 abort 风暴（setHost → abortInflight）不能打断
    // 它，否则 hosts_changed 广播触发的 refreshHosts 会静默失败、列表
    // 不更新；StrictMode 双挂载的 disconnect 同样不能 abort 它。
    const url = `${this.apiBase()}/api/hosts`
    const handed = freshHostRegistry(url)
    if (handed) return { hosts: handed.hosts, defaultHostId: handed.defaultHostId }
    const res = await this.fetch(url, {}, { hubLevel: true })
    const data = (await res.json().catch(() => ({}))) as {
      hosts?: HostInfo[]
      defaultHostId?: string
      authRequired?: boolean
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error
          ? data.error
          : '需要有效的访问 token',
      )
    }
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `hosts failed (${res.status})`,
      )
    }
    const snap: HostRegistrySnapshot = {
      hosts: data.hosts ?? [],
      defaultHostId: data.defaultHostId,
      authRequired: data.authRequired,
    }
    rememberHostRegistry(url, snap)
    return { hosts: snap.hosts, defaultHostId: snap.defaultHostId }
  },

  async pairingCode(this: TransportCore): Promise<{ code: string; expiresAt?: string; ttl?: number }> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持查看配对码')
    const res = await this.fetch(`${this.apiBase()}/api/pairing`)
    const data = (await res.json().catch(() => ({}))) as {
      code?: string
      expiresAt?: string
      ttl?: number
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || !data.code) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `pairing failed (${res.status})`,
      )
    }
    return { code: data.code, expiresAt: data.expiresAt, ttl: data.ttl }
  },

  async rotatePairingCode(this: TransportCore): Promise<{ code: string; expiresAt?: string }> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持轮换配对码')
    const res = await this.fetch(`${this.apiBase()}/api/pairing/rotate`, { method: 'POST' })
    const data = (await res.json().catch(() => ({}))) as {
      code?: string
      expiresAt?: string
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || !data.code) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `rotate failed (${res.status})`,
      )
    }
    return { code: data.code, expiresAt: data.expiresAt }
  },

  async renameHost(this: TransportCore, hostId: string, hostName: string): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持修改 Host')
    const res = await this.fetch(`${this.apiBase()}/api/hosts/${encodeURIComponent(hostId)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostName }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `rename failed (${res.status})`,
      )
    }
    // 注册表刚被写：交接快照作废，随后的 refreshHosts 必须问真实数据。
    clearHostRegistryHandoff()
  },

  async unpairHost(this: TransportCore, hostId: string): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持删除 Host')
    const res = await this.fetch(`${this.apiBase()}/api/hosts/${encodeURIComponent(hostId)}`, {
      method: 'DELETE',
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `unpair failed (${res.status})`,
      )
    }
    // 注册表刚被写：同 renameHost，作废交接快照。
    clearHostRegistryHandoff()
  },

  /**
   * POST /api/agent-restart — 用户显式重启当前选中 host 的 agent
   * 进程：杀旧进程、清 host 状态、重新 boot、恢复上次会话。host 从不
   * 自动重启 agent（假设 agent 可靠，传输/扫描失败只报错）——这是
   * 唯一的重启通道。mode-aware：local 模式同源本机；hub 模式经
   * ?host= 中继到选中 host。
   * 杀进程 + boot（host 侧 2min 上限）+ 恢复会话可能超过默认 30s
   * fetch 超时，这里给足 120s。在飞回合会被中断且不重试。
   */
  async restartAgent(this: TransportCore): Promise<void> {
    const res = await this.fetch(
      this.url('/api/agent-restart'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      { timeoutMs: 120_000 },
    )
    const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `agent restart failed (${res.status})`,
      )
    }
  },

  /**
   * GET /api/prefs — 拉取置顶/待办文档 + 当前版本（版本是 PUT 条件
   * 写入的 base；旧 hub 不带 version 字段 → undefined，调用方退回
   * 无条件写）。
   */
  async getPrefs(this: TransportCore): Promise<{ prefs: HubPrefsDoc; version?: number }> {
    const origin = this.prefsOrigin()
    if (!origin) throw new Error('仅 Hub 模式支持置顶/待办持久化')
    // hubLevel：hub 级请求，不参与 host 切换的 abortInflight 风暴——
    // 否则启动时与 refreshHosts（自动选中 host → setHost → abort）并发
    // 的 prefs 拉取每次都被中止，置顶/待办永远同步不过来。
    const res = await this.fetch(`${origin}/api/prefs`, {}, { hubLevel: true })
    const data = (await res.json().catch(() => ({}))) as {
      prefs?: HubPrefsDoc
      version?: number
      error?: string
      ok?: boolean
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error ? data.error : `prefs read failed (${res.status})`,
      )
    }
    return {
      prefs: data.prefs ?? {},
      version: typeof data.version === 'number' ? data.version : undefined,
    }
  },

  /**
   * PUT /api/prefs {prefs, baseVersion?} — 全量替换置顶/待办文档。
   * baseVersion（新 hub）使写入成为条件写：版本过旧时 hub 回 409 +
   * 当前文档（抛 PrefsConflictError，调用方重放待推操作后重试）；
   * 不带 baseVersion 为无条件写（旧 hub / 旧 FE 兼容）。成功响应带
   * 新版本。
   */
  async putPrefs(
    this: TransportCore,
    prefs: HubPrefsDoc,
    baseVersion?: number,
  ): Promise<{ version?: number }> {
    const origin = this.prefsOrigin()
    if (!origin) throw new Error('仅 Hub 模式支持置顶/待办持久化')
    const body: Record<string, unknown> = { prefs }
    if (baseVersion != null) body.baseVersion = baseVersion
    const res = await this.fetch(
      `${origin}/api/prefs`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      // hubLevel：同上，回写不被 host 切换的 abort 风暴打断。
      { hubLevel: true },
    )
    const data = (await res.json().catch(() => ({}))) as {
      error?: string
      ok?: boolean
      version?: number
      prefs?: HubPrefsDoc
    }
    if (res.status === 401) {
      throw new AccessTokenError(
        typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
      )
    }
    if (res.status === 409) {
      throw new PrefsConflictError(
        typeof data.error === 'string' && data.error ? data.error : '置顶/待办版本冲突',
        typeof data.version === 'number' ? data.version : undefined,
        data.prefs,
      )
    }
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === 'string' && data.error ? data.error : `prefs write failed (${res.status})`,
      )
    }
    return { version: typeof data.version === 'number' ? data.version : undefined }
  },
}
