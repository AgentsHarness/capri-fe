import { describe, expect, it } from 'vitest'
import {
  GUEST_EXPIRY_OPTIONS,
  formatGuestExpiry,
  guestAccessUrl,
  guestExpiryFromNow,
  guestShareLink,
} from './guestTokens'

/**
 * 分享链接的格式是协议的一部分（管理员复制给访客的就是这一串）：
 * `#g=<token>` 让令牌留在 fragment 里——浏览器不会把 fragment 发给服务器，
 * 因而不会落进反代 access log。
 */
describe('guestShareLink', () => {
  it('链接把令牌放在 fragment，访问地址不带 query/hash', () => {
    const link = guestShareLink('g_abc123')
    expect(link).toBe(`${location.origin}${location.pathname}#g=g_abc123`)
    expect(link.endsWith(`#g=g_abc123`)).toBe(true)
    expect(guestAccessUrl()).toBe(`${location.origin}${location.pathname}`)
    expect(guestAccessUrl()).not.toContain('#')
  })
})

describe('有效期', () => {
  it('0 = 永久；正数 = 当前时刻 + 秒数', () => {
    expect(guestExpiryFromNow(0)).toBe(0)
    const now = Math.floor(Date.now() / 1000)
    const at = guestExpiryFromNow(3600)
    expect(at).toBeGreaterThanOrEqual(now + 3599)
    expect(at).toBeLessThanOrEqual(now + 3601)
  })

  it('展示文案：永久 / YYYY-MM-DD HH:mm', () => {
    expect(formatGuestExpiry(0)).toBe('永久')
    const at = Math.floor(new Date(2026, 9, 21, 14, 32).getTime() / 1000)
    expect(formatGuestExpiry(at)).toBe('2026-10-21 14:32')
  })

  it('下拉选项覆盖永久，且秒数严格递增', () => {
    expect(GUEST_EXPIRY_OPTIONS.some((o) => o.seconds === 0)).toBe(true)
    const secs = GUEST_EXPIRY_OPTIONS.map((o) => o.seconds).filter((s) => s > 0)
    for (let i = 1; i < secs.length; i++) expect(secs[i]).toBeGreaterThan(secs[i - 1])
  })
})

import { beforeEach, vi } from 'vitest'
import { guestTokensRpc } from './guestTokens'
import { AccessTokenError } from '../transport'
import type { TransportCore } from '../transport'

/**
 * RPC 契约：请求方法/路径/请求体 + 403 与 401 的区分。管理端点由 hub 判定
 * 身份，FE 只负责把「不是管理员」和「该登录了」转成不同错误。
 */
function core(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return {
    mode: 'hub',
    prefsOrigin: () => 'https://hub.example',
    apiBase: () => 'https://hub.example',
    url: (p: string) => `https://hub.example${p}`,
    urlForHost: (hostId: string, p: string) =>
      `https://hub.example${p}?host=${encodeURIComponent(hostId)}`,
    fetch: fetchImpl,
  } as unknown as TransportCore
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const call = <T>(fn: (this: TransportCore) => Promise<T>, c: TransportCore) =>
  (fn as unknown as (this: TransportCore) => Promise<T>).call(c)

describe('guestTokensRpc 契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('create 把 sessions 原样送进请求体，并回填返回的 token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const c = core(async (url, init) => {
      calls.push({ url, init })
      return json({
        ok: true,
        token: {
          id: 'g_1',
          token: 'g_tok',
          label: '给小王',
          createdAt: 1,
          expiresAt: 0,
          revoked: false,
          sessions: [{ hostId: 'h1', sessionId: 's1' }],
        },
      })
    })
    const created = await call(function (this: TransportCore) {
      return guestTokensRpc.createGuestToken.call(this, {
        label: '给小王',
        expiresAt: 0,
        sessions: [{ hostId: 'h1', sessionId: 's1', cwd: '/w', hostName: 'H1' }],
      })
    }, c)
    expect(created.token).toBe('g_tok')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://hub.example/api/guest-tokens/create')
    expect(calls[0].init?.method).toBe('POST')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.sessions).toEqual([{ hostId: 'h1', sessionId: 's1', cwd: '/w', hostName: 'H1' }])
    // expiresAt 0 = 永久，按 hub 的缺省语义省略。
    expect(body.expiresAt).toBeUndefined()
  })

  it('403 透出 hub 的原因，且不是登录错误（不该把人踢回门禁）', async () => {
    const c = core(async () => json({ ok: false, error: '访客模式不支持该操作' }, 403))
    const err = await call(function (this: TransportCore) {
      return guestTokensRpc.listGuestTokens.call(this)
    }, c).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('访客模式不支持该操作')
    expect(err).not.toBeInstanceOf(AccessTokenError)
  })

  it('401 抛 AccessTokenError（令牌失效 → 回门禁）', async () => {
    const c = core(async () => json({ ok: false, error: '需要有效的访问 token' }, 401))
    const err = await call(function (this: TransportCore) {
      return guestTokensRpc.listGuestTokens.call(this)
    }, c).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccessTokenError)
  })

  it('accessRole：admin / guest / 404（旧 hub 回落 admin）', async () => {
    const admin = core(async () => json({ ok: true, role: 'admin' }))
    expect(
      await call(function (this: TransportCore) {
        return guestTokensRpc.accessRole.call(this)
      }, admin),
    ).toEqual({ role: 'admin' })

    const guest = core(async () =>
      json({
        ok: true,
        role: 'guest',
        guest: { id: 'g_1', label: '给小王', expiresAt: 123 },
        sessions: [{ hostId: 'h1', sessionId: 's1', cwd: '/w', title: 't' }],
      }),
    )
    const role = await call(function (this: TransportCore) {
      return guestTokensRpc.accessRole.call(this)
    }, guest)
    expect(role).toEqual({
      role: 'guest',
      guest: { id: 'g_1', label: '给小王', expiresAt: 123 },
      sessions: [{ hostId: 'h1', sessionId: 's1', cwd: '/w', title: 't' }],
    })

    const old = core(async () => json({ ok: false, error: 'not found' }, 404))
    expect(
      await call(function (this: TransportCore) {
        return guestTokensRpc.accessRole.call(this)
      }, old),
    ).toEqual({ role: 'admin' })
  })

  it('hub 返回 sessions: null 时归一成空数组（列表渲染不崩）', async () => {
    const c = core(async () =>
      json({
        ok: true,
        tokens: [
          {
            id: 'g_1',
            token: 'g_tok',
            label: '给小王',
            createdAt: 1,
            expiresAt: 0,
            revoked: false,
            sessions: null,
          },
        ],
      }),
    )
    const rows = await call(function (this: TransportCore) {
      return guestTokensRpc.listGuestTokens.call(this)
    }, c)
    expect(rows[0].sessions).toEqual([])
  })

  it('create 返回的 sessions: null 同样归一成空数组', async () => {
    const c = core(async () =>
      json({
        ok: true,
        token: {
          id: 'g_1',
          token: 'g_tok',
          label: '给小王',
          createdAt: 1,
          expiresAt: 0,
          revoked: false,
          sessions: null,
        },
      }),
    )
    const created = await call(function (this: TransportCore) {
      return guestTokensRpc.createGuestToken.call(this, { label: '给小王' })
    }, c)
    expect(created.sessions).toEqual([])
  })

  it('非 hub 模式：管理端点直接拒绝（没有分享承载）', async () => {
    const c = { ...core(async () => json({})), mode: 'local', prefsOrigin: () => '' }
    await expect(
      call(function (this: TransportCore) {
        return guestTokensRpc.listGuestTokens.call(this)
      }, c as TransportCore),
    ).rejects.toThrow('仅 Hub 模式支持分享')
  })

  it('listHostSessions 用 urlForHost + forceRelay 读指定 host 的会话', async () => {
    const seen: Array<{ url: string; opts?: unknown }> = []
    const c = {
      ...core(async () => json({})),
      fetch: async (url: string, _init?: RequestInit, opts?: unknown) => {
        seen.push({ url, opts })
        return json({
          ok: true,
          sessions: [
            { sessionId: 's1', cwd: '/w', title: 'one' },
            { sessionId: '', cwd: '/ignored' },
            { sessionId: 's2' },
          ],
        })
      },
    } as unknown as TransportCore
    const rows = await call(function (this: TransportCore) {
      return guestTokensRpc.listHostSessions.call(this, 'h2')
    }, c)
    expect(seen[0].url).toBe('https://hub.example/api/sessions?host=h2')
    expect(seen[0].opts).toEqual({ forceRelay: true })
    // 无 sessionId 的行被丢弃；空字段不占键位
    expect(rows).toEqual([{ sessionId: 's1', cwd: '/w', title: 'one' }, { sessionId: 's2' }])
  })
})
