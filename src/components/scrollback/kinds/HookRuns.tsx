/**
 * Hook runs rendering — TUI `scrollback/blocks/tool/hook.rs` view port.
 *
 * Folded: a colored count suffix rides the host row — `[hooks: 2/1]` on a tool
 * line, the fully labeled `[hooks: 1 ok, 1 blocked, 1 failed]` on a group
 * header (which cannot show member detail), `stop  [hooks: 2]` right-justified
 * on a turn-terminal marker.
 *
 * Expanded: a `───` separator then one section per phase, one line per run,
 * with error / blocked-detail / output lines clipped to 120 columns × 3 lines.
 * A section whose runs were all skipped renders nothing (TUI
 * `render_hooks_expanded`), while an individual skipped run inside a live
 * section still shows as `- <name> skipped`.
 */
import { Check, CornerDownLeft, Minus, X } from 'lucide-react'
import type {
  HookCounts,
  HookGroup,
  HookRun,
  HookSuffixPart,
  ToolHookData,
} from '../../../api/types'
import {
  cleanHookError,
  countHookRuns,
  hookCountsTotal,
  hookElapsedLabel,
  hookSuffixParts,
  hookSuffixText,
  hookTextLines,
  stopHookSummaryParts,
  type HookCountShape,
} from '../../../scrollback/hookRuns'
import { Accents } from '../../../theme/accents'
import {
  DETAIL_SUB_TEXT_PAD_CLASS,
  DETAIL_TEXT_PAD_CLASS,
} from '../../../theme/layout'
import { RowIcon } from '../EntryShell'

const TONE_COLOR: Record<HookSuffixPart['tone'], string> = {
  muted: Accents.grayDim,
  success: Accents.success,
  blocked: Accents.running,
  error: Accents.error,
}

function HookSuffixPartsView({ parts }: { parts: HookSuffixPart[] }) {
  return (
    <span
      className="shrink-0 whitespace-pre font-mono text-[12px] leading-[1.35] opacity-80"
      title={hookSuffixText(parts)}
    >
      {parts.map((p, i) => (
        <span
          key={i}
          className={p.bold ? 'font-bold' : undefined}
          style={{ color: TONE_COLOR[p.tone] }}
        >
          {p.text}
        </span>
      ))}
    </span>
  )
}

/** `[hooks: 2/1]` (rows) / `[hooks: 1 ok, 1 blocked, 1 failed]` (group heads). */
export function HookCountSuffix({
  counts,
  shape = 'compact',
  className = '',
}: {
  counts: HookCounts
  shape?: HookCountShape
  className?: string
}) {
  const parts = hookSuffixParts(counts, shape)
  if (!parts) return null
  return (
    <span className={className}>
      <HookSuffixPartsView parts={parts} />
    </span>
  )
}

/** Tool row suffix — counts across both phases. */
export function ToolHookSuffix({ data }: { data: ToolHookData | undefined }) {
  if (!data) return null
  return <HookCountSuffix counts={hookCounts(data)} />
}

function hookCounts(data: ToolHookData): HookCounts {
  const a = countHookRuns(data.pre)
  const b = countHookRuns(data.post)
  return {
    success: a.success + b.success,
    blocked: a.blocked + b.blocked,
    failed: a.failed + b.failed,
  }
}

/** Turn-marker summary: `stop  [hooks: 2]` per group, two spaces between. */
export function StopHookSummary({ groups }: { groups: HookGroup[] }) {
  const parts = stopHookSummaryParts(groups)
  if (!parts) return null
  return <HookSuffixPartsView parts={parts} />
}

// ── expanded detail ──────────────────────────────────────────────────

/** TUI `render_separator` — three `─` (U+2500) on the tool-detail text column. */
function HookSeparator() {
  return (
    <div
      className={`${DETAIL_TEXT_PAD_CLASS} font-mono text-[12px] leading-[1.4] text-gn-gray-dim`}
      aria-hidden
    >
      {'───'}
    </div>
  )
}

function HookRunLine({ run }: { run: HookRun }) {
  const st = run.status
  const icon =
    st.type === 'success' ? (
      <RowIcon Icon={Check} color={Accents.success} />
    ) : st.type === 'failed' ? (
      <RowIcon Icon={X} color={Accents.error} />
    ) : st.type === 'blocked' ? (
      // blocked is the ↩ (U+21A9) shape in the running colour — a stop-gate
      // verdict, not an error, so it never goes red.
      <RowIcon Icon={CornerDownLeft} color={Accents.running} />
    ) : (
      <RowIcon Icon={Minus} color={Accents.grayDim} />
    )
  const detail =
    st.type === 'failed'
      ? cleanHookError(st.error, run.name)
      : st.type === 'blocked'
        ? st.detail
        : ''
  return (
    <>
      <div
        className={`flex min-w-0 items-center gap-1 ${DETAIL_TEXT_PAD_CLASS} font-mono text-[12px] leading-[1.4]`}
      >
        {icon}
        <span className="min-w-0 truncate text-gn-muted">{run.name}</span>
        {st.type === 'skipped' ? (
          <span className="shrink-0 text-gn-muted">skipped</span>
        ) : (
          <span className="shrink-0 text-gn-gray-dim">
            {hookElapsedLabel(st.elapsedMs)}
          </span>
        )}
      </div>
      {detail
        ? hookTextLines(detail).map((line, i) => (
            <div
              key={`d${i}`}
              className={`whitespace-pre-wrap break-words ${DETAIL_SUB_TEXT_PAD_CLASS} font-mono text-[12px] leading-[1.4]`}
              style={{
                color: st.type === 'blocked' ? Accents.running : Accents.error,
              }}
            >
              {line}
            </div>
          ))
        : null}
      {run.output
        ? hookTextLines(run.output).map((line, i) => (
            <div
              key={`o${i}`}
              className={`whitespace-pre-wrap break-words ${DETAIL_SUB_TEXT_PAD_CLASS} font-mono text-[12px] leading-[1.4] text-gn-muted`}
            >
              {line}
            </div>
          ))
        : null}
    </>
  )
}

/**
 * One hook section: bold muted event name + its runs. Renders nothing when the
 * whole batch was skipped.
 */
function HookSection({
  event,
  runs,
  showHeader = true,
}: {
  event: string
  runs: HookRun[]
  showHeader?: boolean
}) {
  if (hookCountsTotal(countHookRuns(runs)) === 0) return null
  return (
    <div className="py-0.5">
      {showHeader ? (
        <div
          className={`${DETAIL_TEXT_PAD_CLASS} text-[12px] font-bold leading-[1.4] text-gn-muted`}
        >
          {event}
        </div>
      ) : null}
      {runs.map((run, i) => (
        <HookRunLine key={`${run.name}-${i}`} run={run} />
      ))}
    </div>
  )
}

/** Expanded hook detail of a tool row (separator + pre + post). */
export function ToolHookDetail({
  data,
  separator = true,
}: {
  data: ToolHookData
  separator?: boolean
}) {
  const pre = data.pre ?? []
  const post = data.post ?? []
  const hasPre = hookCountsTotal(countHookRuns(pre)) > 0
  const hasPost = hookCountsTotal(countHookRuns(post)) > 0
  if (!hasPre && !hasPost) return null
  return (
    <div>
      {separator ? <HookSeparator /> : null}
      {hasPre ? <HookSection event="pre_tool_use" runs={pre} /> : null}
      {hasPost ? <HookSection event="post_tool_use" runs={post} /> : null}
    </div>
  )
}

/**
 * Expanded detail for named groups (lifecycle row / turn-terminal marker).
 * A single group omits its header — the host row already shows that event name
 * (TUI `render_hooks_detail`); two or more keep their headers so `stop_failure`
 * and `stop` read apart.
 */
export function HookGroupsDetail({ groups }: { groups: HookGroup[] }) {
  const shown = groups.filter(
    (g) => hookCountsTotal(countHookRuns(g.runs)) > 0,
  )
  if (!shown.length) return null
  // TUI `stop_hooks.len() > 1` — 按原始组数判定，含全 skipped 组。
  const multiple = groups.length > 1
  return (
    <div>
      {shown.map((g, i) => (
        <HookSection
          key={`${g.event}-${i}`}
          event={g.event}
          runs={g.runs}
          showHeader={multiple}
        />
      ))}
    </div>
  )
}
