import type { TransportCore } from '../transport'
import { AccessTokenError } from '../transport'
import type { UserRecord, UserTokenIssue } from '../types'

/**
 * 用户账号（hub 管理面）。
 *
 * 管理员：创建用户、重置 token、删除用户。列表永远不含 token。
 * 普通用户：修改自己的 token。
 */
type ErrorBody = { error?: string; ok?: boolean }

function apiBase(core: TransportCore): string {
  const origin = core.prefsOrigin()
  if (!origin) throw new Error('仅 Hub 模式支持用户管理')
  return origin
}

function asUser(raw: unknown): UserRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('用户响应缺少 user')
  }
  const u = raw as UserRecord
  return {
    id: String(u.id ?? ''),
    label: String(u.label ?? ''),
    createdAt: Number(u.createdAt ?? 0),
    lastUsedAt: Number(u.lastUsedAt ?? 0) || undefined,
    hostCount: Number(u.hostCount ?? 0),
    hosts: Array.isArray(u.hosts) ? u.hosts : [],
  }
}

function asIssue(data: Record<string, unknown>): UserTokenIssue {
  const token = typeof data.token === 'string' ? data.token : ''
  if (!token) throw new Error('用户响应缺少 token')
  return { user: asUser(data.user), token }
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

function assertOk(res: Response, data: ErrorBody, fallback: string): void {
  if (res.status === 401) {
    throw new AccessTokenError(
      typeof data.error === 'string' && data.error ? data.error : '需要有效的访问 token',
    )
  }
  if (!res.ok || data.ok === false) {
    throw new Error(
      typeof data.error === 'string' && data.error ? data.error : `${fallback} (${res.status})`,
    )
  }
}

export const usersRpc = {
  /** GET /api/users —— 管理员查看用户列表（不含 token）。 */
  async listUsers(this: TransportCore): Promise<UserRecord[]> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持用户管理')
    const res = await this.fetch(`${apiBase(this)}/api/users`, {}, { hubLevel: true })
    const data = (await res.json().catch(() => ({}))) as ErrorBody & { users?: unknown[] }
    assertOk(res, data, 'users failed')
    return Array.isArray(data.users) ? data.users.map(asUser) : []
  },

  /** POST /api/users/create —— 管理员创建用户，返回一次性明文 token。 */
  async createUser(this: TransportCore, label: string): Promise<UserTokenIssue> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持用户管理')
    const { res, data } = await postJson(this, '/api/users/create', { label })
    assertOk(res, data, 'create user failed')
    return asIssue(data)
  },

  /** POST /api/users/reset —— 管理员重置用户 token，返回一次性明文 token。 */
  async resetUserToken(this: TransportCore, id: string): Promise<UserTokenIssue> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持用户管理')
    const { res, data } = await postJson(this, '/api/users/reset', { id })
    assertOk(res, data, 'reset user token failed')
    return asIssue(data)
  },

  /** POST /api/users/delete —— 删除用户并解除其名下 host。 */
  async deleteUser(this: TransportCore, id: string): Promise<void> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持用户管理')
    const { res, data } = await postJson(this, '/api/users/delete', { id })
    assertOk(res, data, 'delete user failed')
  },

  /**
   * POST /api/me/token —— 普通用户修改自己的 token。
   * 传空串让 hub 生成随机 token；新 token 只在此响应中出现一次。
   */
  async changeMyToken(this: TransportCore, token: string): Promise<UserTokenIssue> {
    if (this.mode !== 'hub') throw new Error('仅 Hub 模式支持修改 token')
    const { res, data } = await postJson(this, '/api/me/token', { token })
    assertOk(res, data, 'change token failed')
    return asIssue(data)
  },
}
