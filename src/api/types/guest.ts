/**
 * 访客令牌（hub 侧 guests.json 的浏览器视图）。
 *
 * 一个令牌 = 一组可跨 host 的会话白名单。管理员在「设置 → 分享」或会话
 * 右键里创建/维护；访客用 `#g=<token>` 打开页面后只能看到这些会话。
 */

/** 白名单里的一条会话（加入时的快照 + refresh 回填的实时字段）。 */
export type GuestSessionItem = {
  hostId: string
  hostName?: string
  sessionId: string
  cwd?: string
  title?: string
  /** 加入时间（epoch 秒）。 */
  addedAt?: number
  /** refresh 判定 Host 上已不存在该会话。 */
  stale?: boolean
}

/** GET /api/guest-tokens 的一行（含 token 明文）。 */
export type GuestTokenRecord = {
  id: string
  token: string
  label: string
  /** epoch 秒。 */
  createdAt: number
  /** epoch 秒；0 = 永久。 */
  expiresAt: number
  revoked: boolean
  sessions: GuestSessionItem[]
  lastUsedAt?: number
}

/** GET /api/access-role —— 当前凭据的角色。 */
export type AccessRole =
  | { role: 'admin' }
  | {
      role: 'guest'
      guest: { id: string; label: string; expiresAt: number }
      sessions: GuestSessionItem[]
    }

/** 访客壳需要的身份（accessRole 的 guest 分支 + sessions）。 */
export type GuestIdentity = Extract<AccessRole, { role: 'guest' }>

/**
 * GET /api/subscribers 的一行：一个在线的浏览器 /ws/fe 订阅者。
 *
 * 顶栏数字是它的条数；点开面板看的就是这些行。除 `id` 外全部可缺失（老
 * hub 没有这个端点）。`guestId`/`guestLabel` 指向 guests.json 的记录，
 * hub 从不回传令牌明文。
 */
export type SubscriberRow = {
  /** hub 注册序号（单调递增，按连接时间升序）。 */
  id: number
  /** 客户端地址（hub 走反代时取 X-Real-IP，否则是 TCP peer，均去掉端口）。 */
  ip?: string
  userAgent?: string
  role: 'admin' | 'guest'
  guestId?: string
  guestLabel?: string
  /** 该页当前过滤到的 host（切 host 即变）。 */
  hostId?: string
  /** 该页当前显示的会话（subscribe 帧声明）。 */
  sessionId?: string
  /** 连接建立时刻（epoch ms）。 */
  connectedAt: number
}
