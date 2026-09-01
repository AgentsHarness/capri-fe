import type { AcpEvent, ScrollEntry, ToolCall } from '../../../api/types'
import type { ChatState, SetState } from '../types'
import { nid } from '../ids'
import {
  collapsedEditBlocks,
} from '../modeFlags'
import { isEditToolKind } from '../../../theme/toolFamily'
import { planTodos, toolVerb } from '../format'
import {
  absorbBashOutputIntoBgTask,
  absorbTaskOutputIntoBgTask,
  extractTarget,
  isOrphanBashStreamUpdate,
  resolveAnonToolUpdate,
  shouldSuppressToolFromScrollback,
  suppressedToolIds,
  toolCallIdOf,
  toolKindName,
} from '../tools'
import {
  sealAssistantStream,
  sealThought,
} from '../stream'
import {
  busyPlausibleForView,
} from '../turn'
import { claimPendingToolHooks } from '../hookAttach'
import { hookRoutingOf } from '../hookRouting'
/**
 * Route a tool_call_update that carries no toolCallId.
 *
 * Some OpenAI/responses-compatible gateways omit call_id on function calls
 * and the agent relays that blank key verbatim, so nothing can be looked up
 * in toolIndex — dropping these updates left the row at "Running" until the
 * turn-end settle (a 6-minute agentic turn showed every command block
 * spinning the whole time). Claim an unclaimed anonymous row instead;
 * resolveAnonToolUpdate (tools.ts) decides which row and whether its raw
 * may be merged — the subagent view runs the same rule.
 */
function applyAnonToolUpdate(
  set: SetState,
  get: () => ChatState,
  tc: ToolCall,
): void {
  const target = resolveAnonToolUpdate(get().entries, tc)
  if (!target) return
  const { entryId, exact, terminal, applyRaw } = target
  const existing = get().entries.find((e) => e.id === entryId)
  if (existing?.kind !== 'tool') return
  const status = typeof tc.status === 'string' ? tc.status : ''
  if (!exact && !terminal) return
  // 合并而不是替换：富更新（rawOutput/content）不带 title/rawInput，整体
  // 替换会让行头读不到路径（readPathOf 只认 raw.rawInput），标题丢文件名。
  const merged: ToolCall = applyRaw ? { ...(existing.raw || {}), ...tc } : tc
  if (
    applyRaw &&
    (shouldSuppressToolFromScrollback(merged) || isOrphanBashStreamUpdate(merged))
  ) {
    // Late classification (is_background / TaskOutput only in this update):
    // the log belongs on the bg_task row. A blank id cannot enter
    // suppressedToolIds, but removing the entry takes it out of the claim
    // candidates, so later updates route elsewhere on their own.
    set({ entries: get().entries.filter((e) => e.id !== entryId) })
    absorbTaskOutputIntoBgTask(get, set, merged)
    absorbBashOutputIntoBgTask(get, set, merged)
    return
  }
  const nextStatus = status || existing.status
  const running = nextStatus === 'pending' || nextStatus === 'in_progress'
  const kindName = toolKindName(merged, existing.kindName)
  set({
    // A running tool settling opens the wait-for-next-token window (TUI
    // Waiting(Model)) — same cue as the id-routed path.
    ...(terminal ? { statusText: 'Waiting for response…' } : {}),
    entries: get().entries.map((e) =>
      e.id !== entryId || e.kind !== 'tool'
        ? e
        : {
            ...e,
            status: nextStatus,
            verb: toolVerb(applyRaw ? kindName : e.kindName, running),
            ...(applyRaw
              ? {
                  raw: merged,
                  kindName,
                  title: extractTarget(merged) || e.title,
                }
              : {}),
            ...(terminal ? { finishedAt: Date.now() } : {}),
          },
    ),
  })
}

export function handleToolEvent(
  set: SetState,
  get: () => ChatState,
  ev: AcpEvent,
): boolean {
  switch (ev.type) {
      case 'tool_call': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Seal assistant stream (liveStream → entry + streaming:false) so
        // the streaming flag drops immediately; then seal
        // any open thought. Do not leave assistant streaming:true until
        // turn-end settleTurnEntries.
        const sealedAsst = sealAssistantStream(get())
        const sealed = sealThought(sealedAsst)
        const tc = ev.toolCall || {}
        const toolCallId = toolCallIdOf(tc)
        // TUI: bg-task plumbing / background execute / task-spawn / todo /
        // goal / scheduler / workflow never become tool rows — their UI
        // lives on BgTask / Subagent / chips. Otherwise get_*_output dumps
        // appear as "Ran other" with the full task log in scrollback.
        if (toolCallId && suppressedToolIds.has(toolCallId)) {
          absorbTaskOutputIntoBgTask(get, set, tc)
          break
        }
        if (shouldSuppressToolFromScrollback(tc)) {
          if (toolCallId) suppressedToolIds.add(toolCallId)
          absorbTaskOutputIntoBgTask(get, set, tc)
          // Still seal thought so the next real row doesn't sit under an
          // open Thinking… shell (TUI finish_thinking on tool start).
          set({
            ...sealed,
            openAssistantId: undefined,
            openThoughtId: undefined,
            currentStreamStartMs: undefined,
          })
          break
        }
        const status = (tc.status as string) || 'pending'
        const kindName = toolKindName(tc, undefined)
        const running = status === 'pending' || status === 'in_progress'
        const title = extractTarget(tc) || (tc.title as string) || kindName
        const id = nid()

        // 回放分页边界：该 call 的 rich update 先于 tool_call 到达并已按
        // 「未知 id 当作新行」建过行（loadHistory 新页先回放、loadMoreHistory
        // 旧页后回放时，调用与结果可能被拆到两次抓取）——此时再无条件新建
        // 一行，会把同一 call 渲染成「有内容 + 无内容」两条（旧页行只有
        // tool_call/元数据、没有 rawOutput）。id 已知且已有行 → 按 update
        // 合并语义并入既有行（保留先到 update 的 rawOutput，补齐标题等）。
        if (toolCallId && get().toolIndex[toolCallId]) {
          const existingId = get().toolIndex[toolCallId]
          const plug = get().entries.find((e) => e.id === existingId)
          if (plug?.kind === 'tool') {
            // 合并编辑行（collapsed_edit_blocks）：子调用走 update 槽位
            // 语义（mergedRaws 保持行自己的首个调用在 raw 上）。
            if (plug.mergedRaws?.length) {
              get().handleEvent({ type: 'tool_call_update', toolCallUpdate: tc } as AcpEvent)
              break
            }
            const merged: ToolCall = { ...(plug.raw || {}), ...tc }
            const status = (tc.status as string) || plug.status
            const kindName = toolKindName(merged, plug.kindName)
            const running = status === 'pending' || status === 'in_progress'
            set({
              ...sealed,
              conn: 'busy',
              awaitingNext: false,
              openAssistantId: undefined,
              openThoughtId: undefined,
              currentStreamStartMs: undefined,
              toolIndex: { ...get().toolIndex },
              entries: get().entries.map((e) =>
                e.kind === 'tool' && e.id === existingId
                  ? {
                      ...e,
                      status,
                      kindName,
                      verb: toolVerb(kindName, running),
                      title: extractTarget(merged) || e.title,
                      raw: merged,
                    }
                  : e,
              ),
            })
            break
          }
        }

        // TUI [ui] collapsed_edit_blocks=true: edits render as one-line
        // +N/-M diffstats (collapsed) and back-to-back same-file edits
        // merge into one row (default false = diffs expanded, no merge).
        if (isEditToolKind(kindName) && collapsedEditBlocks()) {
          const prev = sealed.entries[sealed.entries.length - 1]
          if (
            prev &&
            prev.kind === 'tool' &&
            isEditToolKind(prev.kindName) &&
            prev.title === title
          ) {
            const toolIndex = { ...get().toolIndex }
            // Route the new call's updates into the merged row.
            if (toolCallId) toolIndex[toolCallId] = prev.id
            const mergedEntry: ScrollEntry = {
              ...prev,
              mergedRaws: [...(prev.mergedRaws ?? []), tc],
              status,
              verb: toolVerb(kindName, running),
            }
            // Same claim rule as a fresh row: a queued pre_tool_use batch for
            // this file's edit belongs to the merged row.
            const claimed = claimPendingToolHooks(
              [...sealed.entries.slice(0, -1), mergedEntry],
              mergedEntry,
              hookRoutingOf(get()).pendingToolHooks,
            )
            set({
              ...sealed,
              conn: 'busy',
              awaitingNext: false,
              openAssistantId: undefined,
              openThoughtId: undefined,
              currentStreamStartMs: undefined,
              toolIndex,
              entries: claimed.entries,
              pendingToolHooks: claimed.pending,
            })
            break
          }
        }

        const entry: ScrollEntry = {
          id,
          kind: 'tool',
          toolCallId,
          title,
          verb: toolVerb(kindName, running),
          status,
          kindName,
          detail: tc.title as string | undefined,
          // collapsed_edit_blocks=false (default): edit diffs expanded.
          expanded: isEditToolKind(kindName) && !collapsedEditBlocks(),
          raw: tc,
          // Activity start for the turn status line's phase timer (TUI
          // tracker started_at); replay/completed snapshots omit it.
          ...(running ? { startedAt: Date.now() } : {}),
        }
        const toolIndex = { ...get().toolIndex }
        if (toolCallId) toolIndex[toolCallId] = id
        // A pre_tool_use batch is announced before this row existed — the row
        // claims whatever the queue holds for its function name now.
        const claimed = claimPendingToolHooks(
          [...sealed.entries, entry],
          entry,
          hookRoutingOf(get()).pendingToolHooks,
        )
        set({
          ...sealed,
          // 回合确实在跑（envelope 归属的 tool_call 可信）：busy 事件可能
          // 被 host 错标/缺省而没点亮状态行——工具先行回合（无 thought/
          // chunk 前置）在这里补上 busy，turn-status 行才能显示工具活动。
          // 回放路径同样适用（回放 chunk 本就驱动 conn busy，load 页末
          // 统一复位 ready）。
          conn: 'busy',
          awaitingNext: false,
          openAssistantId: undefined,
          openThoughtId: undefined,
          currentStreamStartMs: undefined,
          toolIndex,
          entries: claimed.entries,
          pendingToolHooks: claimed.pending,
        })
        break
      }
      case 'tool_call_update': {
        // 多会话广播（host withSid 约定）：非当前会话忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        const tc = ev.toolCallUpdate || {}
        const toolCallId = toolCallIdOf(tc)
        if (!toolCallId) {
          applyAnonToolUpdate(set, get, tc)
          break
        }
        if (suppressedToolIds.has(toolCallId)) {
          // Final TaskOutput / Bash stream — fold log into bg_task.
          absorbTaskOutputIntoBgTask(get, set, tc)
          absorbBashOutputIntoBgTask(get, set, tc)
          break
        }
        const entryId = get().toolIndex[toolCallId]
        // Late classification: raw_input arrives on update (is_background,
        // variant=TaskOutput, …). Demote any flash row and suppress further
        // updates — stdout belongs on the bg_task block (dblclick viewer).
        if (entryId) {
          const existing = get().entries.find((e) => e.id === entryId)
          const merged: ToolCall =
            existing?.kind === 'tool'
              ? { ...(existing.raw || {}), ...tc }
              : tc
          if (
            shouldSuppressToolFromScrollback(merged) ||
            isOrphanBashStreamUpdate(merged)
          ) {
            suppressedToolIds.add(toolCallId)
            const { [toolCallId]: _drop, ...toolIndex } = get().toolIndex
            set({
              toolIndex,
              entries: get().entries.filter((e) => e.id !== entryId),
            })
            absorbTaskOutputIntoBgTask(get, set, merged)
            absorbBashOutputIntoBgTask(get, set, merged)
            break
          }
        } else if (
          shouldSuppressToolFromScrollback(tc) ||
          isOrphanBashStreamUpdate(tc)
        ) {
          // Page-boundary orphan: history tail is pure Bash stream deltas
          // for a backgrounded execute whose tool_call lived on an earlier
          // page ("start acpfe" last-100 = vite/host logs as "Ran other").
          suppressedToolIds.add(toolCallId)
          absorbTaskOutputIntoBgTask(get, set, tc)
          absorbBashOutputIntoBgTask(get, set, tc)
          break
        }
        if (!entryId) {
          // treat as new
          get().handleEvent({ type: 'tool_call', toolCall: tc })
          break
        }
        // A running tool settling is a wait-for-next-token window (TUI
        // Waiting(Model) between tool completion and the next inference
        // stream) — the status line reads "Waiting for response…" until
        // the next streamed event.
        const existing = get().entries.find((e) => e.id === entryId)
        const wasRunningBefore =
          existing?.kind === 'tool' &&
          (existing.status === 'pending' || existing.status === 'in_progress')
        const settledNow =
          wasRunningBefore &&
          (tc.status === 'completed' || tc.status === 'failed')
        set({
          ...(settledNow ? { statusText: 'Waiting for response…' } : {}),
          entries: get().entries.map((e) => {
            if (e.id !== entryId || e.kind !== 'tool') return e
            // TUI collapsed_edit_blocks merged row: an update for a
            // merged sub-call patches that slot — raw stays the row's own
            // first call, mergedRaws keep the others (display order).
            const mergedIdx =
              e.mergedRaws?.findIndex((m) => toolCallIdOf(m) === toolCallId) ??
              -1
            if (mergedIdx >= 0) {
              const mergedRaws = [...(e.mergedRaws ?? [])]
              mergedRaws[mergedIdx] = { ...mergedRaws[mergedIdx], ...tc }
              const status = (tc.status as string) || e.status
              const kindName = toolKindName(tc, e.kindName)
              const running = status === 'pending' || status === 'in_progress'
              const finishedAt =
                wasRunningBefore && !running ? Date.now() : e.finishedAt
              return {
                ...e,
                status,
                kindName,
                verb: toolVerb(kindName, running),
                mergedRaws,
                finishedAt,
              }
            }
            const merged: ToolCall = { ...(e.raw || {}), ...tc }
            const status = (merged.status as string) || e.status
            const kindName = toolKindName(merged, e.kindName)
            const running = status === 'pending' || status === 'in_progress'
            const wasRunning =
              e.status === 'pending' || e.status === 'in_progress'
            // Finish flash: stamp finishedAt when a running tool settles
            const finishedAt =
              wasRunning && !running ? Date.now() : e.finishedAt
            // TUI replace_tool_block: Other → Edit rematerializes to the
            // collapsed_edit_blocks default. Already-Edit keeps the
            // current fold (user gesture).
            const becameEdit =
              isEditToolKind(kindName) && !isEditToolKind(e.kindName)
            return {
              ...e,
              status,
              kindName,
              verb: toolVerb(kindName, running),
              title: extractTarget(merged) || e.title,
              raw: merged,
              finishedAt,
              ...(becameEdit
                ? { expanded: !collapsedEditBlocks() }
                : {}),
            }
          }),
        })
        break
      }
      case 'plan': {
        // 多会话广播（host withSid 约定）：非当前会话忽略（后台回合的
        // plan 不能覆盖当前会话的 todo 面板）。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // Plan updates are the todo source (TUI todo pane + status-bar
        // badge). Matches the TUI: plan entries never land in the
        // scrollback — the TopBar TodoChip is the single display surface.
        const { items, counts } = planTodos(ev.entries)
        const planFlag = (ev as unknown as { planMode?: unknown }).planMode
        // Plan can arrive mid-stream: seal assistant (merge live text +
        // streaming:false) before the openAssistantId pointer drops.
        const sealedAsst = sealAssistantStream(get())
        set({
          ...sealedAsst,
          currentStreamStartMs: undefined,
          todoCounts: counts,
          todos: items,
          // Some hosts piggyback the plan-mode flag on the plan event —
          // apply it when present, otherwise keep the local value.
          ...(typeof planFlag === 'boolean' ? { planMode: planFlag } : {}),
        })
        break
      }
      case 'gen_rate': {
        // 多会话广播（host withSid 约定）：非当前会话的 gen_rate 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 同 busy 防线：gen_rate 由 host 合成，sid 可能错标或缺省（见
        // 模块头 sessionIdFrom 注释）——别的会话的生成速率不能显示在
        // 本会话的状态行上。只有当前视图确实在跑回合才接受；回放不
        // 派发 gen_rate，无需豁免。
        if (!busyPlausibleForView(get())) break
        // 生成输出速率（字符/秒）由 host 推送：只在输出过程中显示。
        // 流式期间 ≥250ms 一条 live 值（active:true + rate）；输出结束
        // （工具执行 / 回合终态）host 广播 active:false 且不带 rate——
        // 清除显示，不做回合末冻结（冻结值在数学上系统性高估，见
        // host genrate.go 顶部注释）；user_message_chunk 时 host 静默
        // 复位不发事件（FE 在 send 时清空）。
        if (ev.active === false) {
          set({ genRate: undefined })
          break
        }
        if (ev.rate == null) break
        set({ genRate: ev.rate })
        break
      }
      case 'usage':
        // 多会话广播（host withSid 约定）：非当前会话的 usage 直接忽略。
        if (ev.sessionId && ev.sessionId !== get().sessionId) break
        // 同 busy 防线（错标/缺省 sid 的 usage 会把别的会话的 token 数
        // 画在已完成会话的 context chip 上）：当前视图没有 live 回合时
        // 不接受。回放（loadHistory / loadMoreHistory）的 usage 无 sid 且
        // 属于正在加载的会话本身，照常应用（历史页只在新页应用 usage）。
        if (
          !get().historyLoading &&
          !get().historyLoadingMore &&
          !busyPlausibleForView(get())
        ) {
          break
        }
        // Merge, don't overwrite: streamed session/update usage events
        // carry only `used`/`size` (no usage object) and must not clobber
        // the context-window `used`.
        set((s) => ({
          usage: {
            used: ev.used ?? s.usage?.used,
            size: ev.size ?? s.usage?.size,
          },
        }))
        break
    default:
      return false
  }
  return true
}
