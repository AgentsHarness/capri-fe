/** 管理员用户列表里的 host 配对快照。 */
export type UserHostRecord = {
  hostId: string
  hostName: string
  online: boolean
  lastSeenAgeMs?: number
}

/** 用户令牌（hub 侧 users.json 的浏览器视图）。token 明文只在创建/重置/自助修改的响应里出现一次。 */
export type UserRecord = {
  id: string
  label: string
  /** epoch 秒。 */
  createdAt: number
  /** epoch 秒；0/缺省 = 从未使用。 */
  lastUsedAt?: number
  /** 该用户名下的 host 数。 */
  hostCount: number
  /** 管理界面只读展示的 host 配对明细。 */
  hosts?: UserHostRecord[]
}

/** 创建 / 重置 / 自助修改 token 的响应：明文 token 只在这里出现一次。 */
export type UserTokenIssue = {
  user: UserRecord
  token: string
}
