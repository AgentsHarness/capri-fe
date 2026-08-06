import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'

type Option = { optionId: string; name?: string; kind?: string; label?: string }

/**
 * Permission strip — maps to TUI PermissionView sitting above the prompt.
 * Numbered options 1–N, diamond cue for "waiting on you".
 */
export function ApprovalStrip() {
  const pending = useChatStore((s) => s.pending)
  const respond = useChatStore((s) => s.respondPermission)

  if (pending.length === 0) return null
  const req = pending[0]
  const options = (req.params?.options as Option[] | undefined) || []
  const toolCall = req.params?.toolCall as { title?: string; kind?: string } | undefined

  return (
    <div className="border-t border-gn-yellow/30 bg-gn-bg-dark py-2.5">
      <div className={`${CONTENT_COLUMN_CLASS} ${COLUMN_PAD_X_CLASS}`}>
        <div className="mb-1.5 flex items-center gap-2 text-[12px]">
          <span className="text-gn-yellow animate-pulse" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="font-bold text-gn-yellow">waiting on you</span>
          <span className="text-gn-muted truncate">{req.method}</span>
        </div>
        {toolCall?.title && (
          <div className="mb-2 truncate pl-5 font-mono text-[12px] text-gn-fg2">
            {toolCall.title}
          </div>
        )}
        <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap pl-0 sm:pl-5">
          {options.map((opt, i) => (
            <button
              key={opt.optionId}
              type="button"
              onClick={() => void respond(req.requestId, opt.optionId)}
              className="min-h-10 rounded border border-gn-prompt-border bg-gn-bg-base px-3 py-1.5 text-left text-[12.5px] text-gn-fg hover:border-gn-magenta/50 hover:bg-gn-bg-highlight"
            >
              <span className="mr-2 font-mono text-gn-muted">{i + 1}</span>
              {opt.name || opt.label || opt.optionId}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void respond(req.requestId, undefined, true)}
            className="min-h-10 rounded border border-gn-red/40 px-3 py-1.5 text-[12.5px] text-gn-red hover:bg-gn-diff-del-bg sm:ml-auto"
          >
            <span className="mr-1 inline-flex items-center">
              <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
            </span>
            reject
          </button>
        </div>
      </div>
    </div>
  )
}
