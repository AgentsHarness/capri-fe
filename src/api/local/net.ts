import type { TransportCtx } from './ctx'
import type { FetchOpts } from './types'
import { DEFAULT_FETCH_TIMEOUT_MS } from './types'

/**
 * HTTP：URL 拼装、鉴权头、超时、在途请求分桶与 401 归因。
 *
 * 三个 abort 桶各管一段生命周期：`inflight` 随切 host 作废（上一个 host
 * 的请求必须落地），`hubInflight` 只随登出/disconnect 作废（hub 级请求
 * 与选中 host 无关），`probeInflight` 谁都不许打断（问的是「该连哪」，
 * 被重挂载的 disconnect 打断会误判成网络故障）。
 */

export const netMixin = {

  url(this: TransportCtx, path: string): string {
    // 访客：恒走 hub 中继 + 选中 host。本机直连没有 hub 承担白名单，
    // 也拿不到这台 host 的近路钥匙。
    if (this.guest) {
      const params = new URLSearchParams()
      if (this.selectedHostId) params.set('host', this.selectedHostId)
      // hub 用它把 /api/status 的 sessionId/cwd 钉到访客正在看的会话
      // （host 的活动会话可能是别人的）。其余端点忽略这个参数。
      if (this.guestSessionId) params.set('session', this.guestSessionId)
      const qs = params.toString()
      return `${this.apiBase()}${path}${qs ? `?${qs}` : ''}`
    }
    // hub 模式：base 指向 hub，带 ?host= 由 hub 中转到目标 host；
    // 但选中本机 host 时直连本地（不绕 hub 中继，省一跳网络往返）。
    // local 模式：同源本机，绝不带 ?host=（避免 hostId=local 混淆）。
    const local = this.isLocalDirect()
    const base = local ? this.directBase() : this.apiBase()
    const qs =
      !local && this.mode === 'hub' && this.selectedHostId
        ? `?host=${encodeURIComponent(this.selectedHostId)}`
        : ''
    return `${base}${path}${qs}`
  },


  /**
   * Mode-aware URL for an API path (hub → 带 ?host= 指向选中 host；
   * 选中本机 → 直连本地；local → 同源本机)。独立 API 客户端
   * （如 shell.ts）必须用它拼 URL，不能裸 fetch 相对路径——
   * 否则 hub 模式下请求会打到页面所在机器而不是选中的 host。
   */
  apiUrl(this: TransportCtx, path: string): string {
    return this.url(path)
  },


  /**
   * 指向**指定** host 的 API URL（跨 host 读数据用，如「从其他 Host 导入
   * 模型配置」）。始终走 hub base + ?host=，不做本机近路判定——调用方问的
   * 是那台 host，不是当前选中的这台。非 hub 模式返回 null（没有第二台），
   * 调用方据此禁用入口而不是发一条打错的请求。
   */
  urlForHost(this: TransportCtx, hostId: string, path: string): string | null {
    const id = hostId.trim()
    if (this.mode !== 'hub' || !id) return null
    return `${this.apiBase()}${path}?host=${encodeURIComponent(id)}`
  },


  /**
   * Mode-aware fetch：apiUrl 拼 URL + Authorization bearer + 超时 +
   * 在途请求跟踪（setHost/disconnect 时统一 abort）。所有 API 调用
   * 都应走这里而不是裸 fetch。
   */
  apiFetch(
    this: TransportCtx,
    path: string,
    init: RequestInit = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    return this.fetch(this.url(path), init, opts)
  },


  /**
   * fetch wrapper that attaches Authorization: Bearer when a hub FE
   * token is configured. All API calls go through this so token handling
   * stays in one place.
   *
   * Every request gets a hard timeout (default DEFAULT_FETCH_TIMEOUT_MS;
   * `opts.timeoutMs` overrides, 0 disables) plus an optional caller
   * `opts.signal`. Both sources are forwarded onto an owned
   * AbortController tracked in `inflight`, so disconnect()/
   * setHost()/setAccessToken() can abort everything in flight — a
   * gapPull's finally then releases its per-host pulling slot instead of
   * wedging it forever. Sources are composed by forwarding rather than
   * AbortSignal.any (newer than this build's baseline browsers), which is
   * equivalent here since every source funnels into one controller.
   */
  async fetch(
    this: TransportCtx,
    input: string,
    init: RequestInit = {},
    opts: FetchOpts = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    // 钥匙选择集中在 tokenFor：打 hub 用 hub 槽，走近路用那台的 host 槽，
    // 本机开放就什么都不带（免得把 hub 密钥写进 URL / 代理日志）。
    // opts.forceToken / auth:true 是探测用途的强制指定（探路、模式判定）。
    const forced =
      opts.forceToken !== undefined
        ? opts.forceToken
        : opts.auth === true
          ? this.probeKey()
          : null
    // forceRelay（跨 host 读别的 host）：一定是打 hub 的请求——出示 hub 槽
    // 那把，也按 hub 拒绝归因（绝不因为目标那台而清掉本机的房间钥匙）。
    const token = opts.forceRelay
      ? (forced ?? (this.hubToken || null))
      : (forced ?? (opts.auth === false ? null : this.tokenFor(input)))
    // 401 归因用的目标，在**发请求之前**定格：见 handleRejection 的注释。
    const target = opts.forceRelay
      ? { local: false, hostId: null }
      : { local: this.isLocalRequest(input), hostId: this.routeOwner(input) }
    if (token) {
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    } else {
      headers.delete('Authorization')
    }
    const ac = new AbortController()
    // 三条在途队列：探测请求（authProbe）谁都不许 abort（见 probeInflight）；
    // hub 级请求（hubLevel）躲过 host 切换的 abortInflight 风暴，但 disconnect()
    // 仍会中止它们；其余是选中 host 的请求。
    const tracked = opts.authProbe
      ? this.probeInflight
      : opts.hubLevel
        ? this.hubInflight
        : this.inflight
    tracked.add(ac)
    const sources: AbortSignal[] = []
    const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    if (timeoutMs > 0) sources.push(AbortSignal.timeout(timeoutMs))
    const extSignal = opts.signal ?? init.signal ?? undefined
    if (extSignal) sources.push(extSignal)
    const wired = sources.map((s) => ({ s, fn: () => ac.abort(s.reason) }))
    for (const { s, fn } of wired) {
      if (s.aborted) {
        ac.abort(s.reason)
        break
      }
      s.addEventListener('abort', fn, { once: true })
    }
    try {
      // `await` matters: with a bare `return`, the finally would run the
      // moment fetch() returns its pending promise — un-wiring the abort
      // listeners and untracking the controller before the request ends.
      const res = await fetch(input, { ...init, signal: ac.signal, headers })
      // 带着钥匙仍被 401 = 那把钥匙不对。按目标分流（hub 失效 / 这台换中继）。
      // 启动期探测（detectMode / probeAccess / 近路探路）自带 401 语义，
      // 由调用方判读，绝不能在这里顺手清掉用户刚输入的密钥。
      if (res.status === 401 && token && opts.authProbe !== true) this.handleRejection(target)
      return res
    } finally {
      for (const { s, fn } of wired) s.removeEventListener('abort', fn)
      tracked.delete(ac)
    }
  },


  isLocalRequest(this: TransportCtx, input: string): boolean {
    if (this.mode === 'local') return true
    if (!this.isLocalDirect()) return false
    try {
      const target = new URL(input, location.href)
      const local = new URL(this.directBase() || location.href, location.href)
      return target.origin === local.origin
    } catch {
      return false
    }
  },


  /**
   * 这条请求属于哪台 host 的近路（null = 不是近路请求，即打 hub）。
   * 钥匙按台存，所以 401 归因也必须落到具体 hostId——纯 local 时页面这台
   * 就是唯一答案。
   */
  routeOwner(this: TransportCtx, input: string): string | null {
    if (this.mode === 'local') return this.pageSlot()
    if (!this.isLocalDirect() || !this.selectedHostId) return null
    try {
      const target = new URL(input, location.href)
      const local = new URL(this.directBase() || location.href, location.href)
      return target.origin === local.origin ? this.selectedHostId : null
    } catch {
      return null
    }
  },


  abortInflight(this: TransportCtx) {
    // 只作废 host 级在途请求（gap pulls 等）；hub 级请求（hubInflight）
    // 与选中 host 无关，host 切换不能杀掉它们（见 syncPrefsFromHub 的
    // 启动竞态，prefs 读写均标记 hubLevel）。
    for (const ac of this.inflight) ac.abort()
    this.inflight.clear()
  },
}
