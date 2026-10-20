import type { TransportCore } from '../transport'
import { AccessTokenError } from '../transport'
import type {
  AccessRole,
  GuestSessionItem,
  GuestTokenRecord,
  SubscriberRow,
} from '../types'

/**
 * 访客令牌（hub 管理面）。
 *
 * 管理端点在 hub 上是 admin-only：访客拿着自己的令牌调用会得到 403
 * （不是 401）——401 表示「该登录了」，403 表示「这个身份不许做这件事」。
 * 全部请求走 `hubLevel: true`：它们是 hub 级数据，不受切 host 的 abort
 * 风暴影响。
 */

type ErrorBody = { error?: string; ok?: boolean }

function apiBase(core: TransportCore): string {
  const origin = core.prefsOrigin()
  if (!origin) throw new Error('仅 Hub 模式支持分享')
  return origin
}

/** 403 归一成一句「非管理员」，避免把 hub 的原始文案漏到 FE。 */
function assertAdmin(res: Response, data: ErrorBody, fallback: string): void {
  if (res.status === 401) {
    throw new AccessTokenError(
      typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
    )
  }
  if (res.status === 403) {
    throw new Error(data.error || '仅管理员可管理访客令牌')
  }
  if (!res.ok || data.ok === false) {
    throw new Error(
      typeof data.error === 'string' && data.error ? data.error : `${fallback} (${res.status})`,
    )
  }
}

async function postJson(
  core: TransportCore,
  path: string,
  body: unknown,
): Promise<{ res: Response; data: ErrorBody & Record<string, unknown> }> {
  const res = await core.fetch(
    `${apiBase(core)}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    { hubLevel: true },
  )
  const data = (await res.json().catch(() => ({}))) as ErrorBody & Record<string, unknown>
  return { res, data }
}

/**
 * hub 的 JSON 可能把空白名单写成 `sessions: null`（老版本 hub / 手改
 * guests.json）；FE 内部一律按数组处理，否则渲染层读 `.length` 会崩。
 */
function normalizeToken(raw: GuestTokenRecord): GuestTokenRecord {
  return Array.isArray(raw.sessions) ? raw : { ...raw, sessions: [] }
}

function asToken(data: Record<string, unknown>): GuestTokenRecord {
  const t = data.token
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    throw new Error('访客令牌响应缺少 token')
  }
  return normalizeToken(t as GuestTokenRecord)
}

/** TUI/设置面板共用的「有效期」选项（秒）。0 = 永久。 */
export type GuestExpiryOption = {
  id: string
  label: string
  seconds: number
}

export const GUEST_EXPIRY_OPTIONS: GuestExpiryOption[] = [
  { id: '1h', label: '1 小时', seconds: 60 * 60 },
  { id: '1d', label: '1 天', seconds: 24 * 60 * 60 },
  { id: '7d', label: '7 天', seconds: 7 * 24 * 60 * 60 },
  { id: '30d', label: '30 天', seconds: 30 * 24 * 60 * 60 },
  { id: 'forever', label: '永久', seconds: 0 },
]

/** 相对当前时刻的到期时间（epoch 秒）；0 表示永久。 */
export function guestExpiryFromNow(seconds: number): number {
  return seconds > 0 ? Math.floor(Date.now() / 1000) + seconds : 0
}

/** 到期时间的展示文案（永久 / YYYY-MM-DD HH:mm）。 */
export function formatGuestExpiry(expiresAt: number): string {
  if (!expiresAt) return '永久'
  const d = new Date(expiresAt * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 分享链接：`#g=<token>`。fragment 不发给服务器，不落反代日志。 */
export function guestShareLink(token: string): string {
  const base =
    typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : ''
  return `${base}#g=${token}`
}

/** 访问地址：当前页面去掉 query 与 hash。 */
export function guestAccessUrl(): string {
  return typeof location !== 'undefined'
    ? `${location.origin}${location.pathname}`
    : ''
}

export const guestTokensRpc = {
  /** GET /api/guest-tokens —— 全量列表（含 token 明文）。 */
  async listGuestTokens(this: TransportCore): Promise<GuestTokenRecord[]> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const res = await this.fetch(`${apiBase(this)}/api/guest-tokens`, {}, { hubLevel: true })
    const data = (await res.json().catch(() => ({}))) as ErrorBody & {
      tokens?: GuestTokenRecord[]
    }
    assertAdmin(res, data, 'guest tokens failed')
    return Array.isArray(data.tokens) ? data.tokens.map(normalizeToken) : []
  },

  async createGuestToken(
    this: TransportCore,
    input: { label: string; expiresAt?: number; sessions?: GuestSessionItem[] },
  ): Promise<GuestTokenRecord> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const { res, data } = await postJson(this, '/api/guest-tokens/create', {
      label: input.label,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.sessions && input.sessions.length > 0 ? { sessions: input.sessions } : {}),
    })
    assertAdmin(res, data, 'create guest token failed')
    return asToken(data)
  },

  async updateGuestToken(
    this: TransportCore,
    patch: { id: string; label?: string; expiresAt?: number; revoked?: boolean },
  ): Promise<GuestTokenRecord> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const { res, data } = await postJson(this, '/api/guest-tokens/update', patch)
    assertAdmin(res, data, 'update guest token failed')
    return asToken(data)
  },

  async deleteGuestToken(this: TransportCore, id: string): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const { res, data } = await postJson(this, '/api/guest-tokens/delete', { id })
    assertAdmin(res, data, 'delete guest token failed')
  },

  async addGuestSessions(
    this: TransportCore,
    id: string,
    items: GuestSessionItem[],
  ): Promise<GuestTokenRecord> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const { res, data } = await postJson(this, '/api/guest-tokens/sessions/add', { id, items })
    assertAdmin(res, data, 'add guest sessions failed')
    return asToken(data)
  },

  async removeGuestSessions(
    this: TransportCore,
    id: string,
    items: Array<{ hostId: string; sessionId: string }>,
  ): Promise<GuestTokenRecord> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const { res, data } = await postJson(this, '/api/guest-tokens/sessions/remove', { id, items })
    assertAdmin(res, data, 'remove guest sessions failed')
    return asToken(data)
  },

  /** POST /api/guest-tokens/refresh —— 回填标题/hostName，标记 stale。 */
  async refreshGuestToken(this: TransportCore, id: string): Promise<GuestTokenRecord> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持分享')
    const { res, data } = await postJson(this, '/api/guest-tokens/refresh', { id })
    assertAdmin(res, data, 'refresh guest token failed')
    return asToken(data)
  },

  /**
   * GET /api/access-role —— 当前凭据的角色。404 表示 hub 太旧（没有访客
   * 功能）：按 admin 处理，分享入口随后会因 404 而不可用。
   */
  async accessRole(this: TransportCore): Promise<AccessRole> {
    const res = await this.fetch(`${apiBase(this)}/api/access-role`, {}, { hubLevel: true })
    if (res.status === 404) return { role: 'admin' }
    if (res.status === 401) throw new AccessTokenError()
    if (!res.ok) throw new Error(`access role failed (${res.status})`)
    const data = (await res.json().catch(() => ({}))) as {
      role?: string
      guest?: { id?: string; label?: string; expiresAt?: number }
      sessions?: GuestSessionItem[]
    }
    if (data.role !== 'guest') return { role: 'admin' }
    return {
      role: 'guest',
      guest: {
        id: data.guest?.id ?? '',
        label: data.guest?.label ?? '',
        expiresAt: data.guest?.expiresAt ?? 0,
      },
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
    }
  },

  /**
   * GET /api/subscribers —— 在线浏览器订阅者名单（admin-only）。
   *
   * 顶栏那个数字是这个名单的条数；面板点开就是逐行详情（地址、浏览器、
   * 身份、当前在看哪个会话）。老 hub 没有这个端点 → 404 归一成一句
   * 「Hub 不支持订阅者详情」，面板据此只显示数字。
   */
  async listSubscribers(this: TransportCore): Promise<SubscriberRow[]> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持查看订阅者')
    const res = await this.fetch(`${apiBase(this)}/api/subscribers`, {}, { hubLevel: true })
    if (res.status === 404) throw new Error('Hub 不支持订阅者详情（请升级 hub）')
    if (res.status === 401) throw new AccessTokenError()
    if (res.status === 403) throw new Error('仅管理员可查看订阅者')
    const data = (await res.json().catch(() => ({}))) as ErrorBody & {
      subscribers?: SubscriberRow[]
    }
    if (!res.ok) throw new Error(data.error || `subscribers failed (${res.status})`)
    return Array.isArray(data.subscribers) ? data.subscribers : []
  },

  /** GET /api/guest/sessions —— 切换/刷新会话下拉用。 */
  async guestSessions(this: TransportCore): Promise<GuestSessionItem[]> {
    const res = await this.fetch(`${apiBase(this)}/api/guest/sessions`, {}, { hubLevel: true })
    if (!res.ok) throw new Error(`guest sessions failed (${res.status})`)
    const data = (await res.json().catch(() => ({}))) as { sessions?: GuestSessionItem[] }
    return Array.isArray(data.sessions) ? data.sessions : []
  },

  /**
   * 列某台 host 的会话（「分享」面板里挑会话用）。复用既有的
   * `urlForHost` + `forceRelay`：始终经 hub 中继，绝不因为目标恰好是本机
   * 就改走近路。非 hub 模式 / 没有第二台时 urlForHost 返回 null。
   */
  async listHostSessions(
    this: TransportCore,
    hostId: string,
  ): Promise<Array<{ sessionId: string; cwd?: string; title?: string }>> {
    const url = this.urlForHost(hostId, '/api/sessions')
    if (!url) throw new Error('仅 Hub 模式支持跨 Host 读取会话')
    const res = await this.fetch(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { forceRelay: true },
    )
    const data = (await res.json().catch(() => ({}))) as {
      sessions?: Array<{ sessionId?: string; cwd?: string; title?: string }>
      error?: string
    }
    if (!res.ok) throw new Error(data.error || `sessions failed (${res.status})`)
    const rows = Array.isArray(data.sessions) ? data.sessions : []
    return rows
      .filter((s): s is { sessionId: string; cwd?: string; title?: string } => !!s?.sessionId)
      .map((s) => ({
        sessionId: s.sessionId,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.title ? { title: s.title } : {}),
      }))
  },
}
