import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { transport } from '../api/client'
import type { SessionInfoDetail, SessionInfoExt } from '../api/types'
import { fmtTok, shortCwd } from '../format'
import { contextUrgencyColor } from '../theme/contextColor'
import { UsageInfoTabs } from './UsageInfoTabs'

/** agent 快照的按需抽取字段（x.ai/session/info，context 只取两个兜底数）。 */
type AgentExt = Omit<SessionInfoExt, 'context'> & {
  contextUsed?: number
  contextTotal?: number
}

/**
 * Session info modal — web counterpart of the TUI `/session-info` command
 * (usage modal "Session info" tab; row order/labels follow session_info_fields
 * in xai-grok-pager effects/mod.rs).
 * Every open fetches the host's thin record (POST /api/session-info) and the
 * agent's full snapshot (x.ai/session/info) in parallel and merges them —
 * agent fields fill the rows the host lacks (conversation id / model hash /
 * api backend / turn); GET /api/status supplies the Shell version row
 * (agentInfo._meta.agentVersion, the hello snapshot's data). Nothing is read
 * from the chat store except the locked-in sessionId, so the numbers are
 * authoritative at open time (loading / error / retry states included).
 */
export function SessionInfoModal() {
  const open = useChatStore((s) => s.sessionInfoOpen)
  const close = useChatStore((s) => s.closeSessionInfo)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [data, setData] = useState<SessionInfoDetail>()
  // ── agent 全量快照（弱依赖：失败只降级少行，不整弹窗报错）───────
  const [ext, setExt] = useState<AgentExt>()
  const [extError, setExtError] = useState<string>()
  // Shell version 行 + model_display_name 的 show_resolved 开关（均取自
  // GET /api/status，同样是弱依赖）。
  const [shellVersion, setShellVersion] = useState<string>()
  const [showResolved, setShowResolved] = useState(true)
  const [copied, setCopied] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const fetchInfo = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(undefined)
    // 锁定打开弹窗时的会话：两个请求都必须显式带 sessionId——省略时
    // host 的 Bridge.XaiCall 会填它自己的活动会话，多 tab / 正在查看别的
    // 会话时会串数据（ContextModal 刚修过同一个坑）。
    const sid = useChatStore.getState().sessionId
    const [hostRes, extRes, stRes] = await Promise.allSettled([
      transport.sessionInfo(sid),
      transport.sessionInfoExt({ sessionId: sid }),
      transport.status(),
    ])
    // A newer open superseded this one (or the modal closed mid-flight).
    if (seq !== reqSeq.current) return
    setLoading(false)
    // /api/status：agentVersion（Shell version 行）+ show_resolved_model
    // （Model 行规则）；失败只是少一行 / 用默认值。
    setShellVersion(stRes.status === 'fulfilled' ? parseAgentVersion(stRes.value) : undefined)
    setShowResolved(stRes.status === 'fulfilled' ? parseShowResolved(stRes.value) : true)
    setExt(extRes.status === 'fulfilled' ? parseAgentExt(extRes.value) : undefined)
    setExtError(extRes.status === 'rejected' ? errMsg(extRes.reason) : undefined)
    if (hostRes.status === 'fulfilled') {
      const info = hostRes.value
      // Host's in-process record can lag on the title (agent-side
      // session_info_update not delivered for resumed sessions) — merge
      // it from the roster list we already fetched.
      if (!info.title) {
        const s = useChatStore.getState().sessions.find((x) => x.sessionId === info.sessionId)
        if (s?.title) info.title = s.title
      }
      setData(info)
    } else {
      // 主数据源失败 → 沿用既有 error/retry 语义。
      setData(undefined)
      setError(errMsg(hostRes.reason))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setCopied(false)
    setExt(undefined)
    setExtError(undefined)
    setShellVersion(undefined)
    setShowResolved(true)
    void fetchInfo()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, fetchInfo, close])

  if (!open) return null

  // session id：host 薄记录为主，agent 快照兜底。
  const sid = data?.sessionId || ext?.sessionId

  const copyId = async () => {
    if (!sid) return
    try {
      await navigator.clipboard.writeText(sid)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }

  // Context window: host-tracked usage size if reported, else the model's
  // totalContextTokens — same precedence as the TUI context bar, with the
  // agent snapshot's context as last-resort fallback when the host has
  // none. pct is clamped to 100 like the TUI (used can transiently exceed
  // the window); the color follows the same urgency gradient as the
  // context chip.
  const ctxSize = data?.contextSize || data?.model?.contextWindow || ext?.contextTotal || 0
  const ctxUsed = data?.contextUsed ?? ext?.contextUsed ?? 0
  const pct =
    ctxSize > 0 ? Math.min(100, Math.round((ctxUsed / ctxSize) * 100)) : undefined

  // Model 行显示规则对齐 TUI model_display_name()（xai-grok-shell
  // acp_types.rs）：catalog 有 name 用 name；否则 show_resolved 时显示
  // `model (resolved)`；否则显示 model。agent 快照缺失时退回 host model
  // 行；reasoningEffort 是 host 侧数据，两种来源都照常追加。
  const mBase = ext?.model
    ? ext.modelDisplayName ||
      (showResolved && ext.resolvedModelId && ext.resolvedModelId !== ext.model
        ? `${ext.model} (${ext.resolvedModelId})`
        : ext.model)
    : data?.model
      ? data.model.name || data.model.modelId
      : undefined
  const modelText = mBase
    ? `${mBase}${data?.model?.reasoningEffort ? ` · ${data.model.reasoningEffort}` : ''}`
    : undefined
  const cwd = data?.cwd || ext?.cwd

  // 行序/标签对齐 TUI session_info_fields（xai-grok-pager effects/mod.rs）：
  // Title · Shell version · Session ID · Conversation ID · Working directory ·
  // Model · Model Hash · API Backend · Turn · Context；usage/host/git 为 FE
  // 特有行置尾。TUI 的 Sandbox 行取自 agent 进程本地的
  // xai_grok_sandbox::profile_name()，host 端点与 x.ai 快照均不暴露 → Web
  // 端无数据源，不渲染该行。
  const rows: Array<{ label: string; value: React.ReactNode; mono?: boolean }> = [
    ...(data?.title ? [{ label: 'title', value: data.title }] : []),
    ...(shellVersion ? [{ label: 'shell version', value: shellVersion, mono: true }] : []),
    ...(sid
      ? [
          {
            label: 'session id',
            value: (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{sid}</span>
                <button
                  type="button"
                  onClick={() => void copyId()}
                  className="shrink-0 rounded px-1.5 py-px text-[10px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
                  title="复制 session id"
                >
                  {copied ? '✓' : 'copy'}
                </button>
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    ...(ext?.conversationId
      ? [{ label: 'conversation id', value: ext.conversationId, mono: true }]
      : []),
    ...(cwd
      ? [
          {
            label: 'working directory',
            value: (
              <span className="block truncate" title={cwd}>
                {shortCwd(cwd, data?.homeDir)}
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    ...(modelText ? [{ label: 'model', value: modelText }] : []),
    ...(ext && ext.showModelFingerprint && ext.modelFingerprint
      ? [{ label: 'model hash', value: ext.modelFingerprint, mono: true }]
      : []),
    ...(ext?.apiBackend ? [{ label: 'api backend', value: ext.apiBackend }] : []),
    ...(ext && ext.turnIndex != null
      ? [{ label: 'turn', value: String(ext.turnIndex), mono: true }]
      : []),
    ...(ctxSize > 0
      ? [
          {
            label: 'context',
            value: (
              <span style={pct != null ? { color: contextUrgencyColor(pct) } : undefined}>
                {fmtTok(ctxUsed)} / {fmtTok(ctxSize)}
                {pct != null ? ` (${pct}%)` : ''}
              </span>
            ),
            mono: true,
          },
        ]
      : []),
    ...(data?.hostName || data?.hostId
      ? [{ label: 'host', value: [data.hostName, data.hostId].filter(Boolean).join(' · ') }]
      : []),
    ...(data?.gitBranch
      ? [
          {
            label: 'git branch',
            value: data.gitIsWorktree ? `${data.gitBranch} (worktree)` : data.gitBranch,
            mono: true,
          },
        ]
      : []),
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="session info"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="mt-8 w-full max-w-[460px] gn-modal-panel"
      >
        <header className="gn-modal-header">
          <span className="font-mono text-[13px] font-bold text-gn-fg">/session-info</span>
          <button
            type="button"
            onClick={close}
            className="ml-auto rounded p-1 text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <UsageInfoTabs active="session-info" />

        <div className="py-1">
          {loading ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              加载中…
            </div>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <div className="text-[12px] text-gn-red">{error}</div>
              <button
                type="button"
                onClick={() => void fetchInfo()}
                className="mt-2 rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
              >
                重试
              </button>
            </div>
          ) : !data ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-gn-muted">
              暂无活动会话
            </div>
          ) : (
            <>
              {rows.map((r, i) => (
                <div
                  key={r.label}
                  className={`flex items-start gap-3 px-4 py-2 ${i < rows.length - 1 ? 'border-b border-gn-prompt-border/50' : ''}`}
                >
                  <span className="w-24 shrink-0 pt-px text-[10px] uppercase tracking-wider text-gn-gutter">
                    {r.label}
                  </span>
                  <span
                    className={`min-w-0 flex-1 break-words text-[12px] leading-snug ${r.mono ? 'font-mono text-gn-fg' : 'text-gn-fg2'}`}
                  >
                    {r.value}
                  </span>
                </div>
              ))}
              {extError && (
                <div className="px-4 py-1.5 text-[10.5px] leading-snug text-gn-warning">
                  agent 快照获取失败，conversation id / model hash / api backend /
                  turn 等行缺失：{extError}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Finite non-negative number helper (usage fields are optional). */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * x.ai/session/info 响应的防御性抽取（字段名/类型不可全信，缺啥不显示
 * 啥）：只取本弹窗要用的行 + context 两个兜底数。
 */
function parseAgentExt(raw: unknown): AgentExt {
  const o = obj(raw)
  const ctx = obj(o?.context)
  return {
    sessionId: str(o?.sessionId),
    cwd: str(o?.cwd),
    model: str(o?.model),
    modelDisplayName: str(o?.modelDisplayName),
    resolvedModelId: str(o?.resolvedModelId),
    modelFingerprint: str(o?.modelFingerprint),
    showModelFingerprint: o?.showModelFingerprint === true,
    apiBackend: str(o?.apiBackend),
    conversationId: str(o?.conversationId),
    agentName: str(o?.agentName),
    turns: num(o?.turns),
    turnIndex: num(o?.turnIndex),
    contextUsed: num(ctx?.used),
    contextTotal: num(ctx?.total),
  }
}

/**
 * Shell version 行数据源：/api/status（与 SSE hello 同一快照）的
 * agentInfo._meta.agentVersion —— agent initialize 里宣告的
 * xai_grok_version::VERSION，即 TUI "Shell version" 对应的版本。
 */
function parseAgentVersion(status: unknown): string | undefined {
  const info = obj(obj(status)?.agentInfo)
  return str(obj(info?._meta)?.agentVersion)
}

/** authMeta.show_resolved_model（agent authenticate 的 _meta，snake_case
 * 直通）；缺省按 TUI 的默认值 true。 */
function parseShowResolved(status: unknown): boolean {
  const meta = obj(obj(status)?.authMeta)
  const v = meta?.show_resolved_model ?? meta?.showResolvedModel
  return typeof v === 'boolean' ? v : true
}
