import type {
  AcpEvent,
  ScrollEntry,
  SubagentViewState,
  ToolCall,
} from '../../api/types'
import type { SetState } from './types'
import { nid } from './ids'
import { formatElapsed, imageSrc, toolVerb } from './format'
import { extractTarget, toolCallIdOf } from './tools'

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
        elapsed:
          it.startedAt != null ? formatElapsed(Date.now() - it.startedAt) : it.elapsed,
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
    const items = subagentViewAppend(prev?.items ?? [], ev)
    const view: SubagentViewState = { ...(prev ?? { items: [], fetchState: 'idle' }), items }
    if (prev && prev.items === items) return {}
    return { subagentViews: { ...s.subagentViews, [childSid]: view } }
  })
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
        next[next.length - 1] = { ...last, text: last.text + text, streaming: true }
        return next
      }
      // 新思考段：先收口前面挂着的流（多段思考/回放防御），再开新条目。
      return subagentViewPush(sealSubagentStreaming(items), {
        id: nid(),
        kind: 'thought',
        text,
        streaming: true,
        displayMode: 'expanded',
        startedAt: Date.now(),
      })
    }
    case 'tool_call': {
      // 工具开始 = 思考/回答段即时收口（TUI finish_thinking on tool
      // start，主 scrollback tool_call 分支 sealThought 同款）——否则
      // 运行中的每段 thinking 都挂着 "Thinking…" 直到回合终态。
      const sealed = sealSubagentStreaming(items)
      const tc = ev.toolCall || {}
      const item = subagentToolItem(tc)
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
      if (toolCallId) {
        const idx = sealed.findIndex(
          (it) => it.kind === 'tool' && it.toolCallId === toolCallId,
        )
        if (idx >= 0) {
          const existing = sealed[idx]
          if (existing.kind === 'tool') {
            // 与主 scrollback 相同：update 的字段合并进 raw，标题/动词重算。
            const merged: ToolCall = { ...(existing.raw || {}), ...tc }
            const next = [...sealed]
            next[idx] = subagentToolItem(merged, existing)
            return next
          }
        }
      }
      // 未找到对应条目（回放分页边界）：按首次 tool_call 追加。
      return subagentViewAppend(sealed, { type: 'tool_call', toolCall: tc })
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
      // settleTurnEntries 一致：折叠 + 本地 elapsed），追加回合结束标记——
      // 主 scrollback 同款：turn 标记用 session_event 条目。
      const sealed = sealSubagentStreaming(items)
      const marker: ScrollEntry = {
        id: nid(),
        kind: 'session_event',
        text:
          ev.type === 'done'
            ? '— turn completed —'
            : ev.type === 'cancelled'
              ? '— turn cancelled —'
              : '— turn ended —',
      }
      return subagentViewPush(sealed, marker)
    }
    default:
      return items
  }
}

/** 从 ToolCall 构造主 scrollback 同款的 tool 条目（title/verb/status/raw，
 *  与 handleEvent 的 tool_call / tool_call_update 分支同构）。 */
export function subagentToolItem(
  tc: ToolCall,
  prev?: Extract<ScrollEntry, { kind: 'tool' }>,
): Extract<ScrollEntry, { kind: 'tool' }> {
  const status = (tc.status as string) || prev?.status || 'pending'
  const kindName = (tc.kind as string) || prev?.kindName || 'other'
  const running = status === 'pending' || status === 'in_progress'
  return {
    id: prev?.id ?? nid(),
    kind: 'tool',
    toolCallId: toolCallIdOf(tc) ?? prev?.toolCallId,
    title: extractTarget(tc) || (tc.title as string) || kindName,
    verb: toolVerb(kindName, running),
    status,
    kindName,
    expanded: false,
    raw: tc,
    // 活动起点（epoch ms）——主 scrollback 相位计时器同款；运行中才打。
    ...(running && !prev ? { startedAt: Date.now() } : {}),
  }
}
