import type { TransportMode } from '../transport'

/**
 * 传输层的对外类型与调优常量。
 *
 * 这些既被 mixin 用到，也被 `client.ts` / 调用方引用，所以独立成模块：
 * mixin 之间不互相 import，共享的东西都落在这里。
 */

/**
 * 本机近路探路的四态 + 一个结论态：
 * - `open`     —— 端口上就是一台不需要钥匙的 capri-host；
 * - `pending`  —— 探到了 host，但这台要它自己的钥匙，还没问到；
 * - `hub-ok`   —— 要钥匙，且 hub 那把在这里也有效；
 * - `host-ok`  —— 用户为这台单独输入的钥匙已验证通过；
 * - `rejected` —— 探路 401 且用户取消：这台走中继，不再重复问。
 */
export type LocalProbe = 'open' | 'pending' | 'hub-ok' | 'host-ok' | 'rejected'

/** 这三态才允许走近路（其余一律回落 hub 中继）。 */
export function probeAllowsDirect(probe: LocalProbe): boolean {
  return probe === 'open' || probe === 'hub-ok' || probe === 'host-ok'
}

/** 一条已验证的本机近路（host 直连，不绕 hub 中继）。 */
export type LocalRoute = {
  /** 直连用的 origin（如 http://127.0.0.1:8765）；空串 = 页面 origin 本身。 */
  base: string
  /** 验证时这台 host 自报的本机监听端口；0 = 页面 origin 近路（与端口无关）。 */
  port: number
  /** 这台 host 的 API 是否要求 FE_TOKEN。 */
  authRequired: boolean
  /** 近路钥匙状态（见 LocalProbe）。 */
  probe: LocalProbe
}

/** `fetch` 的传输层选项（钥匙选择、超时、abort 归属、401 归因）。 */
export type FetchOpts = {
  timeoutMs?: number
  signal?: AbortSignal
  /** hub 级请求：不被切 host 的 abortInflight 风暴打断。 */
  hubLevel?: boolean
  /** 强制出示「当前门禁那把」（启动探测用），不做近路剥除。 */
  auth?: boolean
  /** 强制指定出示哪把钥匙（近路探路用：此刻近路还不可用，自动判定选不出归属）。 */
  forceToken?: string
  /**
   * 这条请求自带 401 语义（模式判定 / 门禁探测 / 探路），不参与运行时登出
   * 分流；同时它属于 probeInflight，任何 abort 风暴都不得打断它。
   */
  authProbe?: boolean
  /**
   * 强制走 hub 中继：URL 由 urlForHost 拼成（始终 hub base + ?host=），
   * 钥匙固定用 hub 槽，401 归因给 hub。跨 host 读配置用——不能按「选中
   * host 的近路」自动判定，否则可能把请求发到本机另一台上。
   */
  forceRelay?: boolean
}

/** detectMode 的结论。`mode: null` = 不可知（网络失败），调用方不得改状态。 */
export type DetectModeResult = {
  mode: TransportMode | null
  hubUrl: string
  localHostId?: string
  /** 页面这台 host 的展示名（门禁文案用它，别把裸 hostId 甩给用户）。 */
  localHostName?: string
  authRequired?: boolean
}

/** `/ws/fe` 的下行帧（hub 模式）。 */
export type HubWsFrame =
  | {
      type: 'hello'
      service?: string
      hosts?: unknown
      defaultHostId?: string
      seqs?: Record<string, number>
      [k: string]: unknown
    }
  | { type: 'events'; events: unknown[] }
  | { type: 'ping'; ts?: number }
  /** 新 hub 对 subscribe 控制帧的回执：该 host 当前的 seq 水位。 */
  | { type: 'subscribed'; host?: string; seq?: number }
  | { type: string; [k: string]: unknown }

/**
 * Default hard timeout for transport fetches. Host-side endpoints are
 * quick operations; 30s covers slow hubs while bounding half-open TCP
 * connections that would otherwise hang the fetch (and, for gap pulls,
 * wedge the per-host `pulling` slot) forever.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** 旧 hub/host 不下发 port 时试的本机默认端口（与 capri-host 的 PORT 默认一致）。 */
export const DEFAULT_LOCAL_PORT = 8765
/** 单个 127.0.0.1 探测的超时：本机要么毫秒级应答，要么根本没服务。 */
export const LOCAL_PROBE_TIMEOUT_MS = 800
/** 探不到的端口多久内不再重复探测（hosts_changed 会频繁驱动 discoverLocalHost）。 */
export const LOCAL_PROBE_RETRY_MS = 30_000
