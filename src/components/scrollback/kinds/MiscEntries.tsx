import { useState } from 'react'
import type { ScrollEntry } from '../../../api/types'
import { planTodos, useChatStore } from '../../../store/chat'
import { entryExpanded } from '../../../scrollback/entryState'
import { Accents } from '../../../theme/accents'
import { Glyphs } from '../../../theme/glyphs'
import { Ansi } from '../../Ansi'
import { Markdown } from '../../Markdown'
import { TodoMark } from '../../todoMark'
import { Bullet, EntryShell } from '../EntryShell'
import type { EntryChrome } from '../chrome'

export function ImageEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'image' }>
  chrome: EntryChrome
}) {
  const { shell, openViewer } = chrome
  // Standalone image entry (no open assistant / user row to attach to):
  // centered large image + mimeType caption; click → fullscreen viewer.
  return (
    <EntryShell {...shell}>
      <figure className="flex flex-col items-center gap-1 py-1.5">
        <img
          src={e.data}
          alt={e.mimeType ? `image (${e.mimeType})` : 'image'}
          loading="lazy"
          onClick={() => openViewer(e.id)}
          title="点击放大查看"
          className="max-h-[55vh] w-auto max-w-full cursor-zoom-in rounded border border-gn-prompt-border object-contain"
        />
        {e.mimeType ? (
          <figcaption className="font-mono text-[11px] text-gn-muted">
            {e.mimeType}
          </figcaption>
        ) : null}
      </figure>
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
  const { shell, onHeaderDblClick } = chrome
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
      <div
        className="flex items-start gap-1.5 py-0.5 text-[13px] leading-[1.35]"
        title="dblclick / enter · view"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <Bullet color={Accents.error} glyph={Glyphs.ballotX} />
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words" style={{ color: Accents.error }}>
          {e.text}
        </div>
        {e.action === 'restart-agent' && (
          // 传输级失败：agent 不可达，唯一恢复动作是重启——行内直接可点。
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              void onRestart()
            }}
            disabled={restarting}
            className="shrink-0 rounded border border-gn-red/40 px-1.5 py-px text-[11px] text-gn-red transition-opacity enabled:hover:bg-gn-red/10 disabled:cursor-not-allowed disabled:opacity-50"
            title="杀掉当前 agent 进程并重新启动（恢复上次会话）"
          >
            {restarting ? '重启中…' : '重启'}
          </button>
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
  const { shell, onHeaderDblClick } = chrome
  // TUI todo pane: plan updates render as a structured todo list
  // (status mark + content), not the raw wire JSON.
  const items = planTodos(e.entries).items
  return (
    <EntryShell {...shell}>
      <div
        title="dblclick / enter · view"
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <div className="mb-1 text-[12px] font-bold" style={{ color: Accents.plan }}>
          Plan
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

export function SessionEventEntry({
  e,
  chrome,
}: {
  e: Extract<ScrollEntry, { kind: 'session_event' }>
  chrome: EntryChrome
}) {
  const { shell, bullet } = chrome
  // Recap events are two-part (TUI session_event recap_output): bold
  // "Recap" header + muted summary body, foldable via `open` (←/→).
  // Default expanded: the full summary renders with line breaks
  // (pre-wrap); collapsing is a keyboard-only action. Warning events
  // keep the warning text color AND get the warning accent rail
  // (resolveAccent sessionEvent.warning).
  return (
    <EntryShell {...shell}>
      <div className="flex items-start gap-1.5 py-[2px] text-[13px] leading-[1.35]">
        {(e.recap || e.streaming) && (
          <Bullet color={bullet.color} animated={bullet.animated} />
        )}
        {e.recap ? (
          <div className="min-w-0">
            {entryExpanded(e) && e.text ? (
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
        ) : (e as { ansi?: boolean }).ansi ? (
          // Raw command output (`!` shell exec) — render ANSI-colored.
          <span className="font-mono text-[12px] whitespace-pre-wrap break-words">
            <Ansi text={e.text} />
          </span>
        ) : (
          <span
            className="text-[12.5px] whitespace-pre-wrap break-words"
            style={{
              color: e.warning ? Accents.warning : Accents.gray,
            }}
          >
            {e.text}
          </span>
        )}
      </div>
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
      <div className="text-[13px] font-bold py-1" style={{ color: Accents.warning }}>
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
  const { shell, bullet, onHeaderClick, onHeaderDblClick, toggleBtw } = chrome
  const expanded = entryExpanded(e)
  return (
    <EntryShell {...shell}>
      <div
        className="flex items-start gap-1.5 py-[2px] text-[13px] leading-[1.35]"
        title="click fold · dblclick / enter view"
        onClick={(ev) => {
          ev.stopPropagation()
          onHeaderClick(() => toggleBtw(e.id))
        }}
        onDoubleClick={(ev) => {
          ev.stopPropagation()
          ev.preventDefault()
          onHeaderDblClick()
        }}
      >
        <Bullet color={bullet.color} animated={bullet.animated} />
        <div className="min-w-0 flex-1">
          {expanded ? (
            <>
              {/* 头部一行 /btw <问题>（TUI btw.rs header，金色粗体）。 */}
              <div className="font-bold leading-[1.35]" style={{ color: Accents.plan }}>
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
            // 折叠态只有一行（TUI Collapsed）：muted 头部；错误时行内截断
            // 露出错误摘要，折叠中也能直接看到失败。
            <div className="flex min-w-0 items-baseline gap-1 font-bold text-gn-muted">
              <span className="shrink-0">/btw {e.question}</span>
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
