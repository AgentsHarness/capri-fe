import type { ScrollEntry, SessionHistoryPage, ToolCall } from '../../api/types'
import { transport } from '../../api/client'
import { isEditToolKind } from '../../theme/toolFamily'
import {
  detailIsEmpty,
  extractToolDetail,
  toolBodyStillOwed,
} from '../../scrollback/toolDetail'
import { currentLiteReplay } from '../historyPins'
import type { ChatState, SetState } from './types'
import { captureAsyncScope, isAsyncScopeCurrent, runtime } from './globals'
import { INITIAL_TURNS } from './historyPage'
import { type RawEnvelope } from './envelopeParse'
import { toolCallIdOf } from './tools'

// ── 精简回放（lite）：FE 侧策略 + 正文补全引擎 ─────────────────────────
//
// host 的 lite 投影只裁工具正文（tool_call / tool_call_update 的
// rawOutput / content），行数、顺序、msgSeq、其余信封一律不变。所以「补全」
// 不是把一页重新回放进视图（那会闪空滚动区、还会抢改 live 指针），而只是
// 把被裁掉的那两个字段按 toolCallId 填回已经渲染好的行——契约 [E]。
//
// 三条纪律：
// - 幂等：同一区间补两次结果一致（正文来自同一份全量信封）；
// - 零结构变化：不增删条目、不改顺序、正文之外的字段一律不动；
// - 切会话作废：结果回来后先过 scope / sessionSwitchGen 校验，整包丢弃。

/** 后台补全的预算闸门：整页被裁正文超过这个字节数就不自动补（契约 [E]）。 */
export const FILL_BUDGET_BYTES = 2 * 1024 * 1024

/**
 * host 对 `detail` 的能力（契约 [B]）：请求过投影但响应没带 `projected`
 * = 旧 host 不认识该字段 → 停用这个 host 的 lite（按 host 记；切回支持的
 * host 仍然开）。只活在内存里：刷新 / 换 host 重新试探一次。
 */
const liteUnsupportedHosts = new Set<string>()

/** 同一区间只拉一次：在途共享同一 promise + 已成功集合（切会话清空）。 */
const fillInflight = new Map<string, Promise<void>>()
const fillSettled = new Set<string>()

/** 待触发的后台补全句柄（idle 或 setTimeout(0)）。 */
let idleHandle: number | null = null

/** 一个补全窗口：offset/limit（更早轮 / 上滑翻页）或 turnIndex（当前轮）。 */
export type FillWindow =
  | { offset: number; limit: number; turnIndex?: undefined }
  | { turnIndex: number; offset?: undefined; limit?: undefined }

/** 补全目标：缺省主 scrollback 的 entries，或某个子代理迷你视图的 items。 */
export type FillTarget = { childSessionId?: undefined } | { childSessionId: string }

function hostScope(s: ChatState): string {
  return s.selectedHostId || s.hostId || 'local'
}

/**
 * 本次历史请求该带的 `detail`：开关关闭、或该 host 已被判定不支持时返回
 * undefined——请求体里连键都不带，与今天的逐字节请求完全一致。
 */
export function historyDetailParam(get: () => ChatState): 'lite' | undefined {
  if (!currentLiteReplay()) return undefined
  if (liteUnsupportedHosts.has(hostScope(get()))) return undefined
  return 'lite'
}

/**
 * 消费 host 的投影回显。`asked` = 本次请求要过投影（lite / meta）：回了
 * projected 就把该 host 记为支持，没回就停用它的 lite（本次按 full 渲染）。
 */
export function noteHistoryProjection(
  get: () => ChatState,
  asked: boolean,
  page: Pick<SessionHistoryPage, 'projected'> | undefined,
): void {
  if (!asked) return
  const host = hostScope(get())
  if (page?.projected === 'lite' || page?.projected === 'meta') liteUnsupportedHosts.delete(host)
  else liteUnsupportedHosts.add(host)
}

/**
 * 这条工具行还欠正文：lite 裁过、还没补上，且知道去哪个区间取
 * （live 行无 msgSeq → 不参与补全）。断言成带区间的形态，调用点
 * 因此不用再写 `!`。
 */
export function toolEntryNeedsFill(
  e: ScrollEntry,
): e is Extract<ScrollEntry, { kind: 'tool' }> & { msgSeq: number; msgSeqEnd: number } {
  if (e.kind !== 'tool') return false
  if (!e.liteOmitted || e.liteOmitted <= 0) return false
  if (e.liteState === 'filled') return false
  return e.msgSeq != null && e.msgSeqEnd != null
}

/**
 * 占位行是否该显示（补全成功后一律不再显示，即使 liteOmitted 仍留着）。
 * 必须与 toolEntryNeedsFill 一样要求补全坐标：没有 msgSeq 区间就没有任何
 * 可点的拉取路径（host 走 _x.ai/session/updates 透传回退时整页无 msgSeq），
 * 显示出来就是一个永远拿不回正文的死按钮。
 */
export function toolEntryLitePending(
  e: ScrollEntry,
): e is Extract<ScrollEntry, { kind: 'tool' }> & { liteOmitted: number } {
  return (
    e.kind === 'tool' &&
    !!e.liteOmitted &&
    e.liteState !== 'filled' &&
    e.msgSeq != null &&
    e.msgSeqEnd != null
  )
}

/**
 * lite 裁过且尚未补回。不含补全坐标要求：按 turnIndex 补整轮时靠它筛候选
 * （host 走 _x.ai/session/updates 透传回退时整页没有 msgSeq，区间补算不出
 * 窗口，整轮补仍能按 toolCallId 回填）。
 */
export function toolEntryLiteOmitted(e: ScrollEntry): boolean {
  return (
    e.kind === 'tool' && !!e.liteOmitted && e.liteOmitted > 0 && e.liteState !== 'filled'
  )
}

/**
 * live 事件把真实正文并进了这条 lite 行之后该怎么记账。
 *
 * 裁过的历史行在忙会话里会被 live 事件续写：不撤占位的话，已经到达的正文
 * 一直盖在「已省略 N 字节」下面；更糟的是随后按 [msgSeq, msgSeqEnd] 触发的
 * 快照补全拉的是历史全量，会把更新的 live 终态写回去并标 filled。
 * 判据是「合并后还欠不欠可显示正文」（toolBodyStillOwed），不是「这条
 * update 带没带 rawOutput」：状态-only 的更新不撤占位。记 filled 之后
 * applyToolBodies 会跳过该行，迟到的快照再也覆盖不到 live 正文。
 *
 * candidates = 合并后可能仍带占位的全部 raw（主 raw + 合并行的子槽位）。
 * 已不欠正文时返回的 raw 会抹掉 `_meta.lite`，渲染层据此不再当占位。
 * kindName 传合并后重算的那个：正文判据按 kind 分支，拿旧值（或拿不到）
 * 会把 edit 行当 generic 处理——generic 有 inputArgs 就判「非空」。
 */
export function liteAfterLiveBody(
  e: Extract<ScrollEntry, { kind: 'tool' }>,
  mergedRaw: ToolCall,
  opts: { kindName?: string; candidates?: ToolCall[] } = {},
): Partial<Extract<ScrollEntry, { kind: 'tool' }>> {
  if (!e.liteOmitted && e.liteState == null) return {}
  if (!e.raw) return {}
  if ((opts.candidates ?? [mergedRaw]).some(toolBodyStillOwed)) return {}
  const probe = clearLiteMark(mergedRaw)
  // 主载体补上了但渲染仍是空态 = 真正缺的那部分在别处（edit 的正文是
  // content 的 Diff 块，live 只回了个 rawOutput），占位不能撤——撤了就是
  // 一个既没正文又没了拉取入口的死行。
  if (detailIsEmpty(extractToolDetail(probe, opts.kindName ?? e.kindName))) return {}
  return {
    raw: probe,
    liteOmitted: undefined,
    liteState: 'filled' as const,
  }
}

/** 补全窗口的去重键（会话 + 闭区间；turnIndex 与 offset 空间分开记）。 */
function windowKey(sid: string, win: FillWindow): string {
  return win.turnIndex != null
    ? `${sid}@turn:${win.turnIndex}`
    : `${sid}@${win.offset}:${win.offset + win.limit - 1}`
}

/**
 * 切会话 / 重建快照：正文去重集合一律作废（条目是全新的一批）。host 能力
 * 档案不清——它是 host 属性，跟会话无关。
 */
export function resetToolFillCache(): void {
  cancelScheduledFill()
  fillInflight.clear()
  fillSettled.clear()
}

/** 清空 host 能力档案（测试用；线上靠换 host / 刷新自然重探）。 */
export function resetLiteCapability(): void {
  liteUnsupportedHosts.clear()
}

/** 一页全量信封里，某次工具调用目前为止的正文（按 toolCallId 合并后）。 */
export type ToolBody = {
  hasRawOutput: boolean
  rawOutput?: unknown
  hasContent: boolean
  content?: unknown
}

/**
 * 从一页 `detail=full` 的信封里按 toolCallId 摘出工具正文。合并语义与回放
 * 一致（逐条 `{...raw, ...update}` → 后到的覆盖先到的），所以不必真的过
 * 一遍 store 回放：只取正文，其余字段一概不碰。
 */
export function extractToolBodies(updates: unknown[]): Map<string, ToolBody> {
  const out = new Map<string, ToolBody>()
  for (const env of updates) {
    const up = (env as RawEnvelope | undefined)?.params?.update
    if (!up) continue
    const kind = up.sessionUpdate
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue
    const id = toolCallIdOf(up as ToolCall) ?? ''
    if (!id) continue
    const body: ToolBody = out.get(id) ?? { hasRawOutput: false, hasContent: false }
    if ('rawOutput' in up) {
      body.rawOutput = up.rawOutput
      body.hasRawOutput = true
    }
    if ('content' in up) {
      body.content = up.content
      body.hasContent = true
    }
    out.set(id, body)
  }
  return out
}

/**
 * 抹掉 host 打的 `_meta.lite` 标记——带过正文的 raw 不再是占位（渲染与
 * toolDetail 的假空态判定都看这个标记）。
 */
export function clearLiteMark(raw: ToolCall): ToolCall {
  const meta = raw._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !('lite' in (meta as object))) {
    return raw
  }
  const cleared = { ...(meta as Record<string, unknown>) }
  delete cleared.lite
  return { ...raw, _meta: cleared }
}

/**
 * 全量正文填回一份 raw，并抹掉 host 的 `_meta.lite` 标记——填完之后这份
 * raw 不再是占位（渲染与 toolDetail 的假空态判定都看这个标记）。
 */
function fillRaw(raw: ToolCall | undefined, body: ToolBody): ToolCall {
  const next: ToolCall = { ...(raw ?? {}) }
  if (body.hasRawOutput) next.rawOutput = body.rawOutput
  if (body.hasContent) next.content = body.content
  return clearLiteMark(next)
}

/**
 * 把正文按 toolCallId 填回条目（纯函数、幂等：填两次结果一致）。没有条目
 * 命中时返回原数组引用——调用方据此跳过无谓重渲染。
 */
export function applyToolBodies<T extends ScrollEntry>(
  entries: T[],
  bodies: Map<string, ToolBody>,
): T[] {
  if (bodies.size === 0) return entries
  let changed = false
  const next = entries.map((e) => {
    if (e.kind !== 'tool') return e
    // 幂等：已经填过的行直接跳过——再补一次既不重复写、也不换引用。
    if (e.liteState === 'filled') return e
    const own = e.toolCallId ? bodies.get(e.toolCallId) : undefined
    let mergedRaws: ToolCall[] | undefined
    if (e.mergedRaws?.length) {
      mergedRaws = e.mergedRaws.map((m) => {
        const id = toolCallIdOf(m) ?? ''
        const b = id ? bodies.get(id) : undefined
        if (!b) return m
        changed = true
        return fillRaw(m, b)
      })
    }
    if (!own) return mergedRaws ? ({ ...e, mergedRaws } as T) : e
    changed = true
    return {
      ...e,
      raw: fillRaw(e.raw, own),
      ...(mergedRaws ? { mergedRaws } : {}),
      liteState: 'filled' as const,
    } as T
  })
  return changed ? next : entries
}

/** 给目标集合里的 lite 工具行打补全态（loading / error）。 */
function markLiteState(
  entries: ScrollEntry[],
  ids: Set<string>,
  state: 'loading' | 'error',
): ScrollEntry[] {
  let changed = false
  const next = entries.map((e) => {
    if (e.kind !== 'tool' || !ids.has(e.id)) return e
    // 已填好的不回退；同状态不重复造对象（EntryView 的 memo 靠引用相等）。
    if (e.liteState === 'filled' || e.liteState === state) return e
    changed = true
    return { ...e, liteState: state }
  })
  return changed ? next : entries
}

function candidateIds(
  entries: ScrollEntry[],
  only: string[] | undefined,
  requireRange: boolean,
): Set<string> {
  const want = only ? new Set(only) : null
  const out = new Set<string>()
  for (const e of entries) {
    if (e.kind !== 'tool') continue
    if (want && !want.has(e.id)) continue
    // 按 turnIndex 拉整轮时不需要行内坐标（正文按 toolCallId 匹配回填）；
    // 按区间拉必须有 [msgSeq, msgSeqEnd]，否则连窗口都算不出来。
    if (requireRange ? !toolEntryNeedsFill(e) : !toolEntryLiteOmitted(e)) continue
    out.add(e.id)
  }
  return out
}

function readTarget(get: () => ChatState, target: FillTarget): ScrollEntry[] {
  const s = get()
  const sid = target.childSessionId
  // 最小 store（单测里的 Partial ChatState）可能连 entries / subagentViews
  // 都缺 → 一律按空集合处理。
  if (!sid) return s.entries ?? []
  return (s.subagentViews ?? {})[sid]?.items ?? []
}

function writeTarget(
  set: SetState,
  get: () => ChatState,
  target: FillTarget,
  items: ScrollEntry[],
): void {
  const sid = target.childSessionId
  if (!sid) {
    set({ entries: items })
    return
  }
  const views = get().subagentViews ?? {}
  const view = views[sid]
  if (!view || view.items === items) return
  set({ subagentViews: { ...views, [sid]: { ...view, items } } })
}

export type FillRequest = {
  /** 发起补全的会话（stale 判定基准；子代理迷你视图 = 父会话）。 */
  sessionId: string
  cwd: string
  /** 取正文的会话：缺省 = sessionId；子代理迷你视图 = child_session_id。 */
  fetchSessionId?: string
  win: FillWindow
  target?: FillTarget
  /**
   * 后台自动补全：不打 loading、失败静默。仍然走同一区间去重（否则窗口里
   * 每行各发一次整轮请求），但不写 settled——用户手势的按需拉取要能重试。
   */
  background?: boolean
  entryIds?: string[]
}

/**
 * 拉一个区间的 `detail=full` 并把工具正文填回现有条目。同一区间只拉一次
 * （在途共享同一 promise，成功后进 settled）；区间里还有停在 error 的条目
 * 时绕开 settled 再拉一次（占位行上的就地重试）。
 */
export function fillToolBodies(
  set: SetState,
  get: () => ChatState,
  req: FillRequest,
): Promise<void> {
  const target = req.target ?? {}
  const fetchSessionId = req.fetchSessionId ?? req.sessionId
  const key = windowKey(fetchSessionId, req.win)
  const items = readTarget(get, target)
  const ids = candidateIds(
    items,
    req.background ? undefined : req.entryIds,
    // turnIndex 窗口补整轮，行内坐标可有可无；offset 区间窗必须有坐标。
    req.win.turnIndex == null,
  )
  if (ids.size === 0) return Promise.resolve()
  if (!req.background) {
    const running = fillInflight.get(key)
    if (running) return running
    const retryable = items.some(
      (e) => e.kind === 'tool' && ids.has(e.id) && e.liteState === 'error',
    )
    if (fillSettled.has(key) && !retryable) return Promise.resolve()
  }

  const scope = captureAsyncScope(get, req.sessionId, req.cwd)
  const genAtStart = runtime.sessionSwitchGen
  const stale = () =>
    genAtStart !== runtime.sessionSwitchGen ||
    !isAsyncScopeCurrent(get, scope) ||
    get().sessionId !== req.sessionId ||
    get().cwd !== req.cwd
  const relabel = (state: 'loading' | 'error') => {
    if (stale()) return
    writeTarget(set, get, target, markLiteState(readTarget(get, target), ids, state))
  }

  const run = (async () => {
    if (!req.background) relabel('loading')
    let page: SessionHistoryPage
    try {
      page = await transport.loadSessionHistory(fetchSessionId, req.cwd, {
        ...(req.win.turnIndex != null
          ? { turnIndex: req.win.turnIndex }
          : { offset: req.win.offset, limit: req.win.limit }),
        // 补全显式要全量正文（与 host 的默认档同义，写出来避免歧义）。
        detail: 'full',
      })
    } catch {
      // 失败：后台补全静默（下次展开仍会按需拉）；按需展开就地转错误行。
      if (!req.background) relabel('error')
      return
    }
    if (stale()) return
    const bodies = extractToolBodies(page.updates ?? [])
    if (bodies.size === 0) {
      if (!req.background) relabel('error')
      return
    }
    writeTarget(set, get, target, applyToolBodies(readTarget(get, target), bodies))
    // settled 只记用户手势的按需拉取：后台补全用 turn 窗口键，与区间键不
    // 相撞，但把它记进来会让「后台失败过一次」看起来像已补全，后续展开
    // 的手势被 settled 挡掉，永远不再重试。
    if (!req.background) fillSettled.add(key)
  })()
  if (!req.background) {
    fillInflight.set(key, run)
    void run.finally(() => fillInflight.delete(key))
  }
  return run
}

/**
 * 展开入口（toggleTool / 「查看」/ Diff 审查 / 子代理迷你视图）：按需补全
 * 一条工具行所在的 [msgSeq, msgSeqEnd] 闭区间。非 lite 行 no-op。
 */
export function fillEntryRange(
  set: SetState,
  get: () => ChatState,
  entryId: string,
  target: FillTarget = {},
): Promise<void> {
  const s = get()
  const e = readTarget(get, target).find((x) => x.id === entryId)
  if (!e || e.kind !== 'tool' || !toolEntryNeedsFill(e)) return Promise.resolve()
  const sessionId = s.sessionId
  const cwd = s.cwd
  if (!sessionId || !cwd) return Promise.resolve()
  return fillToolBodies(set, get, {
    sessionId,
    cwd,
    fetchSessionId: target.childSessionId ?? sessionId,
    win: { offset: e.msgSeq!, limit: e.msgSeqEnd! - e.msgSeq! + 1 },
    target,
    entryIds: [entryId],
  })
}

/**
 * 按条目 id 补全：主 scrollback 优先，其次任一子代理迷你视图（mini 条目不
 * 在主 entries 里，按 id 找不到就得去 subagentViews 定位它的 child session）。
 */
export function fillEntryDetail(
  set: SetState,
  get: () => ChatState,
  entryId: string,
): Promise<void> {
  if ((get().entries ?? []).some((e) => e.id === entryId)) return fillEntryRange(set, get, entryId)
  for (const [childSid, view] of Object.entries(get().subagentViews ?? {})) {
    if (view.items.some((e) => e.id === entryId)) {
      return fillEntryRange(set, get, entryId, { childSessionId: childSid })
    }
  }
  return Promise.resolve()
}

/**
 * 整窗按需补全（Diff 审查弹窗这类「一次展开一片」的入口）：把窗口里所有
 * 欠正文的工具行按各自区间拉一遍，同区间由去重集合合并成一次请求。
 */
export function fillLiteWindow(
  set: SetState,
  get: () => ChatState,
  opts: { editOnly?: boolean } = {},
): Promise<void>[] {
  const s = get()
  const sessionId = s.sessionId
  // 一律用视图当前的 cwd：stale 判定按 captureAsyncScope 比 sessionId+cwd，
  // 换成别的来源（historyCwd 在跨会话查看时可能不同）会让校验恒失败。
  const cwd = s.cwd
  if (!sessionId || !cwd) return []
  const jobs: Promise<void>[] = []
  for (const e of s.entries ?? []) {
    if (!toolEntryNeedsFill(e)) continue
    if (opts.editOnly && !isEditToolKind(e.kindName)) continue
    jobs.push(
      fillToolBodies(set, get, {
        sessionId,
        cwd,
        win: { offset: e.msgSeq!, limit: e.msgSeqEnd! - e.msgSeq! + 1 },
        entryIds: [e.id],
      }),
    )
  }
  return jobs
}

/**
 * 当前轮首帧渲染后的后台补全（契约 [E]）：整轮再拉一次 `detail=full`，只
 * 把工具正文填回现有行。预算闸门按 host 回显的 omittedBytes 估算（超了就不
 * 补，退回纯按需加载）；失败静默、不改 UI。
 */
export function scheduleCurrentTurnFill(
  set: SetState,
  get: () => ChatState,
  page: Pick<SessionHistoryPage, 'projected' | 'omittedBytes'> | undefined,
): void {
  cancelScheduledFill()
  if (page?.projected !== 'lite') return
  const omitted = page.omittedBytes
  if (omitted != null && omitted > FILL_BUDGET_BYTES) return
  const sessionId = get().sessionId
  const cwd = get().cwd
  if (!sessionId || !cwd) return
  idleHandle = runWhenIdle(() => {
    idleHandle = null
    if (get().sessionId !== sessionId || get().cwd !== cwd) return
    void fillToolBodies(set, get, {
      sessionId,
      cwd,
      win: { turnIndex: INITIAL_TURNS },
      background: true,
    })
  })
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (h: number) => void
}

/** requestIdleCallback 缺失（Safari / jsdom）→ setTimeout(0) 兜底。 */
function runWhenIdle(cb: () => void): number {
  const w = window as IdleWindow
  if (typeof w.requestIdleCallback === 'function') return w.requestIdleCallback(cb, { timeout: 2000 })
  return setTimeout(cb, 0) as unknown as number
}

/** 取消待触发的后台补全（切会话 / 下一次快照加载前）。 */
export function cancelScheduledFill(): void {
  if (idleHandle == null) return
  const h = idleHandle
  idleHandle = null
  const w = window as IdleWindow
  if (typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(h)
  else clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
}
