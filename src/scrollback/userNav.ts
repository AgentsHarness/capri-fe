import type { ScrollEntry } from '../api/types'
import type { UserMessageNavItem } from '../components/UserMessageNav'
import { userMessagePreview } from '../format'
import { classifyUserPrompt } from '../store/chat/envelope'

/**
 * 用户消息目录条目：全量（已加载 + 未加载）合并。
 *
 * - promptStarts + promptPreviews 齐全且等长（host 本地归一化路径）→ 全量
 *   目录：未加载轮用 host 预览（经 classifyUserPrompt 过滤隐藏 prompt：
 *   system-reminder / monitor events / 空文本，与滚动区渲染用的同一套规
 *   则，序号因此与渲染行一致）；已加载轮用渲染条目的文本。预览级过滤只有
 *   首行，隐藏判定均为首行前缀，结论与全文本一致；legacy 无 displayText
 *   的 cron prompt 首行是 <system-reminder>，会被误滤（极小概率的老日志
 *   形态，代价只是该轮不进目录）。
 * - 缺任一（旧 host / 透传路径）→ 退回只列已加载轮（今天的行为）。
 */
export function buildUserNavItems(
  entries: ScrollEntry[],
  promptStarts: number[] | undefined,
  promptPreviews: string[] | undefined,
): UserMessageNavItem[] {
  const items: UserMessageNavItem[] = []
  let turnIdx = 0
  const full =
    !!(
      promptStarts &&
      promptStarts.length > 0 &&
      promptPreviews &&
      promptPreviews.length > 0
    ) && promptStarts.length === promptPreviews.length
  if (full) {
    type UserEntry = Extract<ScrollEntry, { kind: 'user' }>
    const userBySeq = new Map<number, UserEntry>()
    for (const e of entries) {
      if (e.kind === 'user' && e.msgSeq != null && !userBySeq.has(e.msgSeq)) {
        userBySeq.set(e.msgSeq, e)
      }
    }
    for (let i = 0; i < promptStarts!.length; i++) {
      const seq = promptStarts![i]
      const loaded = userBySeq.get(seq)
      if (loaded) {
        items.push({
          id: loaded.id,
          seq,
          preview: userMessagePreview(loaded.text),
          turnIdx: turnIdx++,
          loaded: true,
        })
        continue
      }
      const preview = promptPreviews![i] ?? ''
      // 隐藏 prompt（system-reminder / monitor events / --- / 空文本）与
      // 滚动区渲染一致地跳过（空预览即图块 run，滚动区同样没有 user 行）。
      if (!classifyUserPrompt(preview)) continue
      items.push({
        id: `prompt:${seq}`,
        seq,
        preview: userMessagePreview(preview),
        turnIdx: turnIdx++,
        loaded: false,
      })
    }
    // promptStarts 快照之后才出现的 live user 行（无 msgSeq 或新轮已入库）
    // 补在末尾，目录永远覆盖滚动区当前内容。
    const covered = new Set(items.map((it) => it.id))
    for (const e of entries) {
      if (e.kind === 'user' && !covered.has(e.id)) {
        items.push({
          id: e.id,
          seq: e.msgSeq,
          preview: userMessagePreview(e.text),
          turnIdx: turnIdx++,
          loaded: true,
        })
      }
    }
    return items
  }
  for (const e of entries) {
    if (e.kind !== 'user') continue
    items.push({
      id: e.id,
      seq: e.msgSeq,
      preview: userMessagePreview(e.text),
      turnIdx: turnIdx++,
      loaded: true,
    })
  }
  return items
}
