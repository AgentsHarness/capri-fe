import { loadJSON, loadStr, removeKey, saveJSON, saveStr } from '../lib/storage'
import { KEY } from '../lib/keys'

/**
 * 三把钥匙，三个槽。
 *
 * - **hub 槽**（`capri-fe.token`）：公网 hub 的门禁密钥（管理员身份）。
 *   打 hub 的 `/api/*`、`/ws/fe` 用它。
 * - **访客槽**（`capri-fe.guestToken`）：访客令牌（只读分享）。与管理员那把
 *   **分开存**：同一浏览器可以同时保存两把，切换身份只是换「这次出示哪格」。
 *   管理员能随时从顶栏 host 列表切到访客视图，退出也不用重新输入。
 * - **host 槽**（`capri-fe.hostTokens`，hostId → 密钥）：某台 capri-host
 *   自己 `FE_TOKEN` 的密钥。**只在浏览器直连那台的本机端口（近路）时出示。**
 *
 * 它们可以不同：经 hub 中继的请求由 host 进程自己注入凭据（见 capri-host
 * internal/hub/client.go 的 relayInProcess），浏览器根本不需要知道 host 那
 * 把；只有走近路才需要。所以近路钥匙按 hostId 另存，绝不覆盖 hub 槽——相
 * 反，hub 换密钥也不该抹掉各台 host 已验证过的钥匙，换访客令牌也不该抹掉
 * 管理员那把。
 *
 * 纯 local（host 没配 `HUB_URL`）时不存在 hub，页面本身就是那台 host，门禁
 * 问的也是 host 钥匙 → 同样写 host 槽，与 hub 槽彻底分开。认不出 hostId
 * 的退化场景（host 太旧、/api/hosts 不报 hostId）用 `PAGE_SLOT` 这个保留键。
 */

const HUB_KEY = KEY.hubToken
const HOST_KEY = KEY.hostTokens
const GUEST_KEY = KEY.guestToken

/** host 槽里代表「页面 origin 这台 host」的保留键（hostId 未知时用）。 */
export const PAGE_SLOT = '@page'

type HostTokenMap = Record<string, string>

function sane(map: unknown): HostTokenMap {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
  const out: HostTokenMap = {}
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

// ── hub 槽 ──────────────────────────────────────────────────────────────

export function loadHubToken(): string {
  return loadStr(HUB_KEY)?.trim() || ''
}

/** 空串 = 清除。 */
export function saveHubToken(token: string): void {
  const t = token.trim()
  if (t) saveStr(HUB_KEY, t)
  else removeKey(HUB_KEY)
}

// ── 访客槽 ──────────────────────────────────────────────────────────────

/**
 * 访客令牌（hub 的 guests.json 里那一把）。
 *
 * 与管理员那把**分开两格**：同一浏览器可以同时保存两把，切换身份只是换
 * 「这次用哪格」，互不覆盖——从访客壳退出后不用重新输入管理员密钥，管理员
 * 也能从顶栏的 host 列表随时切到访客视图。
 */
export function loadGuestToken(): string {
  return loadStr(GUEST_KEY)?.trim() || ''
}

/** 空串 = 清除（访客令牌被吊销 / 失效时）。 */
export function saveGuestToken(token: string): void {
  const t = token.trim()
  if (t) saveStr(GUEST_KEY, t)
  else removeKey(GUEST_KEY)
}

/**
 * 采纳 URL fragment 里的访客令牌：`#g=<token>`。
 *
 * fragment 不会发给服务器，所以令牌不落反代日志；采纳后立刻用
 * history.replaceState 清掉它，避免刷新/复制地址时把令牌留在地址栏历史里。
 * 令牌写**访客槽**，管理员那把原样留在 hub 槽——退出访客就能直接回去。
 *
 * 返回采纳的令牌（没有则 null）。
 */
export function adoptSharedToken(): string | null {
  if (typeof location === 'undefined') return null
  const raw = location.hash.match(/^#g=(.+)$/)?.[1]
  if (!raw) return null
  const token = decodeURIComponent(raw).trim()
  if (!token) return null
  saveGuestToken(token)
  try {
    history.replaceState(null, '', location.pathname + location.search)
  } catch {
    /* 老浏览器 / sandbox iframe：地址栏留着 #g=，功能不受影响 */
  }
  return token
}

// ── host 槽 ─────────────────────────────────────────────────────────────

export function loadHostTokens(): HostTokenMap {
  return sane(loadJSON<unknown>(HOST_KEY, {}))
}

/** 某台 host 的近路钥匙（未存过则空串）。 */
export function loadHostToken(hostId: string): string {
  return loadHostTokens()[hostId] ?? ''
}

/** 空串 = 删掉这台（密钥被拒 / host 被解除配对时用）。 */
export function saveHostToken(hostId: string, token: string): void {
  const map = loadHostTokens()
  const t = token.trim()
  if (t) map[hostId] = t
  else delete map[hostId]
  saveJSON(HOST_KEY, map)
}

/** host 被 unpair / 删除时回收它的钥匙与通路选择。 */
export function dropHost(hostId: string): void {
  saveHostToken(hostId, '')
  saveRouteChoice(hostId, 'auto')
}

// ── 通路选择（用户显式覆盖近路默认） ─────────────────────────────────────

/** `auto` = 有近路候选就直连；`relay` = 强制经 hub 中继。 */
export type RouteChoice = 'auto' | 'direct' | 'relay'

const CHOICE_KEY = KEY.routeChoice

export function loadRouteChoices(): Record<string, RouteChoice> {
  const raw = loadJSON<unknown>(CHOICE_KEY, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, RouteChoice> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === 'direct' || v === 'relay') out[k] = v
  }
  return out
}

/** 传 `auto` 即删掉这条覆盖，回到默认。 */
export function saveRouteChoice(hostId: string, choice: RouteChoice): void {
  const map = loadRouteChoices()
  if (choice === 'auto') delete map[hostId]
  else map[hostId] = choice
  saveJSON(CHOICE_KEY, map)
}
