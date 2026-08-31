import { memo, useEffect, useRef, useState } from 'react'
import type { ScrollEntry } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { accentOpts } from '../../scrollback/accentOpts'
import { entryFlashActive, entryFoldable, expandableGlyph } from '../../scrollback/entryState'
import { hookGroupsHaveContent } from '../../scrollback/hookRuns'
import { mergeLiveText } from '../../scrollback/liveText'
import { resolveBullet } from '../../theme/accents'
import { DENSE_ROW_CLASS, HEADER_ROW_CLASS } from '../../theme/layout'
import type { EntryChrome, EntryViewProps } from './chrome'
import { AssistantEntry } from './kinds/AssistantEntry'
import {
  BtwEntry,
  CreditLimitEntry,
  ErrorEntry,
  GroupHeaderEntry,
  ImageEntry,
  LifecycleEntry,
  PlanEntry,
  SessionEventEntry,
  StatusEntry,
} from './kinds/MiscEntries'
import { BgTaskEntry, SubagentEntry, WorkflowEntry } from './kinds/TaskEntries'
import { ThoughtEntry } from './kinds/ThoughtEntry'
import { ToolEntry } from './kinds/ToolEntry'
import { UserEntry } from './kinds/UserEntry'

export type { EntryViewActions, EntryViewProps } from './chrome'

/**
 * Memo comparator: entries only re-render when their own data changes;
 * `now` clock ticks are ignored unless the entry is mid finish-flash
 * (the tick that expires the flash still re-renders via the prev check).
 */
function entryViewEqual(prev: EntryViewProps, next: EntryViewProps): boolean {
  return (
    prev.e === next.e &&
    prev.selected === next.selected &&
    prev.pendingFreeze === next.pendingFreeze &&
    prev.dense === next.dense &&
    prev.denseNext === next.denseNext &&
    prev.densePrev === next.densePrev &&
    prev.inGroup === next.inGroup &&
    // actions 由调用方保证稳定（主 scrollback 不传 → undefined 恒等；
    // mini 用 useMemo/useState setter 构造 → 引用稳定）。patch 同理。
    prev.actions === next.actions &&
    prev.patch === next.patch &&
    prev.streamBodyRef === next.streamBodyRef &&
    (prev.now === next.now ||
      (!entryFlashActive(prev.e, prev.now) && !entryFlashActive(next.e, next.now)))
  )
}

export const EntryView = memo(function EntryView({
  e: eProp,
  selected,
  pendingFreeze,
  now,
  dense = false,
  denseNext = false,
  densePrev = false,
  inGroup = false,
  actions,
  patch,
  streamBodyRef,
}: EntryViewProps) {
  // 迷你 scrollback 折叠覆盖：patch 合并进渲染条目（不写回 store）。
  const e = patch ? ({ ...eProp, ...patch } as ScrollEntry) : eProp
  // Live-stream delta/suffix for THIS entry only. Parent Scrollback does
  // not select liveStream — each row subscribes itself so chunk growth
  // re-renders only the streaming EntryView (selector returns undefined
  // for every other row → Object.is skip). Mini timelines without a
  // matching liveStream id also get undefined.
  // liveText is the store buffer only (not including e.text); display
  // always uses mergeLiveText(e.text, liveText) — additive.
  const liveText = useChatStore((s) =>
    s.liveStream?.entryId === eProp.id ? s.liveStream.text : undefined,
  )
  // 迷你 scrollback 局部动作覆盖（缺省主 store 动作——行为不变）。
  const storeToggleTool = useChatStore((s) => s.toggleTool)
  const storeToggleThought = useChatStore((s) => s.toggleThought)
  const storeToggleUser = useChatStore((s) => s.toggleUser)
  const storeToggleBtw = useChatStore((s) => s.toggleBtw)
  const storeToggleLifecycle = useChatStore((s) => s.toggleLifecycle)
  const storeToggleSessionEvent = useChatStore((s) => s.toggleSessionEvent)
  const storeOpenViewer = useChatStore((s) => s.openViewer)
  const storeSelectEntry = useChatStore((s) => s.selectEntry)
  const cancelSubagent = useChatStore((s) => s.cancelSubagent)
  const killTask = useChatStore((s) => s.killTask)
  // 工具行路径打印基准目录（TUI path_for_tool_surface 的 cwd）。
  const sessionCwd = useChatStore((s) => s.historyCwd ?? s.cwd)
  const toggleTool = actions?.toggleTool ?? storeToggleTool
  const toggleThought = actions?.toggleThought ?? storeToggleThought
  const toggleUser = actions?.toggleUser ?? storeToggleUser
  const toggleBtw = actions?.toggleBtw ?? storeToggleBtw
  const toggleLifecycle = actions?.toggleLifecycle ?? storeToggleLifecycle
  const toggleSessionEvent = actions?.toggleSessionEvent ?? storeToggleSessionEvent
  const openViewer = actions?.openViewer ?? storeOpenViewer
  const selectEntry = actions?.selectEntry ?? storeSelectEntry
  const onSelect = () => selectEntry(e.id)
  // 整块单击折叠：标题行以外的正文/留白同样生效。「查看」是独立 button，
  // 不走这条路径。流式思考 / 无可折叠正文的 kind 不挂 onFold（点击只选中）。
  const foldAction = !entryFoldable(e)
    ? undefined
    : e.kind === 'tool'
      ? () => toggleTool(e.id)
      : e.kind === 'thought'
        ? () => toggleThought(e.id)
        : e.kind === 'user'
          ? () => toggleUser(e.id)
          : e.kind === 'btw'
            ? () => toggleBtw(e.id)
            : e.kind === 'lifecycle'
              ? () => toggleLifecycle(e.id)
              : e.kind === 'session_event' && hookGroupsHaveContent(e.stopHooks)
                ? () => toggleSessionEvent(e.id)
                : undefined
  const [hovered, setHovered] = useState(false)
  const opts = accentOpts(e, selected, pendingFreeze, now, hovered)
  const bullet = resolveBullet(opts)
  // › on selected OR hover pre-select when collapsed foldable
  const caret = expandableGlyph(e, selected || hovered)
  const bulletGlyph = caret ?? undefined

  // Thought body preview: cap at 4 lines (max-h 6.5em == 4 lines @
  // leading-relaxed), overflow clipped — no internal scroll (the full
  // text lives in the viewer).
  const localBodyRef = useRef<HTMLDivElement>(null)
  const bodyRef = streamBodyRef ?? localBodyRef
  const thoughtStreaming = e.kind === 'thought' ? e.streaming : false
  // Additive: base entry text + liveStream delta (see mergeLiveText).
  const thoughtText =
    e.kind === 'thought' ? mergeLiveText(e.text, liveText) : undefined
  // 流式期间把思考 body 元素注册给父组件（父 effect 每帧固定一次；
  // 收口/卸载时父组件读到 null 即停止固定）。
  useEffect(() => {
    if (!streamBodyRef) return
    streamBodyRef.current = thoughtStreaming ? bodyRef.current : null
  }, [streamBodyRef, thoughtStreaming, e.id, bodyRef])
  const shell = {
    e,
    selected,
    hovered,
    onHover: setHovered,
    onSelect,
    pendingFreeze,
    now,
    dense,
    denseNext,
    densePrev,
    inGroup,
    onFold: foldAction,
  }
  // One-line tool/thought chrome: center bullet with text (not baseline — ⌄/◆).
  // Icon col pins text-[13px] so em-box is stable across user/tool rows.
  // TUI has_vpad=false for dense tool rows.
  const rowBtn = dense ? DENSE_ROW_CLASS : HEADER_ROW_CLASS

  const chrome: EntryChrome = {
    shell,
    bullet,
    caret,
    bulletGlyph,
    rowBtn,
    openViewer,
    toggleTool,
    toggleThought,
    toggleUser,
    toggleBtw,
    cancelSubagent,
    killTask,
    liveText,
    thoughtText,
    bodyRef,
    inMini: actions != null,
    cwd: sessionCwd,
  }

  if (e.kind === 'user') return <UserEntry e={e} chrome={chrome} />
  if (e.kind === 'assistant') return <AssistantEntry e={e} chrome={chrome} />
  if (e.kind === 'image') return <ImageEntry e={e} chrome={chrome} />
  if (e.kind === 'thought') return <ThoughtEntry e={e} chrome={chrome} />
  if (e.kind === 'tool') return <ToolEntry e={e} chrome={chrome} />
  if (e.kind === 'error') return <ErrorEntry e={e} chrome={chrome} />
  if (e.kind === 'status') return <StatusEntry e={e} />
  if (e.kind === 'plan') return <PlanEntry e={e} chrome={chrome} />
  if (e.kind === 'subagent') return <SubagentEntry e={e} chrome={chrome} />
  if (e.kind === 'workflow') return <WorkflowEntry e={e} chrome={chrome} />
  if (e.kind === 'bg_task') return <BgTaskEntry e={e} chrome={chrome} />
  if (e.kind === 'session_event') return <SessionEventEntry e={e} chrome={chrome} />
  if (e.kind === 'lifecycle') return <LifecycleEntry e={e} chrome={chrome} />
  if (e.kind === 'credit_limit') return <CreditLimitEntry e={e} chrome={chrome} />
  if (e.kind === 'btw') return <BtwEntry e={e} chrome={chrome} />
  if (e.kind === 'group_header') return <GroupHeaderEntry e={e} chrome={chrome} />
  return null
}, entryViewEqual)
