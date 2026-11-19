/**
 * 新块预览的停留窗口（纯逻辑）。
 *
 * 默认折叠的新工具块在运行中会展开正文预览；结束后再从 `finishedAt` 起
 * 停留 `holdMs`，到点撤销预览。这个窗口与当前密度是否会把该块收进折叠组
 * 无关：命令在 diff focus、编辑/命令在 balanced 下不入组，同样按这个时长
 * 预览后收回一行。默认展开的块（detailed 的编辑/命令、diff focus 的编辑）
 * 不参与预览。
 *
 * 用户手动折叠（`foldPinned`）或手动展开（displayMode 不再是 collapsed）
 * 的块立即退出预览，手动收起应当立刻生效。手动收起分组时，调用方把该组
 * 里已有的工具 id 放进 suppressed，避免它们在停留窗口内被重新展开/留在
 * 原地。
 */
import type { ScrollEntry } from '../api/types'
import type { ToolCallDensity } from '../api/transport'
import { entryRunning, toolDisplayMode } from './entryState'
import { toolDefaultDisplay } from './toolDefault'

/** 预览停留默认时长（fePrefs.groupHoldMs 的默认值）。 */
export const GROUP_HOLD_DEFAULT_MS = 1000
/** 可配置范围：0 = 不预览，结束后立即收回。 */
export const GROUP_HOLD_MIN_MS = 0
export const GROUP_HOLD_MAX_MS = 5000

/** 把存储/用户给的停留时长夹到支持范围；非法值回落默认。 */
export function clampGroupHoldMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return GROUP_HOLD_DEFAULT_MS
  }
  return Math.min(
    GROUP_HOLD_MAX_MS,
    Math.max(GROUP_HOLD_MIN_MS, Math.round(value)),
  )
}

export type PreviewHold = {
  /** 当前处于预览停留窗口、需要保持可见的工具 id。 */
  ids: ReadonlySet<string>
  /** 最近一个停留窗口到期的 epoch ms；null = 没有需要唤醒的计时。 */
  nextAt: number | null
}

const NONE: ReadonlySet<string> = new Set()

/**
 * 当前应套「新块预览」的工具 id。
 *
 * 资格只看块自身的默认形态与时间窗，不看它是否已经/将要入组：
 *  - 当前密度下默认折叠；
 *  - 用户没有手动折叠/展开过；
 *  - 运行中，或结束后仍在 `holdMs` 窗口内。
 *
 * 已完成但没有 `finishedAt` 的块不预览：回放路径（replayUpdates / 历史
 * 分页收口）不盖这个时间戳，只有直播中新收口的块算「刚结束的新块」。
 */
export function previewToolIds(
  entries: readonly ScrollEntry[],
  now: number,
  holdMs: number,
  density: ToolCallDensity,
  suppressed?: ReadonlyMap<string, number>,
): PreviewHold {
  if (holdMs <= 0) return { ids: NONE, nextAt: null }

  const ids = new Set<string>()
  let nextAt: number | null = null
  for (const e of entries) {
    if (e.kind !== 'tool') continue
    if (e.foldPinned) continue
    if (toolDisplayMode(e) !== 'collapsed') continue
    if (toolDefaultDisplay(e.kindName, density) !== 'collapsed') continue
    const until = suppressed?.get(e.id)
    if (until != null && until > now) continue

    if (entryRunning(e)) {
      ids.add(e.id)
      continue
    }
    if (e.finishedAt == null) continue
    const expireAt = e.finishedAt + holdMs
    if (expireAt <= now) continue
    ids.add(e.id)
    if (nextAt == null || expireAt < nextAt) nextAt = expireAt
  }
  return { ids, nextAt }
}
