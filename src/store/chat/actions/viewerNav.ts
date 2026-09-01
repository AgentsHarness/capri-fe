import { scanGroups, spanContaining } from '../../../scrollback/verbGroup'
import {
  nextThoughtMode,
  thoughtDisplayMode,
  thoughtModeStepDown,
  thoughtModeStepUp,
  type ThoughtDisplayMode,
} from '../../../scrollback/thoughtMode'
import { hookGroupsHaveContent } from '../../../scrollback/hookRuns'
import { currentCollapseToolGroups } from '../../historyPins'
import { fillEntryRange } from '../historyFill'
import type { ChatState, SetState } from '../types'
import { selectableRowIds } from '../turn'

export function viewerNavActions(set: SetState, get: () => ChatState) {
  return {
  toggleTool: (id) => {
    // 展开即「要看正文」：lite 裁掉的行按 [msgSeq, msgSeqEnd] 区间按需补回
    // （非 lite 行 no-op；折叠回去不打扰）。
    const cur = get().entries.find((e) => e.id === id)
    const willExpand = cur != null && cur.kind === 'tool' && !cur.expanded
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'tool' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
    if (willExpand) void fillEntryRange(set, get, id)
  },

  toggleThought: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'thought'
          ? { ...e, displayMode: nextThoughtMode(thoughtDisplayMode(e)) }
          : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleUser: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'user' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleBtw: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'btw' ? { ...e, open: !e.open } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleLifecycle: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'lifecycle' ? { ...e, expanded: !e.expanded } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  toggleSessionEvent: (id) => {
    set({
      entries: get().entries.map((e) =>
        e.id === id && e.kind === 'session_event' ? { ...e, open: !e.open } : e,
      ),
      selectedId: id,
      focusMode: 'scrollback',
    })
  },

  setFocus: (mode) => {
    const s = get()
    if (mode === 'scrollback') {
      const ids = selectableRowIds(s.entries, s.expandedGroups)
      const id =
        s.selectedId && ids.includes(s.selectedId)
          ? s.selectedId
          : (ids[ids.length - 1] ?? null)
      set({ focusMode: 'scrollback', selectedId: id })
    } else {
      set({ focusMode: 'prompt' })
    }
  },

  selectEntry: (id) => set({ selectedId: id, focusMode: id ? 'scrollback' : get().focusMode }),

  selectDelta: (delta) => {
    const { entries, selectedId, expandedGroups } = get()
    const ids = selectableRowIds(entries, expandedGroups)
    if (ids.length === 0) return
    const idx = selectedId ? ids.indexOf(selectedId) : -1
    let next = idx < 0 ? (delta > 0 ? 0 : ids.length - 1) : idx + delta
    next = Math.max(0, Math.min(ids.length - 1, next))
    set({ selectedId: ids[next], focusMode: 'scrollback' })
  },

  toggleGroupExpansion: (anchorId) => {
    const next = new Set(get().expandedGroups)
    if (next.has(anchorId)) next.delete(anchorId)
    else next.add(anchorId)
    set({ expandedGroups: next, focusMode: 'scrollback', selectedId: `gh_${anchorId}` })
  },

  setExpanded: (expanded) => {
    const { selectedId, entries, expandedGroups } = get()
    if (!selectedId) return

    // Group header (synthetic gh_<anchorId>): expand/collapse the whole run
    if (selectedId.startsWith('gh_')) {
      const anchorId = selectedId.slice(3)
      const next = new Set(expandedGroups)
      if (expanded) next.add(anchorId)
      else next.delete(anchorId)
      set({ expandedGroups: next, focusMode: 'scrollback' })
      return
    }

    const idx = entries.findIndex((e) => e.id === selectedId)
    const entry = idx >= 0 ? entries[idx] : undefined
    if (!entry) return

    const memberCollapsed =
      (entry.kind === 'tool' && !entry.expanded) ||
      (entry.kind === 'thought' && thoughtDisplayMode(entry) === 'collapsed')

    // ← on already-collapsed member inside an expanded group → fold the group
    if (!expanded && memberCollapsed) {
      const spans = scanGroups(entries, expandedGroups, {
        defaultExpanded: !currentCollapseToolGroups(),
      })
      const span = spanContaining(spans, idx)
      if (span?.expanded) {
        const next = new Set(expandedGroups)
        next.delete(span.anchorId)
        set({
          expandedGroups: next,
          selectedId: `gh_${span.anchorId}`,
          focusMode: 'scrollback',
        })
      }
      return
    }

    if (entry.kind === 'tool') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'tool' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      // 键盘 ←/→ 展开同样是「要看正文」→ 按需补回 lite 裁掉的部分。
      if (expanded) void fillEntryRange(set, get, selectedId!)
      return
    }
    if (entry.kind === 'thought') {
      // Three-state ladder (TUI collapse_mode/expand_selected): → steps up
      // collapsed → truncated → expanded; ← steps down expanded → truncated
      // → collapsed.
      const cur = thoughtDisplayMode(entry)
      const target: ThoughtDisplayMode = expanded
        ? thoughtModeStepUp(cur)
        : thoughtModeStepDown(cur)
      if (target === cur) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'thought'
            ? { ...e, displayMode: target }
            : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'user') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'user' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'btw') {
      if (!!entry.open === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'btw' ? { ...e, open: expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (entry.kind === 'lifecycle') {
      if (!!entry.expanded === expanded) return
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'lifecycle' ? { ...e, expanded } : e,
        ),
        focusMode: 'scrollback',
      })
      return
    }
    if (
      entry.kind === 'session_event' &&
      (entry.recap || hookGroupsHaveContent(entry.stopHooks))
    ) {
      set({
        entries: entries.map((e) =>
          e.id === selectedId && e.kind === 'session_event'
            ? { ...e, open: expanded }
            : e,
        ),
        focusMode: 'scrollback',
      })
    }
  },

  toggleSelected: () => {
    const { selectedId, entries, expandedGroups } = get()
    if (!selectedId) return
    if (selectedId.startsWith('gh_')) {
      const anchorId = selectedId.slice(3)
      get().toggleGroupExpansion(anchorId)
      return
    }
    const e = entries.find((x) => x.id === selectedId)
    if (!e) return
    // Inline fold only (←/→/click/Space). Enter uses openViewer instead.
    if (e.kind === 'tool') get().setExpanded(!e.expanded)
    else if (e.kind === 'thought') get().toggleThought(e.id)
    else if (e.kind === 'user') get().setExpanded(!e.expanded)
    else if (e.kind === 'btw') get().toggleBtw(e.id)
    else if (e.kind === 'lifecycle') get().toggleLifecycle(e.id)
    else if (
      e.kind === 'session_event' &&
      (e.recap || hookGroupsHaveContent(e.stopHooks))
    )
      get().toggleSessionEvent(e.id)
    else {
      const idx = entries.findIndex((x) => x.id === selectedId)
      const spans = scanGroups(entries, expandedGroups, {
        defaultExpanded: !currentCollapseToolGroups(),
      })
      const span = spanContaining(spans, idx)
      if (span && !span.expanded) get().toggleGroupExpansion(span.anchorId)
    }
  },

  } satisfies Partial<ChatState>
}
