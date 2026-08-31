import type { BtwHistoryRecord, ScrollEntry } from '../../api/types'

/**
 * /btw 侧问回放合并（host 从 btw_history.jsonl 读出的记录 → 滚动区块）。
 *
 * live 路径不经过这里：/btw 发出时 askBtw 已建本地条目并原位收到答案。
 * 回放记录由 agent 落盘（不在会话更新流里），host 按页窗口附带 —— 本模块
 * 只负责把记录换成条目并按锚点缝进时间线。
 */

/** btw 回放条目的稳定 id：跨页加载去重（btw_session_id 由 agent 分配）。 */
export function btwReplayId(rec: Pick<BtwHistoryRecord, 'btwSessionId'>): string {
  return `btw_${rec.btwSessionId}`
}

/** 回放记录 → 滚动区块。已收口（回放时必已结束），默认折叠（TUI 持久化
 *  BtwBlock 同款：折叠=单行头，展开/查看看全文）。msgSeq 取锚点 + 0.5：
 *  排在锚点信封条目之后、下一条信封条目之前，且不与任何信封 msgSeq 撞值
 *  （不干扰 findMsgSeqGap / mergeEntriesByMsgSeq 的等值语义）。 */
export function btwReplayEntry(rec: BtwHistoryRecord): ScrollEntry {
  return {
    id: btwReplayId(rec),
    kind: 'btw',
    question: rec.question,
    ...(rec.answer ? { answer: rec.answer } : {}),
    ...(!rec.success && rec.error ? { error: rec.error } : {}),
    streaming: false,
    open: false,
    msgSeq: rec.afterMsgSeq + 0.5,
  }
}

/**
 * 把 btw 回放记录缝进已构建条目列表（按 msgSeq 升序稳定插入）：
 * - 稳定 id 去重：同 id 已在（重入的分页/回放）→ 跳过该记录；
 * - 内容去重：live 已回答的同问同答条目（askBtw 本地条目，id 不同）在
 *   会话未重建时先于回放合并出现——内容相同视为同一条，避免时间线上
 *   同一问答出现两次；会话重建后以回放记录为准，单条呈现；
 * - 锚点 -1（置顶）插在最前；缺 msgSeq 的既有条目保持原相对位置，
 *   未消耗的记录缀在其后。
 * 无记录 / 无新增 → 原数组返回（引用不变，调用方 memo 不受影响）。
 */
export function spliceBtwEntries<T extends ScrollEntry>(
  entries: T[],
  records: readonly BtwHistoryRecord[],
): T[] {
  if (!records.length) return entries
  const have = new Set(entries.map((e) => e.id))
  const answered = new Set(
    entries
      .filter((e) => e.kind === 'btw' && !e.streaming)
      .map((e) => btwKey(e as Extract<ScrollEntry, { kind: 'btw' }>)),
  )
  const incoming: T[] = []
  for (const rec of records) {
    const id = btwReplayId(rec)
    if (have.has(id)) continue
    if (answered.has(btwKey(rec))) continue
    have.add(id)
    incoming.push(btwReplayEntry(rec) as T)
  }
  if (!incoming.length) return entries
  // 防御性排序（host 已按锚点升序，这里保证记录乱序到达也稳定）：msgSeq
  // 升序，同锚点按 askedAt（msgSeq 只做序，不做键）。
  incoming.sort(
    (a, b) =>
      (a as { msgSeq?: number }).msgSeq! - (b as { msgSeq?: number }).msgSeq!,
  )
  const out: T[] = []
  let i = 0
  for (const e of entries) {
    while (
      i < incoming.length &&
      (e.msgSeq == null || incoming[i]!.msgSeq! <= e.msgSeq!)
    ) {
      out.push(incoming[i++]!)
    }
    out.push(e)
  }
  while (i < incoming.length) out.push(incoming[i++]!)
  return out
}

function btwKey(e: { question?: string; answer?: string; error?: string }): string {
  return `${e.question ?? ''}\u0000${e.answer ?? ''}\u0000${e.error ?? ''}`
}