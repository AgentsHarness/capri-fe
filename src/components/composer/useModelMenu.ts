import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { pushToast } from '../../store/toast'
import { transport } from '../../api/client'

/**
 * /model 模型菜单（composer 底部 caption 的模型槽）：开关、「设为默认」
 * 勾选、视口固定定位、激活项匹配与切换动作。菜单 JSX 由 Composer 渲染，
 * 状态与行为都归这个 hook。
 */
export function useModelMenu() {
  const modelName = useChatStore((s) => s.modelName)
  const reasoningEffort = useChatStore((s) => s.reasoningEffort)
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
    window.addEventListener('resize', place)
    // Capture scroll from nested scroll parents (scrollback).
    window.addEventListener('scroll', place, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [modelOpen])

  const switchModel = (modelId: string, reasoningEffort?: string) => {
    setModelOpen(false)
    void setModel(modelId, reasoningEffort)
    // 「设为默认」勾选时：写入 config.toml 的 [models] default（+effort），
    // 与切换动作一起生效（agent 热加载，TUI /model <name> <effort> 语义）。
    if (setAsDefault) {
      void transport
        .setDefaultModel(modelId, reasoningEffort, useChatStore.getState().sessionId)
        .then(() => pushToast(`已设为默认模型`))
        .catch((e) => pushToast(`设为默认失败: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

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
    effortActive,
    modelActive,
  }
}
