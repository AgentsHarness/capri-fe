import { useCallback, useEffect, useReducer, useState } from 'react'
import { useChatStore } from '../store/chat'
import { Glyphs } from '../theme/glyphs'
import { IconGlyph } from './IconGlyph'
import { CONTENT_COLUMN_CLASS, COLUMN_PAD_X_CLASS } from '../theme/layout'
import { onUiSettingsReady, uiBool } from '../store/settings'
import type { PendingReq, PermissionScope, ScrollEntry } from '../api/types'

/** One permission option from the request params. `meta` is the ACP
 *  PermissionOption `meta` map (camelCase wire) — the TUI reads
 *  McpToolPermission / BashCommandPermission off it. */
type Option = {
  optionId: string
  name?: string
  kind?: string
  label?: string
  meta?: unknown
}

/**
 * Permission strip — maps to TUI PermissionView sitting above the prompt.
 * Numbered options 1–N, diamond cue for "waiting on you".
 *
 * Keyboard model (card owns the keyboard while open, TUI PermissionView):
 *   ↑/↓ or j/k      move the selection (clamped)
 *   Tab/Shift+Tab   walk the options, wrapping
 *   1–9             pick that option directly
 *   Enter           confirm the focused option
 *   ←/→             cycle the "always allow" scope preset — bash:
 *                   精确 → 目录 → 通配 (TUI arrow word-scope); MCP
 *                   prompts: 精确工具 → 整个 server (TUI McpScope
 *                   Tool/Server toggle, hidden without a `server__`
 *                   prefix)
 *   e               open the free-form bash pattern editor (TUI e key;
 *                   pre-filled with the command, Enter persists)
 *   Ctrl+F          expand/collapse the bash command body (TUI Ctrl-F)
 *   Esc             "park": hand the keyboard back to the scrollback (the
 *                   card stays on screen; Tab/Space returns; parked Esc is
 *                   a swallowed no-op — it never answers or dismisses)
 *   Ctrl+C          cancel the request (respond cancelled)
 * Mouse: click an option, the ✗ reject button (opens the inline followup
 * input — Enter confirms, Esc closes), or the reset button — all kept
 * from the previous mouse-only version.
 */
export function ApprovalStrip() {
  const pending = useChatStore((s) => s.pending)
  const respond = useChatStore((s) => s.respondPermission)
  const resetPermissions = useChatStore((s) => s.resetPermissions)
  const [sel, setSel] = useState(0)
  const [parked, setParked] = useState(false)
  const [scopeIdx, setScopeIdx] = useState(0)
  /** Bash command body Ctrl+F expand/collapse (TUI args_expanded). */
  const [expanded, setExpanded] = useState(false)
  /** Reject-with-followup inline input (TUI RejectOnce followup row). */
  const [followupOpen, setFollowupOpen] = useState(false)
  const [followupText, setFollowupText] = useState('')
  /** optionId of the reject option awaiting followup confirmation (TUI
   *  RejectOnce: picking the reject row opens the followup input first —
   *  the reply is only sent once the feedback is confirmed). */
  const [rejectOption, setRejectOption] = useState<string | undefined>(undefined)
  /** Free-form bash pattern editor (TUI e key → PatternEdit focus): the
   *  current buffer, or null when closed. Enter persists the pattern as a
   *  glob grant (scope {commandParts: [pattern], isGlob: true}); Esc
   *  discards and returns to the option rows. */
  const [patternEdit, setPatternEdit] = useState<string | null>(null)

  const req = pending[0]
  const rawOptions = (req?.params?.options as Option[] | undefined) || []
  // TUI [ui] remember_tool_approvals (default false): per-command
  // "Always allow" rows only appear on prompts when enabled. Filtering is
  // display-side only — host-side grants are untouched.
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    onUiSettingsReady(() => forceRender())
  }, [])
  const rememberApprovals = uiBool('remember_tool_approvals', false)
  const options = rememberApprovals
    ? rawOptions
    : visiblePermissionOptions(rawOptions)
  const toolCall = req?.params?.toolCall as
    | { title?: string; kind?: string; rawInput?: unknown; raw_input?: unknown }
    | undefined
  /** Bash command text — toolCall.title is already the command (TUI
   *  build_permission_display's raw-command source). */
  const command = typeof toolCall?.title === 'string' ? toolCall.title : ''
  // Collapsed budget for the command body (TUI PERMISSION_COLLAPSED_ROWS).
  // Independent of `expanded` so Ctrl+F can collapse an expanded view again.
  const commandLines = command ? command.split('\n') : []
  const collapsible = commandLines.length > PERMISSION_COLLAPSED_ROWS
  const hasAlways = options.some(isAlwaysOption)

  // ── MCP scope (TUI McpScopeState) ─────────────────────────────────
  // Detection mirrors the TUI (acp_handler/permissions.rs
  // enqueue_permission): the `allow-always-mcp` option carrying
  // McpToolPermission meta {prompt_prefix, tool_name, server_prefix} is
  // the source of truth; the tool_call rawInput variant
  // (UseTool/MCPTool — mcp_args_lines) and a `server__tool` title are
  // defensive fallbacks for hosts that strip option meta.
  const mcp = deriveMcp(options, toolCall)
  // Scope presets: Tool ↔ Server only when the tool name has a `__`
  // server segment (TUI has_adjustable_scope; no prefix → tool-only).
  const mcpScopes: ReadonlyArray<'tool' | 'server'> = mcp.serverPrefix
    ? ['tool', 'server']
    : ['tool']
  const mcpScope = mcpScopes[scopeIdx % mcpScopes.length] ?? 'tool'
  /** TUI dynamic_option_label scope text: "(Server) Action" for tool
   *  scope, "all tools from <Server>" (title-cased) for server scope. */
  const mcpScopeText =
    mcpScope === 'server' && mcp.serverPrefix
      ? `all tools from ${mcpTitleizeSegment(mcp.serverPrefix)}`
      : mcpToolDisplayName(mcp.toolName, mcp.serverPrefix)
  /** ←/→ meaningful: always option present; MCP additionally needs the
   *  `__` server segment (TUI has_adjustable_scope). */
  const arrowsEnabled = hasAlways && (!mcp.isMcp || !!mcp.serverPrefix)

  // TUI ←/→ presets for the scope an "always" answer would remember. The
  // structured scope rides along in the permission response as `scope`.
  const scopeText = mcp.isMcp
    ? mcpScopeText
    : SCOPE_PRESETS[scopeIdx % SCOPE_PRESETS.length]

  /** Structured scope for the current ←/→ preset, or undefined when there
   *  is no command to scope. Bash mirrors TUI BashCommandSelectedTerms
   *  construction (dispatch/permissions.rs build_selection_meta):
   *  arrow word-scope is a literal command-prefix word list (is_glob
   *  false), the pattern editor's confirmed pattern is a single text
   *  (is_glob true). MCP mirrors TUI McpScopeSelection (kind-tagged).
   *  useCallback: the keydown effect depends on it — a fresh function
   *  every render would re-attach the listener. */
  const scopeForPreset = useCallback((): PermissionScope | undefined => {
    if (mcp.isMcp) {
      if (!mcp.toolName) return undefined
      if (mcpScope === 'server' && mcp.serverPrefix) {
        return { kind: 'server', server: mcp.serverPrefix }
      }
      return { kind: 'tool', tool_name: mcp.toolName }
    }
    const words = command.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return undefined
    const rawInput =
      (toolCall?.rawInput as Record<string, unknown> | undefined) ??
      (toolCall?.raw_input as Record<string, unknown> | undefined)
    // '目录' carries the command's first word + its working directory
    // (raw_input cwd/workdir, falling back to the session cwd).
    const cmdCwd =
      (typeof rawInput?.cwd === 'string' && rawInput.cwd) ||
      (typeof rawInput?.workdir === 'string' && rawInput.workdir) ||
      useChatStore.getState().cwd
    switch (SCOPE_PRESETS[scopeIdx % SCOPE_PRESETS.length]) {
      case '目录':
        return {
          commandParts: [words[0], cmdCwd].filter(
            (p): p is string => !!p && p.length > 0,
          ),
          isGlob: false,
        }
      case '通配':
        // The pattern editor's confirmed pattern (pre-filled with the
        // command) as a single glob (TUI pattern editor, e key).
        return { commandParts: [patternEdit ?? command], isGlob: true }
      default: // '精确' — every word, literal prefix.
        return { commandParts: words, isGlob: false }
    }
  }, [mcp, mcpScope, command, toolCall, scopeIdx, patternEdit])

  /** Subagent provenance line above the title (TUI resolve_subagent_label,
   *  acp_handler/permissions.rs L207-237): direct source/subagent fields in
   *  the request params when the host ships them, else the request's
   *  session_id looked up in the tracked subagent registry (tier 1), else
   *  a plain "Child session (untracked)" marker for non-root sessions
   *  (tier 2). Root session → no provenance. */
  function subagentProvenance(req: PendingReq | undefined): string | undefined {
    if (!req) return undefined
    const params = req.params ?? {}
    const src = params.source ?? params.subagent
    if (typeof src === 'string' && src) return `Subagent "${src}":`
    if (src && typeof src === 'object') {
      const o = src as Record<string, unknown>
      const name =
        (typeof o.description === 'string' && o.description) ||
        (typeof o.name === 'string' && o.name) ||
        (typeof o.subagent_type === 'string' && o.subagent_type) ||
        ''
      const type =
        typeof o.subagent_type === 'string' && o.subagent_type !== name
          ? o.subagent_type
          : undefined
      if (name) return type ? `Subagent "${name}" (${type}):` : `Subagent "${name}":`
    }
    const st = useChatStore.getState()
    const sid =
      (typeof params.session_id === 'string' && params.session_id) ||
      (typeof params.sessionId === 'string' && params.sessionId) ||
      ''
    if (!sid || sid === st.sessionId) return undefined
    // Tier 1: tracked subagent (subagentIndex keyed by subagent/child id).
    const entryId = st.subagentIndex[sid]
    const entry = entryId
      ? st.entries.find(
          (e): e is Extract<ScrollEntry, { kind: 'subagent' }> =>
            e.id === entryId && e.kind === 'subagent',
        )
      : undefined
    if (entry) return `Subagent "${entry.title}":`
    // Tier 2: non-root session with no tracked info.
    return 'Child session (untracked):'
  }

  // Reset per-request local state.
  useEffect(() => {
    setSel(0)
    setParked(false)
    setScopeIdx(0)
    setExpanded(false)
    setFollowupOpen(false)
    setFollowupText('')
    setRejectOption(undefined)
    setPatternEdit(null)
  }, [req?.requestId])

  // Keyboard ownership while a permission request is open. Capture phase +
  // stopImmediatePropagation so this card wins over the global scrollback
  // keys (and over the cancel panel / question modal, which register after).
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const st = useChatStore.getState()
      // Fullscreen block viewer owns keys while open (TUI viewer layer).
      if (st.viewerEntryId || st.viewerTask) return
      // The request was resolved while this listener was live.
      if (st.pending.length === 0 || st.pending[0].requestId !== req.requestId) return
      // Fresh options straight from the store (never stale closures).
      const rawOpts =
        (st.pending[0].params?.options as Option[] | undefined) || []
      const opts = rememberApprovals
        ? rawOpts
        : visiblePermissionOptions(rawOpts)
      const hasAlwaysOpt = opts.some(isAlwaysOption)
      // Fresh MCP facts (allow-always-mcp option meta / toolCall variant).
      const tc = st.pending[0].params?.toolCall as
        | { title?: string; rawInput?: unknown; raw_input?: unknown }
        | undefined
      const mcpNow = deriveMcp(opts, tc)
      const commandNow = typeof tc?.title === 'string' ? tc.title : ''
      // Browser chords (Cmd/Ctrl/Alt) pass through untouched.
      if (e.metaKey || e.altKey) return

      // Typing a message draft in the prompt: the card only keeps Tab
      // (walk options) / Esc (park) / Ctrl+C (cancel) so the draft can be
      // edited and Enter can still send/queue it.
      const typingDraft = (() => {
        const t = e.target as HTMLElement | null
        if (!t) return false
        if (
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'INPUT' ||
          t.isContentEditable
        ) {
          return (t as HTMLTextAreaElement).value.trim() !== ''
        }
        return false
      })()

      if (e.ctrlKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault()
          e.stopImmediatePropagation()
          void respond(req.requestId, undefined, true)
        } else if ((e.key === 'f' || e.key === 'F') && collapsible) {
          // TUI Ctrl-F: expand/collapse the bash command body. When the
          // body fits the collapsed budget, the chord falls through to the
          // browser (find) / scrollback (block viewer).
          e.preventDefault()
          e.stopImmediatePropagation()
          setExpanded((x) => !x)
        } else {
          // Other Ctrl chords: keep them from reaching the scrollback keys,
          // but don't preventDefault (browser copy/paste still works).
          e.stopImmediatePropagation()
        }
        return
      }

      if (patternEdit !== null) {
        // Free-form pattern editor owns the row (TUI PatternEdit focus):
        // Enter persists the pattern as a glob grant, Esc discards it;
        // every other key edits the buffer (no preventDefault — the
        // focused input receives it) and must never reach the option keys.
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopImmediatePropagation()
          const text = patternEdit.trim()
          if (!text) return // blank → stay in the editor (TUI trimmed gate)
          // The editor authors an ALLOW pattern: dispatch through the
          // scoped allow-always row (TUI selects the allow-always-command
          // row on Enter).
          const target =
            opts.find((o) => o.optionId === 'allow-always-command') ??
            opts[sel] ??
            opts.find(isAlwaysOption)
          setPatternEdit(null)
          if (target && isAlwaysOption(target)) {
            void respond(req.requestId, target.optionId, false, {
              commandParts: [text],
              isGlob: true,
            })
          } else if (target) {
            void respond(req.requestId, target.optionId, false, undefined)
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setPatternEdit(null)
        }
        return
      }

      if (followupOpen) {
        // Reject-followup inline input owns the row (TUI FollowupInput):
        // Enter confirms, Esc closes; every other key edits the input and
        // must NOT reach the option keys below.
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopImmediatePropagation()
          const text = followupText.trim()
          const ro = rejectOption
          setFollowupOpen(false)
          setFollowupText('')
          setRejectOption(undefined)
          // Empty text = plain reject; non-empty rides along as
          // followupMessage (host contract, TUI dispatch_permission_followup).
          void respond(req.requestId, ro, true, undefined, text || undefined)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setFollowupOpen(false)
          setFollowupText('')
          setRejectOption(undefined)
          setParked(false)
        }
        return
      }

      if (parked) {
        // Parked: Tab / Space hand the keyboard back to the card. Esc is a
        // swallowed no-op (TUI Escape table: pending needs-input overlay).
        if (e.key === 'Tab' || (e.key === ' ' && !typingDraft)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          setParked(false)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        return
      }

      if (typingDraft) {
        if (e.key === 'Tab') {
          e.preventDefault()
          e.stopImmediatePropagation()
          const dir = e.shiftKey ? -1 : 1
          if (opts.length > 0) {
            setSel((s) => (s + dir + opts.length) % opts.length)
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setParked(true)
        }
        return
      }

      // ── card keyboard (active) ──
      const n = opts.length
      if (n === 0) {
        // No options: only Esc (park) and Ctrl+C (above) make sense; every
        // other key is swallowed so it can't act on the scrollback/prompt.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopImmediatePropagation()
          setParked(true)
        } else {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        return
      }
      let handled = true
      switch (e.key) {
        case 'ArrowUp':
        case 'k':
          setSel((s) => Math.max(0, s - 1))
          break
        case 'ArrowDown':
        case 'j':
          setSel((s) => Math.min(n - 1, s + 1))
          break
        case 'Tab': {
          const dir = e.shiftKey ? -1 : 1
          setSel((s) => (s + dir + n) % n)
          break
        }
        case 'ArrowLeft':
        case 'h':
        case 'ArrowRight':
        case 'l':
          // ←/→ widen/narrow the scope an "always" answer remembers —
          // bash: 精确/目录/通配; MCP: 精确工具/整个 server (only when
          // the tool name has a `__` server segment). Without an
          // adjustable scope they are swallowed no-ops (never fold keys).
          if (hasAlwaysOpt && (!mcpNow.isMcp || !!mcpNow.serverPrefix)) {
            const dir = e.key === 'ArrowLeft' || e.key === 'h' ? -1 : 1
            const count = mcpNow.isMcp
              ? mcpNow.serverPrefix
                ? 2
                : 1
              : SCOPE_PRESETS.length
            const next = (scopeIdx + dir + count) % count
            setScopeIdx(next)
            // Bash: landing on 通配 opens the pattern editor (TUI e-key
            // flow, pre-filled with the command); leaving it closes the
            // editor. MCP prompts have no pattern editor.
            if (!mcpNow.isMcp) {
              if (next === SCOPE_PRESETS.length - 1 && patternEdit === null) {
                setPatternEdit(commandNow)
              } else if (next !== SCOPE_PRESETS.length - 1 && patternEdit !== null) {
                setPatternEdit(null)
              }
            }
          }
          break
        case 'Enter': {
          const opt = opts[sel]
          // TUI RejectOnce: a reject row never answers directly — it opens
          // the followup input first; the reply fires on confirmation.
          if (isRejectOption(opt)) {
            setRejectOption(opt.optionId)
            setFollowupOpen(true)
            setFollowupText('')
            break
          }
          void respond(
            req.requestId,
            opt?.optionId,
            false,
            isAlwaysOption(opt) ? scopeForPreset() : undefined,
          )
          break
        }
        case 'e':
          // TUI e key: open the free-form pattern editor on a bash prompt
          // (has_editable_bash_pattern — pre-filled with the command;
          // Enter persists, Esc discards). MCP prompts have no editor.
          if (
            !mcpNow.isMcp &&
            commandNow.trim() &&
            hasAlwaysOpt &&
            patternEdit === null
          ) {
            setScopeIdx(SCOPE_PRESETS.length - 1)
            setPatternEdit(commandNow)
            break
          }
          handled = false
          break
        case 'Escape':
          setParked(true)
          break
        default:
          if (/^[1-9]$/.test(e.key)) {
            const idx = Number(e.key) - 1
            if (idx < n) {
              const opt = opts[idx]
              if (isRejectOption(opt)) {
                setRejectOption(opt.optionId)
                setFollowupOpen(true)
                setFollowupText('')
                break
              }
              void respond(
                req.requestId,
                opt.optionId,
                false,
                isAlwaysOption(opt) ? scopeForPreset() : undefined,
              )
              break
            }
          }
          handled = false
      }
      if (handled) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, respond, sel, parked, scopeIdx, followupOpen, followupText, rejectOption, patternEdit, expanded, collapsible, scopeForPreset, rememberApprovals])

  if (pending.length === 0) return null

  const provenance = subagentProvenance(req)

  return (
    // Background band is confined to the content column (max-w-[960px],
    // same as scrollback/composer) — the strip must not read wider than
    // the conversation it approves.
    <div
      className={`${CONTENT_COLUMN_CLASS} border-t border-gn-yellow/30 bg-gn-bg-dark py-2.5`}
    >
      <div className={COLUMN_PAD_X_CLASS}>
        {provenance && (
          <div className="mb-1 text-[11px] text-gn-muted">{provenance}</div>
        )}
        <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          <span className="text-gn-yellow animate-pulse" aria-hidden>
            <IconGlyph glyph={Glyphs.diamondFilled} color="currentColor" />
          </span>
          <span className="font-bold text-gn-yellow">waiting on you</span>
          <span className="text-gn-muted truncate">{req.method}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void resetPermissions()}
              className="rounded border border-gn-prompt-border px-2 py-[3px] text-[11px] text-gn-muted transition-colors hover:border-gn-prompt-border-active hover:bg-gn-bg-highlight hover:text-gn-fg"
              title="x.ai/permissions/reset — 忘记已记忆的权限规则（始终允许模式等）"
            >
              重置权限规则
            </button>
            <button
              type="button"
              onClick={() => {
                // Opens the followup input INSIDE the reject option row
                // (TUI RejectOnce followup — no separate input line); a
                // second click closes it. Without a reject option the
                // button rejects directly (nothing to attach feedback to).
                if (followupOpen) {
                  setFollowupOpen(false)
                  setFollowupText('')
                  setRejectOption(undefined)
                  return
                }
                const firstReject = options.find(isRejectOption)
                if (firstReject) {
                  setRejectOption(firstReject.optionId)
                  setFollowupOpen(true)
                  setFollowupText('')
                } else {
                  void respond(req.requestId, undefined, true)
                }
              }}
              className={`inline-flex items-center gap-1 rounded border px-2 py-[3px] text-[11px] transition-colors ${
                followupOpen
                  ? 'border-gn-red/70 bg-gn-diff-del-bg text-gn-red'
                  : 'border-gn-red/40 text-gn-red hover:bg-gn-diff-del-bg'
              }`}
              title="拒绝并取消该请求（可附带给 agent 的反馈）"
            >
              <IconGlyph glyph={Glyphs.ballotX} color="currentColor" />
              reject
            </button>
          </span>
        </div>
        {command && (
          <div className="mb-2 pl-5">
            <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-gn-fg2">
              {commandLines
                .slice(0, expanded || !collapsible ? commandLines.length : PERMISSION_COLLAPSED_ROWS - 1)
                .join('\n')}
            </div>
            {collapsible && !expanded && (
              <div className="mt-0.5 text-[11px] text-gn-muted">
                … Ctrl-F to expand
              </div>
            )}
          </div>
        )}
        {hasAlways && (!mcp.isMcp || !!mcp.serverPrefix) && (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11.5px] text-gn-cyan">
            <span>
              {mcp.isMcp ? '←/→ 切换允许范围' : '←/→ 调整始终允许范围'}
            </span>
            <span
              className="rounded border border-gn-cyan/40 bg-gn-bg-base px-1.5 py-[1px] font-mono"
              title={
                mcp.isMcp && mcp.serverPrefix
                  ? '精确工具: 仅该工具 · 整个 server: 该服务器的全部工具'
                  : undefined
              }
            >
              {scopeText}
            </span>
            {!mcp.isMcp && patternEdit === null && (
              <button
                type="button"
                onClick={() => {
                  setScopeIdx(SCOPE_PRESETS.length - 1)
                  setPatternEdit(command)
                }}
                className="rounded border border-gn-cyan/40 px-1.5 py-[1px] text-[10.5px] text-gn-cyan transition-colors hover:bg-gn-bg-highlight"
                title="打开自由模式 glob 编辑器（TUI e 键）"
              >
                e 编辑
              </button>
            )}
          </div>
        )}
        {/* Free-form bash pattern editor (TUI e key → PatternEdit focus):
            single-line input pre-filled with the command; Enter persists
            the pattern as {commandParts:[pattern], isGlob:true}, Esc
            discards. Mouse users get 保存/取消. */}
        {!mcp.isMcp && patternEdit !== null && (
          <div className="mb-2 flex items-center gap-1.5 pl-5">
            <input
              autoFocus
              value={patternEdit}
              onChange={(e) => setPatternEdit(e.target.value)}
              onFocus={(e) => {
                const v = e.target.value
                e.target.setSelectionRange(v.length, v.length)
              }}
              placeholder="glob 模式，如 gh api repos/*"
              className="min-w-0 flex-1 rounded border border-gn-cyan/40 bg-gn-bg-base px-2 py-1 font-mono text-[12px] text-gn-fg outline-none placeholder:text-gn-muted"
            />
            <button
              type="button"
              onClick={() => {
                const text = patternEdit.trim()
                const target =
                  options.find((o) => o.optionId === 'allow-always-command') ??
                  options[sel] ??
                  options.find(isAlwaysOption)
                setPatternEdit(null)
                if (!text || !target) return
                void respond(
                  req.requestId,
                  target.optionId,
                  false,
                  isAlwaysOption(target)
                    ? { commandParts: [text], isGlob: true }
                    : undefined,
                )
              }}
              className="shrink-0 rounded border border-gn-cyan/40 px-2 py-1 text-[11px] text-gn-cyan transition-colors hover:bg-gn-bg-highlight"
              title="Enter 确认 · 以 glob 模式保存"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setPatternEdit(null)}
              className="shrink-0 rounded border border-gn-prompt-border px-2 py-1 text-[11px] text-gn-muted transition-colors hover:bg-gn-bg-highlight hover:text-gn-fg"
              title="Esc 取消"
            >
              取消
            </button>
          </div>
        )}
        {/* TUI PermissionView: options are full-width rows, one per line —
            j/k ↑/↓ walk them, Enter or 1-N pick. Always vertical; never
            wraps into a horizontal row on wide screens. The reject row
            embeds its followup input (TUI RejectOnce followup) instead of
            opening a separate input line. */}
        <div className="flex flex-col gap-1.5 pl-0 sm:pl-5">
          {options.map((opt, i) =>
            isRejectOption(opt) && followupOpen && rejectOption === opt.optionId ? (
              <div
                key={opt.optionId}
                className="flex min-h-10 w-full items-center gap-1.5 rounded border border-gn-red/50 bg-gn-bg-base px-3 py-1.5"
              >
                <span className="mr-1.5 font-mono text-gn-muted">{i + 1}</span>
                <input
                  autoFocus
                  value={followupText}
                  onChange={(e) => setFollowupText(e.target.value)}
                  placeholder="给 agent 的反馈（可选，Enter 拒绝）…"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-gn-fg outline-none placeholder:text-gn-muted"
                />
                <button
                  type="button"
                  onClick={() => {
                    const text = followupText.trim()
                    const ro = rejectOption
                    setFollowupOpen(false)
                    setFollowupText('')
                    setRejectOption(undefined)
                    void respond(req.requestId, ro, true, undefined, text || undefined)
                  }}
                  className="shrink-0 rounded border border-gn-red/40 px-2 py-1 text-[11px] text-gn-red transition-colors hover:bg-gn-diff-del-bg"
                  title="Enter 确认 · Esc 关闭"
                >
                  确认拒绝
                </button>
              </div>
            ) : (
              <button
                key={opt.optionId}
                type="button"
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  // TUI RejectOnce: clicking a reject row opens the followup
                  // input inside the row instead of answering directly.
                  if (isRejectOption(opt)) {
                    setRejectOption(opt.optionId)
                    setFollowupOpen(true)
                    setFollowupText('')
                    return
                  }
                  void respond(
                    req.requestId,
                    opt.optionId,
                    false,
                    isAlwaysOption(opt) ? scopeForPreset() : undefined,
                  )
                }}
                className={`min-h-10 w-full rounded border px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                  i === sel
                    ? // Selected row: yellow border + solid dot, background
                      // stays base — no dark-gray fill.
                      'border-gn-yellow/60 bg-gn-bg-base text-gn-fg'
                    : 'border-gn-prompt-border bg-gn-bg-base text-gn-fg hover:border-gn-magenta/50 hover:bg-gn-bg-highlight'
                }`}
              >
                <span className="mr-1.5 font-mono text-gn-muted">{i + 1}</span>
                {/* Radio marker: solid for always-allow rows AND the
                    selected row (TUI `1 (●) …` rows), hollow otherwise. */}
                <span
                  className={`mr-1.5 ${
                    isAlwaysOption(opt)
                      ? 'text-gn-cyan'
                      : i === sel
                        ? 'text-gn-yellow'
                        : 'text-gn-muted'
                  }`}
                  aria-hidden
                >
                  {isAlwaysOption(opt) || i === sel ? '●' : '○'}
                </span>
                {opt.name || opt.label || opt.optionId}
                {isAlwaysOption(opt) && (
                  <span className="ml-1.5 text-[10.5px] text-gn-cyan">always</span>
                )}
              </button>
            ),
          )}
        </div>
        <div className="mt-1.5 pl-5 text-[11px] text-gn-muted">
          {parked ? (
            <span>
              <span className="text-gn-fg2">Tab/Space</span> 返回权限卡 ·{' '}
              <span className="text-gn-fg2">Ctrl+C</span> 取消请求
            </span>
          ) : (
            <span>
              ↑/↓ 或 j/k 选择 · <span className="text-gn-fg2">1-9</span> 直接选 ·{' '}
              <span className="text-gn-fg2">Enter</span> 确认 ·{' '}
              <span className="text-gn-fg2">Esc</span> 暂停键盘
              {arrowsEnabled
                ? ` · ←/→ ${mcp.isMcp ? '切换允许范围' : '调整始终允许范围'}`
                : ''}
              {!mcp.isMcp && hasAlways && patternEdit === null ? ' · e 编辑模式' : ''}
              {collapsible && !expanded ? ' · Ctrl+F 展开命令' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** TUI ←/→ scope presets for an "always allow" answer. Each maps to a
 *  structured BashCommandSelectedTerms (see scopeForPreset): 精确 = every
 *  command word, 目录 = first word + working directory, 通配 = the whole
 *  command as a glob (editable via the e-key pattern editor). MCP prompts
 *  replace this with the Tool/Server pair (McpScopeSelection). */
const SCOPE_PRESETS = ['精确', '目录', '通配']

/** TUI mcp_titleize_segment (xai-grok-workspace permission/prompter.rs):
 *  split on '_', capitalize each word's first char, join with spaces —
 *  "list_issues" → "List Issues"; camelCase/hyphens pass through. */
function mcpTitleizeSegment(name: string): string {
  return name
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** TUI mcp_tool_display_name — "(Server) Action" with both segments
 *  title-cased when a server prefix exists, else the title-cased tool
 *  name. The scope badge shows exactly this for tool-scope. */
function mcpToolDisplayName(toolName: string, serverPrefix?: string): string {
  if (serverPrefix && toolName.startsWith(`${serverPrefix}__`)) {
    const action = toolName.slice(serverPrefix.length + 2)
    return `(${mcpTitleizeSegment(serverPrefix)}) ${mcpTitleizeSegment(action)}`
  }
  return mcpTitleizeSegment(toolName)
}

/** TUI parse_mcp_qualified_name (xai-grok-mcp servers.rs): exactly one
 *  `__` delimiter with non-empty segments → {server, tool}, else
 *  undefined (zero or 2+ delimiters are not qualified MCP ids). */
function parseMcpQualifiedName(
  name: string,
): { server: string; tool: string } | undefined {
  const idx = name.indexOf('__')
  if (idx <= 0) return undefined
  if (name.indexOf('__', idx + 2) !== -1) return undefined
  const server = name.slice(0, idx)
  const tool = name.slice(idx + 2)
  if (!server || !tool) return undefined
  return { server, tool }
}

/** McpToolPermission meta (TUI prompter.rs) — attached to the
 *  `allow-always-mcp` option: {prompt_prefix, tool_name, server_prefix}. */
type McpPermMeta = {
  prompt_prefix?: string
  tool_name?: string
  server_prefix?: string | null
}

/** Read McpToolPermission off the `allow-always-mcp` option's meta —
 *  the TUI's source of truth for MCP scope state (acp_handler/
 *  permissions.rs enqueue_permission). Undefined = not an MCP prompt. */
function mcpOptionMeta(opts: Option[]): McpPermMeta | undefined {
  const opt = opts.find((o) => o.optionId === 'allow-always-mcp')
  const meta = opt?.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  return meta as McpPermMeta
}

/**
 * MCP permission derivation shared by the render and the key handler.
 * Primary detection: the `allow-always-mcp` option carrying McpToolPermission
 * meta (TUI enqueue_permission). Defensive fallbacks for hosts that strip
 * option meta: the tool_call rawInput variant UseTool/MCPTool (TUI
 * mcp_args_lines) and a qualified `server__tool` title.
 */
function deriveMcp(
  opts: Option[],
  toolCall: { title?: string; rawInput?: unknown; raw_input?: unknown } | undefined,
): { isMcp: boolean; toolName: string; serverPrefix?: string } {
  const meta = mcpOptionMeta(opts)
  const ri = (toolCall?.rawInput ?? toolCall?.raw_input) as
    | Record<string, unknown>
    | undefined
  const variant = ri?.variant
  const qualified =
    typeof toolCall?.title === 'string'
      ? parseMcpQualifiedName(toolCall.title)
      : undefined
  const toolName =
    (typeof meta?.tool_name === 'string' && meta.tool_name) ||
    (typeof ri?.tool_name === 'string' && ri.tool_name) ||
    (qualified?.tool ?? '') ||
    (typeof toolCall?.title === 'string' ? toolCall.title : '')
  const serverPrefix =
    (typeof meta?.server_prefix === 'string' && meta.server_prefix) ||
    parseMcpQualifiedName(toolName)?.server
  return {
    isMcp: !!meta || variant === 'UseTool' || variant === 'MCPTool' || !!qualified,
    toolName,
    serverPrefix,
  }
}

/** TUI PERMISSION_COLLAPSED_ROWS (permission_view.rs) — bash body rows
 *  shown before folding with "… Ctrl-F to expand". */
const PERMISSION_COLLAPSED_ROWS = 5

const ALWAYS_RE = /always|always_allow|alwaysAllow|始终|总是/i

/** remember_tool_approvals=false: drop always-allow rows from display,
 *  unless that would leave no options at all (never show an empty card). */
function visiblePermissionOptions(raw: Option[]): Option[] {
  const kept = raw.filter((o) => !isAlwaysOption(o))
  return kept.length > 0 ? kept : raw
}

/** An option carrying "always allow" semantics (optionId or label). */
function isAlwaysOption(opt: Option | undefined): boolean {
  if (!opt) return false
  return (
    ALWAYS_RE.test(opt.optionId || '') ||
    ALWAYS_RE.test(opt.label || '') ||
    ALWAYS_RE.test(opt.name || '')
  )
}

const REJECT_RE = /reject|拒绝/i

/** An option carrying reject semantics — selecting it opens the followup
 *  input first (TUI RejectOnce) instead of answering immediately. */
function isRejectOption(opt: Option | undefined): boolean {
  if (!opt) return false
  return (
    REJECT_RE.test(opt.optionId || '') ||
    REJECT_RE.test(opt.label || '') ||
    REJECT_RE.test(opt.name || '')
  )
}
