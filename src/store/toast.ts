import { create } from 'zustand'
import type { Toast, ToastType } from '../api/types'

export type { ToastType }

/** In-page toast stack (ToastStack). Independent of the chat store so
 *  promptQueue / notifications can fire toasts without importing chat —
 *  that import was the last edge of a 14-node circular SCC. */
const MAX_TOASTS = 4

export type ToastOptions = {
  id?: string
  type?: ToastType
}

/** 智能推断 toast 类型（若未显式指定）。 */
export function inferToastType(text: string): ToastType {
  // 错误类
  if (/失败|错误|error|fail|拒绝|不可用|异常|禁止/i.test(text)) {
    return 'error'
  }
  // 警告类
  if (/警告|warning|稍候|请先|未输入|不支持/i.test(text)) {
    return 'warning'
  }
  // 提示/通知类
  if (/^🔔|需要审批|后台任务/i.test(text)) {
    return 'info'
  }
  // 成功类
  if (/成功|已|完成|已复制|已恢复|已开启|已更新|已删除|已生成|已重启/i.test(text)) {
    return 'success'
  }
  return 'info'
}

type ToastState = {
  toasts: Toast[]
  /** Push a toast. Optional `idOrOptions` lets the caller dismiss it later or specify options. */
  pushToast: (
    text: string,
    idOrOptions?: string | ToastOptions,
    explicitType?: ToastType
  ) => string
  dismissToast: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  pushToast: (text, idOrOptions, explicitType) => {
    let id: string | undefined
    let type: ToastType | undefined

    if (typeof idOrOptions === 'string') {
      id = idOrOptions
      type = explicitType
    } else if (idOrOptions && typeof idOrOptions === 'object') {
      id = idOrOptions.id
      type = idOrOptions.type ?? explicitType
    }

    const toastId =
      id ?? `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

    const item: Toast = {
      id: toastId,
      text,
      ...(type ? { type } : {}),
    }

    set({ toasts: [...get().toasts, item].slice(-MAX_TOASTS) })
    return toastId
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export function pushToast(
  text: string,
  idOrOptions?: string | ToastOptions,
  explicitType?: ToastType
): string {
  return useToastStore.getState().pushToast(text, idOrOptions, explicitType)
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismissToast(id)
}
