import { useEffect } from 'react'
import { useChatStore } from '../store/chat'
import { selectableRowIds } from '../store/chat/turn'

const NAV_KEYS = new Set([
  'j',
  'k',
  'h',
  'l',
  'J',
  'K',
  'H',
  'L',
  'g',
  'G',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  ' ',
  'Escape',
])

/** The scrollback scroll container (Scrollback.tsx data-scrollback-box). */
function scrollBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-scrollback-box]')
}

/**
 * Esc 阶梯跨焦点臂时间戳（epoch ms，0 = 未臂定）：scrollback 侧首个 idle
 * Esc 臂定（TUI prompt.rs try_handle_esc_policy 的 2×Esc = /rewind）。
 * 首次 Esc 已把焦点交回 prompt，第二次 Esc 落在 composer 的阶梯里——
 * Composer 的 idle Esc 分支经 escArmTimestamp() 读到这份臂定，跨焦点
 * 也能两击直达回退；第二击仍落在 scrollback（composer 缺席/异常）时由
 * 本 hook 的 idle 分支兜底。任何非 Esc 键（onKey 顶部）与臂定动作的
 * 执行路径都会解除。
 */
let escArmAt = 0

/** Esc 阶梯 TTL：与 Composer useEscLadder 的 800ms 臂定窗口一致。 */
const ESC_ARM_TTL_MS = 800

/** 当前跨焦点 Esc 臂时间戳（Composer idle Esc 分支判定第二次 Esc 用）。 */
export function escArmTimestamp(): number {
  return escArmAt
}

/** 解除跨焦点 Esc 臂（composer 执行臂定动作后调用，避免残留臂定）。 */
export function clearEscArm(): void {
  escArmAt = 0
}

/**
 * TUI page_up/page_down 的 select_viewport_edge（nav.rs:446-503）：翻页
 * 后选中视口上/下边缘的可见可选行。用滚动容器内 [data-entry-id] 行与
 * 视口矩形求交得可见行，边缘行须命中 selectableRowIds（j/k 的同一可选
 * 行通路；折叠隐藏的成员行不在其中），不命中则向视口内侧行走。
 */
function selectViewportEdge(dir: 'top' | 'bottom'): void {
  const st = useChatStore.getState()
  const box = scrollBox()
  if (!box) return
  const selectable = new Set(selectableRowIds(st.entries, st.expandedGroups))
  const boxRect = box.getBoundingClientRect()
  const visible = Array.from(
    box.querySelectorAll<HTMLElement>('[data-entry-id]'),
  ).filter((el) => {
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.bottom > boxRect.top && r.top < boxRect.bottom
  })
  const ordered = dir === 'top' ? visible : visible.reverse()
  for (const el of ordered) {
    const id = el.dataset.entryId
    if (id && selectable.has(id)) {
      st.selectEntry(id)
      return
    }
  }
}

/**
 * TUI NextResponse / PrevResponse (Shift+J / Shift+K) and PrevTurn /
 * NextTurn (Shift+H / Shift+L, actions/defaults.rs): select the nearest
 * entry of the given kind in `dir` and scroll it into view.
 */
function jumpToKind(
  st: ReturnType<typeof useChatStore.getState>,
  kind: 'user' | 'assistant',
  dir: 1 | -1,
): void {
  const idx = st.entries.findIndex((e) => e.id === st.selectedId)
  let i = (idx === -1 ? (dir === 1 ? -1 : st.entries.length) : idx) + dir
  while (i >= 0 && i < st.entries.length) {
    const e = st.entries[i]
    if (e?.kind === kind) {
      st.selectEntry(e.id)
      document
        .querySelector(`[data-entry-id="${e.id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      return
    }
    i += dir
  }
}

/**
 * True when the event target sits on (or inside) an interactive control —
 * links, buttons, selects, details/summary or any explicitly-tabbable
 * element. Those own Tab/Enter/Space natively (audit B1).
 */
function onInteractiveControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      'a[href], button, select, summary, [tabindex]:not([tabindex="-1"])',
    )
  )
}

/**
 * Global keybindings matching TUI scrollback navigation:
 * - Tab: toggle prompt ↔ scrollback focus
 * - j/k / ↑↓: move selection (scrollback focus)
 * - ← / → / h / l: collapse / expand selected foldable block (inline)
 * - Enter: open block viewer (TUI OpenBlockViewer); on a group header
 *   (gh_ row) toggles the group's expansion instead (TUI router.rs)
 * - Space: toggle inline expand
 * - g / G: scroll to top / bottom and select the first / last selectable
 *   entry (TUI goto_top/goto_bottom); G restores bottom-follow
 * - PgUp / PgDn: page the conversation and select the viewport-edge
 *   entry (TUI select_viewport_edge; from the prompt it only scrolls)
 * - Ctrl+J / Ctrl+K: scroll one line down / up without moving selection
 * - Ctrl+U / Ctrl+D: half page up / down
 * - Shift+J / Shift+K: next / previous assistant response
 * - Shift+H / Shift+L: previous / next user turn (TUI PrevTurn/NextTurn)
 * - Esc: close viewer if open, else scrollback → prompt (or the cancel
 *   flow when busy: saved preference acts directly, running subagents
 *   open the cancel panel, otherwise the turn is cancelled). Idle Esc is
 *   a 2-press ladder (TUI try_handle_esc_policy): the second press within
 *   the TTL opens the rewind picker.
 * - Ctrl+C: TUI ladder — a text selection always wins (browser copy); a
 *   non-empty draft is cleared next (turn keeps running); an empty draft
 *   cancels the running turn (subagents keep running). Idle with a draft
 *   clears it; idle and empty does nothing.
 * - Tab / Enter / Space: pane-switch and scrollback bindings yield to
 *   native behavior on interactive controls (link/button/select), so
 *   keyboard focus traversal and activation stay reachable (audit B1).
 */
export function useScrollbackKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore pure modifier chords (Ctrl-F also opens viewer — handled below)
      if (e.metaKey || e.altKey) return

      // Esc 阶梯：非 Esc 键解除跨焦点臂定（TUI try_handle_esc_policy）。
      if (e.key !== 'Escape') escArmAt = 0

      const store0 = useChatStore.getState()

      // Ctrl+F → OpenBlockViewer (TUI alt_keys for OpenBlockViewer)
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        if (store0.viewerEntryId || store0.viewerTask) return
        const target = e.target as HTMLElement | null
        const inField =
          !!target &&
          (target.tagName === 'TEXTAREA' ||
            target.tagName === 'INPUT' ||
            target.isContentEditable)
        if (inField) return
        e.preventDefault()
        if (store0.focusMode !== 'scrollback') store0.setFocus('scrollback')
        useChatStore.getState().openViewer()
        return
      }
      // Ctrl+C — TUI ladder (03-keyboard-shortcuts.md): a non-empty draft
      // is cleared first and the turn keeps running; an EMPTY draft
      // cancels the running turn directly (subagents keep running; no
      // panel, no preference check). Idle with a draft clears it; idle
      // and empty does nothing. Skipped while the viewer / x.ai surfaces
      // / cancel panel own the keys, and while a text selection exists
      // (browser copy must win).
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        const st = useChatStore.getState()
        if (
          (st.viewerEntryId || st.viewerTask) ||
          st.xaiRequests.length > 0 ||
          st.cancelPanelOpen
        ) {
          return
        }
        // 滚动区/页面文本选区优先（TUI 复制优先）：有非空选区时 Ctrl+C
        // 让给浏览器复制——不清草稿、不取消回合（textarea/input 内选区
        // 下面另有同效守卫，这里补上滚动区选中文本的场景，与文档注释
        // 承诺的行为对齐）。
        if ((window.getSelection()?.toString() ?? '') !== '') return
        const t = e.target as HTMLElement | null
        const inField =
          !!t &&
          (t.tagName === 'TEXTAREA' ||
            t.tagName === 'INPUT' ||
            t.isContentEditable)
        if (inField) {
          const el = t as HTMLTextAreaElement | HTMLInputElement
          if (
            el.selectionStart != null &&
            el.selectionEnd != null &&
            el.selectionStart !== el.selectionEnd
          ) {
            return // copy the selection, not a clear/cancel
          }
        }
        if (st.composerDraftLen > 0) {
          // Draft first: clear it, keep the turn (TUI Ctrl+C semantics).
          e.preventDefault()
          st.clearComposerDraft()
          return
        }
        if (st.conn === 'busy') {
          e.preventDefault()
          void st.cancelTurn({})
        }
        return
      }
      // Ctrl+J / Ctrl+K / Ctrl+U / Ctrl+D (TUI ScrollDown / ScrollUp /
      // HalfPageUp / HalfPageDown): scroll the conversation without moving
      // the selection. Inert while a modal surface owns the keys.
      if (
        e.ctrlKey &&
        (e.key === 'j' ||
          e.key === 'J' ||
          e.key === 'k' ||
          e.key === 'K' ||
          e.key === 'u' ||
          e.key === 'U' ||
          e.key === 'd' ||
          e.key === 'D')
      ) {
        if (
          store0.viewerEntryId ||
          store0.viewerTask ||
          store0.xaiRequests.length > 0 ||
          store0.cancelPanelOpen
        ) {
          return
        }
        const box = scrollBox()
        if (!box) return
        e.preventDefault()
        const line = e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K'
        let amount: number
        if (line) {
          // TUI ScrollUp/ScrollDown 是 1 行（defaults.rs "Scroll up/down
          // one line"）：按滚动容器的计算行高滚 1 行，读不到（line-height:
          // normal 等 NaN 场景）回退 22px。
          const lh = parseFloat(getComputedStyle(box).lineHeight)
          amount = Number.isFinite(lh) && lh > 0 ? lh : 22
        } else {
          amount = Math.max(120, Math.round(box.clientHeight / 2))
        }
        const up =
          e.key === 'k' || e.key === 'K' || e.key === 'u' || e.key === 'U'
        box.scrollBy({ top: up ? -amount : amount })
        return
      }
      if (e.ctrlKey) return

      const target = e.target as HTMLElement | null
      const inField =
        !!target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable)

      // Viewer open: only Esc is handled here (BlockViewer also listens);
      // don't steal other keys from the dialog.
      if (store0.viewerEntryId || store0.viewerTask) {
        if (e.key === 'Escape') {
          e.preventDefault()
          store0.closeViewer()
        }
        return
      }

      // x.ai interactive surface (ask_user_question modal / plan approval):
      // the modals own Esc + navigation while open.
      if (store0.xaiRequests.length > 0) return
      // Cancel-turn panel owns the keyboard while open (defense in depth —
      // the panel's own capture listener already stops the keys).
      if (store0.cancelPanelOpen) return

      // Activation keys on a focused control (link/button/select row)
      // must reach the control — the scrollback bindings below (Enter →
      // viewer, Space → fold toggle) must not swallow native keyboard
      // activation (same audit-B1 class as the Tab fix). j/k/←/→ don't
      // collide with any control, so they keep working globally.
      if (
        (e.key === 'Enter' || e.key === ' ') &&
        !inField &&
        onInteractiveControl(target)
      ) {
        return
      }

      // Tab: TUI pane-switch (prompt ↔ scrollback) — but native focus
      // traversal wins whenever focus already sits on an interactive
      // control (link / button / select / another field): hijacking Tab
      // unconditionally made every link and button keyboard-unreachable
      // (audit B1). The composer textarea keeps the pane-switch binding.
      if (e.key === 'Tab') {
        const isComposer =
          target instanceof HTMLElement && target.id === 'composer-input'
        if (isComposer || (!inField && !onInteractiveControl(target))) {
          e.preventDefault()
          const store = useChatStore.getState()
          if (store.focusMode === 'prompt') {
            store.setFocus('scrollback')
            if (inField) target?.blur()
          } else {
            store.setFocus('prompt')
            requestAnimationFrame(() => {
              document.getElementById('composer-input')?.focus()
            })
          }
        }
        return
      }

      // Typing in the prompt: Esc→cancel flow while busy; PgUp/PgDn page
      // the conversation without stealing focus (TUI docs: "prompt
      // focused — PgUp/PgDn scroll the conversation").
      if (inField) {
        const store = useChatStore.getState()
        if (e.key === 'Escape' && store.conn === 'busy') {
          e.preventDefault()
          void store.requestCancelTurn()
          return
        }
        if (e.key === 'PageUp' || e.key === 'PageDown') {
          const box = scrollBox()
          if (box) {
            e.preventDefault()
            box.scrollBy({
              top: (e.key === 'PageUp' ? -1 : 1) * box.clientHeight * 0.9,
            })
          }
        }
        return
      }

      if (!NAV_KEYS.has(e.key)) return

      // Enter scrollback on first nav key
      let store = useChatStore.getState()
      if (store.focusMode !== 'scrollback') {
        if (e.key === 'Escape') return
        store.setFocus('scrollback')
        store = useChatStore.getState()
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          store.selectDelta(1)
          return
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          store.selectDelta(-1)
          return
        case 'ArrowRight':
        case 'l':
          // Inline expand (TUI fold → Truncated)
          e.preventDefault()
          store.setExpanded(true)
          return
        case 'ArrowLeft':
        case 'h':
          // Inline collapse
          e.preventDefault()
          store.setExpanded(false)
          return
        case 'Enter':
          // Open block viewer (TUI OpenBlockViewer default_key: Enter).
          // 组头上 Enter 先切换组展开（TUI router.rs OpenBlockViewer 遇组
          // 头先 toggle_group_expansion）——openViewer 对 gh_ 前缀直接
          // no-op，不拦截的话组头上的 Enter 永远无动作。
          e.preventDefault()
          if (store.selectedId?.startsWith('gh_')) {
            store.toggleGroupExpansion(store.selectedId.slice(3))
            return
          }
          store.openViewer()
          return
        case ' ':
          // Space: inline fold toggle (not viewer)
          e.preventDefault()
          store.toggleSelected()
          return
        case 'g': {
          // TUI GotoTop: jump to the scrollback top (follow pauses
          // automatically — the box's onScroll sees the distance grow),
          // and select the FIRST selectable entry (nav.rs goto_top →
          // find_first_selectable_in_range) — j/k 的同一可选行通路。
          e.preventDefault()
          const box = scrollBox()
          if (box) box.scrollTop = 0
          const st = useChatStore.getState()
          const ids = selectableRowIds(st.entries, st.expandedGroups)
          if (ids.length > 0) st.selectEntry(ids[0])
          return
        }
        case 'G': {
          // TUI GotoBottom: jump to the bottom; landing near the bottom
          // re-engages the existing bottom-follow. Also selects the LAST
          // selectable entry (nav.rs goto_bottom →
          // find_last_selectable_in_range).
          e.preventDefault()
          const box = scrollBox()
          if (box) box.scrollTop = box.scrollHeight
          const st = useChatStore.getState()
          const ids = selectableRowIds(st.entries, st.expandedGroups)
          if (ids.length > 0) st.selectEntry(ids[ids.length - 1])
          return
        }
        case 'PageUp':
        case 'PageDown': {
          e.preventDefault()
          const box = scrollBox()
          if (!box) return
          box.scrollBy({
            top: (e.key === 'PageUp' ? -1 : 1) * box.clientHeight * 0.9,
          })
          // TUI page_up/page_down 滚完 select_viewport_edge（nav.rs）：
          // 选中视口上/下边缘的可见可选行。
          selectViewportEdge(e.key === 'PageUp' ? 'top' : 'bottom')
          return
        }
        case 'J':
          // TUI NextResponse: next assistant reply
          e.preventDefault()
          jumpToKind(store, 'assistant', 1)
          return
        case 'K':
          // TUI PrevResponse: previous assistant reply
          e.preventDefault()
          jumpToKind(store, 'assistant', -1)
          return
        case 'H':
          // TUI PrevTurn: previous user prompt
          e.preventDefault()
          jumpToKind(store, 'user', -1)
          return
        case 'L':
          // TUI NextTurn: next user prompt
          e.preventDefault()
          jumpToKind(store, 'user', 1)
          return
        case 'Escape':
          // TUI: Esc while a turn runs goes through the cancel flow —
          // saved preference acts directly, running subagents open the
          // cancel panel, otherwise the turn is cancelled outright.
          // Idle Esc = TUI prompt.rs try_handle_esc_policy 阶梯：首个 Esc
          // 臂定并照旧把焦点交回 prompt，800ms TTL（与 Composer 的
          // useEscLadder 一致）内第二次 Esc 打开 /rewind 回退选择器——
          // 第二击仍落在 scrollback 时在这里触发；焦点已切走时由
          // composer 经 escArmTimestamp() 串联的臂定判定触发。
          e.preventDefault()
          if (store.conn === 'busy') {
            // busy 路径不经阶梯：消费掉可能挂着的臂定，取消后的首个
            // idle Esc 不会误判为第二击。
            escArmAt = 0
            void store.requestCancelTurn()
            return
          }
          if (Date.now() - escArmAt < ESC_ARM_TTL_MS) {
            escArmAt = 0
            store.openRewind()
            return
          }
          escArmAt = Date.now()
          store.setFocus('prompt')
          requestAnimationFrame(() => {
            document.getElementById('composer-input')?.focus()
          })
          return
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
