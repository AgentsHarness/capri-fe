import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import type { PendingReq } from '../api/types'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import {
  contentFromDraft,
  initialDrafts,
  parseElicitFields,
  safeHttpUrl,
  type ElicitDraft,
  type ElicitField,
} from './mcpElicit'
import { beginUrlWait, clearUrlWait, subscribeUrlWait, urlWaitSnapshot, type UrlWait } from './mcpElicitWait'

/**
 * x.ai/mcp/elicit — the card an MCP server uses to ask for a form or a
 * URL consent. One request at a time (the newest). Accept / Decline /
 * Cancel match the agent's tagged response. A URL accept answers the
 * request, opens the link, and stays up until elicit_complete.
 */
export function McpElicitCard() {
  const req = useChatStore((s) => s.xaiRequests.find((r) => r.method === 'x.ai/mcp/elicit'))
  const [wait, setWait] = useState<UrlWait | null>(urlWaitSnapshot)
  useEffect(() => subscribeUrlWait(() => setWait(urlWaitSnapshot())), [])

  if (req) return <LiveCard req={req} />
  if (wait) return <WaitingCard wait={wait} />
  return null
}

function LiveCard({ req }: { req: PendingReq }) {
  const params = req.params ?? {}
  const mode = params.mode === 'url' ? 'url' : 'form'
  const server = typeof params.serverName === 'string' ? params.serverName : 'MCP'
  const message = typeof params.message === 'string' ? params.message : ''
  const fields = useMemo(
    () => (mode === 'form' ? parseElicitFields(params.requestedSchema) : []),
    [mode, params.requestedSchema],
  )
  const [draft, setDraft] = useState<ElicitDraft>(() => initialDrafts(fields))
  const [error, setError] = useState<string>()

  const respond = (result: Record<string, unknown>) => {
    void useChatStore.getState().respondXai(req.requestId, result)
  }

  const accept = () => {
    if (mode === 'url') {
      const raw = typeof params.url === 'string' ? params.url : ''
      const url = safeHttpUrl(raw)
      if (!url) {
        setError('这个链接不能打开')
        return
      }
      const elicitationId = typeof params.elicitationId === 'string' ? params.elicitationId : ''
      window.open(url, '_blank', 'noopener,noreferrer')
      beginUrlWait({ elicitationId, serverName: server, url, message })
      respond({ outcome: 'accept' })
      return
    }
    const built = contentFromDraft(fields, draft)
    if (!built.ok) {
      setError(built.error)
      return
    }
    respond({ outcome: 'accept', content: built.content })
  }

  return (
    <CardFrame
      title={`${server} 需要你确认`}
      message={message}
      error={error}
      onAccept={accept}
      onDecline={() => respond({ outcome: 'decline' })}
      onCancel={() => respond({ outcome: 'cancel' })}
    >
      {mode === 'url' ? (
        <p className="text-[12px] text-gn-muted">
          接受后会打开链接，并在服务器完成前保持这张卡片。
        </p>
      ) : (
        <FormFields fields={fields} draft={draft} setDraft={setDraft} />
      )}
    </CardFrame>
  )
}

function WaitingCard({ wait }: { wait: UrlWait }) {
  return (
    <CardFrame
      title={`${wait.serverName} 正在等待`}
      message={wait.message || '已打开链接，完成后这张卡片会自己关掉。'}
      onAccept={() => window.open(wait.url, '_blank', 'noopener,noreferrer')}
      acceptLabel="重新打开链接"
      onCancel={() => clearUrlWait()}
      cancelLabel="关闭"
    />
  )
}

function FormFields({
  fields,
  draft,
  setDraft,
}: {
  fields: ElicitField[]
  draft: ElicitDraft
  setDraft: (d: ElicitDraft) => void
}) {
  if (fields.length === 0) {
    return <p className="text-[12px] text-gn-muted">没有需要填写的字段。</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-[12px]">
          <span>
            {f.title}
            {f.required ? <span className="text-gn-red"> *</span> : null}
          </span>
          {f.description ? <span className="text-gn-muted">{f.description}</span> : null}
          <FieldControl field={f} draft={draft} setDraft={setDraft} />
        </label>
      ))}
    </div>
  )
}

function FieldControl({
  field,
  draft,
  setDraft,
}: {
  field: ElicitField
  draft: ElicitDraft
  setDraft: (d: ElicitDraft) => void
}) {
  const inputClass =
    'rounded-md border border-gn-prompt-border/60 bg-gn-bg-dark px-3 py-1.5 text-[12.5px] text-gn-fg outline-none focus:border-gn-cyan'
  if (field.kind === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={draft[field.name] === true}
        onChange={(e) => setDraft({ ...draft, [field.name]: e.target.checked })}
      />
    )
  }
  if (field.kind === 'single') {
    return (
      <select
        className={inputClass}
        value={typeof draft[field.name] === 'number' ? String(draft[field.name]) : ''}
        onChange={(e) =>
          setDraft({
            ...draft,
            [field.name]: e.target.value === '' ? null : Number(e.target.value),
          })
        }
      >
        <option value="">请选择</option>
        {field.options.map((o, i) => (
          <option key={o.value} value={i}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.kind === 'multi') {
    const picked = Array.isArray(draft[field.name]) ? (draft[field.name] as number[]) : []
    return (
      <div className="flex flex-col gap-1">
        {field.options.map((o, i) => (
          <label key={o.value} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={picked.includes(i)}
              onChange={(e) => {
                const next = e.target.checked ? [...picked, i] : picked.filter((n) => n !== i)
                setDraft({ ...draft, [field.name]: next })
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
    )
  }
  if (field.kind === 'unsupported') {
    return <span className="text-gn-muted">{field.reason}</span>
  }
  return (
    <input
      className={inputClass}
      value={typeof draft[field.name] === 'string' ? (draft[field.name] as string) : ''}
      onChange={(e) => setDraft({ ...draft, [field.name]: e.target.value })}
    />
  )
}

function CardFrame({
  title,
  message,
  error,
  children,
  onAccept,
  acceptLabel = '接受',
  onDecline,
  onCancel,
  cancelLabel = '取消',
}: {
  title: string
  message: string
  error?: string
  children?: ReactNode
  onAccept: () => void
  acceptLabel?: string
  onDecline?: () => void
  onCancel: () => void
  cancelLabel?: string
}) {
  return (
    <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS} py-1.5`} data-testid="mcp-elicit">
      <div className="gn-card-rise mx-auto w-full max-w-[640px] overflow-hidden rounded-lg border border-gn-cyan/50 bg-gn-bg-base shadow-xl ring-1 ring-gn-cyan/30">
        <header className="flex min-h-[38px] items-center gap-2 border-b border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3.5 py-1.5">
          <span className="shrink-0 text-gn-cyan" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="min-w-0 truncate text-[13px] font-bold text-gn-fg">{title}</span>
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭卡片"
            title="关闭"
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <div className="bg-gn-bg-base p-3.5">
          {message ? (
            <p className="mb-2.5 whitespace-pre-wrap text-[13.5px] font-semibold leading-snug text-gn-fg">
              {message}
            </p>
          ) : null}
          {children}
          {error ? <p className="mt-2 text-[12px] text-gn-red">{error}</p> : null}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-gn-prompt-border/70 bg-gn-bg-dark/60 px-3.5 py-2">
          <button
            type="button"
            className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-red transition-colors hover:bg-gn-diff-del-bg"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {onDecline ? (
            <button
              type="button"
              className="min-h-8 rounded px-2.5 py-1 text-[12px] text-gn-fg2 transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              onClick={onDecline}
            >
              拒绝
            </button>
          ) : null}
          <button
            type="button"
            className="min-h-8 rounded bg-gn-bg-highlight px-4 py-1 text-[12.5px] font-semibold text-gn-fg transition-colors hover:bg-gn-bg-hover"
            onClick={onAccept}
          >
            {acceptLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
