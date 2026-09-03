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

/** flushLiteFills 不带参数调用时用的 store 句柄（store 初始化时登记）。 */
let activeStore: { set: SetState; get: () => ChatState } | null = null

export function registerHistoryFillStore(set: SetState, get: () => ChatState): void {
  activeStore = { set, get }
}

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
 * `''` = 不显示（没有欠正文的行）。`pending.loading.failed` = 还没去拉 /
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
    // 一条思考行的补全窗口是 [msgSeq, msgSeqEnd]。host 只在「连续
    // agent_thought_chunk」间合成，被 usage_update / 隐藏注入打断时留多条
    // run，而 FE 把它们并进了同一条目（指针不 seal）——窗口里会命中多段
    // run。只取第一段会把思考截成开头几行，必须按序拼回全部重叠片段。
    const end = e.msgSeqEnd ?? seq
    const covered = runs.filter((r) => r.msgSeq <= end && seq <= r.msgSeqEnd && r.text)
    if (covered.length === 0) return e
    const text = covered.map((r) => r.text).join('')
    if (!text) return e
    changed = true
    return { ...e, text, liteState: 'filled' as const }
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
 * 与 host `lite.go` `liteBodyKeys` + `file_matches` 对齐（投影时整键删除，
 * 不留 `{"omitted": n}`）。camelCase 是 FE 侧偶发的同一字段。
 */
const LITE_DELETED_BODY_KEYS = new Set([
  'output',
  'output_delta',
  'output_for_prompt',
  'content',
  'content_concise',
  'data',
  'stdout',
  'stderr',
  'new_string',
  'old_string',
  'plan_content',
  'file_matches',
  'fileMatches',
  'newString',
  'oldString',
  'contentConcise',
  'planContent',
])

/** host `liteLongStringBytes`：未知键长字符串按正文删。 */
const LITE_LONG_STRING_BYTES = 512

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * live 已经写过正文：具名正文键，或 ≥512 字节的未知字符串（host 会当正文删）。
 * 骨架里的 match_count / 短 URL citations / 裁空 `edits: [{}]` 都不是。
 */
function hasProjectedBody(v: unknown, budget = 256): boolean {
  if (budget <= 0 || v == null || liteStubIn(v)) return false
  if (typeof v === 'string') return jsonLen(v) >= LITE_LONG_STRING_BYTES
  if (Array.isArray(v)) return v.some((item) => hasProjectedBody(item, budget - 1))
  if (isPlainObj(v)) {
    for (const [k, iv] of Object.entries(v)) {
      if (iv == null || liteStubIn(iv)) continue
      if (LITE_DELETED_BODY_KEYS.has(k)) return true
      if (hasProjectedBody(iv, budget - 1)) return true
    }
  }
  return false
}

/** 字符串 / 数组 / 含字符串的对象算载荷；数字布尔不算（match_count 等标量）。 */
function isPayloadValue(v: unknown, budget = 8): boolean {
  if (budget <= 0 || v == null || liteStubIn(v)) return false
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.some((item) => isPayloadValue(item, budget - 1))
  if (isPlainObj(v)) return Object.values(v).some((item) => isPayloadValue(item, budget - 1))
  return false
}

/**
 * 快照是不是比骨架多出了可显示载荷（当前缺的键、或当前是 null 占位）。
 * 用来接住 host 预算整键删掉的未知数组（元素往往 <512，不算 hasProjectedBody）。
 */
function incomingHasExtraPayload(current: unknown, incoming: unknown, budget = 256): boolean {
  if (budget <= 0 || incoming == null || liteStubIn(incoming)) return false
  if (isPlainObj(incoming)) {
    const cur = isPlainObj(current) ? current : undefined
    for (const [k, iv] of Object.entries(incoming)) {
      if (iv == null || liteStubIn(iv)) continue
      const cv = cur?.[k]
      if (cv == null || liteStubIn(cv)) {
        if (isPayloadValue(iv)) return true
        continue
      }
      if (incomingHasExtraPayload(cv, iv, budget - 1)) return true
    }
    return false
  }
  if (Array.isArray(incoming)) {
    const curArr = Array.isArray(current) ? current : []
    if (incoming.some(isPayloadValue) && !curArr.some(isPayloadValue)) return true
    for (let i = 0; i < incoming.length; i++) {
      if (incomingHasExtraPayload(curArr[i], incoming[i], budget - 1)) return true
    }
  }
  return false
}

/** 当前没 live 正文、快照多出载荷 → 整段换成 full；已有正文则保护 live。 */
function incomingFillsLiteSkeleton(current: unknown, incoming: unknown): boolean {
  if (incoming == null || liteStubIn(incoming)) return false
  if (hasProjectedBody(current)) return false
  return hasProjectedBody(incoming) || incomingHasExtraPayload(current, incoming)
}

/**
 * 全量正文填回一份 raw，并抹掉 host 的 `_meta.lite` 标记——填完之后这份
 * raw 不再是占位（渲染与 toolDetail 的假空态判定都看这个标记）。
 */
function fillRaw(raw: ToolCall | undefined, body: ToolBody): ToolCall {
  const next: ToolCall = { ...(raw ?? {}) }
  // live-owned：这个载体上已经有一份不带占位的真实正文（live 事件续写进来的），
  // 而快照那一帧可能更旧 —— 不许覆盖。缺失、仍是 {omitted} 占位、或极致
  // lite 删光正文键只剩标量骨架时，都算还没拥有，用快照填。
  const owned = (key: 'rawOutput' | 'content') => {
    if (!(key in next)) return false
    const cur = (next as Record<string, unknown>)[key]
    if (liteStubIn(cur)) return false
    const has = key === 'rawOutput' ? body.hasRawOutput : body.hasContent
    const incoming = key === 'rawOutput' ? body.rawOutput : body.content
    if (has && incomingFillsLiteSkeleton(cur, incoming)) return false
    return true
  }
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
   * 整轮批量补全（主动点顶部进度图标）：不打行内 loading、失败静默，也不写
   * settled（用户手势的按需拉取要能重试）。同窗口的重复由 fillInflight 挡住。
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
    req.entryIds,
    // 批量补全的窗口由调用方给定（整轮 turnIndex 或 offset/limit），正文
    // 按 toolCallId 回填 → 不要求行内有坐标（host 透传回退的整页就没有坐标，
    // 那种页照样能补）。只有用户手势的区间补需要坐标来算窗口。
    req.win.turnIndex == null && !req.background,
  )
  if (ids.size === 0) return Promise.resolve()
  const running = fillInflight.get(key)
  if (running) return running
  if (!req.background) {
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
  // 批量补全不能被全局代际抖动否决：活跃会话里重连、自动选 host 近路、
  // pending 同步都会 bump sessionSwitchGen，而这跟「这些条目还在不在」毫无
  // 关系——一律按代际作废的结果就是忙会话永远补不上。改成认条目归属：
  // 发起会话没变 + 要填的那些行还在原视图里，就照填（行被重建过 →
  // id 全新一批 → 整包丢弃）。
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

  // 顶部进度图标的在途计数：只记批量补全（用户手势的行内 spinner 由
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
      // 失败：批量补全静默（下次展开仍会按需拉）；按需展开就地转错误行。
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
    // settled 只记用户手势的按需拉取：批量补全用 turn 窗口键，与区间键不
    // 相撞，但把它记进来会让「批量补失败过一次」看起来像已补全，后续展开
    // 的手势被 settled 挡掉，永远不再重试。
    if (!req.background) fillSettled.add(key)
  })()
  fillInflight.set(key, run)
  void run.finally(() => fillInflight.delete(key))
  if (req.background) {
    void run.finally(() =>
      set((s) => ({ liteFillBusy: Math.max(0, (s.liteFillBusy ?? 1) - 1) })),
    )
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
 * 从条目列表中提取出按轮次划分的未补全任务（每个包含待补全条目的轮次为一个任务）。
 */
export function collectLiteTurnJobs(
  entries: ScrollEntry[],
  sessionId: string,
  cwd: string,
  target?: FillTarget,
): {
  win: FillWindow
  entryIds: string[]
  sessionId: string
  cwd: string
  target?: FillTarget
}[] {
  if (!sessionId || !cwd || !entries.length) return []

  // 按 user 消息划分轮次（排除 shell 直执行行）
  const turns: ScrollEntry[][] = []
  let current: ScrollEntry[] = []
  for (const e of entries) {
    if (e.kind === 'user' && !e.isShell) {
      if (current.length > 0) turns.push(current)
      current = [e]
    } else {
      current.push(e)
    }
  }
  if (current.length > 0) turns.push(current)

  const jobs: {
    win: FillWindow
    entryIds: string[]
    sessionId: string
    cwd: string
    target?: FillTarget
  }[] = []

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const liteItems = turn.filter(
      (e) =>
        (e.kind === 'tool' || e.kind === 'thought') &&
        !!e.liteOmitted &&
        e.liteOmitted > 0 &&
        e.liteState !== 'filled',
    )
    if (liteItems.length === 0) continue

    let minSeq: number | undefined
    let maxSeq: number | undefined
    for (const item of liteItems) {
      if (item.msgSeq != null) {
        minSeq = minSeq == null ? item.msgSeq : Math.min(minSeq, item.msgSeq)
        const end = (item as { msgSeqEnd?: number }).msgSeqEnd ?? item.msgSeq
        maxSeq = maxSeq == null ? end : Math.max(maxSeq, end)
      }
    }

    if (minSeq != null && maxSeq != null) {
      jobs.push({
        win: { offset: minSeq, limit: maxSeq - minSeq + 1 },
        entryIds: liteItems.map((e) => e.id),
        sessionId,
        cwd,
        target,
      })
    } else {
      const reverseIdx = turns.length - i
      jobs.push({
        win: { turnIndex: Math.max(1, reverseIdx) },
        entryIds: liteItems.map((e) => e.id),
        sessionId,
        cwd,
        target,
      })
    }
  }

  return jobs
}

/**
 * 主动补全：算出当前视图里所有还欠正文的 lite 轮，按轮并发拉 detail=full
 * 回填（顶部进度图标的点击入口）。首屏不再自动跑这个——lite 页就是首屏，
 * 欠正文的行要么单行展开时按需补，要么用户点这里一次补齐全视图。
 */
export async function fillAllLiteTurns(
  set?: SetState,
  get?: () => ChatState,
): Promise<void> {
  const currentSet = typeof set === 'function' ? set : activeStore?.set
  const currentGet = typeof get === 'function' ? get : activeStore?.get
  if (!currentSet || !currentGet) return

  const s = currentGet()
  const sessionId = s.sessionId
  const cwd = s.cwd
  if (!sessionId || !cwd) return

  const jobMap = new Map<
    string,
    {
      win: FillWindow
      entryIds?: string[]
      sessionId: string
      cwd: string
      target?: FillTarget
    }
  >()

  // 1. 主滚动区 entries 里的所有 lite 轮
  for (const job of collectLiteTurnJobs(s.entries ?? [], sessionId, cwd)) {
    const key = windowKey(sessionId, job.win)
    if (!jobMap.has(key)) jobMap.set(key, job)
  }

  // 2. 子代理迷你视图 subagentViews 里的所有 lite 轮
  for (const [childSid, view] of Object.entries(s.subagentViews ?? {})) {
    const childJobs = collectLiteTurnJobs(view.items ?? [], sessionId, cwd, {
      childSessionId: childSid,
    })
    for (const job of childJobs) {
      const key = windowKey(childSid, job.win)
      if (!jobMap.has(key)) {
        jobMap.set(key, { ...job, sessionId })
      }
    }
  }

  const allJobs = [...jobMap.values()]
  if (allJobs.length === 0) return

  if (import.meta.env.DEV) {
    console.info(`[capri lite] 主动并发补全 ${allJobs.length} 个 lite 轮`)
  }

  await Promise.all(
    allJobs.map((job) =>
      fillToolBodies(currentSet, currentGet, {
        sessionId: job.sessionId,
        cwd: job.cwd,
        fetchSessionId: job.target?.childSessionId ?? job.sessionId,
        win: job.win,
        target: job.target,
        entryIds: job.entryIds,
        background: true,
      }),
    ),
  )
}
