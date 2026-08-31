import type { AcpEvent } from '../../../api/types'

/** AcpEvent plus the optional wire fields every handler reads. */
export type WireEvent = AcpEvent & {
  sessionId?: string
  params?: Record<string, unknown>
  /** 回放归一化序号（host msgSeq 契约）——仅历史回放事件携带，live 无。
   *   hook 路由用它按批次判定 replay（TUI `meta.is_replay`）。 */
  msgSeq?: number
}
