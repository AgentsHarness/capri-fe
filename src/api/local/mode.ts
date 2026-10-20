import type { TransportCtx } from './ctx'
import type { DetectModeResult } from './types'
import type { TransportMode } from '../transport'
import { freshHostRegistry, rememberHostRegistry } from '../rpc/hosts'
import { KEY } from '../../lib/keys'
import { removeKey, saveStr } from '../../lib/storage'
import type { HostInfo } from '../types'

/**
 * 连接模式：判定打到的是 capri-host 还是 hub，以及 hub 地址、门禁探测。
 *
 * 判定只看免鉴权的 `GET /api/hosts`：capri-host 会额外报 `mode`，hub 只
 * 回 hosts / defaultHostId。网络失败返回 `mode: null`——调用方既不能进
 * 主界面也不能改成 local，更不能抹密钥。
 */

export const modeMixin = {

  /**
   * 判定页面 base 指向 capri-host 还是 hub，并带回 hub 地址。**只看
   * 免鉴权的 `GET /api/hosts`**：
   * - 应答带 `mode` 字段 → 打到的是 capri-host（host 才报自己的部署形态）：
   *   配了 HUB_URL 就升到 hub，hostId 交给 setLocalHostId 认「页面就是这台」。
   * - 只有 hosts / defaultHostId → 打到的是 hub（部署版前端 / VITE_PROXY_TARGET=hub）。
   * - 401 → hub（需要 FE_TOKEN，门禁会接管）。
   * - 网络失败 → `mode: null`：模式未知，调用方**既不能进主界面也不能改
   *   成 local**，更不能抹密钥（旧实现在这里盲判 local，把 hub 会话连带抹掉）。
   *
   * 不再请求需鉴权的 /api/status：那把浏览器此刻未必有的 host 钥匙，正是
   * 局域网 IP 打开内嵌前端时升不了 hub 的原因。
   */
  async detectMode(this: TransportCtx): Promise<DetectModeResult> {
    let res: Response
    try {
      res = await this.fetch(
        `${this.base}/api/hosts`,
        {},
        // hubLevel：模式探测是 hub 级请求（不带 ?host=），绝不能被
        // host 切换 / setConnectionMode 的 abortInflight 风暴打断——
        // 被 abort 会走下面的 catch 误判成网络故障。
        // authProbe：这里的 401 是「该弹门禁了」的信号，不是「密钥失效」；
        // 且这条请求进 probeInflight，连 disconnect() 也不许杀它（重挂载
        // 竞态下那会把新一轮探测读成「无法连接到服务」）。
        // 手里已有密钥就带上：hub 的 /api/hosts 不像 capri-host 那样开放，
        // 空手去问只会换回 401——白跑一趟，还看不见注册表（也就无从交接）。
        {
          auth: this.allowDetectAuth || this.probeKey() !== '',
          hubLevel: true,
          authProbe: true,
        },
      )
    } catch {
      return { mode: null, hubUrl: '' }
    }
    if (res.status === 401) {
      return { mode: 'hub', hubUrl: this.base }
    }
    if (!res.ok) return { mode: null, hubUrl: '' }
    const data = (await res.json().catch(() => null)) as {
      hosts?: HostInfo[]
      defaultHostId?: string
      authRequired?: boolean
      mode?: string
      hubUrl?: string
      hostId?: string
      port?: number
    } | null
    if (!data) return { mode: null, hubUrl: '' }
    const authRequired = data.authRequired === true
    // 这份注册表应答可能就是 hub 的那份（部署版前端与 hub 同源时 URL 完全
    // 相同）：交给 listHosts 用，别在启动链里问第二遍。URL 不同（本机 host
    // 的注册表 ≠ hub 的注册表）时自然不会命中。
    rememberHostRegistry(`${this.base}/api/hosts`, {
      hosts: data.hosts ?? [],
      defaultHostId: data.defaultHostId,
      authRequired: data.authRequired,
    })

    const hostRow =
      data.hosts?.length === 1 && data.hosts[0]?.local === true ? data.hosts[0] : null
    const hostLocalId = typeof data.hostId === 'string' ? data.hostId : hostRow?.hostId
    const localHostName = hostRow?.hostName
    const isHostShape =
      typeof data.mode === 'string' ||
      (!data.defaultHostId && data.hosts?.length === 1 && hostRow?.local === true)

    if (isHostShape && hostLocalId) {
      // 应答者自报 hostId，且形状像 host。`mode` 缺失 = 旧版本 capri-host
      // （只在 /api/status 里报模式）：走降级，仍按今天那样试一次 status。
      if (typeof data.mode !== 'string') {
        return this.detectModeLegacy(hostLocalId, authRequired, localHostName)
      }
      if (data.mode === 'hub') {
        return {
          mode: 'hub',
          hubUrl: data.hubUrl || this.base,
          localHostId: hostLocalId,
          localHostName,
          authRequired,
        }
      }
      return {
        mode: 'local',
        hubUrl: '',
        localHostId: hostLocalId,
        localHostName,
        authRequired,
      }
    }

    // 没有 mode 字段、又不是「单台 local:true」的形状 → hub 的注册表。
    // 不带 authRequired：hub 的「要不要钥匙」就是这里的 200/401，
    // 且升 hub 时页面那台 host 的身份也无从谈起。
    if (!isHostShape) {
      return { mode: 'hub', hubUrl: this.base }
    }
    // 形状像 host 但认不出它的 hostId（极旧的 host）：本机锁定，无近路可认。
    return { mode: 'local', hubUrl: '', authRequired }
  },


  /**
   * 旧版本 capri-host 的降级路径（/api/hosts 不带 mode）：只能去问需要
   * 钥匙的 /api/status。拿不到就锁本机——比从前多带一层保护：**不因失败
   * 抹密钥**，也不谎报 hub。
   */
  async detectModeLegacy(
    this: TransportCtx,
    hostId: string,
    authRequired: boolean,
    localHostName?: string,
  ): Promise<DetectModeResult> {
    try {
      const stRes = await this.fetch(
        `${this.base}/api/status`,
        {},
        {
          auth: this.allowDetectAuth || this.probeKey() !== '' || authRequired,
          hubLevel: true,
          authProbe: true,
        },
      )
      if (stRes.ok) {
        const st = (await stRes.json().catch(() => ({}))) as {
          mode?: string
          hubUrl?: string
          hostId?: string
        }
        if (st.mode === 'hub') {
          return {
            mode: 'hub',
            hubUrl: st.hubUrl || this.base,
            localHostId: st.hostId || hostId,
            localHostName,
            authRequired,
          }
        }
      }
    } catch {
      /* 保持 local */
    }
    return { mode: 'local', hubUrl: '', localHostId: hostId, localHostName, authRequired }
  },


  async probeAccess(this: TransportCtx): Promise<'ok' | 'need_token' | 'error'> {
    try {
      // hubLevel：门禁探测与选中 host 无关，被 abortInflight 打断会退成
      // 'error'，调用方（App）把 'error' 当「网络问题也进主界面」处理，
      // 于是本该弹出的密钥门禁被跳过。authProbe 让它落在 probeInflight，
      // 连重挂载带来的 disconnect() 也打不断。
      // authProbe：这里的 401 是「该弹门禁」，不是「手里的密钥失效」。
      const url = `${this.apiBase()}/api/hosts`
      const opts = { hubLevel: true, authProbe: true }
      // 「能不能访问」这个问题，detectMode 刚问过的那个 URL 的应答已经回答了
      // （200 本身即访问通过，authRequired 与本地密钥是否齐备决定要不要进门禁）
      // ——交接窗口内直接据此作答，不再问第二遍。
      const handed = freshHostRegistry(url)
      if (handed) {
        return handed.authRequired && !this.doorToken() ? 'need_token' : 'ok'
      }
      const res = await this.fetch(url, {}, opts)
      if (res.status === 401) return 'need_token'
      if (!res.ok) return 'error'
      // capri-host 配置了 FE_TOKEN 时 /api/hosts 保持开放（启动探测端点），
      // 但响应声明 authRequired —— 浏览器本地没有 token 就直接进门禁，
      // 避免无 token 裸请求打到所有接口上才暴露。
      const data = (await res.json().catch(() => ({}))) as {
        authRequired?: boolean
        hosts?: HostInfo[]
        defaultHostId?: string
      }
      if (data.authRequired && !this.doorToken()) return 'need_token'
      // 这份应答与随后 refreshHosts 要问的是同一个 URL：交出去，别问第二遍。
      rememberHostRegistry(url, {
        hosts: data.hosts ?? [],
        defaultHostId: data.defaultHostId,
        authRequired: data.authRequired,
      })
      return 'ok'
    } catch {
      return 'error'
    }
  },


  setConnectionMode(this: TransportCtx, mode: TransportMode, hubUrl: string = '') {
    const next = hubUrl.replace(/\/$/, '')
    if (mode === 'local') {
      const changed = this.mode !== 'local' || this.hubUrl !== '' || this.lastHubUrl !== ''
      this.mode = 'local'
      this.hubUrl = ''
      this.lastHubUrl = ''
      removeKey(KEY.hubUrl)
      // 这里**不动任何密钥槽**。旧实现「本机开放就把当前凭据当 hub 残留删
      // 掉」是因为那时只有一把钥匙；现在 hub 槽与 host 槽分开，本机要的那把
      // 存在 host 槽里，删 hub 槽既救不了本机也白白抹掉用户刚输入的密钥
      // （探测失败回退 local 曾因此吃掉刚输的 hub 凭据）。
      this.abortInflight()
      for (const ac of this.hubInflight) ac.abort()
      this.hubInflight.clear()
      if (changed && (this.es || this.ws)) this.connect()
      return
    }
    if (next) {
      this.lastHubUrl = next
      saveStr(KEY.hubUrl, next)
    }
    if (this.mode === mode && this.hubUrl === next) return
    this.resetSequencing()
    this.mode = mode
    this.hubUrl = next
    this.abortInflight()
    if (this.es || this.ws) this.connect()
  },


  getConnectionMode(this: TransportCtx): TransportMode {
    return this.mode
  },


  getHubUrl(this: TransportCtx): string {
    return this.mode === 'hub' ? this.hubUrl || this.lastHubUrl : ''
  },


  prefsOrigin(this: TransportCtx): string {
    // 部署版前端与 hub 同源时（页面即 hub，base / 显式 hubUrl 均为
    // 空串），prefs 落在页面自身 origin——相对路径 /api/prefs 经反代
    // 直达 hub。跨源 hub（host 报的 HUB_URL / 显式 hubUrl）优先。
    // local 模式不写 hub：置顶/待办仅存 localStorage。
    return this.mode === 'hub' ? this.hubUrl || this.lastHubUrl || location.origin : ''
  },


  apiBase(this: TransportCtx): string {
    if (this.mode === 'hub' && this.hubUrl) return this.hubUrl
    return this.base
  },
}
