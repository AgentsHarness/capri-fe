import type { ScrollEntry, SessionHistoryPage, ToolCall } from '../../api/types'
import { transport } from '../../api/client'
import { isEditToolKind } from '../../theme/toolFamily'
import {
  liteStubIn,
  toolBodyStillOwed,
} from '../../scrollback/toolDetail'
import { currentLiteReplay } from '../historyPins'
import type { ChatState, SetState } from './types'
import { captureAsyncScope, isAsyncScopeCurrent, runtime } from './globals'
import { envelopeMsgSeq, envelopeToEvents, type RawEnvelope } from './envelopeParse'
import { toolCallIdOf } from './tools'

// ── 精简回放（lite）：FE 侧策略 + 正文补全引擎 ─────────────────────────
//
// host 的 lite 投影是首屏时间线：工具信封按 toolCallId 合成、thought 正文
// 占位、params._meta 收到回放真用的键。条数可以少于 full，msgSeq 与
// _meta.lite.msgSeqEnd 给出补全闭区间。「补全」不是把一页重新回放进视图
// （那会闪空滚动区、还会抢改 live 指针），而只是把工具 rawOutput/content
// 和 thought 文本填回已经渲染好的行。
//
// 三条纪律：
// - 幂等：同一区间补两次结果一致（正文来自同一份全量信封）；
// - 零结构变化：不增删条目、不改顺序、正文之外的字段一律不动；
// - 切会话作废：结果回来后先过 scope / sessionSwitchGen 校验，整包丢弃。

/**
 * host 对 `detail` 的能力（契约 [B]）：请求过投影但响应没带 `projected`
 * = 旧 host 不认识该字段 → 停用这个 host 的 lite（按 host 记；切回支持的
 * host 仍然开）。只活在内存里：刷新 / 换 host 重新试探一次。
 */
const liteUnsupportedHosts = new Set<string>()

/** 同一区间只拉一次：在途共享同一 promise + 已成功集合（切会话清空）。 */
const fillInflight = new Map<string, Promise<void>>()
const fillSettled = new Set<string>()

/**
 * 待触发的后台补全（每页一个，键 = 窗口键）：idle 期才发，且串行排队——
 * 上滑连翻多页时不会同时压出多份整窗全量。
 */
const pendingPageFills = new Map<string, { handle: number; run: () => void }>()
const bgQueued = new Set<string>()
let bgChain: Promise<void> = Promise.resolve()

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
 * 本次历史请求该带的 `detail`：直连 / 开关关闭 / 该 host 不支持时返回
 * undefined——请求体里连键都不带，即逐字节 full。
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
 * 三条都得满足：
 *  - 有补全坐标：没有 [msgSeq, msgSeqEnd]（host 走 _x.ai/session/updates
 *    透传回退时整页无 msgSeq）就没有任何可点的拉取路径，显示出来是个永远
 *    拿不回正文的死按钮；
 *  - 确实还没有可显示的正文（toolBodyStillOwed）：live 事件续写进来的正文
 *    不能被占位层盖住——这种行留着 liteOmitted 让补全继续跑，把剩下的载体
 *    填齐，但占位让位给正文。
 */
export function toolEntryLitePending(
  e: ScrollEntry,
): e is Extract<ScrollEntry, { kind: 'tool' }> & { liteOmitted: number } {
  return (
    e.kind === 'tool' &&
    !!e.liteOmitted &&
    e.liteState !== 'filled' &&
    e.msgSeq != null &&
    e.msgSeqEnd != null &&
    toolBodyStillOwed(e.raw ?? {})
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

export function thoughtEntryNeedsFill(
  e: ScrollEntry,
): e is Extract<ScrollEntry, { kind: 'thought' }> & { msgSeq: number; msgSeqEnd: number } {
  if (e.kind !== 'thought') return false
  if (!e.liteOmitted || e.liteOmitted <= 0) return false
  if (e.liteState === 'filled') return false
  return e.msgSeq != null && e.msgSeqEnd != null
}

export function thoughtEntryLiteOmitted(e: ScrollEntry): boolean {
  return (
    e.kind === 'thought' && !!e.liteOmitted && e.liteOmitted > 0 && e.liteState !== 'filled'
  )
}

/** lite 页合成后条数 < 原窗口：用信封 msgSeq + lite.msgSeqEnd 还原闭区间。 */
export function pageFillWindow(updates: unknown[]): FillWindow | undefined {
  let min: number | undefined
  let max: number | undefined
  for (const env of updates) {
    const seq = envelopeMsgSeq(env)
    if (seq == null) continue
    min = min == null ? seq : Math.min(min, seq)
    max = max == null ? seq : Math.max(max, seq)
    const mark = liteMarkFromEnv(env)
    if (mark?.msgSeqEnd != null) max = Math.max(max, mark.msgSeqEnd)
  }
  if (min == null || max == null) return undefined
  return { offset: min, limit: max - min + 1 }
}

function liteMarkFromEnv(env: unknown): { omitted: number; msgSeqEnd?: number } | undefined {
  const up = (env as RawEnvelope)?.params?.update
  if (!up) return undefined
  const meta = (up as { _meta?: unknown })._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const lite = (meta as Record<string, unknown>).lite
  if (!lite || typeof lite !== 'object' || Array.isArray(lite)) return undefined
  const o = lite as Record<string, unknown>
  const omitted = typeof o.omitted === 'number' && Number.isFinite(o.omitted) ? o.omitted : 0
  const msgSeqEnd =
    typeof o.msgSeqEnd === 'number' && Number.isFinite(o.msgSeqEnd) ? o.msgSeqEnd : undefined
  if (omitted <= 0 && msgSeqEnd == null) return undefined
  return { omitted, ...(msgSeqEnd != null ? { msgSeqEnd } : {}) }
}

/**
 * live 事件把真实正文并进了这条 lite 行之后的结账：所有被裁过的载体都不剩
 * 占位了，就把这行记成 filled 并抹掉 `_meta.lite`（图标少一格、占位与补全
 * 候选都到此为止）。只补上部分载体时不动任何字段——占位的隐藏由
 * toolEntryLitePending 按「还有没有可显示正文」判定，`liteOmitted` 留着，
 * 补全照旧会跑把剩下的填齐（`fillRaw` 保证它不覆盖 live 带来的那份）。
 *
 * candidates = 合并后可能仍带占位的全部 raw（主 raw + 合并行的子槽位）。
 * 这里绝不调正文解析器：它在 live 事件通路（handleToolEvent）上，一次抛错
 * 会打断整条工具事件链 —— 判据一律走形状识别（liteStubIn）。
 */
export function liteAfterLiveBody(
  e: Extract<ScrollEntry, { kind: 'tool' }>,
  mergedRaw: ToolCall,
  opts: { candidates?: ToolCall[] } = {},
): Partial<Extract<ScrollEntry, { kind: 'tool' }>> {
  if (!e.liteOmitted || e.liteState === 'filled') return {}
  if ((opts.candidates ?? [mergedRaw]).some((r) => liteStubIn(r.rawOutput) || liteStubIn(r.content))) {
    return {}
  }
  return {
    raw: clearLiteMark(mergedRaw),
    liteOmitted: undefined,
    liteState: 'filled' as const,
  }
}

/**
 * 顶部进度图标的读数（给 zustand 选择器用）。返回定长字符串而不是对象：
 * 选择器按引用比较，返回新对象会让每次 store 变化都重渲染。
 *
 * 判据只看「还有没有工具行欠着正文」（lite 裁过且未 filled），不去看
 * `historyProjected`：那个旗标记的是**最新一页**的回显，而滚动区里同时躺着
 * 好几页——首页是全量、上滑翻出的旧页是 lite（或反之）时两者会不同步，
 * 图标就会在该显示的时候不显示。开关关掉后重进会话，条目根本不带
 * liteOmitted，自然也就没有图标。
 *
 * `''` = 不显示（没有欠正文的行）。`pending.loading.failed` = 排队中 /
 * 正在拉 / 拉失败可重试的行数。
 */
export function liteFillSummary(s: ChatState): string {
  let pending = 0
  let loading = 0
  let failed = 0
  for (const e of s.entries ?? []) {
    if ((e.kind !== 'tool' && e.kind !== 'thought') || !e.liteOmitted || e.liteOmitted <= 0) continue
    if (e.liteState === 'filled') continue
    if (e.liteState === 'loading') loading++
    else if (e.liteState === 'error') failed++
    else pending++
  }
  if (pending + loading + failed === 0) return ''
  return `${pending}.${loading}.${failed}`
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
  bgQueued.clear()
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
 * 桶里到底有没有正文。
 */
function bodyFilled(b: ToolBody | undefined): b is ToolBody {
  return !!b && (b.hasRawOutput || b.hasContent)
}

/**
 * 从一页 `detail=full` 的信封里摘出工具正文，键 = toolCallId。
 * 合并语义与回放一致（逐条 `{...raw, ...update}` → 后到的覆盖先到的）。
 */
export function extractToolBodies(updates: unknown[]): Map<string, ToolBody> {
  const out = new Map<string, ToolBody>()
  for (const env of updates) {
    const raw = env as RawEnvelope | undefined
    const up = raw?.params?.update
    if (!up) continue
    const kind = up.sessionUpdate
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue
    const tc = up as ToolCall
    const id = toolCallIdOf(tc)
    if (id) {
      mergeToolBody(out, id, tc)
    }
  }
  return out
}

export type ThoughtRun = { msgSeq: number; msgSeqEnd: number; text: string }

/** 从 detail=full 页里按连续 thought chunk 拼出各段正文。 */
export function extractThoughtRuns(updates: unknown[]): ThoughtRun[] {
  const out: ThoughtRun[] = []
  let cur: ThoughtRun | null = null
  const flush = () => {
    if (cur && cur.text) out.push(cur)
    cur = null
  }
  for (const env of updates) {
    const up = (env as RawEnvelope)?.params?.update
    if (up?.sessionUpdate !== 'agent_thought_chunk') {
      flush()
      continue
    }
    const seq = envelopeMsgSeq(env) ?? 0
    let text = ''
    for (const ev of envelopeToEvents(env)) {
      if (ev.type === 'thought' && ev.text && ev.text !== '…') text += ev.text
    }
    if (!cur) cur = { msgSeq: seq, msgSeqEnd: seq, text }
    else {
      cur.msgSeqEnd = seq
      cur.text += text
    }
  }
  flush()
  return out
}

function applyThoughtBodies(entries: ScrollEntry[], runs: ThoughtRun[]): ScrollEntry[] {
  if (runs.length === 0) return entries
  let changed = false
  const next = entries.map((e) => {
    if (e.kind !== 'thought' || e.liteState === 'filled' || !e.liteOmitted) return e
    const seq = e.msgSeq
    if (seq == null) return e
    const run = runs.find((r) => r.msgSeq <= seq && seq <= r.msgSeqEnd)
    if (!run?.text) return e
    changed = true
    return { ...e, text: run.text, liteState: 'filled' as const }
  })
  return changed ? next : entries
}

/** 合并正文进 body（后到覆盖先到，与逐条 `{...raw, ...update}` 同语义）。 */
function mergeInto(body: ToolBody, up: ToolCall): void {
  if ('rawOutput' in up) {
    body.rawOutput = up.rawOutput
    body.hasRawOutput = true
  }
  if ('content' in up) {
    body.content = up.content
    body.hasContent = true
  }
}

/** 有 toolCallId 的调用：按 id 合并正文。 */
function mergeToolBody(out: Map<string, ToolBody>, key: string, up: ToolCall): void {
  let body = out.get(key)
  if (!body) {
    body = { hasRawOutput: false, hasContent: false }
    out.set(key, body)
  }
  mergeInto(body, up)
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
  // live-owned：这个载体上已经有一份不带占位的真实正文（live 事件续写进来的），
  // 而快照那一帧可能更旧 —— 不许覆盖。只有该键缺失或仍是占位时才填。
  const owned = (key: 'rawOutput' | 'content') =>
    key in next && !liteStubIn((next as Record<string, unknown>)[key])
  if (body.hasRawOutput && !owned('rawOutput')) next.rawOutput = body.rawOutput
  if (body.hasContent && !owned('content')) next.content = body.content
  return clearLiteMark(next)
}

/**
 * 把正文按 toolCallId 填回条目（纯函数、幂等：填两次结果一致）。
 * 没有条目命中时返回原数组引用——调用方据此跳过无谓重渲染。
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
    const hit = e.toolCallId ? bodies.get(e.toolCallId) : undefined
    const own = bodyFilled(hit) ? hit : undefined
    let mergedRaws: ToolCall[] | undefined
    if (e.mergedRaws?.length) {
      mergedRaws = e.mergedRaws.map((m) => {
        const id = toolCallIdOf(m) ?? ''
        const b = id ? bodies.get(id) : undefined
        if (!bodyFilled(b)) return m
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
    if ((e.kind !== 'tool' && e.kind !== 'thought') || !ids.has(e.id)) return e
    // 已填好的不回退；同状态不重复造对象（EntryView 的 memo 靠引用相等）。
    if (e.liteState === 'filled' || e.liteState === state) return e
    changed = true
    return { ...e, liteState: state }
  })
  return changed ? next : entries
}

/** 补全后仍欠正文的行数（`ids` 里没进 filled 的那几行）。 */
function countLiteOwed(entries: ScrollEntry[], ids: Set<string>): number {
  let n = 0
  for (const e of entries) {
    if (!ids.has(e.id)) continue
    if (toolEntryLiteOmitted(e) || thoughtEntryLiteOmitted(e)) n++
  }
  return n
}

function candidateIds(
  entries: ScrollEntry[],
  only: string[] | undefined,
  requireRange: boolean,
): Set<string> {
  const want = only ? new Set(only) : null
  const out = new Set<string>()
  for (const e of entries) {
    if (want && !want.has(e.id)) continue
    const owed =
      e.kind === 'tool'
        ? requireRange
          ? toolEntryNeedsFill(e)
          : toolEntryLiteOmitted(e)
        : e.kind === 'thought'
          ? requireRange
            ? thoughtEntryNeedsFill(e)
            : thoughtEntryLiteOmitted(e)
          : false
    if (!owed) continue
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

/** 这一批条目 id 是否还在目标视图里（视图被重建过就是全新一批 id）。 */
function rowsStillOwned(get: () => ChatState, target: FillTarget, ids: Set<string>): boolean {
  const have = new Set(readTarget(get, target).map((e) => e.id))
  for (const id of ids) if (!have.has(id)) return false
  return true
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
   * 后台自动补全：不打行内 loading、失败静默，也不写 settled（用户手势的
   * 按需拉取要能重试）。同窗口的重复由 schedulePageFill 的排队键挡住，
   * 所以这里不必再过 fillInflight。
   */
  background?: boolean
  entryIds?: string[]
}

/**
 * 拉一个区间的 `detail=full` 并把工具正文填回现有条目。同一区间只拉一次
 * （在途共享同一 promise，整窗都补上了才进 settled）；区间里还有停在 error
 * 的条目时绕开 settled 再拉一次（占位行上的就地重试）。
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
    // 后台补全的窗口由调用方给定（同一页的 turnIndex 或 offset/limit），正文
    // 按 toolCallId 回填 → 不要求行内有坐标（host 透传回退的整页就没有坐标，
    // 那种页照样能补）。只有用户手势的区间补需要坐标来算窗口。
    req.win.turnIndex == null && !req.background,
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
  const viewGone = () =>
    genAtStart !== runtime.sessionSwitchGen ||
    !isAsyncScopeCurrent(get, scope) ||
    get().sessionId !== req.sessionId ||
    get().cwd !== req.cwd
  // 后台补全不能被全局代际抖动否决：活跃会话里重连、自动选 host 近路、
  // pending 同步都会 bump sessionSwitchGen，而这跟「这一页的条目还在不在」
  // 毫无关系，串行队列又会把等待窗口拉长到秒级——一律按代际作废的结果就是
  // 忙会话永远补不上。改成认条目归属：发起会话没变 + 要填的那些行还在原视图
  // 里，就照填（行被重建过 → id 全新一批 → 整包丢弃）。
  const stale = req.background
    ? () =>
        get().sessionId !== req.sessionId ||
        get().cwd !== req.cwd ||
        !rowsStillOwned(get, target, ids)
    : viewGone
  const relabel = (state: 'loading' | 'error') => {
    if (stale()) return
    writeTarget(set, get, target, markLiteState(readTarget(get, target), ids, state))
  }

  // 顶部进度图标的在途计数：只记后台补全（用户手势的行内 spinner 由
  // liteState='loading' 带出来，不用重复计）。
  if (req.background) set((s) => ({ liteFillBusy: (s.liteFillBusy ?? 0) + 1 }))
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
    const thoughts = extractThoughtRuns(page.updates ?? [])
    writeTarget(
      set,
      get,
      target,
      applyThoughtBodies(applyToolBodies(readTarget(get, target), bodies), thoughts),
    )
    // 结账：这一批候选里仍欠正文的行（同指纹并行拒绝、或它的实例根本不在这
    // 一页里）必须从 loading 退下来。留在 loading 上是永久 spinner，而下面
    // 的 settled 只放行 error 重试 —— 那点第二次[加载]就彻底没反应了。
    const stillOwed = countLiteOwed(readTarget(get, target), ids)
    if (stillOwed > 0) {
      if (!req.background) relabel('error')
      return
    }
    // settled 只记用户手势的按需拉取：后台补全用 turn 窗口键，与区间键不
    // 相撞，但把它记进来会让「后台失败过一次」看起来像已补全，后续展开
    // 的手势被 settled 挡掉，永远不再重试。
    if (!req.background) fillSettled.add(key)
  })()
  if (req.background) {
    void run.finally(() =>
      set((s) => ({ liteFillBusy: Math.max(0, (s.liteFillBusy ?? 1) - 1) })),
    )
  }
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
  const owed =
    e &&
    (e.kind === 'tool'
      ? toolEntryNeedsFill(e)
        ? e
        : undefined
      : e.kind === 'thought' && thoughtEntryNeedsFill(e)
        ? e
        : undefined)
  if (!owed) return Promise.resolve()
  const sessionId = s.sessionId
  const cwd = s.cwd
  if (!sessionId || !cwd) return Promise.resolve()
  return fillToolBodies(set, get, {
    sessionId,
    cwd,
    fetchSessionId: target.childSessionId ?? sessionId,
    win: { offset: owed.msgSeq, limit: owed.msgSeqEnd - owed.msgSeq + 1 },
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
 * 一页 lite 渲染完后的后台补全：按**同一窗口**再拉一次 detail=full，把
 * 工具正文和 thought 文本填回已经渲染好的行。当前轮走这里；更早轮只在
 * 展开时按需拉。
 *
 * 不设预算闸门：host 真把这一页裁过（projected=lite）就补。被裁最多的恰恰是
 * 带后台任务 / 长流式输出的会话，闸门只会让它们整轮退化成逐条手点；传输成本
 * 由窗口本身和 hub 侧 gzip 负责，未压缩的 omittedBytes 不是依据。
 *
 * 一页一个任务：idle 期触发 + 全局串行排队（连翻多页时不会同时压出多份整窗
 * 全量）；失败静默——行仍是 lite 占位，点开或点顶部进度图标都能再要一次。
 */
export function schedulePageFill(
  set: SetState,
  get: () => ChatState,
  page: Pick<SessionHistoryPage, 'projected'> | undefined,
  win: FillWindow,
): void {
  if (page?.projected !== 'lite') return
  const sessionId = get().sessionId
  const cwd = get().cwd
  if (!sessionId || !cwd) return
  const key = windowKey(sessionId, win)
  if (pendingPageFills.has(key) || bgQueued.has(key)) return
  const stale = () => get().sessionId !== sessionId || get().cwd !== cwd
  const run = () => {
    pendingPageFills.delete(key)
    if (stale()) return
    bgQueued.add(key)
    // 每个任务自己吞掉异常：一个 reject 会顺着 bgChain 传下去，之后所有
    // .then 都被跳过 —— 那正是「某次补全炸了以后回放再也不补」的机制。
    bgChain = bgChain
      .then(() =>
        stale() ? undefined : fillToolBodies(set, get, { sessionId, cwd, win, background: true }),
      )
      .catch((e) => {
        if (import.meta.env.DEV) console.warn('[capri lite] 后台补全任务异常：', e)
      })
      .finally(() => bgQueued.delete(key))
  }
  pendingPageFills.set(key, { handle: runWhenIdle(run), run })
}

/**
 * 立刻发出所有排队中的后台补全（顶部进度图标上点一下 = 不等 idle）。
 * 已经在途的不受影响，只补还没发的。
 */
export function flushScheduledPageFills(): void {
  const w = window as IdleWindow
  const waiting = [...pendingPageFills.values()]
  pendingPageFills.clear()
  for (const { handle } of waiting) cancelIdleTask(w, handle)
  for (const { run } of waiting) run()
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

function cancelIdleTask(w: IdleWindow, handle: number): void {
  if (typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(handle)
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
}

/**
 * 取消所有待触发的后台补全（切会话 / 重建快照前）。已经排进队列的任务不
 * 撤销——它们在真正发请求前会过 stale()，代际一变就自我作废。
 */
export function cancelScheduledFill(): void {
  const w = window as IdleWindow
  for (const { handle } of pendingPageFills.values()) cancelIdleTask(w, handle)
  pendingPageFills.clear()
}
