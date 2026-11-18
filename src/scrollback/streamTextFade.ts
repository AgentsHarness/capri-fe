/**
 * 流式正文的「半透明淡入」模型（纯逻辑）。
 *
 * 网络文本块的节奏和大小都不可控：思考首包可能是几千字，慢流可能几百
 * 毫秒才来一个 token。按“到达块”淡入会让整块文字一起忽明忽暗，按“单字
 * 立即挂载”又会让首包同时起播几千个动画。这里用短缓冲把两件事解耦：
 *
 * - 新到文本先按字素进入 pending 队列；
 * - 每个动画帧从队头取出少量字素，挂成新的淡入片段；
 * - 取多少由显示延迟上限决定：慢流每帧 1 个字（真正的逐字淡入），大块
 *   在 STREAM_TEXT_MAX_LAG_MS / STREAM_TEXT_BURST_LAG_MS 内线性排空；
 * - 同一帧取出的字再按最多 STREAM_TEXT_MAX_SUB_PARTS 组错峰起播，避免
 *   大块文字在同一帧整块闪出。
 *
 * 思考块的尾窗会滑动（丢掉最旧的行、追加新行），所以更新时先求旧文本
 * 的后缀与新文本前缀的最长重合，只把真正的增量放进 pending。已显示片段
 * 与 pending 始终拼成最新文本。
 */

/** 单个淡入片段的动画时长上限（慢流用满）。 */
export const STREAM_TEXT_FADE_MS = 180
/** 高吞吐时淡入时长缩短到的下限：再短会像闪一下。 */
export const STREAM_TEXT_MIN_FADE_MS = 90
/** 同时处于半透明状态的字符目标上限（约两三行）。 */
export const STREAM_TEXT_FADE_TARGET_CHARS = 48
/** 普通流的最大显示滞后：短缓冲不会让正文明显落后于网络。 */
export const STREAM_TEXT_MAX_LAG_MS = 160
/** 首包 / 长段仍按短缓冲排空，但给淡入留出更长的铺开时间。 */
export const STREAM_TEXT_BURST_LAG_MS = 420
/** 新增文本超过该字数视为大块，走更长的铺开窗口。 */
export const STREAM_TEXT_BURST_CHARS = 240
/** 计算剩余帧数时使用的保守帧长。 */
export const STREAM_TEXT_FRAME_MS = 16
/** 同一帧释放的文字最多拆成几组错峰起播。 */
export const STREAM_TEXT_MAX_SUB_PARTS = 8
/** 同帧组间的错峰间隔；上限 14ms，不跨到下一帧。 */
export const STREAM_TEXT_SUB_STAGGER_MS = 2

/** 流式动画统一时钟：优先用单调时钟，测试环境退回 epoch 毫秒。 */
export function streamClockNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * 当前视图里所有淡入/排队文字完全落定的时刻（与 expiresAt 同一时钟）。
 * 没有正在淡入的片段与 pending 时返回 0。已过期的片段按已落定处理。
 */
export function streamViewSettledAt(
  view: StreamTextView,
  now = streamClockNow(),
): number {
  let at = 0
  for (const part of view.parts) {
    if (part.fading && part.expiresAt > now && part.expiresAt > at) {
      at = part.expiresAt
    }
  }
  if (view.pending.length > 0) {
    at = Math.max(
      at,
      view.deadline + STREAM_TEXT_FADE_MS + STREAM_TEXT_SUB_STAGGER_MS,
    )
  }
  return at
}

/**
 * 按本帧释放的字数选择淡入时长：高吞吐时缩短动画，把同时半透明的
 * 字符数压在目标附近，避免最新几行长期发灰；慢流仍用满 180ms。
 */
export function streamTextFadeMs(count: number): number {
  if (count <= 0) return STREAM_TEXT_FADE_MS
  const ideal =
    (STREAM_TEXT_FADE_TARGET_CHARS * STREAM_TEXT_FRAME_MS) / count
  return Math.round(
    Math.max(STREAM_TEXT_MIN_FADE_MS, Math.min(STREAM_TEXT_FADE_MS, ideal)),
  )
}

export type StreamTextPart = {
  id: number
  text: string
  /** false = 已完成淡入，可直接作为普通文本渲染。 */
  fading: boolean
  /** 该片段的动画完全结束时刻（epoch ms，按调用方时钟）。 */
  expiresAt: number
  /** 同一批片段的错峰延迟（ms）。 */
  delayMs: number
  /** 本片段淡入时长（ms）。 */
  durationMs: number
}

export type StreamTextView = {
  /** 上一次更新的目标文本（用于判断是否有变化）。 */
  source: string
  /** 已到达但尚未显示的文字，按字素切分。 */
  pending: string[]
  /** 已挂载的片段，拼接结果等于 source 去掉 pending 后的前缀。 */
  parts: StreamTextPart[]
  /** pending 需要在此时刻前排空；空队列时为 0。 */
  deadline: number
}

export const EMPTY_STREAM_TEXT_VIEW: StreamTextView = {
  source: '',
  pending: [],
  parts: [],
  deadline: 0,
}

let graphemeSegmenter: Intl.Segmenter | null | undefined

function segmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter
  graphemeSegmenter =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null
  return graphemeSegmenter
}

/**
 * 按字素切分：emoji / 组合字符不会被拆到两个 span 里。
 * 没有 Intl.Segmenter 的旧环境退回按码点切，至少不切坏代理对。
 */
export function splitStreamGraphemes(text: string): string[] {
  if (text === '') return []
  const seg = segmenter()
  if (!seg) return Array.from(text)
  return Array.from(seg.segment(text), (part) => part.segment)
}

/** 旧文本的某个后缀正好是新文本前缀时的最长长度（滑动尾窗用）。 */
function commonOverlap(oldText: string, nextText: string): number {
  if (nextText.startsWith(oldText)) return oldText.length
  const max = Math.min(oldText.length, nextText.length)
  for (let len = max; len > 0; len--) {
    if (oldText.endsWith(nextText.slice(0, len))) return len
  }
  return 0
}

/** 从字素队列头部丢掉 drop 个 UTF-16 码元（可能切进某个字素）。 */
function dropPendingPrefix(pending: string[], drop: number): string[] {
  if (drop <= 0) return pending
  let index = 0
  let rest = drop
  while (index < pending.length && rest > 0) {
    const grapheme = pending[index]
    if (grapheme.length <= rest) {
      rest -= grapheme.length
      index += 1
    } else {
      return [grapheme.slice(rest), ...pending.slice(index + 1)]
    }
  }
  return pending.slice(index)
}

/** 已过淡入窗口的片段合并成稳定文本，避免 span 随流式时长无限累积。 */
function settleParts(parts: StreamTextPart[], now: number): StreamTextPart[] {
  const out: StreamTextPart[] = []
  for (const part of parts) {
    const finished = !part.fading || part.expiresAt <= now
    if (!finished) {
      out.push(part)
      continue
    }
    const last = out[out.length - 1]
    if (last && !last.fading) {
      out[out.length - 1] = { ...last, text: last.text + part.text }
    } else {
      out.push(
        part.fading
          ? { ...part, fading: false, delayMs: 0, durationMs: 0 }
          : part,
      )
    }
  }
  return out
}

/**
 * 推进一步流式文本视图：吸收目标文本，并立刻释放第一批。
 * `makeId` 由组件层提供（模块内自增），保证 React key 稳定。
 */
export function advanceStreamTextView(
  prev: StreamTextView,
  text: string,
  now: number,
  makeId: () => number,
): StreamTextView {
  if (text === prev.source) return prev

  const keep = commonOverlap(prev.source, text)
  let drop = prev.source.length - keep

  // 从旧片段头部裁掉不属于重合后缀的部分（可能切进某个片段）。
  const kept: StreamTextPart[] = []
  for (const part of prev.parts) {
    if (drop <= 0) {
      kept.push(part)
      continue
    }
    if (part.text.length <= drop) {
      drop -= part.text.length
      continue
    }
    kept.push({ ...part, text: part.text.slice(drop) })
    drop = 0
  }

  // 片段已裁完，剩余的头裁落在尚未显示的字素队列上。
  let pending = drop > 0 ? dropPendingPrefix(prev.pending, drop) : prev.pending
  const appended = splitStreamGraphemes(text.slice(keep))
  if (appended.length > 0) pending = pending.concat(appended)

  const lag =
    appended.length > STREAM_TEXT_BURST_CHARS
      ? STREAM_TEXT_BURST_LAG_MS
      : STREAM_TEXT_MAX_LAG_MS
  const next: StreamTextView = {
    source: text,
    pending,
    parts: settleParts(kept, now),
    deadline:
      pending.length > 0 ? Math.max(now + lag, prev.deadline) : 0,
  }
  return releaseStreamTextView(next, now, makeId)
}

/**
 * 从 pending 队头释放一批文字。由组件的 rAF 循环调用；一次至少释放
 * 一个字素，直到队列排空。
 */
export function releaseStreamTextView(
  prev: StreamTextView,
  now: number,
  makeId: () => number,
): StreamTextView {
  if (prev.pending.length === 0) return prev

  const parts = settleParts(prev.parts, now)
  const remainingMs = Math.max(0, prev.deadline - now)
  const framesLeft = Math.max(
    1,
    Math.ceil(remainingMs / STREAM_TEXT_FRAME_MS),
  )
  const count = Math.min(
    prev.pending.length,
    Math.max(1, Math.ceil(prev.pending.length / framesLeft)),
  )
  const taken = prev.pending.slice(0, count)
  const pending = prev.pending.slice(count)

  // 同一帧的字按组错峰，组内仍是一小段；慢流 count=1 时就是单字片段。
  const groups = Math.min(STREAM_TEXT_MAX_SUB_PARTS, count)
  const perGroup = Math.ceil(count / groups)
  const durationMs = streamTextFadeMs(count)
  for (let start = 0; start < count; start += perGroup) {
    const groupIndex = start / perGroup
    const delayMs = groupIndex * STREAM_TEXT_SUB_STAGGER_MS
    parts.push({
      id: makeId(),
      text: taken.slice(start, start + perGroup).join(''),
      fading: true,
      delayMs,
      durationMs,
      expiresAt: now + delayMs + durationMs,
    })
  }

  return {
    ...prev,
    parts,
    pending,
    deadline: pending.length > 0 ? prev.deadline : 0,
  }
}
