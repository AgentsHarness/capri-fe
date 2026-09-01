/**
 * 历史分页（POST /api/session-updates）的投影档位与能力回显——三端
 * （agent / capri-host / 本 FE）逐字对齐的共享契约，字段名与取值不得改。
 */

/**
 * 请求侧 `detail`：
 * - `full` / 缺省 / 未知值 → 今天的行为，信封逐字节原样（默认）
 * - `lite` → 只裁工具正文（host 侧 lite 投影）
 * - `meta` → 不回 `updates` 键，只回 totalCount / hasMore / promptStarts（+ projected）
 */
export type SessionHistoryDetail = 'full' | 'lite' | 'meta'

/**
 * 响应侧 `projected`：host 的投影能力回显，仅投影真正生效时带。请求了
 * lite/meta 却没拿到该键 = 旧 host 不认识 detail → FE 按 full 渲染并
 * 停用该 host 的 lite。
 */
export type SessionHistoryProjected = 'lite' | 'meta'

/**
 * host lite 投影打在信封 `params.update._meta.lite` 上的标记：被裁掉的
 * 字节数与被裁字段路径。放在 `_meta` 是有意的——FE 的工具去重键函数
 * （`toolReplayPayload`）会 delete `_meta`，标记因此不参与去重。
 */
export type LiteProjectionMark = {
  omitted: number
  fields: string[]
}

/**
 * POST /api/session-updates 的响应（信封页 + 锚点 + 投影回显）。
 * `updates` 在 meta 档下由 host 直接省略（不是空数组——空数组会被 FE
 * 当成「无历史」）。
 */
export type SessionHistoryPage = {
  totalCount?: number
  hasMore?: boolean
  updates?: unknown[]
  /** 所有 user 回合的起始行号索引（turnIndex 模式返回；导航/定位用）。 */
  promptStarts?: number[]
  /**
   * /btw 侧问回放记录（host 本地归一化路径从 btw_history.jsonl 读出，
   * 按页窗口切片；agent 透传路径不带）。仅本地回放路径可用。
   */
  btw?: import('./scroll').BtwHistoryRecord[]
  /** host 的投影能力回显；缺省 = 旧 host 不认识 detail。 */
  projected?: SessionHistoryProjected
  /** 整页被裁掉的总字节数（projected 生效时带；补全预算闸门用）。 */
  omittedBytes?: number
}
