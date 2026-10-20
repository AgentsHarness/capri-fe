import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalTransport } from './localTransport'
import { clearHostRegistryHandoff } from './rpc/hosts'
import { loadGuestToken, loadHubToken, saveGuestToken, saveHubToken } from './credentials'

/**
 * 管理员与访客两把令牌各占一格：
 * - 启动时管理员优先；
 * - 顶栏切访客：存过访客令牌就直接验，没存过/验不过就弹门禁；
 * - 切回管理员不需要重新输入——那把从来没被顶掉。
 *
 * 这里只覆盖令牌槽与请求头，不断言访客视图渲染（App.guest.test.tsx 负责）。
 */

const HUB = 'https://hub.example'
const ADMIN_KEY = 'admin-key'
const GUEST_KEY = 'g_guest_key'

const identity = {
  role: 'guest' as const,
  guest: { id: 'g_1', label: '给小王', expiresAt: 0 },
  sessions: [{ hostId: 'h1', hostName: 'H1', sessionId: 's1', cwd: '/w1', title: 'one' }],
}

/**
 * 编排 hub 的 access-role：按请求头里的 Bearer 判身份。
 * `roleFor` 返回 'guest' | 'admin' | 401。
 */
function stubHub(roleFor: (token: string) => 'guest' | 'admin' | 401) {
  const asked: Array<{ url: string; auth: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      asked.push({ url, auth })
      if (url.endsWith('/api/access-role')) {
        const verdict = roleFor(auth.replace(/^Bearer /, ''))
        if (verdict === 401) {
          return new Response(JSON.stringify({ ok: false, error: '需要有效的访问 token' }), {
            status: 401,
          })
        }
        return new Response(
          JSON.stringify(
            verdict === 'guest'
              ? { ok: true, role: 'guest', guest: identity.guest, sessions: identity.sessions }
              : { ok: true, role: 'admin' },
          ),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }),
  )
  return asked
}

/** hub 模式、管理员已登录的 transport（可选：构造前先放一把访客令牌）。 */
function adminTransport(guestToken?: string): LocalTransport {
  if (guestToken) saveGuestToken(guestToken)
  saveHubToken(ADMIN_KEY)
  const t = new LocalTransport('', ADMIN_KEY)
  t.setConnectionMode('hub', HUB)
  return t
}

/** 发一条普通 API 请求，取它实际带出去的 Authorization。 */
async function bearerOf(t: LocalTransport, path = '/api/sessions'): Promise<string> {
  vi.mocked(fetch).mockClear()
  await t.apiFetch(path)
  const call = vi.mocked(fetch).mock.calls.at(-1)
  return new Headers(call?.[1]?.headers).get('Authorization') ?? ''
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  clearHostRegistryHandoff()
  vi.restoreAllMocks()
})

describe('启动时管理员优先', () => {
  it('两把都存着 → 用管理员那把（访问先用管理员界面）', async () => {
    stubHub(() => 'admin')
    const t = adminTransport()
    saveGuestToken(GUEST_KEY)
    expect(t.chooseStartupCredential()).toBe('admin')
    expect(await bearerOf(t)).toBe(`Bearer ${ADMIN_KEY}`)
  })

  it('只存过访客令牌 → 用访客槽，否则这台浏览器会被管理员门禁挡住', () => {
    localStorage.clear()
    stubHub(() => 'guest')
    const t = new LocalTransport('')
    t.setConnectionMode('hub', HUB)
    saveGuestToken(GUEST_KEY)
    expect(t.chooseStartupCredential()).toBe('guest')
    expect(t.getAccessToken()).toBe(GUEST_KEY)
  })

  it('两把都没有 → 管理员（回门禁）', () => {
    localStorage.clear()
    const t = new LocalTransport('')
    t.setConnectionMode('hub', HUB)
    expect(t.chooseStartupCredential()).toBe('admin')
    expect(t.getAccessToken()).toBe('')
  })
})

describe('从 host 列表切到访客模式', () => {
  it('没存过访客令牌 → need_token，且管理员那把照常可用', async () => {
    stubHub((tok) => (tok === ADMIN_KEY ? 'admin' : 401))
    const t = adminTransport()
    expect(await t.enterGuestMode()).toBe('need_token')
    expect(t.getCredentialSource()).toBe('admin')
    expect(await bearerOf(t)).toBe(`Bearer ${ADMIN_KEY}`)
  })

  it('存过访客令牌 → 直接验通过，之后的请求带访客那把', async () => {
    stubHub((tok) => (tok === GUEST_KEY ? 'guest' : 'admin'))
    const t = adminTransport()
    saveGuestToken(GUEST_KEY)
    expect(await t.enterGuestMode()).toBe('ok')
    expect(t.getCredentialSource()).toBe('guest')
    expect(t.getGuestIdentity()?.guest.label).toBe('给小王')
    expect(await bearerOf(t)).toBe(`Bearer ${GUEST_KEY}`)
    // 管理员那把仍在自己的槽里
    expect(loadHubToken()).toBe(ADMIN_KEY)
  })

  it('存的那把已被吊销（401）→ invalid，清访客槽并退回管理员', async () => {
    stubHub((tok) => (tok === ADMIN_KEY ? 'admin' : 401))
    const t = adminTransport()
    saveGuestToken('g_revoked')
    expect(await t.enterGuestMode()).toBe('invalid')
    expect(loadGuestToken()).toBe('')
    expect(t.getCredentialSource()).toBe('admin')
    expect(t.isGuest()).toBe(false)
    expect(await bearerOf(t)).toBe(`Bearer ${ADMIN_KEY}`)
  })

  it('输入的访客令牌验通过才落库', async () => {
    stubHub((tok) => (tok === GUEST_KEY ? 'guest' : 'admin'))
    const t = adminTransport()

    expect(await t.tryGuestToken('wrong')).toBeNull()
    expect(loadGuestToken()).toBe('') // 错的不留
    expect(t.getCredentialSource()).toBe('admin')

    const ok = await t.tryGuestToken(GUEST_KEY)
    expect(ok?.role).toBe('guest')
    expect(loadGuestToken()).toBe(GUEST_KEY)
    expect(loadHubToken()).toBe(ADMIN_KEY) // 管理员那把没被顶掉
    expect(await bearerOf(t)).toBe(`Bearer ${GUEST_KEY}`)
  })

  it('输入的其实是管理员密钥（hub 回 admin）→ 不落库、不改身份', async () => {
    stubHub(() => 'admin')
    const t = adminTransport()
    expect(await t.tryGuestToken('some-admin-key')).toBeNull()
    expect(loadGuestToken()).toBe('')
    expect(t.getCredentialSource()).toBe('admin')
    expect(await bearerOf(t)).toBe(`Bearer ${ADMIN_KEY}`)
  })
})

describe('退出访客', () => {
  it('切回管理员那把，访客槽保留（下次不用重新输入）', async () => {
    stubHub((tok) => (tok === GUEST_KEY ? 'guest' : 'admin'))
    const t = adminTransport()
    saveGuestToken(GUEST_KEY)
    expect(await t.enterGuestMode()).toBe('ok')
    expect(t.getCredentialSource()).toBe('guest')

    t.exitGuestMode()
    expect(t.isGuest()).toBe(false)
    expect(t.getCredentialSource()).toBe('admin')
    expect(await bearerOf(t)).toBe(`Bearer ${ADMIN_KEY}`)
    expect(loadGuestToken()).toBe(GUEST_KEY)
  })

  it('管理员槽为空时退出访客：门禁那把为空，由 UI 回登录界面', async () => {
    localStorage.clear()
    stubHub(() => 'guest')
    const t = new LocalTransport('')
    t.setConnectionMode('hub', HUB)
    saveGuestToken(GUEST_KEY)
    expect(t.chooseStartupCredential()).toBe('guest')
    t.setGuestMode(identity)
    t.exitGuestMode()
    expect(t.getAccessToken()).toBe('')
    expect(t.hasAdminToken()).toBe(false)
  })
})

describe('访客令牌在运行中被拒', () => {
  it('清访客槽、通知上层，管理员槽与登录不受影响', async () => {
    stubHub((tok) => (tok === GUEST_KEY ? 'guest' : 'admin'))
    const t = adminTransport(GUEST_KEY)
    await t.enterGuestMode()
    const invalid = vi.fn()
    t.onHubAuthInvalid(invalid)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 401 })),
    )
    const res = await t.apiFetch('/api/sessions')
    expect(res.status).toBe(401)

    expect(invalid).toHaveBeenCalled()
    expect(loadGuestToken()).toBe('')
    expect(loadHubToken()).toBe(ADMIN_KEY)
  })
})

describe('过期分享链接的兜底', () => {
  it('dropGuestCredential 只清访客槽，管理员那把仍可用', async () => {
    stubHub((tok) => (tok === ADMIN_KEY ? 'admin' : 401))
    const t = adminTransport('g_expired')
    expect(await t.enterGuestMode()).toBe('invalid')
    // enterGuestMode 已经清过槽；再显式调一次应当是幂等的
    t.dropGuestCredential()
    expect(loadGuestToken()).toBe('')
    expect(t.getCredentialSource()).toBe('admin')
    expect(await bearerOf(t)).toBe(`Bearer ${ADMIN_KEY}`)
  })

  it('管理员槽也为空时，清完访客槽就没有门禁令牌了', () => {
    localStorage.clear()
    const t = new LocalTransport('')
    t.setConnectionMode('hub', HUB)
    saveGuestToken('g_expired')
    t.chooseStartupCredential()
    expect(t.getAccessToken()).toBe('g_expired')
    t.dropGuestCredential()
    expect(t.getAccessToken()).toBe('')
    expect(t.hasAdminToken()).toBe(false)
  })
})
