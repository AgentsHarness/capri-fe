import { useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu'

export type PermId = 'normal' | 'auto' | 'always-approve'

/**
 * 底栏模式标签的两种写法：TUI 全名（'always-approve'）与窄屏短名（'always'）。
 * 底栏是 max-w-[75%] 的绝对定位 flex，模型名一长、再叠上全名就会顶出 prompt
 * 边框，所以由 composer/useFittedModeLabel.ts 按实测宽度挑一个。
 * 模式菜单的 PERMISSION 列表始终用全名 'Always-Approve'。
 */
const PERM_LABEL: Record<PermId, { full: string; short: string }> = {
  normal: { full: 'normal', short: 'normal' },
  auto: { full: 'auto', short: 'auto' },
  'always-approve': { full: 'always-approve', short: 'always' },
}

function modeLabel(
  id: PermId,
  inPlan: boolean,
  form: 'full' | 'short',
): string {
  if (!inPlan) return PERM_LABEL[id][form]
  return id === 'normal' ? 'plan' : `plan·${PERM_LABEL[id][form]}`
}

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

  const currentPermLabel = PERM_LABEL[currentPermId].short

  const currentModeLabel = modeLabel(currentPermId, inPlan, 'full')

  const currentModeShortLabel = modeLabel(currentPermId, inPlan, 'short')

  const modeMenuPos = useAnchoredMenu({
    open: modeOpen,
    anchorRef: modeBtnRef,
    menuRef: modeRef,
    setOpen: setModeOpen,
    minHeight: 140,
    maxHeight: 360,
    maxWidth: 280,
    gap: 6,
    pad: 8,
  })

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
    currentModeShortLabel,
    currentPermId,
    currentPermLabel,
    switchPerm,
    togglePlan,
  }
}
