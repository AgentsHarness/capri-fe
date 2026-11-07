import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import type { ScrollEntry } from '../../api/types'
import { useFePrefs } from '../../store/historyPins'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { Glyphs } from '../../theme/glyphs'
import { useDisplayRows } from '../scrollback/useDisplayRows'
import { useEnteringEntries } from '../scrollback/useEnteringEntries'
import { useJunctionDissolve } from '../scrollback/useJunctionDissolve'
import { EntryView } from '../scrollback/EntryView'
import { GroupHeaderView } from '../scrollback/GroupHeaderView'
import type { EntryViewActions } from '../scrollback/chrome'
import { fallbackStickyBandH, pickStickyPin } from '../../scrollback/stickyPin'
import { USER_COLLAPSED_MAX_LINES, collapseUserText } from '../../scrollback/userText'
import { displayRowKey, isDensePackableRow, spanContaining } from '../../scrollback/verbGroup'
import { toolDisplayMode } from '../../scrollback/entryState'
import {
  COLUMN_PAD_X_CLASS,
  CONTENT_COLUMN_CLASS,
  ICON_COL_INSET_PX,
} from '../../theme/layout'
import { BlockBodyDialog } from './BlockBodyDialog'

const MINI_VIEWABLE_KINDS = new Set([
  'tool',
  'thought',
  'user',
  'assistant',
  'error',
  'plan',
  'image',
  'btw',
  'bg_task',
  'subagent',
])


export function SubagentView({
  entry,
  now,
}: {
  entry: Extract<ScrollEntry, { kind: 'subagent' }>
  now: number
}) {
  const subagentViews = useChatStore((s) => s.subagentViews)
  // 迷你 scrollback 按 child_session_id 取数（宿主转发的子代理会话事件流）。
  const childSid = entry.childSessionId
  const view = childSid ? subagentViews[childSid] : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      {entry.error && (
        <div
          className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} shrink-0 pt-2.5`}
        >
          <div className="rounded border border-gn-red/40 bg-gn-diff-del-bg px-2.5 py-1.5 font-mono text-[12px] text-gn-red">
            {entry.error}
          </div>
        </div>
      )}

      {/* 活动时间线占满剩余区域（flex-1 自行滚动）。 */}
      {childSid && (
        <SubagentTimeline
          childSid={childSid}
          items={view?.items ?? []}
          running={!!entry.running}
          now={now}
          prompt={entry.title && entry.title !== entry.subagentId ? entry.title : ''}
        />
      )}

      {/* 子代理 composer 暂不渲染（组件本体保留在下方 SubagentComposer，
          供 agent 侧支持后直接接回）。原因：它走 x.ai/subagent/message，
          该方法被 Feature::ActiveAgentMessages 门控（agent 侧
          extensions/subagent_message.rs，默认 active_agent_messages =
          false），不进注册表，调用必然返回 Method not found；即便开启，
          它要的也是 coordinator 铸的不透明 agentAddress（aa1.<hex>），
          而非 subagentId / childSessionId（本地子代理两者同为一个
          UUIDv7），且 SubagentSpawned.agentAddress 被
          without_live_agent_address 在 SessionUpdate 序列化与落盘两处
          抹掉，客户端拿不到该地址。
          重开条件：1) agent 默认启用 active_agent_messages；
          2) 客户端能拿到子代理的 agent address（或改由 host 代持、提供
          按 subagentId 寻址的通道）。届时在此处渲染
          <SubagentComposer agentAddress={...} disabled={!entry.running} />，
          地址用那时可得的真实值。 */}
    </div>
  )
}

/**
 * 子代理的活动时间线（迷你 scrollback，TUI subagent_views 同款）。
 * 数据来自宿主转发的子代理会话事件流（live 捕获，store 侧
 * applySubagentViewEvent）或按需历史回放（fetchSubagentView）。
 * 打开时若视图为空（例如历史回放场景没有 live 捕获）会触发一次
 * 子代理会话 updates 拉取——动作内部有 loading/loaded 去重。
 *
 * 渲染直接复用主 scrollback 的体系（任务 1）：条目已是主模型 ScrollEntry，
 * 这里走同一条管线——useDisplayRows（scanGroups + projectDisplayRows）→ EntryView /
 * GroupHeaderView（内部即 EntryShell + AccentRail(resolveAccent) +
 * Bullet(resolveBullet)，accent 竖条/动词分组头/折叠展开/字体配色全部
 * 与主 scrollback 一致）。选中/折叠/双击全文弹窗用组件内局部状态
 * （expandedGroups/folds/viewerId 局部化），不接主 store 的
 * selectEntry/openViewer——mini 条目不在主 entries 里，主 viewer 找不到
 * 目标，双击用 BlockBodyDialog 在组件内弹同一套全文内容。
 */
function SubagentTimeline({
  childSid,
  items,
  running,
  now,
  prompt,
}: {
  childSid: string
  items: ScrollEntry[]
  running: boolean
  now: number
  prompt: string
}) {
  // 访客只读：迷你时间线里的 cancel / kill / fork 等写入口一并藏掉。
  const guest = useChatStore((s) => s.guestIdentity != null)
  const fetchSubagentView = useChatStore((s) => s.fetchSubagentView)
  const loadMoreSubagentView = useChatStore((s) => s.loadMoreSubagentView)
  const view = useChatStore((s) =>
    childSid ? s.subagentViews[childSid] : undefined,
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  // 迷你视图的折叠/选中全部局部化：主 scrollback 的 expandedGroups /
  // selectedId 不接（mini 条目不在主 entries 里）。
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // DOM 全量挂载 items（与主 scrollback 一致，无渲染窗口上限）。
  const renderItems = items
  const entryFadeIn = useFePrefs((s) => s.fePrefs.entryFadeIn)

  // 打开时若尚未回放过（idle），按 child_session_id 拉取该子代理会话的更新
  // 回放（TUI replay_inherited_updates 同款）。不看 items 是否为空——即使
  // live 已捕获到正在输出的 thinking，也以磁盘回放的完整历史为基线重建。
  useEffect(() => {
    if (view && view.fetchState !== 'loading' && view.fetchState !== 'loaded') {
      void fetchSubagentView(childSid)
    }
  }, [childSid, view, fetchSubagentView])

  // 上滑分页门控：仅回放填充的视图（loadedCount > 0）提供；宿主给了
  // totalCount 时严格比较，否则拉完一页即停。
  const loadedCount = view?.loadedCount ?? 0
  const hasMore =
    loadedCount > 0 &&
    (view?.totalCount != null ? loadedCount < view.totalCount : false)
  const loadingMore = view?.fetchState === 'loading' && items.length > 0

  // 内容不满视口（无滚动条）时自动补宿主历史——否则 onScroll 永远不触发。
  const autoFillStopped = useRef(false)
  useEffect(() => {
    autoFillStopped.current = false
  }, [childSid])
  useEffect(() => {
    if (autoFillStopped.current) return
    if (loadingMore) return
    const el = scrollRef.current
    if (!el || el.scrollHeight > el.clientHeight + 1) return
    if (!hasMore) return
    void loadMoreSubagentView(childSid).then((ok) => {
      autoFillStopped.current = !ok
    })
  }, [hasMore, loadingMore, renderItems, childSid, loadMoreSubagentView])

  // stick-to-bottom 跟随：与块查看弹窗正文共用 useStickToBottom——距底
  // 48px 内随内容增长钉尾，用户上滑立即让位，滑回尾部恢复。运行中的子代理
  // 打开即跟随；已结束的从顶部读起，除非用户自己滑到底。
  const {
    onScroll: measureFollow,
    pin: pinTimelineTail,
    isFollowing: timelineFollowsTail,
  } = useStickToBottom(scrollRef, {
    initialFollowing: running,
    resetKey: childSid,
  })
  // 流式条目的正文自滚交给外层容器统一滚底：mini 传一个恒空 ref
  // （streamBodyRef 存在即跳过 EntryView 的条目自滚），body 内上滑
  // 不会被"自滚拉回"。
  const miniStreamBodyRef = useRef<HTMLDivElement | null>(null)

  // ── TUI sticky prompt header（主 scrollback sticky.rs 同款）────────
  // Overlay-safe：钉最后一条完全越过顶的 user；下一条顶进 sticky 带则让路。
  // scrollTop === 0 不钉。
  const userById = useMemo(() => {
    const m = new Map<string, ScrollEntry>()
    for (const e of renderItems) if (e.kind === 'user') m.set(e.id, e)
    return m
  }, [renderItems])
  const userEls = useRef<Map<string, HTMLElement>>(new Map())
  const stickyBandElRef = useRef<HTMLDivElement | null>(null)
  const lastPushYRef = useRef(0)
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const updatePinned = useCallback(() => {
    const box = scrollRef.current
    const els = userEls.current
    if (!box || els.size === 0 || box.scrollTop <= 0) {
      lastPushYRef.current = 0
      if (stickyBandElRef.current) stickyBandElRef.current.style.transform = ''
      setPinnedId((prev) => (prev == null ? prev : null))
      return
    }
    const scrollTop = box.scrollTop
    const boxTop = box.getBoundingClientRect().top
    const stickyH =
      stickyBandElRef.current?.offsetHeight ||
      fallbackStickyBandH(7, 12.5)
    const list: { id: string; top: number; bottom: number }[] = []
    for (const [id, el] of els) {
      const top = el.getBoundingClientRect().top - boxTop + scrollTop
      list.push({ id, top, bottom: top + el.offsetHeight })
    }
    const pick = pickStickyPin(list, scrollTop, stickyH)
    lastPushYRef.current = pick.pushY
    if (stickyBandElRef.current) {
      stickyBandElRef.current.style.transform = pick.pushY
        ? `translateY(${pick.pushY}px)`
        : ''
    }
    setPinnedId((prev) => (prev === pick.id ? prev : pick.id))
  }, [])
  // 缓存 user 条目 DOM 元素；条目/折叠布局变化时重算钉选。
  useEffect(() => {
    const box = scrollRef.current
    const map = new Map<string, HTMLElement>()
    if (box) {
      for (const id of userById.keys()) {
        const el = box.querySelector(`[data-entry-id="${id}"]`)
        if (el instanceof HTMLElement) map.set(id, el)
      }
    }
    userEls.current = map
    updatePinned()
  }, [userById, updatePinned, folds])
  const pinnedUser = pinnedId ? (userById.get(pinnedId) ?? null) : null

  // 上滑到顶 → 加载更早的一页；加载前记住距底部距离，prepend 后恢复
  // 视口位置（内容插在顶部，距底距离不变 = 视觉位置稳定）。
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    measureFollow()
    updatePinned()
    if (el.scrollTop > 8 || loadingMore) return
    if (!hasMore) return
    const distFromBottom = el.scrollHeight - el.scrollTop
    void loadMoreSubagentView(childSid).then(() => {
      requestAnimationFrame(() => {
        const el2 = scrollRef.current
        if (el2) el2.scrollTop = el2.scrollHeight - distFromBottom
      })
    })
  }

  // items 变化时同步钉一次（ResizeObserver 回调晚一帧），异步撑高
  // （mermaid / 图片 / markdown 回流）由 useStickToBottom 的观察器兜住。
  // 流式思考的 4 行预览是 overflow:hidden——没有滚动条但可程序滚动，
  // 要显式钉到尾部才显示最新几行，EntryView 收口时会把该 ref 置空。
  useEffect(() => {
    pinTimelineTail()
    const bodyEl = miniStreamBodyRef.current
    if (bodyEl && timelineFollowsTail()) bodyEl.scrollTop = bodyEl.scrollHeight
  }, [running, items, pinTimelineTail, timelineFollowsTail])

  // 主 scrollback 同款分组管线，并跟随 tool_call_density 设置。
  // 只用渲染窗口内的条目（renderItems），DOM 保持扁平。
  const { rows, spans } = useDisplayRows(renderItems, expandedGroups)
  const enteringIds = useEnteringEntries(renderItems, {
    enabled: entryFadeIn && running,
    historyLoadedAt: view?.loadedStart,
    historyLoading: view?.fetchState === 'loading',
    historyLoadingMore: loadingMore,
  })
  const groupEnter = (span: { range: { start: number; end: number } }) => {
    for (let i = span.range.start; i < span.range.end; i++) {
      if (enteringIds.has(renderItems[i].id)) return true
    }
    return false
  }

  // 折叠覆盖（按条目 id）：工具/用户折叠与思考 displayMode 本地化——
  // 不写回 store，渲染时以 patch 合并进条目（EntryView 的 patch 语义）。
  // 思考块不默认折叠：流式思考展开正文、收口后折叠（与主 live scrollback
  // 完全一致）；用户点击只切换已收口思考的展开态。
  // 兜底：子代理已结束（running:false）但视图里仍有 streaming 思考条目
  // （回放分页截断 / 终态事件缺失）→ 展示为已收口（"Thought" + 折叠）。
  // patch 对象按 (id, kind, value, running, streaming) 缓存，保证引用
  // 稳定——EntryView 的 memo 比较（entryViewEqual 的 patch === patch）
  // 才不会失效。
  const foldPatchCache = useRef(new Map<string, Partial<ScrollEntry>>())
  const foldPatch = (e: ScrollEntry): Partial<ScrollEntry> | undefined => {
    const v = folds.get(e.id)
    // 未折叠过、也无已结束兜底需要 → 不 patch（走条目自身状态）。
    if (v == null && !(e.kind === 'thought' && !running && e.streaming)) {
      return undefined
    }
    const cache = foldPatchCache.current
    const key = `${e.id}:${e.kind}:${String(v)}:${String(running)}:${'streaming' in e ? String(e.streaming) : 'none'}`
    let p = cache.get(key)
    if (!p) {
      if (e.kind === 'thought') {
        p = {
          displayMode: v ? 'expanded' : 'collapsed',
          ...(!running && e.streaming ? { streaming: false } : {}),
        } as Partial<ScrollEntry>
        cache.set(key, p)
      } else if (
        (e.kind === 'session_event' || e.kind === 'btw') &&
        v != null
      ) {
        p = { open: v } as Partial<ScrollEntry>
        cache.set(key, p)
      } else if (e.kind === 'tool' && v != null) {
        p = {
          displayMode: v ? 'expanded' : 'collapsed',
          expanded: v,
        } as Partial<ScrollEntry>
        cache.set(key, p)
      } else if (v != null) {
        p = { expanded: v } as Partial<ScrollEntry>
        cache.set(key, p)
      }
    }
    return p
  }

  // 「查看」全文弹窗（局部状态）：mini 条目不在主 entries 里，主 viewer 找
  // 不到目标——弹窗用 BlockBodyDialog 在组件内渲染同一套全文内容。
  const [viewerId, setViewerId] = useState<string | null>(null)
  const viewerEntry = useMemo(() => {
    const e = viewerId ? renderItems.find((x) => x.id === viewerId) : undefined
    return e && MINI_VIEWABLE_KINDS.has(e.kind) ? e : undefined
  }, [viewerId, renderItems])

  // 局部动作：折叠写本地 folds；「查看」打开局部全文弹窗；选中局部化。缺省值
  // 仍是主 store 动作（EntryView 内部取 actions ?? store），此处全部覆盖。
  const renderItemsRef = useRef(renderItems)
  renderItemsRef.current = renderItems
  const actions: EntryViewActions = useMemo(
    () => ({
      toggleTool: (id) => {
        const base = renderItemsRef.current.find((x) => x.id === id)
        const cur =
          folds.get(id) ??
          (base && base.kind === 'tool' ? toolDisplayMode(base) !== 'collapsed' : false)
        const next = !cur
        setFolds((m) => new Map(m).set(id, next))
        // 展开 = 要看正文：lite 裁掉的行按需补全（非 lite / 已补全 no-op）。
        if (next) void useChatStore.getState().fillToolEntryDetail(id)
      },
      toggleThought: (id) => {
        const next = !(folds.get(id) ?? false)
        setFolds((m) => new Map(m).set(id, next))
        if (next) void useChatStore.getState().fillToolEntryDetail(id)
      },
      toggleUser: (id) =>
        setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      toggleSessionEvent: (id) =>
        setFolds((m) => new Map(m).set(id, !(m.get(id) ?? false))),
      openViewer: (id) => {
        // 「查看」全文同样要先有正文（fillToolEntryDetail 会按 id 找到本
        // 子代理视图里的条目）。
        void useChatStore.getState().fillToolEntryDetail(id)
        setViewerId(id)
      },
      selectEntry: (id) => setSelectedId(id),
    }),
    [folds],
  )

  const toggleGroupExpansion = (anchorId: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(anchorId)) next.delete(anchorId)
      else next.add(anchorId)
      return next
    })

  // 空态首条回退：spawn 携带的任务 prompt 作为第一条 user 条目（TUI
  // 同款：子代理 scrollback 首条是注入的任务 prompt）。id 用稳定的合成
  // id（只在本迷你视图内做 key/选中）。
  const promptEntry = useMemo(
    () =>
      prompt
        ? ({ id: '__mini_prompt__', kind: 'user', text: prompt, expanded: false } as const)
        : null,
    [prompt],
  )

  const timelineContentRef = useRef<HTMLDivElement>(null)
  const junctionDissolveRef = useRef<HTMLDivElement>(null)
  // 时间线底缘与 composer 的交界：主 scrollback 同一套溶解带（下方还有
  // 内容时把尾行化进底色，贴底则抬升）。
  useJunctionDissolve(scrollRef, timelineContentRef, junctionDissolveRef)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {loadingMore && (
        <div
          className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} shrink-0 pt-1.5 text-[11px] text-gn-muted`}
        >
          加载更早…
        </div>
      )}
      {/* 平铺无边框盒（主 scrollback 同款）：滚动容器占满弹窗剩余区域
          （flex-1），自行滚动——不再固定 35vh。上滑到顶触发更早分页。 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="gn-scroll min-h-0 flex-1 overflow-y-auto pb-2"
        // 预留滚动条槽（主 scrollback 同款）：底部 composer 按同一宽度留白，
        // 两列才不会在滚动条出现时错开。
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* 常驻包装层：溶解带要观察内容高度变化，空态⇄时间线切换时
            观察目标不能换元素（否则 ResizeObserver 盯的是旧节点）。 */}
        <div ref={timelineContentRef}>
          {renderItems.length === 0 ? (
            <div
              className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} space-y-1.5 py-2`}
            >
              {promptEntry && (
                <EntryView
                  e={promptEntry}
                  selected={promptEntry.id === selectedId}
                  pendingFreeze={false}
                  now={now}
                  actions={actions}
                  readonly={guest}
                />
              )}
              <div className="text-[11px] text-gn-muted">
                {running
                  ? '等待子代理活动上报…（数据来自宿主转发的子代理会话事件流）'
                  : '（未捕获到子代理会话活动 — 无活动时间线）'}
              </div>
            </div>
          ) : (
            <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-1`}>
              {/* TUI sticky prompt header（主 scrollback sticky.rs 同款）：与
                  rows 同父级才能获得整列高度作为 sticky 滚动范围。零高度
                  sticky 壳 + absolute 条：吸附不改文档流，避免抖动。 */}
              <div
                className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible"
                aria-hidden={pinnedUser?.kind !== 'user'}
              >
                {pinnedUser?.kind === 'user' && (
                  <div
                    ref={(el) => {
                      stickyBandElRef.current = el
                      if (el && lastPushYRef.current) {
                        el.style.transform = `translateY(${lastPushYRef.current}px)`
                      }
                    }}
                    className="pointer-events-auto absolute inset-x-0 top-0 border-b border-gn-prompt-border/40 font-ui text-[12.5px] leading-[1.35] text-gn-fg select-none"
                    style={{ backgroundColor: 'var(--color-gn-bg-highlight)' }}
                  >
                    {/* 左内边距对齐同模态行内用户消息的图标列（EntryShell 的
                        accent 条 + 间距），❯ 与文字落在同一条竖线上。 */}
                    <div
                      className="flex items-start gap-1.5 py-[7px] pr-2.5"
                      style={{ paddingLeft: ICON_COL_INSET_PX }}
                    >
                      <span
                        className="mt-[1.5px] shrink-0"
                        style={{ color: 'var(--color-gn-accent-user)' }}
                        aria-hidden
                      >
                        {Glyphs.promptArrow}
                      </span>
                      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                        {collapseUserText(pinnedUser.text, USER_COLLAPSED_MAX_LINES).text}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {rows.map((row, i) => {
                const dense = isDensePackableRow(row)
                const densePrev = i > 0 && isDensePackableRow(rows[i - 1])
                const denseNext =
                  i < rows.length - 1 && isDensePackableRow(rows[i + 1])
                if (row.type === 'group_header') {
                  return (
                    <GroupHeaderView
                      key={displayRowKey(row)}
                      row={row}
                      selected={row.id === selectedId}
                      pendingFreeze={false}
                      now={now}
                      onToggle={() => toggleGroupExpansion(row.span.anchorId)}
                      dense={dense}
                      densePrev={densePrev}
                      denseNext={denseNext}
                      enter={groupEnter(row.span)}
                      selectRow={setSelectedId}
                    />
                  )
                }
                const e = row.entry
                return (
                  <EntryView
                    key={displayRowKey(row)}
                    e={e}
                    selected={e.id === selectedId}
                    pendingFreeze={false}
                    now={now}
                    inGroup={spanContaining(spans, row.index) != null}
                    dense={dense}
                    densePrev={densePrev}
                    denseNext={denseNext}
                    actions={actions}
                    patch={foldPatch(e)}
                    streamBodyRef={miniStreamBodyRef}
                    readonly={guest}
                    enter={enteringIds.has(e.id)}
                  />
                )
              })}
            </div>
          )}
        </div>
      </div>
      {/* 时间线 ⇄ composer 交界溶解带（主 scrollback 同款）：视口底缘的
          尾行不再被硬切，化进底色。武装条件与滚动条槽宽度由
          useJunctionDissolve 写在元素上。 */}
      <div
        ref={junctionDissolveRef}
        aria-hidden
        className="gn-junction-dissolve pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-7"
      />
      {viewerEntry ? (
        <BlockBodyDialog entry={viewerEntry} onClose={() => setViewerId(null)} />
      ) : null}
    </div>
  )
}
