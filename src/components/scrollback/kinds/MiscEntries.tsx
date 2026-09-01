import { useState } from 'react'
import { CornerDownLeft, TriangleAlert } from 'lucide-react'
import type { ScrollEntry } from '../../../api/types'
import { planTodos, useChatStore } from '../../../store/chat'
import { entryExpanded } from '../../../scrollback/entryState'
import {
  countHookRuns,
  hookGroupsHaveContent,
  splitHookAnnotation,
} from '../../../scrollback/hookRuns'
import { Accents } from '../../../theme/accents'
import { Glyphs } from '../../../theme/glyphs'
import { Ansi } from '../../Ansi'
import { InlineAction } from '../../InlineAction'
import { Markdown } from '../../Markdown'
import { TodoMark } from '../../todoMark'
import { Bullet, EntryShell, RowIcon } from '../EntryShell'
import { ViewButton } from '../ViewButton'
import type { EntryChrome } from '../chrome'
import { HookCountSuffix, HookGroupsDetail, StopHookSummary } from './HookRuns'

export function ImageEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'image' }>
  chrome: EntryChrome
}) {
  const { shell, openViewer, onOpenImage } = chrome
  // Standalone image entry (no open assistant / user row to attach to):
  // uniform thumbnail (h-24) — consecutive image rows are wrapped by
  // Scrollback in one bottom-aligned gallery. Hover/selected frame is the
  // entry's SelectionBox (scrollback-column width, constant) — no
  // thumbnail-level outline. Click opens the group lightbox via
  // onOpenImage (‹ › navigation), or the block viewer as fallback (mini).
  return (
    <EntryShell {...shell}>
      <img
        src={e.data}
        alt={e.mimeType ? `image (${e.mimeType})` : 'image'}
        loading="lazy"
        data-no-fold
        onClick={(ev) => {
          ev.stopPropagation()
          if (onOpenImage) onOpenImage(e.id)
          else openViewer(e.id)
        }}
        title="点击放大查看"
        className="h-24 max-w-[45%] cursor-zoom-in rounded border border-gn-prompt-border object-contain"
      />
    </EntryShell>
  )
}

export function ErrorEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'error' }>
  chrome: EntryChrome
}) {
  const { shell, openViewer } = chrome
  const showView = shell.selected
  const restartAgent = useChatStore((s) => s.restartAgent)
  const [restarting, setRestarting] = useState(false)
  const onRestart = async () => {
    if (restarting) return
    setRestarting(true)
    await restartAgent()
    setRestarting(false)
  }
  return (
    <EntryShell {...shell}>
      <div className="flex items-start gap-1.5 py-0.5 text-[13px] leading-[1.35]">
        <Bullet color={Accents.error} glyph={Glyphs.ballotX} />
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words" style={{ color: Accents.error }}>
          {e.text}
        </div>
        <ViewButton visible={showView} onOpen={() => openViewer(e.id)} />
        {e.action === 'restart-agent' && (
          // 传输级失败：agent 不可达，唯一恢复动作是重启——行内直接可点。
          <InlineAction
            label={restarting ? '重启中…' : '重启'}
            title="杀掉当前 agent 进程并重新启动（恢复上次会话）"
            disabled={restarting}
            onRun={() => void onRestart()}
          />
        )}
      </div>
    </EntryShell>
  )
}

export function StatusEntry({
  e,
}: {
  e: Extract<ScrollEntry, { kind: 'status' }>
}) {
  // /session-info (and other multiline status payloads): render as a
  // read-only monospace text block — the TUI pushes a plain text block
  // into the scrollback. Single-line status rows keep the centered dim
  // one-liner.
  if (e.text.includes('\n')) {
    return (
      <div
        data-entry-id={e.id}
        className="px-4 py-1.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-gn-muted"
      >
        {e.text}
      </div>
    )
  }
  return (
    <div className="px-4 py-1 text-center text-[11px] text-gn-muted" data-entry-id={e.id}>
      {e.text}
    </div>
  )
}

export function PlanEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'plan' }>
  chrome: EntryChrome
}) {
  const { shell, openViewer } = chrome
  const showView = shell.selected
  // TUI todo pane: plan updates render as a structured todo list
  // (status mark + content), not the raw wire JSON.
  const items = planTodos(e.entries).items
  return (
    <EntryShell {...shell}>
      <div>
        <div className="mb-1 flex items-center gap-1">
          <div className="text-[12px] font-bold" style={{ color: Accents.plan }}>
            Plan
          </div>
          <ViewButton visible={showView} onOpen={() => openViewer(e.id)} />
        </div>
        {items.length === 0 ? (
          <div className="text-[11px] text-gn-muted">（空计划）</div>
        ) : (
          <div className="space-y-[2px]">
            {items.map((t, i) => (
              <div key={t.id ?? i} className="flex items-start gap-2 text-[12.5px] leading-snug">
                <span className="mt-[1px] shrink-0 font-mono text-[11px]" aria-hidden>
                  <TodoMark status={t.status} />
                </span>
                <span
                  className={`min-w-0 flex-1 break-words ${
                    t.status === 'completed' || t.status === 'cancelled'
                      ? 'text-gn-muted'
                      : 'text-gn-fg'
                  }`}
                >
                  {t.content}
                </span>
                {t.priority && (
                  <span className="shrink-0 text-[10px] text-gn-gutter">{t.priority}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </EntryShell>
  )
}

/**
 * Session-event prose. The agent's hook annotations lead their sentence with a
 * `⚠` / `↩` character; those become the shared 16px icon column instead of a
 * font-dependent glyph, so the mark sits on the same track as the row bullets
 * and stays centred on the first line while the sentence wraps.
 */
function SessionEventText({
  text,
  warning,
}: {
  text: string
  warning?: boolean
}) {
  const color = warning ? Accents.warning : Accents.gray
  const { lead, text: body } = splitHookAnnotation(text)
  const span = (
    <span
      className="min-w-0 whitespace-pre-wrap break-words text-[12.5px]"
      style={{ color }}
    >
      {body}
    </span>
  )
  if (!lead) return span
  return (
    <span className="flex min-w-0 items-start gap-1.5 text-[12.5px] leading-[1.35]">
      <RowIcon
        Icon={lead === 'blocked' ? CornerDownLeft : TriangleAlert}
        color={color}
      />
      {span}
    </span>
  )
}

export function SessionEventEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'session_event' }>
  chrome: EntryChrome
}) {
  const { shell, bullet } = chrome
  const expanded = entryExpanded(e)
  const stopGroups = e.stopHooks
  const showStop = hookGroupsHaveContent(stopGroups)
  // TUI append_stop_hooks: summary is always on the marker; per-hook
  // detail only when expanded. Right-align via ml-auto — same line when
  // there is room, own line when the marker wraps (flex-wrap).
  const stopSummary = showStop ? (
    <span className="ml-auto shrink-0">
      <StopHookSummary groups={stopGroups!} />
    </span>
  ) : null
  const stopDetail =
    showStop && expanded ? <HookGroupsDetail groups={stopGroups!} /> : null
  // Recap events are two-part (TUI session_event recap_output): bold
  // "Recap" header + muted summary body, foldable via `open` (←/→).
  // Default expanded: the full summary renders with line breaks
  // (pre-wrap); collapsing is a keyboard-only action. Warning events
  // keep the warning text color AND get the warning accent rail
  // (resolveAccent sessionEvent.warning).
  if (e.recap) {
    return (
      <EntryShell {...shell}>
        <div className="flex items-start gap-1.5 py-[2px] text-[13px] leading-[1.35]">
          <Bullet color={bullet.color} animated={bullet.animated} />
          <div className="min-w-0">
            {expanded && e.text ? (
              <>
                <div
                  className="text-[12.5px] font-bold leading-[1.35]"
                  style={{ color: Accents.gray }}
                >
                  Recap
                </div>
                <div className="mt-0.5 text-[12.5px] leading-[1.45] whitespace-pre-wrap break-words text-gn-muted">
                  {e.text}
                </div>
              </>
            ) : (
              <div className="flex min-w-0 items-baseline gap-0 text-[12.5px] leading-[1.35]">
                <span className="shrink-0 font-bold" style={{ color: Accents.gray }}>
                  Recap
                </span>
                {e.text.trim() ? (
                  <span className="min-w-0 truncate text-gn-muted">
                    {' '}
                    {e.text.split('\n')[0].trim()}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </EntryShell>
    )
  }
  return (
    <EntryShell {...shell}>
      <div className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 py-[2px] text-[13px] leading-[1.35]">
        {e.streaming && (
          <Bullet color={bullet.color} animated={bullet.animated} />
        )}
        {(e as { ansi?: boolean }).ansi ? (
          // Raw command output (`!` shell exec) — render ANSI-colored.
          <span className="min-w-0 font-mono text-[12px] whitespace-pre-wrap break-words">
            <Ansi text={e.text} />
          </span>
        ) : (
          <SessionEventText text={e.text} warning={e.warning} />
        )}
        {stopSummary}
      </div>
      {stopDetail}
    </EntryShell>
  )
}

/**
 * TUI LifecycleEventBlock: one bold event-name line, foldable, default
 * collapsed, no accent. Collapsed suffix is the compact `[hooks: N]`;
 * expanded detail omits the section header (the row already is the event).
 */
export function LifecycleEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'lifecycle' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, caret, bulletGlyph, rowBtn } = chrome
  const expanded = entryExpanded(e)
  return (
    <EntryShell {...shell}>
      <div className={rowBtn}>
        <Bullet
          color={bullet.color}
          animated={bullet.animated && !caret}
          glyph={bulletGlyph}
        />
        <span
          className="min-w-0 truncate font-bold"
          style={{ color: expanded ? 'var(--color-gn-fg)' : Accents.gray }}
        >
          {e.event}
        </span>
        {!expanded ? <HookCountSuffix counts={countHookRuns(e.runs)} /> : null}
      </div>
      {expanded ? (
        <HookGroupsDetail groups={[{ event: e.event, runs: e.runs }]} />
      ) : null}
    </EntryShell>
  )
}

export function CreditLimitEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'credit_limit' }>
  chrome: EntryChrome
}) {
  const { shell } = chrome
  return (
    <EntryShell {...shell}>
      <div className="break-words text-[13px] font-bold py-1" style={{ color: Accents.warning }}>
        {e.text}
      </div>
    </EntryShell>
  )
}

export function BtwEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'btw' }>
  chrome: EntryChrome
}) {
  const { shell, bullet, openViewer } = chrome
  const expanded = entryExpanded(e)
  const showView = expanded
  return (
    <EntryShell {...shell}>
      <div className="flex w-full items-start gap-0.5">
        <div
          className="flex min-w-0 flex-1 items-start gap-1.5 py-[2px] text-[13px] leading-[1.35]"
          title="click fold · 查看 / enter view"
        >
          <Bullet color={bullet.color} animated={bullet.animated} />
          <div className="min-w-0 flex-1">
            {expanded ? (
              <>
                {/* 头部一行 /btw <问题>（TUI btw.rs header，金色粗体）；长问题可环绕，不断行外溢。 */}
                <div className="font-bold leading-[1.35] break-words" style={{ color: Accents.plan }}>
                  /btw {e.question}
                </div>
                {/* 错误态直接可见；答案走 markdown（TUI BtwBlock 同款）。 */}
                {e.error ? (
                  <div
                    className="mt-0.5 text-[12.5px] leading-[1.45] whitespace-pre-wrap break-words"
                    style={{ color: Accents.error }}
                  >
                    {e.error}
                  </div>
                ) : e.answer ? (
                  <Markdown source={e.answer} />
                ) : e.streaming ? (
                  <div className="mt-0.5 text-[12px] text-gn-muted">等待回答…</div>
                ) : null}
              </>
            ) : (
              // 折叠态只有一行（TUI Collapsed）：muted 头部；问题过长行内
              // 截断（shrink-0 会顶破块边界），错误时行内截断露出错误摘要，
              // 折叠中也能直接看到失败。
              <div className="flex min-w-0 items-baseline gap-1 font-bold text-gn-muted">
                <span className="min-w-0 truncate">/btw {e.question}</span>
                {e.error ? (
                  <span
                    className="min-w-0 truncate text-[12px] font-normal"
                    style={{ color: Accents.error }}
                  >
                    {e.error}
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>
        <ViewButton visible={showView} onOpen={() => openViewer(e.id)} />
      </div>
    </EntryShell>
  )
}

export function GroupHeaderEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'group_header' }>
  chrome: EntryChrome
}) {
  const { shell, bullet } = chrome
  const label =
    e.label ||
    (e.collapse
      ? `${e.count} tool calls & thoughts`
      : e.verbRun
        ? `${e.verbRun.verb || 'Ran'} ${e.count}`
        : `${e.count} more`)
  return (
    <EntryShell {...shell}>
      <div className="flex items-center gap-1.5 py-[2px] text-[13px] leading-[1.35]">
        <Bullet
          color={bullet.color}
          animated={bullet.animated}
          glyph={Glyphs.diamondDotted}
        />
        <span
          className="font-bold"
          style={{ color: 'var(--color-gn-gray)' }}
        >
          {label}
        </span>
      </div>
    </EntryShell>
  )
}
