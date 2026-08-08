/**
 * Accent + bullet resolution — TUI BlockContent::accent / ::bullet matrix
 * (EntryRenderer finish flash / collapsed dim / pending freeze). Split out of
 * AccentRail.tsx so that file exports components only (Fast Refresh).
 */
import { toolFamily, type ToolFamily } from './toolFamily'
import {
  DIM_ACCENT,
  FINISH_FLASH_MS,
  WAVE_ROWS,
  WAVE_SPEED,
  blendColor,
  waveBrightness,
} from './wave'

export const Accents = {
  running: 'var(--color-gn-accent-running)',
  tool: 'var(--color-gn-accent-tool)',
  success: 'var(--color-gn-accent-success)',
  error: 'var(--color-gn-accent-error)',
  thinking: 'var(--color-gn-accent-thinking)',
  thinkingDefault: 'var(--color-gn-gray-dim)', // ThinkingConfig.accent default
  plan: 'var(--color-gn-accent-plan)',
  warning: 'var(--color-gn-warning)',
  gray: 'var(--color-gn-gray)',
  grayDim: 'var(--color-gn-gray-dim)',
  bg: 'var(--color-gn-bg-base)',
} as const

/** Hover vs selected — color only; never changes rail height. */
export type AccentInteraction = 'idle' | 'hover' | 'selected'

export type AccentPaint = {
  /** Whether the rail column is painted at all. */
  show: boolean
  color: string
  animated: boolean
  /** Freeze wave (pending user input) — solid full color. */
  frozen?: boolean
  /**
   * Short centered tick (❙) for idle collapsed dense rows.
   * Height must stay within the entry/SelectionBox — never grow on hover/select.
   */
  collapsedGlyph?: boolean
  /** Blend color with bg at DIM_ACCENT (idle collapsed). */
  dim?: boolean
  /** Preselect / selected emphasis (color only). */
  interaction?: AccentInteraction
}

export type AccentResolveOpts = {
  kind: string
  /** ACP tool kind string → family. */
  kindName?: string
  toolFamily?: ToolFamily
  running?: boolean
  failed?: boolean
  /** Expanded / truncated (not collapsed). */
  expanded?: boolean
  selected?: boolean
  /** Hover pre-select (EntryShell). */
  hovered?: boolean
  /** Epoch ms when tool/thought finished — enables finish flash. */
  finishedAt?: number
  /** Now override (tests). */
  now?: number
  /** Session has pending permission → freeze running wave. */
  pendingFreeze?: boolean
  // ── specialized entry kinds ──────────────────────────────────────
  subagentStatus?: 'started' | 'completed' | 'failed' | 'cancelled'
  workflowStatus?: 'running' | 'done' | 'failed' | 'cancelled' | 'paused'
  /** bg_task row status (live rows: running set; history rows: static). */
  bgTaskStatus?: 'started' | 'completed' | 'failed'
  sessionEvent?: { recap?: boolean; warning?: boolean }
  groupHeader?: {
    variant: 'truncation' | 'verb'
    running?: boolean
    failed?: boolean
  }
  /** Entry is a visible member of a group (expanded verb / truncation tail). */
  inGroup?: boolean
}

/**
 * Apply hover/selected color emphasis without changing rail height.
 * selected > hover > idle (dim).
 */
function withInteraction(
  paint: AccentPaint,
  selected: boolean,
  hovered: boolean,
): AccentPaint {
  if (!paint.show) return paint
  if (selected) {
    return { ...paint, dim: false, interaction: 'selected' }
  }
  if (hovered) {
    // Keep collapsedGlyph as-is (same height as idle); only color shifts.
    return { ...paint, dim: false, interaction: 'hover' }
  }
  return { ...paint, interaction: 'idle' }
}

/**
 * Full TUI accent matrix (BlockContent::accent + EntryRenderer finish flash /
 * collapsed dim / pending freeze).
 *
 * Height follows content mode only (collapsed short tick vs expanded full rail).
 * Hover/selected never grow the rail — they only change color.
 */
export function resolveAccent(opts: AccentResolveOpts): AccentPaint {
  const {
    kind,
    running = false,
    failed = false,
    expanded = false,
    selected = false,
    hovered = false,
    finishedAt,
    now = Date.now(),
    pendingFreeze = false,
  } = opts

  const family = opts.toolFamily ?? toolFamily(opts.kindName)
  const flashing =
    finishedAt != null &&
    !running &&
    now - finishedAt < FINISH_FLASH_MS &&
    (kind === 'tool' || kind === 'thought')

  let paint: AccentPaint

  // ── Finish flash (tools + thinking) ────────────────────────────────
  // Tools without a natural accent (Read etc.) flash accent_success green.
  // Thinking flashes accent_thinking (magenta). Execute uses success/error.
  // Collapsed height stays short (content mode) — not toggled by selection.
  if (flashing) {
    if (kind === 'thought') {
      // Collapsed stays short (content mode) — flash only swaps color,
      // mirroring execute's `collapsedGlyph: !expanded`.
      paint = {
        show: true,
        color: Accents.thinking,
        animated: false,
        collapsedGlyph: !expanded,
      }
      return withInteraction(paint, selected, hovered)
    }
    if (kind === 'tool') {
      if (family === 'execute') {
        paint = {
          show: true,
          color: failed ? Accents.error : Accents.success,
          animated: false,
          collapsedGlyph: !expanded,
        }
        return withInteraction(paint, selected, hovered)
      }
      if (family === 'standard') {
        paint = {
          show: true,
          color: failed ? Accents.error : Accents.tool,
          animated: false,
        }
        return withInteraction(paint, selected, hovered)
      }
      paint = {
        show: true,
        color: failed ? Accents.error : Accents.success,
        animated: false,
      }
      return withInteraction(paint, selected, hovered)
    }
  }

  // ── Group header ───────────────────────────────────────────────────
  if (kind === 'group_header' && opts.groupHeader) {
    const gh = opts.groupHeader
    if (gh.variant === 'verb') {
      if (gh.failed) {
        paint = { show: true, color: Accents.error, animated: false }
        return withInteraction(paint, selected, hovered)
      }
      if (gh.running) {
        paint = {
          show: true,
          color: Accents.tool,
          animated: true,
          frozen: pendingFreeze,
        }
        return withInteraction(paint, selected, hovered)
      }
      // idle verb-run header: short tick (content mode); color via interaction
      paint = {
        show: true,
        color: Accents.tool,
        animated: false,
        collapsedGlyph: true,
        dim: true,
      }
      return withInteraction(paint, selected, hovered)
    }
    // truncation "N more"
    paint = {
      show: true,
      color: Accents.tool,
      animated: false,
      collapsedGlyph: true,
      dim: true,
    }
    return withInteraction(paint, selected, hovered)
  }

  // ── Subagent ───────────────────────────────────────────────────────
  if (kind === 'subagent') {
    const st = opts.subagentStatus
    if (st === 'started' && running) {
      return withInteraction(
        { show: true, color: Accents.running, animated: false },
        selected,
        hovered,
      )
    }
    return { show: false, color: 'transparent', animated: false }
  }

  // ── Workflow ───────────────────────────────────────────────────────
  if (kind === 'workflow') {
    if (opts.workflowStatus === 'running' && running) {
      return withInteraction(
        { show: true, color: Accents.running, animated: false },
        selected,
        hovered,
      )
    }
    return { show: false, color: 'transparent', animated: false }
  }

  // ── Session event ──────────────────────────────────────────────────
  if (kind === 'session_event') {
    const se = opts.sessionEvent
    if (se?.warning) {
      return withInteraction(
        { show: true, color: Accents.warning, animated: false },
        selected,
        hovered,
      )
    }
    if (se?.recap) {
      if (running) {
        return withInteraction(
          {
            show: true,
            color: Accents.gray,
            animated: true,
            frozen: pendingFreeze,
          },
          selected,
          hovered,
        )
      }
      if (expanded) {
        return withInteraction(
          { show: true, color: Accents.tool, animated: false },
          selected,
          hovered,
        )
      }
      return { show: false, color: 'transparent', animated: false }
    }
    return { show: false, color: 'transparent', animated: false }
  }

  // ── Credit limit ───────────────────────────────────────────────────
  if (kind === 'credit_limit') {
    return withInteraction(
      { show: true, color: Accents.warning, animated: false },
      selected,
      hovered,
    )
  }

  // ── Plan (FE-only chrome; gold bar) ─────────────────────────────────
  if (kind === 'plan') {
    return withInteraction(
      { show: true, color: Accents.plan, animated: false },
      selected,
      hovered,
    )
  }

  // ── Error entry ────────────────────────────────────────────────────
  if (kind === 'error') {
    return withInteraction(
      { show: true, color: Accents.error, animated: false },
      selected,
      hovered,
    )
  }

  // ── User / assistant / status — never ──────────────────────────────
  if (kind === 'user' || kind === 'assistant' || kind === 'status') {
    return { show: false, color: 'transparent', animated: false }
  }

  // ── Thought ────────────────────────────────────────────────────────
  // ThinkingConfig: accent = gray_dim default; collapsed → none;
  // running + animate → animated; else static.
  if (kind === 'thought') {
    if (!expanded && !running) {
      // Collapsed idle thought: no rail standalone; inside a group the
      // dense rows share the short centered tick (like group headers).
      if (opts.inGroup) {
        return withInteraction(
          {
            show: true,
            color: Accents.thinkingDefault,
            animated: false,
            collapsedGlyph: true,
            dim: true,
          },
          selected,
          hovered,
        )
      }
      return { show: false, color: 'transparent', animated: false }
    }
    if (running) {
      return withInteraction(
        {
          show: true,
          color: Accents.thinkingDefault,
          animated: true,
          frozen: pendingFreeze,
        },
        selected,
        hovered,
      )
    }
    return withInteraction(
      {
        show: true,
        color: Accents.thinkingDefault,
        animated: false,
      },
      selected,
      hovered,
    )
  }

  // ── Tool ───────────────────────────────────────────────────────────
  if (kind === 'tool') {
    return withInteraction(
      resolveToolAccent({
        family,
        running,
        failed,
        expanded,
        pendingFreeze,
      }),
      selected,
      hovered,
    )
  }

  // ── Bg task (same rail rules as subagent started) ──────────────────
  if (kind === 'bg_task') {
    if (running) {
      return withInteraction(
        { show: true, color: Accents.running, animated: false },
        selected,
        hovered,
      )
    }
    return { show: false, color: 'transparent', animated: false }
  }

  return { show: false, color: 'transparent', animated: false }
}

function resolveToolAccent(o: {
  family: ToolFamily
  running: boolean
  failed: boolean
  expanded: boolean
  pendingFreeze: boolean
}): AccentPaint {
  const { family, running, failed, expanded, pendingFreeze } = o

  // Read / Search / ListDir — never
  if (family === 'never') {
    return { show: false, color: 'transparent', animated: false }
  }

  // Edit — default no rail (appearance.edit.accent unset)
  if (family === 'edit') {
    return { show: false, color: 'transparent', animated: false }
  }

  // Execute — always when enabled; success green.
  // Height: short tick only when collapsed (content mode) — not selection.
  if (family === 'execute') {
    let color: string = Accents.success
    let animated = false
    if (failed) color = Accents.error
    else if (running) {
      color = Accents.running
      animated = true
    }
    const collapsed = !expanded
    return {
      show: true,
      color,
      animated,
      frozen: animated && pendingFreeze,
      collapsedGlyph: collapsed && !animated,
      dim: collapsed,
    }
  }

  // Standard (Other / Web* / MCP / …)
  // collapsed → none; error/running/expanded → rail
  if (!expanded && !running && !failed) {
    return { show: false, color: 'transparent', animated: false }
  }
  // failed while collapsed: TUI still has no rail (error only on bullet)
  if (!expanded && !running && failed) {
    return { show: false, color: 'transparent', animated: false }
  }
  if (failed) {
    return { show: true, color: Accents.error, animated: false }
  }
  if (running) {
    return {
      show: true,
      color: Accents.running,
      animated: true,
      frozen: pendingFreeze,
    }
  }
  // expanded done
  return { show: true, color: Accents.tool, animated: false }
}

/** Bullet color style — TUI BlockContent::bullet (often independent of rail). */
export type BulletPaint = {
  color: string
  animated?: boolean
}

export function resolveBullet(opts: AccentResolveOpts): BulletPaint {
  const {
    kind,
    running = false,
    failed = false,
    expanded = false,
    pendingFreeze = false,
  } = opts
  const family = opts.toolFamily ?? toolFamily(opts.kindName)

  if (kind === 'thought') {
    if (running) {
      return {
        color: Accents.thinkingDefault,
        animated: !pendingFreeze,
      }
    }
    return { color: Accents.gray } // default muted
  }

  if (kind === 'tool') {
    if (failed) return { color: Accents.error }
    if (family === 'execute') {
      if (running) return { color: Accents.running, animated: !pendingFreeze }
      return { color: Accents.success }
    }
    if (family === 'never' || family === 'edit') {
      // default gray/primary; no special accent
      return { color: expanded ? Accents.gray : Accents.grayDim }
    }
    // standard
    if (running) return { color: Accents.running, animated: !pendingFreeze }
    if (expanded) return { color: Accents.tool }
    return { color: Accents.grayDim }
  }

  if (kind === 'subagent') {
    const st = opts.subagentStatus
    if (st === 'started' && running) {
      return { color: Accents.running, animated: !pendingFreeze }
    }
    if (st === 'completed') return { color: Accents.success }
    if (st === 'failed' || st === 'cancelled') return { color: Accents.error }
    return { color: Accents.gray }
  }

  if (kind === 'workflow') {
    const st = opts.workflowStatus
    if (st === 'running' && running) {
      return { color: Accents.running, animated: !pendingFreeze }
    }
    if (st === 'done') return { color: Accents.success }
    if (st === 'failed') return { color: Accents.error }
    if (st === 'cancelled') return { color: Accents.grayDim }
    if (st === 'paused') return { color: Accents.warning }
    return { color: Accents.gray }
  }

  if (kind === 'bg_task') {
    if (running) return { color: Accents.running, animated: !pendingFreeze }
    if (failed) return { color: Accents.error }
    // Historical started row (replay, not captured): keep the live
    // started look — cyan bullet, static (no spinner — it is settled).
    if (opts.bgTaskStatus === 'started') {
      return { color: Accents.running, animated: false }
    }
    return { color: Accents.success }
  }

  if (kind === 'error') return { color: Accents.error }
  if (kind === 'group_header') {
    const gh = opts.groupHeader
    if (gh?.failed) return { color: Accents.error }
    if (gh?.running) return { color: Accents.tool, animated: true }
    return { color: Accents.gray }
  }

  return { color: Accents.gray }
}
