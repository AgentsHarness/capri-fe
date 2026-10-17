import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { contextWindowOptions } from '../../store/chat/model'

/**
 * /model 模型菜单（composer 底部 caption 的模型槽）：开关、「设为默认」
 * 勾选、视口固定定位、激活项匹配与切换动作。菜单 JSX 由 Composer 渲染，
 * 状态与行为都归这个 hook。
 *
 * 上下文窗口选项来自模型目录自己声明的 `_meta.contextWindows`：本地一个
 * 窗口尺寸都不写死。agent 会拒收模型未声明的值（session/set_model 返回
 * invalid_params，整次切换一起失败），所以只能照着目录给。
 */
export function useModelMenu() {
  const modelName = useChatStore((s) => s.modelName)
  const reasoningEffort = useChatStore((s) => s.reasoningEffort)
  const models = useChatStore((s) => s.models)
  const setModel = useChatStore((s) => s.setModel)

  const [modelOpen, setModelOpen] = useState(false)
  // 模型菜单「设为默认」勾选：切换模型时同时写入 config.toml 默认。
  const [setAsDefault, setSetAsDefault] = useState(false)
  const modelRef = useRef<HTMLSpanElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  // Fixed-position menu rect so the picker stays inside the viewport on
  // mobile (absolute + max-h-[320px] was clipped by body { overflow:hidden }
  // when the composer sat at the bottom edge).
  const [modelMenuPos, setModelMenuPos] = useState<{
    bottom: number
    right: number
    maxH: number
    width: number
  } | null>(null)

  // Model picker: close on outside click / Escape; pin to viewport.
  useEffect(() => {
    if (!modelOpen) {
      setModelMenuPos(null)
      return
    }
    const place = () => {
      const btn = modelBtnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const pad = 8
      const gap = 6
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Open upward from the button; clamp height to free space above.
      const bottom = Math.max(pad, vh - r.top + gap)
      const maxH = Math.max(120, Math.min(320, r.top - pad))
      const width = Math.min(288, vw - pad * 2)
      // Prefer right-align to the button, then shift so left/right stay in view.
      let left = r.right - width
      left = Math.max(pad, Math.min(left, vw - pad - width))
      const right = vw - left - width
      setModelMenuPos({ bottom, right, maxH, width })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModelOpen(false)
    }
    const onScroll = (e: Event) => {
      // Ignore scroll events originating from inside the model menu itself.
      if (
        modelRef.current &&
        e.target instanceof Node &&
        modelRef.current.contains(e.target)
      ) {
        return
      }
      place()
    }
    window.addEventListener('resize', place)
    // Capture scroll from nested scroll parents (scrollback).
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [modelOpen])

  /**
   * 切换模型。`windowOverride` 只在用户点某一行自己的窗口 chip 时给出：
   * 给出了就下发该窗口，没给（点模型行 / 点 effort chip）就省略
   * `_meta.contextWindow`，即 agent 的 Preserve —— 沿用会话当前选择，目标
   * 模型不支持时回落到它自己的默认窗口（TUI 点模型行同样是这个语义）。
   */
  /**
   * 非选中模型的待提交选择（草稿）：key = modelId。
   *
   * 一个模型可能有多个类别要挑（推理档位、上下文窗口…），全部点齐才提交切换，
   * 避免"点第一个 chip 就被切走"——用户还没看完剩下的类别，模型已经换了，
   * 菜单也关了。点齐最后一个类别时自动提交并关闭菜单。
   */
  const [drafts, setDrafts] = useState<
    Record<string, { effort?: string; window?: number }>
  >({})

  // 菜单关闭即丢弃草稿：下次打开要从目录的当前值重新开始点，不残留半套选择。
  useEffect(() => {
    if (!modelOpen) setDrafts({})
  }, [modelOpen])

  const switchModel = (
    modelId: string,
    reasoningEffort?: string,
    windowOverride?: number,
  ) => {
    setModelOpen(false)
    // 只把「目标模型确实声明过」的窗口发下去：菜单开着的时候目录可能刚被
    // 热重载换过，把未声明的值发出去会被 agent 整次拒收（invalid_params）。
    const target = models.find((m) => m.modelId === modelId)
    const ctxWin =
      windowOverride != null && contextWindowOptions(target).includes(windowOverride)
        ? windowOverride
        : undefined
    // 「设为默认」勾选时一并写入 config.toml 的 [models] default（+effort），
    // 与切换动作一起生效（agent 热加载，TUI /model <name> <effort> 语义）。
    // 空状态（未锚定会话）下 setModel 只记选择、会话锚定后补发，绝不把
    // 切换打到别的会话上（host 侧无 sessionId 直接 400）。
    void setModel(
      modelId,
      reasoningEffort,
      setAsDefault || ctxWin != null
        ? {
            ...(setAsDefault ? { asDefault: true } : {}),
            ...(ctxWin != null ? { contextWindow: ctxWin } : {}),
          }
        : undefined,
    )
  }

  /**
   * 点某个类别的选项。
   *
   * 选中模型：立即切换（用户就是在改当前会话的档位/窗口，没有别的类别要挑）。
   * 非选中模型：把该类别记进草稿；这个模型声明的类别还没点齐就只更新草稿
   * （不切换、不关菜单），点齐最后一个类别时才提交。
   *
   * `categories` 是该模型实际需要挑的类别数（由 ModelMenu 按目录算出：
   * 有 effort 列表算 1，窗口菜单 >1 个算 1）。模板只算 0 次点击。
   */
  const pickOption = (
    modelId: string,
    categories: number,
    patch: { effort?: string; window?: number },
    fallbackEffort?: string,
  ) => {
    const next = { ...(drafts[modelId] ?? {}), ...patch }
    setDrafts((d) => ({ ...d, [modelId]: next }))
    if (Object.keys(next).length >= categories) {
      switchModel(modelId, next.effort ?? fallbackEffort, next.window)
    }
  }

  /** 该模型当前草稿里该类别是否已选（用于 chip 高亮）。 */
  const draftEffort = (modelId: string) => drafts[modelId]?.effort
  const draftWindow = (modelId: string) => drafts[modelId]?.window

  /** Match current caption effort against a menu row (id or wire value). */
  const effortActive = (opt: { id: string; value: string }) => {
    const cur = (reasoningEffort || '').trim().toLowerCase()
    if (!cur) return false
    return (
      cur === opt.value.toLowerCase() ||
      cur === opt.id.toLowerCase() ||
      cur === opt.value.replace(/_/g, '').toLowerCase()
    )
  }

  const modelActive = (m: { modelId: string; name?: string }) => {
    const cur = (modelName || '').trim().toLowerCase()
    if (!cur) return false
    return (
      cur === m.modelId.toLowerCase() ||
      (m.name != null && cur === m.name.trim().toLowerCase())
    )
  }

  return {
    modelName,
    reasoningEffort,
    modelOpen,
    setModelOpen,
    setAsDefault,
    setSetAsDefault,
    modelRef,
    modelBtnRef,
    modelMenuPos,
    switchModel,
    pickOption,
    draftEffort,
    draftWindow,
    effortActive,
    modelActive,
  }
}
