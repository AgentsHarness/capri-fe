import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'

export type PermId = 'normal' | 'auto' | 'always-approve'

export type PermOption = {
  id: PermId
  label: string
  desc: string
}

export const PERMISSION_OPTIONS: PermOption[] = [
  {
    id: 'normal',
    label: 'Normal',
    desc: '标准模式，敏感操作按需审批',
  },
  {
    id: 'auto',
    label: 'Auto',
    desc: '自动模式，自动执行常用安全工具',
  },
  {
    id: 'always-approve',
    label: 'Always-Approve',
    desc: '始终允许，完全自主执行所有操作',
  },
]

/**
 * 运行模式与权限菜单 hook（composer 底部右下角）。
 * Plan 模式作为独立开关（可与任意权限叠加），权限模式为单选项。
 */
export function useModeMenu() {
  const planMode = useChatStore((s) => s.planMode)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const yoloMode = useChatStore((s) => s.yoloMode)
  const autoMode = useChatStore((s) => s.autoMode)
  const selectMode = useChatStore((s) => s.selectMode)
  const togglePlanMode = useChatStore((s) => s.togglePlanMode)

  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLSpanElement>(null)
  const modeBtnRef = useRef<HTMLButtonElement>(null)
  const [modeMenuPos, setModeMenuPos] = useState<{
    bottom: number
    right: number
    maxH: number
    width: number
  } | null>(null)

  const inPlan = planMode === true || permissionMode === 'plan'
  const perm = (permissionMode || '').toLowerCase()
  const inAlways =
    yoloMode === true ||
    perm === 'always-approve' ||
    perm === 'always_approve' ||
    perm === 'yolo'
  const inAuto = autoMode === true || perm === 'auto'

  const currentPermId: PermId = inAlways
    ? 'always-approve'
    : inAuto
      ? 'auto'
      : 'normal'

  const currentPermLabel = currentPermId

  const currentModeLabel = inPlan
    ? currentPermId === 'normal'
      ? 'plan'
      : `plan·${currentPermId === 'always-approve' ? 'always' : currentPermId}`
    : currentPermLabel

  useEffect(() => {
    if (!modeOpen) {
      setModeMenuPos(null)
      return
    }
    const place = () => {
      const btn = modeBtnRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const pad = 8
      const gap = 6
      const vw = window.innerWidth
      const vh = window.innerHeight
      const bottom = Math.max(pad, vh - r.top + gap)
      const maxH = Math.max(140, Math.min(360, r.top - pad))
      const width = Math.min(280, vw - pad * 2)
      let left = r.right - width
      left = Math.max(pad, Math.min(left, vw - pad - width))
      const right = vw - left - width
      setModeMenuPos({ bottom, right, maxH, width })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) {
        setModeOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModeOpen(false)
    }
    const onScroll = (e: Event) => {
      if (modeRef.current && e.target instanceof Node && modeRef.current.contains(e.target)) {
        return
      }
      place()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [modeOpen])

  const switchPerm = (target: PermId) => {
    setModeOpen(false)
    void selectMode(target)
  }

  const togglePlan = () => {
    void togglePlanMode()
  }

  return {
    modeOpen,
    setModeOpen,
    modeRef,
    modeBtnRef,
    modeMenuPos,
    inPlan,
    currentModeLabel,
    currentPermId,
    currentPermLabel,
    switchPerm,
    togglePlan,
  }
}
