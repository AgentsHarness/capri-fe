import { transport } from '../../../api/client'
import type { ChatState, SetState } from '../types'
import type { MemoryListing } from '../../../lib/memory'
import { canEnableMemory, disabledReasonLabel } from '../../../lib/memory'

/** Settings the modal reads without a round trip when a rail fails. */
function sessionOf(get: () => ChatState): string | undefined {
  return get().sessionId
}

/**
 * Memory modal service actions (TUI /memory). The modal's own UI state
 * (selection, filter, pending confirm) lives in the component; the store
 * keeps the listing, its load status and the last action notice so a
 * reopened modal paints immediately.
 */
export function memoryActions(set: SetState, get: () => ChatState) {
  const applyListing = (listing: MemoryListing) => {
    set({ memoryListing: listing, memoryStatus: 'ready', memoryError: undefined })
  }

  return {
    openMemory: () => {
      // The modal owns the refresh (it re-reads x.ai/memory/list on every open
      // and keeps the cached listing painted meanwhile), so opening does not
      // need to know whether a load is wanted.
      set({ memoryOpen: true, memoryNotice: undefined })
    },
    closeMemory: () => set({ memoryOpen: false }),

    /** Reload the listing via x.ai/memory/list (modal open / refresh button). */
    refreshMemory: async () => {
      set({ memoryStatus: get().memoryListing ? 'ready' : 'loading' })
      try {
        const listing = await transport.memoryList(sessionOf(get))
        applyListing(listing)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({
          memoryStatus: 'error',
          memoryError: /暂无活动会话/.test(msg)
            ? '暂无活动会话 —— 先开始或恢复一个会话，再看记忆。'
            : `读取记忆列表失败: ${msg}`,
        })
      }
    },

    /**
     * Flip memory for the session (TUI `t` in the modal). The agent's reply is
     * authoritative: it carries the resulting state and a fresh listing, so a
     * refusal reverts the optimistic flip instead of lying about it.
     */
    memoryToggle: async (enabled: boolean) => {
      const sessionId = sessionOf(get)
      if (!sessionId) {
        set({ memoryNotice: { text: '无活动会话，无法切换记忆开关', error: true } })
        return
      }
      const previous = get().memoryListing
      if (previous) set({ memoryListing: { ...previous, enabled } })
      try {
        const res = await transport.memoryToggle(sessionId, enabled)
        const refused = res.enabled !== enabled
        if (res.listing) applyListing(res.listing)
        else if (previous) {
          set({
            memoryListing: {
              ...previous,
              enabled: res.enabled,
              disabledReason: res.enabled ? undefined : res.disabledReason,
            },
          })
        }
        set({ memoryNotice: { text: res.message, error: refused } })
      } catch (e) {
        if (previous) set({ memoryListing: previous })
        const msg = e instanceof Error ? e.message : String(e)
        set({ memoryNotice: { text: `切换记忆失败: ${msg}`, error: true } })
      }
    },

    /**
     * Run memory consolidation now (TUI /dream → x.ai/memory/dream). The
     * agent's own `memory_dream_completed` notification reports the outcome in
     * the scrollback; here only the dispatch failure is surfaced.
     */
    memoryDream: async () => {
      const sessionId = sessionOf(get)
      if (!sessionId) {
        set({ statusText: '记忆整合失败: 无活动会话' })
        return
      }
      try {
        await transport.memoryDream(sessionId)
        set({ statusText: '正在整合记忆…' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({ statusText: `记忆整合失败: ${msg}` })
      }
    },

    /**
     * Delete one note (x.ai/memory/forget). `expectedContentHash` is the BLAKE3
     * hex of the previewed bytes — the store refuses a mismatch, so a note
     * edited after the preview survives with the agent's own explanation.
     */
    forgetMemoryNote: async (path: string, expectedContentHash: string) => {
      const sessionId = sessionOf(get)
      if (!sessionId) {
        set({ memoryNotice: { text: '无活动会话，无法删除记忆文件', error: true } })
        return { ok: false, message: '无活动会话' }
      }
      try {
        const res = await transport.memoryForget(sessionId, path, expectedContentHash)
        if (res.outcome === 'forgotten') {
          set({
            memoryNotice: {
              text: res.wasAlreadyForgotten ? '该记忆文件已不存在（已删除）' : '已删除该记忆文件',
              error: false,
            },
          })
          // Drop the row locally, then resync with the store's own listing.
          const cur = get().memoryListing
          if (cur) set({ memoryListing: { ...cur, files: cur.files.filter((f) => f.path !== path) } })
          void get().refreshMemory()
          return { ok: true, message: '已删除' }
        }
        set({ memoryNotice: { text: res.message, error: true } })
        return { ok: false, message: res.message }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({ memoryNotice: { text: `删除记忆文件失败: ${msg}`, error: true } })
        return { ok: false, message: msg }
      }
    },
  } satisfies Partial<ChatState>
}

/** Status text for the modal header: enabled flag plus the off reason. */
export function memoryStatusLabel(listing: MemoryListing): string {
  if (listing.enabled) return '记忆已启用'
  return `记忆已关闭（${disabledReasonLabel(listing.disabledReason)}）`
}

/** Whether the header toggle should offer to turn memory back on. */
export function memoryToggleEnabled(listing: MemoryListing): boolean {
  return listing.enabled || canEnableMemory(listing.disabledReason)
}
