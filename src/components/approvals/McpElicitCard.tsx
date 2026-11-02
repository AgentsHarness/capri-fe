import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../../store/chat'
import type { PendingReq } from '../../api/types'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../../theme/layout'
import { Glyphs } from '../../theme/glyphs'
import { IconGlyph } from '../ui/IconGlyph'
import { Spinner } from '../ui/Spinner'
import {
  contentFromDraft,
  initialDrafts,
  parseElicitFields,
  safeHttpUrl,
  type ElicitDraft,
  type ElicitField,
} from '../../lib/mcpElicit'
import { beginUrlWait, clearUrlWait, subscribeUrlWait, urlWaitSnapshot, type UrlWait } from '../../lib/mcpElicitWait'

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
  /**
   * 出口在飞：点下去到 host 回执之前卡片不动，不锁的话第二次点击会撞上
   * 「已过期」；失败时 respondXai 保留卡片并 toast，这里清掉让用户重试。
   */
  const [submitting, setSubmitting] = useState<'accept' | 'decline' | 'cancel' | null>(null)

  const respond = async (key: 'accept' | 'decline' | 'cancel', result: Record<string, unknown>) => {
    if (submitting !== null) return
    setSubmitting(key)
    try {
      await useChatStore.getState().respondXai(req.requestId, result)
    } finally {
      setSubmitting(null)
    }
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
      void respond('accept', { outcome: 'accept' })
      return
    }
    const built = contentFromDraft(fields, draft)
    if (!built.ok) {
      setError(built.error)
      return
    }
    void respond('accept', { outcome: 'accept', content: built.content })
  }

  return (
    <CardFrame
      title={`${server} 需要你确认`}
      message={message}
      error={error}
      onAccept={accept}
      acceptBusy={submitting === 'accept'}
      onDecline={() => void respond('decline', { outcome: 'decline' })}
      declineBusy={submitting === 'decline'}
      onCancel={() => void respond('cancel', { outcome: 'cancel' })}
      cancelBusy={submitting === 'cancel'}
      locked={submitting !== null}
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
  acceptBusy = false,
  onDecline,
  declineBusy = false,
  onCancel,
  cancelBusy = false,
  cancelLabel = '取消',
  locked = false,
}: {
  title: string
  message: string
  error?: string
  children?: ReactNode
  onAccept: () => void
  acceptLabel?: string
  acceptBusy?: boolean
  onDecline?: () => void
  declineBusy?: boolean
  onCancel: () => void
  cancelBusy?: boolean
  cancelLabel?: string
  /** 任一出口在飞：其余出口一起禁用，避免第二笔应答撞上「已过期」。 */
  locked?: boolean
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
            disabled={locked}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="关闭卡片"
            title="关闭"
          >
            {cancelBusy ? <Spinner /> : <X size={14} aria-hidden />}
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
            disabled={locked}
            className="inline-flex min-h-8 items-center gap-1.5 rounded px-2.5 py-1 text-[12px] text-gn-red transition-colors hover:bg-gn-diff-del-bg disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onCancel}
          >
            {cancelBusy ? <Spinner /> : null}
            {cancelLabel}
          </button>
          {onDecline ? (
            <button
              type="button"
              disabled={locked}
              className="inline-flex min-h-8 items-center gap-1.5 rounded px-2.5 py-1 text-[12px] text-gn-fg2 transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-40"
              onClick={onDecline}
            >
              {declineBusy ? <Spinner /> : null}
              拒绝
            </button>
          ) : null}
          <button
            type="button"
            disabled={locked}
            className="inline-flex min-h-8 items-center gap-1.5 rounded bg-gn-bg-highlight px-4 py-1 text-[12.5px] font-semibold text-gn-fg transition-colors hover:bg-gn-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onAccept}
          >
            {acceptBusy ? <Spinner /> : null}
            {acceptLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
