import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'

/**
 * x.ai/folder_trust/request card — web counterpart of the TUI folder
 * trust prompt (folder_trust_prompt.rs). The agent sends this ExtRequest
 * AFTER new_session/load_session when a workspace contains project-local
 * config (mcp / hooks / lsp / .envrc) but the directory is not yet
 * trusted; project-scoped config stays GATED until the client answers.
 *
 * Request params (camelCase): {sessionId, cwd, workspace, configKinds}.
 * Response: {outcome:"trust"} — the ONLY value that unlocks; anything
 * else (reject / cancelled / malformed) decodes fail-closed to Reject.
 * Explicit reject keeps the agent's dedupe key (no re-ask); a dropped or
 * timed-out answer releases it, so declining here is final for the
 * session while ignoring the card is not.
 *
 * Gated on the client capability `x.ai/folderTrust.interactive` — the
 * host must declare it (ACP_CAP_FOLDER_TRUST_INTERACTIVE) or the agent
 * never sends this request. Until then this card is inert.
 */
const ANCHOR_ID = 'capri-xai-question-anchor'

export function FolderTrustCard() {
  const xaiRequests = useChatStore((s) => s.xaiRequests)
  const respondXai = useChatStore((s) => s.respondXai)

  const req = xaiRequests.find((r) => r.method === 'x.ai/folder_trust/request')
  const params = (req?.params ?? {}) as Record<string, unknown>
  const cwd = typeof params.cwd === 'string' ? params.cwd : ''
  const workspace = typeof params.workspace === 'string' ? params.workspace : ''
  const configKinds = Array.isArray(params.configKinds)
    ? params.configKinds.filter((k): k is string => typeof k === 'string')
    : []

  const trust = () => {
    if (req) void respondXai(req.requestId, { outcome: 'trust' })
  }
  const decline = () => {
    if (req) void respondXai(req.requestId, { outcome: 'reject' })
  }

  // Keyboard: y/Enter = trust, n/Esc = decline. Same window-capture
  // pattern as the question card; text fields keep their keys (typing is
  // never blocked, only bare key presses answer the card).
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.altKey || e.ctrlKey) return
      const t = e.target as HTMLElement | null
      if (
        !!t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return
      }
      if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') {
        e.preventDefault()
        e.stopImmediatePropagation()
        trust()
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        decline()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.requestId])

  // Portaled anchor: the App-level mount stays put, the card DOM lands in
  // the Composer's anchor so it reads as an inline card above the input.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setAnchor(document.getElementById(ANCHOR_ID))
  }, [])

  if (!req || !anchor) return null

  return createPortal(
    <div
      className="mx-2 mb-2 gn-popover"
      data-testid="folder-trust-card"
    >
      <div className="flex items-center gap-2 border-b border-gn-prompt-border px-3 py-1.5">
        <IconGlyph glyph={Glyphs.diamondFilled} color="var(--color-gn-yellow)" />
        <span className="text-[11px] font-bold text-gn-fg2">
          目录信任请求 · waiting on you
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        <div className="text-[12px] leading-snug text-gn-fg">
          Agent 在不受信任的目录里发现了项目级配置。信任后才会加载该目录的
          project 级 MCP / hooks / 规则；拒绝则本会话保持跳过。
        </div>
        {(workspace || cwd) && (
          <div className="font-mono text-[11px] text-gn-fg2">
            {workspace || cwd}
            {cwd && workspace && cwd !== workspace && (
              <span className="text-gn-muted"> （会话：{cwd}）</span>
            )}
          </div>
        )}
        {configKinds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {configKinds.map((k) => (
              <span
                key={k}
                className="rounded-full border border-gn-prompt-border px-2 py-px font-mono text-[10.5px] text-gn-muted"
              >
                {k}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={trust}
            className="rounded px-2.5 py-1 text-[11.5px] text-gn-green transition-colors hover:bg-gn-bg-highlight"
          >
            信任此目录 <span className="text-[10px] opacity-70">y</span>
          </button>
          <button
            type="button"
            onClick={decline}
            className="rounded px-2.5 py-1 text-[11.5px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            不信任 <span className="text-[10px] opacity-70">n</span>
          </button>
          <span className="text-[10px] text-gn-gutter">
            不选择：配置保持跳过，agent 稍后可能再次询问
          </span>
        </div>
      </div>
    </div>,
    anchor,
  )
}
