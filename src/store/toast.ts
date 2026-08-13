import { create } from 'zustand'
import type { Toast } from '../api/types'

/** In-page toast stack (ToastStack). Independent of the chat store so
 *  promptQueue / notifications can fire toasts without importing chat —
 *  that import was the last edge of a 14-node circular SCC. */
const MAX_TOASTS = 4

type ToastState = {
  toasts: Toast[]
  /** Push a toast. Optional `id` lets the caller dismiss it later. */
  pushToast: (text: string, id?: string) => string
  dismissToast: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast: (text, id) => {
    const toastId =
      id ?? `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    set({ toasts: [...get().toasts, { id: toastId, text }].slice(-MAX_TOASTS) })
    return toastId
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export function pushToast(text: string, id?: string): string {
  return useToastStore.getState().pushToast(text, id)
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismissToast(id)
}
