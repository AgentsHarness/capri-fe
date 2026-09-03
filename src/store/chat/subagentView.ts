import type {
  AcpEvent,
  ScrollEntry,
  SubagentViewState,
  ToolCall,
} from '../../api/types'
import type { SetState } from './types'
import { nid } from './ids'
import { formatElapsed, imageSrc, toolVerb } from './format'
import { extractTarget, toolCallIdOf, toolKindName } from './tools'
import { liteMark } from './envelopeParse'
import { turnEndMarkerText, wireElapsedMs } from './turnStatus'
import { collapsedEditBlocks } from './modeFlags'
import { isEditToolKind } from '../../theme/toolFamily'

export function sealSubagentStreaming(items: ScrollEntry[]): ScrollEntry[] {
  let changed = false
  const sealed = items.map((it) => {
    if (it.kind === 'assistant' && it.streaming) {
      changed = true
      return { ...it, streaming: false }
    }
    if (it.kind === 'thought' && it.streaming) {
      changed = true
      return {
        ...it,
        streaming: false,
        displayMode: 'collapsed' as const,
        finishedAt: Date.now(),
        // 与主 scrollback 同款取值顺序：wire elapsedMs（回放原始耗时，
        // agentTimestampMs - streamStartMs）> 本地 startedAt 计时 >
        // 既有 elapsed。只看 startedAt 时回放条目的起点是回放时刻，
        // 收口会算出 ~0ms 的假 "0.0s"。
        elapsed:
          it.elapsedMs != null
            ? formatElapsed(it.elapsedMs)
            : it.startedAt != null
              ? formatElapsed(Date.now() - it.startedAt)
              : it.elapsed,
      }
    }
    return it
  })
  return changed ? sealed : items
}

/** 子代理视图的时间线末尾追加一条（不设条目上限——由用户上滑分页控制）。 */
export function subagentViewPush(
  items: ScrollEntry[],
  item: ScrollEntry,
): ScrollEntry[] {
  return [...items, item]
}

/** 把子代理会话的一个 AcpEvent 追加进对应视图（纯逻辑，live/回放共用）。 */
export function applySubagentViewEvent(
  set: SetState,
  childSid: string,
  ev: AcpEvent,
): void {
  set((s) => {
    const prev = s.subagentViews[childSid]
    // 防御：spawn 尚未处理（索引已建但视图缺失）时惰性初始化。
    const items = subagentViewAppend(prev?.items ?? [], withLocalElapsed(childSid, ev))
    const view: SubagentViewState = { ...(prev ?? { items: [], fetchState: 'idle' }), items }
    if (prev && prev.items === items) return {}
    return { subagentViews: { ...s.subagentViews, [childSid]: view } }
  })
}

/**
 * 子代理视图的 live 回合锚（childSid → 回合开始 epoch ms）。live 的
 * done/cancelled 事件不带任何时长字段（turn_completed 的 elapsedMs 只有
 * 回放/rail 才有），本地锚让 cancelled 的 "Turn cancelled by user in X"
 * 也有真实时长（TUI session_event.rs 同款）。user_message/user_chunk
 * （回合起点）到达时锚定，终态事件消费后即清除；无锚或 wire 已带时长
 * 时事件原样放行。时长只在锚存在且非负时注入，陈旧锚最多多算、不产生
 * 负值。
 */
const subagentTurnAnchors = new Map<string, number>()

function withLocalElapsed(sid: string, ev: AcpEvent): AcpEvent {
  if (ev.type === 'user_message' || ev.type === 'user_chunk') {
    if (!subagentTurnAnchors.has(sid)) subagentTurnAnchors.set(sid, Date.now())
    return ev
  }
  if (
    ev.type !== 'done' &&
    ev.type !== 'cancelled' &&
    ev.type !== 'turn_completed'
  ) {
    return ev
  }
  const start = subagentTurnAnchors.get(sid)
  subagentTurnAnchors.delete(sid)
  if (start == null || ev.type === 'turn_completed') return ev
  if ((ev as { elapsedMs?: number }).elapsedMs != null) return ev
  const elapsed = Date.now() - start
  // done/cancelled 类型上没有 elapsedMs 字段——本地推导值经同一宽松通道
  // 注入，收口分支再用该通道读回。
  return elapsed >= 0 ? ({ ...ev, elapsedMs: elapsed } as unknown as AcpEvent) : ev
}

/**
 * 子代理事件流 → 主模型 ScrollEntry 条目（不可变 reducer）。仅处理
 * scrollback 相关类型：user/assistant/thought/tool/plan/image + 回合
 * 收口；其余忽略（usage/status/hello/… 与宿主 scrollback 无关）。
 * 回合收口标记用 session_event 条目（主 scrollback 同款形态）。
 */
export function subagentViewAppend(
  items: ScrollEntry[],
  ev: AcpEvent,
): ScrollEntry[] {
  switch (ev.type) {
    case 'user_message': {
      const text = ev.text ?? ''
      if (!text.trim()) return items
      return subagentViewPush(items, {
        id: nid(),
        kind: 'user',
        text,
        ts: ev.ts,
        expanded: false,
      })
    }
    case 'user_chunk': {
      if (ev.hideFromScrollback === true) return items
      const text = (ev.displayText ?? ev.text) || ''
      if (!text.trim()) return items
      // 用户插话 = 流切换，先收口挂着的思考/回答段。
      const sealed = sealSubagentStreaming(items)
      // 同一用户回合的连续 chunk 聚合进最后一条 user（主 scrollback 同款）。
      const last = sealed[sealed.length - 1]
      if (last && last.kind === 'user') {
        const next = [...sealed]
        next[next.length - 1] = { ...last, text: last.text + text }
        return next
      }
      return subagentViewPush(sealed, {
        id: nid(),
        kind: 'user',
        text,
        expanded: false,
      })
    }
    case 'chunk': {
      const text = ev.text ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        const next = [...items]
        next[next.length - 1] = { ...last, text: last.text + text, streaming: true }
        return next
      }
      // 流切换：thinking 段结束进入回答段 → 先收口思考（主 scrollback
      // 流切换 seal 同款），回答段新起一条。
      const sealed = sealSubagentStreaming(items)
      return subagentViewPush(sealed, {
        id: nid(),
        kind: 'assistant',
        text,
        streaming: true,
        ts: ev.ts,
      })
    }
    case 'thought': {
      const text = ev.text ?? ''
      if (!text) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'thought' && last.streaming) {
        const next = [...items]
        next[next.length - 1] = {
          ...last,
          text: last.text + text,
          streaming: true,
          // 耗时随流增长：最后一个 chunk 的 elapsedMs 生效（主 scrollback
          // streamBufElapsedMs 同款"last chunk wins"）。
          ...(ev.elapsedMs != null ? { elapsedMs: ev.elapsedMs } : {}),
        }
        return next
      }
      // 新思考段：先收口前面挂着的流（多段思考/回放防御），再开新条目。
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'thought',
        text,
        streaming: true,
        displayMode: 'expanded',
        // 回放/带 meta 的 live 事件带服务端原始耗时（wire elapsedMs）；
        // 无则打本地起点供收口计时（与主 scrollback thought 条目同款）。
        ...(ev.elapsedMs != null
          ? { elapsedMs: ev.elapsedMs }
          : { startedAt: Date.now() }),
      })
    }
    case 'tool_call': {
      // 工具开始 = 思考/回答段即时收口（TUI finish_thinking on tool
      // start，主 scrollback tool_call 分支 sealThought 同款）——否则
      // 运行中的每段 thinking 都挂着 "Thinking…" 直到回合终态。
      const sealed = sealSubagentStreaming(items)
      const tc = ev.toolCall || {}
      const item = stampLiteSeq(subagentToolItem(tc), ev)
      // 同 toolCallId 重复到达时原地替换，避免双行。
      const idx = item.toolCallId
        ? sealed.findIndex(
            (it) => it.kind === 'tool' && it.toolCallId === item.toolCallId,
          )
        : -1
      if (idx >= 0) {
        const next = [...sealed]
        next[idx] = item
        return next
      }
      return subagentViewPush(sealed, item)
    }
    case 'tool_call_update': {
      // 工具行更新同样视为思考段推进（回放/边界防御），先收口挂着的流。
      const sealed = sealSubagentStreaming(items)
      const tc = ev.toolCallUpdate || {}
      const toolCallId = toolCallIdOf(tc)
      // 与主滚动区相同：空 id 等 host 注入合成 ID，不再匿名认领。
      if (!toolCallId) {
        return sealed
      }
      const idx = sealed.findIndex(
        (it) => it.kind === 'tool' && it.toolCallId === toolCallId,
      )
      if (idx >= 0) {
        const existing = sealed[idx]
        if (existing.kind === 'tool') {
          // 与主 scrollback 相同：update 的字段合并进 raw，标题/动词重算。
          const merged: ToolCall = { ...(existing.raw || {}), ...tc }
          const next = [...sealed]
          next[idx] = stampLiteSeq(subagentToolItem(merged, existing), ev, existing)
          return next
        }
      }
      // 未找到对应条目（回放分页边界）：按首次 tool_call 追加。
      return subagentViewAppend(sealed, {
        type: 'tool_call',
        toolCall: tc,
        ...(ev.msgSeq != null ? { msgSeq: ev.msgSeq } : {}),
      })
    }
    case 'plan':
      // plan 展示 = 流切换（主 scrollback plan 分支同样收口思考段）。
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'plan',
        entries: ev.entries,
      })
    case 'image': {
      const src = imageSrc(ev.data, ev.mimeType)
      if (!src) return items
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'image',
        data: src,
        mimeType: ev.mimeType,
        ts: ev.ts,
      })
    }
    case 'done':
    case 'turn_completed':
    case 'cancelled': {
      // 回合收口：assistant/thought 停止 streaming（thought 与主 scrollback
      // settleTurnEntries 一致：折叠 + 本地 elapsed），追加回合结束标记。
      // 文案对齐 TUI session_event.message()（主 scrollback
      // turnStatus.turnEndMarkerText 同源）：turn_completed（回放由
      // envelopeParse.turnCompletedEvent 归一化，live rail 原样带 update）
      // 带 stopReason/agentResult/elapsedMs → "Turn failed …" /
      // "Turn cancelled by user in X." / "Worked for X"；live done 只带
      // stopReason；live cancelled 无字段，时长由 withLocalElapsed 的
      // 本地回合锚注入。无任何数据时回退旧的固定文案。
      const sealed = sealSubagentStreaming(items)
      const stopReason =
        ev.type === 'turn_completed'
          ? (ev.stopReason ??
            (typeof ev.update?.stop_reason === 'string'
              ? ev.update.stop_reason
              : undefined))
          : ev.type === 'done'
            ? ev.stopReason
            : // cancelled 事件本身就是用户取消（TUI TurnCancelled）——
              // 事件类型即 stopReason，没有这个映射注入的时长会落进
              // "Worked for" 分支。
              'cancelled'
      const agentResult =
        ev.type === 'turn_completed'
          ? (ev.agentResult ??
            (typeof ev.update?.agent_result === 'string'
              ? ev.update.agent_result
              : undefined))
          : undefined
      const elapsedMs =
        ev.type === 'turn_completed'
          ? // wire 权威时长（update.elapsed_ms，1.0.9+）优先；旧日志回放
            // 回退 turnStartedAt/endMs 推导（主 scrollback 回放同款取值序）。
            (ev.elapsedMs ??
              wireElapsedMs(ev.update) ??
              (ev.turnStartedAt != null &&
                ev.endMs != null &&
                ev.endMs >= ev.turnStartedAt
                ? ev.endMs - ev.turnStartedAt
                : undefined))
          : // done/cancelled 类型上没有 elapsedMs——withLocalElapsed 注入
            // 的本地推导时长经同一通道读取。
            ((ev as { elapsedMs?: number }).elapsedMs ?? undefined)
      const marker: ScrollEntry =
        stopReason == null && elapsedMs == null
          ? {
              id: nid(),
              kind: 'session_event',
              text:
                ev.type === 'done'
                  ? '— turn completed —'
                  : ev.type === 'cancelled'
                    ? '— turn cancelled —'
                    : '— turn ended —',
            }
          : (() => {
              const { text, warning } = turnEndMarkerText(
                stopReason,
                agentResult,
                elapsedMs,
              )
              return {
                id: nid(),
                kind: 'session_event',
                text,
                // 失败回合的琥珀警示（主 scrollback 同款 warning accent）。
                ...(warning ? { warning } : {}),
              }
            })()
      return subagentViewPush(sealed, marker)
    }
    default:
      return items
  }
}

/**
 * lite 投影下迷你视图工具行的补全坐标：msgSeq = 产生该行的首条信封行号，
 * msgSeqEnd = 本页最后一条碰到它的信封行号，liteOmitted = 本页为它裁掉的
 * 字节。live 事件不带 msgSeq（也没有 lite 标记）→ 不参与补全。
 */
function stampLiteSeq(
  item: Extract<ScrollEntry, { kind: 'tool' }>,
  ev: Extract<AcpEvent, { type: 'tool_call' } | { type: 'tool_call_update' }>,
  prev?: Extract<ScrollEntry, { kind: 'tool' }>,
): Extract<ScrollEntry, { kind: 'tool' }> {
  const tc: unknown =
    ev.type === 'tool_call'
      ? ev.toolCall
      : ev.type === 'tool_call_update'
        ? ev.toolCallUpdate
        : undefined
  const lite = liteMark(tc)
  const seq = ev.msgSeq
  const msgSeq = item.msgSeq ?? prev?.msgSeq ?? seq
  const end = prev?.msgSeqEnd
  const msgSeqEnd = seq != null && (end == null || seq > end) ? seq : end
  const omitted = (prev?.liteOmitted ?? 0) + (lite ? lite.omitted : 0)
  return {
    ...item,
    ...(msgSeq != null ? { msgSeq } : {}),
    ...(msgSeqEnd != null ? { msgSeqEnd } : {}),
    ...(omitted > 0 ? { liteOmitted: omitted } : {}),
  }
}

/** 从 ToolCall 构造主 scrollback 同款的 tool 条目（title/verb/status/raw，
 *  与 handleEvent 的 tool_call / tool_call_update 分支同构）。 */
export function subagentToolItem(
  tc: ToolCall,
  prev?: Extract<ScrollEntry, { kind: 'tool' }>,
): Extract<ScrollEntry, { kind: 'tool' }> {
  const status = (tc.status as string) || prev?.status || 'pending'
  // 与主 scrollback 同款优先序：_meta["x.ai/tool"].kind 权威，再顶层
  // kind（agent 的 todo/plan update 顶层带赝品 kind:"think"，顶层优先
  // 会把 todo 行渲染成 "Thought"——_meta 恒为 plan）。
  const kindName = toolKindName(tc, prev?.kindName)
  const running = status === 'pending' || status === 'in_progress'
  return {
    id: prev?.id ?? nid(),
    kind: 'tool',
    toolCallId: toolCallIdOf(tc) ?? prev?.toolCallId,
    // 主 scrollback 同款取值：终态 update 的 title 是空串，直接取会把
    // 已有的 "Read `path`" 洗成 kindName —— 空标题回退到上一版标题。
    title: extractTarget(tc) || (tc.title as string) || prev?.title || kindName,
    verb: toolVerb(kindName, running),
    status,
    kindName,
    expanded: prev
      ? isEditToolKind(kindName) && !isEditToolKind(prev.kindName)
        ? !collapsedEditBlocks()
        : prev.expanded
      : isEditToolKind(kindName) && !collapsedEditBlocks(),
    raw: tc,
    // 活动起点（epoch ms）——主 scrollback 相位计时器同款；运行中才打。
    ...(running && !prev ? { startedAt: Date.now() } : {}),
  }
}
