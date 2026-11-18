/**
 * 任意块被折叠组收走时的退出动画判定（纯逻辑）：自动并入 run，或用户
 * 手动收起已展开的分组。
 *
 * 折叠组只渲染聚合头；被认领的工具行 / 思考行会从行列表消失，下方内容
 * 瞬间上跳，也看不出它被「收进组里」。这里对比前后两帧的 display rows，
 * 找出「上一帧仍单独可见、这一帧被折进折叠组」的块，交给视图层在旧位置
 * 补一行展开态快照（见 components/scrollback/AbsorbingEntryRow）。
 *
 * 工具行：参与折叠的原始形态是 collapsed（默认展开只是渲染补丁，不写回
 * store），所以「上一帧可见、这一帧被组藏起来」且折叠态没变就是入组；
 * 用户把展开的成员手动折回（mode 变化）不算。detailed 下编辑/命令逐条
 * 显示，探查类仍可能入组。
 *
 * 思考行：
 *  - 本帧刚结束流式（streaming true → false）并被认领；
 *  - 早已收口但组还没成形、一直单独可见，这一帧因工具补齐才进组。
 *
 * 以下情况不播：切会话或整批回放（epoch 变化）、上一帧本来就被组藏着。
 * 用户手动收起分组会播（成员消失前补一行退出快照）；手动展开分组不播
 * （成员本来就是「这一帧新出现」，由视图层的入场淡入负责）。
 */
import type { ScrollEntry } from '../api/types'
import { toolDisplayMode } from './entryState'
import { thoughtDisplayMode } from './thoughtMode'
import {
  displayRowKey,
  spanContaining,
  type DisplayRow,
  type GroupSpan,
} from './verbGroup'

export type AbsorbEntryInfo = {
  kind: 'tool' | 'thought'
  /** 归一后的折叠态（toolDisplayMode / thoughtDisplayMode）。 */
  mode: 'collapsed' | 'truncated' | 'expanded'
  streaming: boolean
  foldPinned: boolean
  /** 在 entries 里的下标（spanContaining 用）。 */
  index: number
}

export type AbsorbSnapshot = {
  /** 当前 display row key 顺序（含合成组头 id），用于给退出行定位。 */
  rowKeys: readonly string[]
  /** 当前作为独立行渲染的 entry id。 */
  visibleIds: ReadonlySet<string>
  entries: ReadonlyMap<string, AbsorbEntryInfo>
  /** 上一帧处于新块预览的工具 id：退出快照据此保留预览正文。 */
  previewIds: ReadonlySet<string>
  /** 会话 / 历史批次标识。 */
  epoch: string
}

export function buildAbsorbSnapshot(
  entries: readonly ScrollEntry[],
  rows: readonly DisplayRow[],
  epoch: string,
  previewIds: ReadonlySet<string> = new Set(),
): AbsorbSnapshot {
  const rowKeys: string[] = []
  const visibleIds = new Set<string>()
  for (const row of rows) {
    rowKeys.push(displayRowKey(row))
    if (row.type === 'entry') visibleIds.add(row.entry.id)
  }
  const infos = new Map<string, AbsorbEntryInfo>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.kind === 'tool') {
      infos.set(e.id, {
        kind: 'tool',
        mode: toolDisplayMode(e),
        streaming: false,
        foldPinned: !!e.foldPinned,
        index: i,
      })
    } else if (e.kind === 'thought') {
      infos.set(e.id, {
        kind: 'thought',
        mode: thoughtDisplayMode(e),
        streaming: !!e.streaming,
        foldPinned: !!e.foldPinned,
        index: i,
      })
    }
  }
  return { rowKeys, visibleIds, entries: infos, previewIds, epoch }
}

export type AbsorbPlacement = {
  id: string
  kind: 'tool' | 'thought'
  /** 插入到这个当前 display row 之后；null = 列表最前。 */
  afterKey: string | null
  /** 上一帧是否在流式（思考）：退出快照要继续铺完淡入。 */
  wasStreaming: boolean
  /** 上一帧是否被用户手动折过：退出行不套「默认展开」预览。 */
  foldPinned: boolean
}

/** 视图层的退出行：纯数据，供布局与 AbsorbingEntryRow 消费。 */
export type AbsorbingEntry = {
  /** 收口前的条目（补丁前的原始状态）。 */
  entry: ScrollEntry
  /** 插在这个当前显示行之后；null = 列表最前。 */
  afterKey: string | null
  /**
   * 退出快照的渲染补丁：工具走行内预览（truncated）；刚结束流式的
   * 思考用 streaming 快照继续铺完淡入。已收口的思考保持单行表头，
   * 用户手动钉过的折叠态不覆盖（undefined）。
   */
  patch?: Partial<ScrollEntry>
  /** 刚结束流式的思考：等正文淡入完全落定后再开始折。 */
  waitForFade: boolean
}

export function absorbPlacements(
  prev: AbsorbSnapshot,
  next: AbsorbSnapshot,
  spans: readonly GroupSpan[],
): AbsorbPlacement[] {
  if (prev.epoch !== next.epoch) return []

  const currentKeys = new Set(next.rowKeys)
  const out: AbsorbPlacement[] = []
  for (const [id, info] of next.entries) {
    if (next.visibleIds.has(id)) continue
    const was = prev.entries.get(id)
    if (!was || !prev.visibleIds.has(id)) continue
    const span = spanContaining(spans, info.index)
    if (!span || span.expanded) continue

    if (info.kind === 'tool') {
      // 原始折叠态没变才是「被组收走」；展开成员被用户折回不算。
      if (was.mode !== 'collapsed' || info.mode !== 'collapsed') continue
    } else {
      const justStreamed = was.streaming && !info.streaming
      // 早已处于折叠态、上一帧只是因为组还没成形才可见：现在进组同样要收。
      const groupedLater =
        !was.streaming &&
        !info.streaming &&
        was.mode === 'collapsed' &&
        info.mode === 'collapsed'
      if (!justStreamed && !groupedLater) continue
    }

    const place = placementAfter(prev.rowKeys, currentKeys, id, span)
    out.push({
      id,
      kind: info.kind,
      afterKey: place,
      wasStreaming: was.streaming,
      foldPinned: was.foldPinned,
    })
  }
  // 多个退出行按上一帧的行序排列，插在同一个锚点后时顺序才稳定。
  out.sort((a, b) => prev.rowKeys.indexOf(a.id) - prev.rowKeys.indexOf(b.id))
  return out
}

/**
 * 退出行落位：
 *  - 组头这一帧才出现（新组）：放到组头之前，按上一帧的左邻定位；
 *  - 组头上一帧就在（并入已有组）：放到组头/仍可见成员之后；
 *  - 其余按最近存活左邻兜底。
 *
 * 不把新组的第二、第三个块塞到组头后面：组头插入会把它们整体往下顶
 * 一行，折起动作起手就有一帧跳动。
 */
function placementAfter(
  prevKeys: readonly string[],
  currentKeys: ReadonlySet<string>,
  id: string,
  span: GroupSpan,
): string | null {
  const idx = prevKeys.indexOf(id)
  const headerKey = `gh_${span.anchorId}`
  const headerExisted = prevKeys.includes(headerKey)

  if (headerExisted) {
    const immediate = idx > 0 ? prevKeys[idx - 1] : undefined
    if (immediate != null && currentKeys.has(immediate)) return immediate
    if (currentKeys.has(headerKey)) return headerKey
    for (let i = idx - 2; i >= 0; i--) {
      const key = prevKeys[i]
      if (currentKeys.has(key)) return key
    }
    return null
  }

  // 新组：优先落在离原位置最近的存活行之后（组头在这些行之后）。
  if (idx > 0) {
    for (let i = idx - 1; i >= 0; i--) {
      const key = prevKeys[i]
      if (currentKeys.has(key)) return key
    }
  }
  return null
}
