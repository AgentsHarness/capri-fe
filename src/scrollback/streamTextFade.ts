/**
 * 流式正文的「半透明淡入」分段模型（纯逻辑）。
 *
 * 每来一段新文本，把它作为独立片段挂到视图尾部，片段从半透明淡入到
 * 不透明；已过淡入窗口的片段合并成稳定文本，DOM 节点数不会随流式时长
 * 无限增长。
 *
 * 思考块的尾窗会滑动（丢掉最旧的行、追加新行），所以更新时先求旧文本
 * 的后缀与新文本前缀的最长重合，只把真正的增量当新片段。
 */

/** 稳定流的小增量淡入时长：只让最新一小段微透，不会压暗整行。 */
export const STREAM_TEXT_FADE_MS = 160
/** 大首包（thinking 的首包常占整段 85–99%）用更长的淡入，保证看得出效果。 */
export const STREAM_TEXT_BULK_FADE_MS = 420
/** 大首包按行/长度切成多个片段时的入场间隔。 */
export const STREAM_TEXT_STAGGER_MS = 35
/** 错峰延迟上限：超大首包也不会让后面的片段等上几秒才出现。 */
export const STREAM_TEXT_MAX_STAGGER_MS = 240
/** 单个淡入片段的最大字符数：大首包切段后是逐行渐显，而不是整块闪。 */
export const STREAM_TEXT_MAX_PART_CHARS = 120
/** 新增文本超过该长度视为“大首包”，整批走错峰淡入。 */
export const STREAM_TEXT_BULK_CHARS = STREAM_TEXT_MAX_PART_CHARS * 2

export type StreamTextPart = {
  id: number
  text: string
  /** false = 已完成淡入，可直接作为普通文本渲染。 */
  fading: boolean
  /** 该片段的动画完全结束时刻（epoch ms，按调用方时钟）。 */
  expiresAt: number
  /** 同一批片段的错峰延迟（ms）。 */
  delayMs: number
  /** 本片段淡入时长（ms）；大首包与稳定流小增量不同。 */
  durationMs: number
}

export type StreamTextView = {
  /** 上一次更新的目标文本（用于判断是否有变化）。 */
  source: string
  parts: StreamTextPart[]
}

export const EMPTY_STREAM_TEXT_VIEW: StreamTextView = { source: '', parts: [] }

/** 把新到文本切成适合淡入的小段：优先在换行处切，长行再按长度切。 */
export function splitStreamFadeParts(text: string): string[] {
  if (text === '') return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' || i - start + 1 >= STREAM_TEXT_MAX_PART_CHARS) {
      out.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
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

/**
 * 推进一步流式文本视图。
 * `makeId` 由组件层提供（模块内自增），保证 React key 稳定。
 */
export function advanceStreamTextView(
  prev: StreamTextView,
  text: string,
  now: number,
  makeId: () => number,
): StreamTextView {
  if (text === prev.source) return prev

  // parts 的拼接恒等于 source，直接用 source 免去每次 join 整个长回复。
  const oldText = prev.source
  const keep = commonOverlap(oldText, text)

  // 从旧片段头部裁掉不属于重合后缀的部分（可能切进某个片段）。
  let drop = oldText.length - keep
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

  // 已过淡入窗口的片段合并为稳定文本，避免 span 无限累积。
  const parts: StreamTextPart[] = []
  for (const part of kept) {
    if (!part.fading || part.expiresAt <= now) {
      const last = parts[parts.length - 1]
      if (last && !last.fading) last.text += part.text
      else parts.push({ ...part, fading: false, delayMs: 0, durationMs: 0 })
    } else {
      parts.push(part)
    }
  }

  const appended = text.slice(keep)
  const bulk = appended.length > STREAM_TEXT_BULK_CHARS
  const fadeMs = bulk ? STREAM_TEXT_BULK_FADE_MS : STREAM_TEXT_FADE_MS
  const staggerMs = bulk ? STREAM_TEXT_STAGGER_MS : 0
  splitStreamFadeParts(appended).forEach((piece, i) => {
    const delayMs = Math.min(i * staggerMs, STREAM_TEXT_MAX_STAGGER_MS)
    parts.push({
      id: makeId(),
      text: piece,
      fading: true,
      delayMs,
      durationMs: fadeMs,
      expiresAt: now + delayMs + fadeMs,
    })
  })

  return { source: text, parts }
}
