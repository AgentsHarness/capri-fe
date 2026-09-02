import { loadStr, saveStr } from './storage'
import { KEY } from './keys'

/** FE 本地设置：审批弹窗默认选中行 —— TUI `[ui].default_selected_permission`
 *  （xai-grok-pager-render appearance/permission_cursor.rs）的 FE 侧副本。
 *  它是 pager 客户端本地设置，不落 agent 配置（不走 /api/settings，
 *  host 白名单也只有 4 个键），按 MULTILINE_KEY（capri-fe.multiline）同款
 *  约定持久化在 localStorage。 */
export const DEFAULT_SELECTED_PERMISSION_KEY = KEY.defaultSelectedPermission

/** 四个 canonical 取值，与 TUI DefaultSelectedPermission::as_canonical
 *  完全一致；顺序对齐 TUI 设置面板与审批弹窗的渲染顺序
 *  （YOLO → allow-always → allow-once → reject）。 */
export const DEFAULT_SELECTED_PERMISSION_CHOICES = [
  'always_allow_all_sessions',
  'allow_command_always',
  'allow_once',
  'reject',
] as const

export type DefaultSelectedPermission =
  (typeof DEFAULT_SELECTED_PERMISSION_CHOICES)[number]

/** 未设置 / 无法识别时的等效默认（TUI 的 fallback）。 */
export const DEFAULT_SELECTED_PERMISSION_DFLT: DefaultSelectedPermission =
  'always_allow_all_sessions'

/** 读取设置；缺失或存了无法识别的值都回到默认（对齐 TUI
 *  from_config_value 的全映射，不抛异常）。 */
export function loadDefaultSelectedPermission(): DefaultSelectedPermission {
  const v = loadStr(DEFAULT_SELECTED_PERMISSION_KEY)
  return (
    DEFAULT_SELECTED_PERMISSION_CHOICES as readonly string[]
  ).includes(v ?? '')
    ? (v as DefaultSelectedPermission)
    : DEFAULT_SELECTED_PERMISSION_DFLT
}

/** 写入设置（storage.ts 自带静默降级）。 */
export function saveDefaultSelectedPermission(value: DefaultSelectedPermission): void {
  saveStr(DEFAULT_SELECTED_PERMISSION_KEY, value)
}

// ── 新审批请求的初始游标解析 ────────────────────────────────────────────

/** 全局 always-approve（YOLO）行的稳定 optionId（xai-grok-workspace
 *  prompter.rs ENABLE_ALWAYS_APPROVE_OPTION_ID）。按身份匹配，绝不按
 *  kind（它的 kind 是 AllowOnce）或列表位置匹配。 */
const ENABLE_ALWAYS_APPROVE_OPTION_ID = 'enable-always-approve'

/** 解析游标所需的 FE wire 选项子集（ApprovalStrip 的 Option 结构）。 */
export type PermissionOptionLike = {
  optionId?: string
  kind?: string
  name?: string
  label?: string
}

const ALLOW_ONCE_RE = /^allow[-_]once$/i
const ALLOW_ALWAYS_KIND_RE = /^allow[-_]always$/i
const ALLOW_ALWAYS_ID_RE = /^(allow[-_]always|always[-_]allow|allow[-_]edits[-_]session)$/i
const ALLOW_ALWAYS_ID_PREFIX_RE = /^allow[-_]always[-_]/i
const REJECT_KIND_RE = /^reject[-_]once$|^reject[-_]always$/i
const REJECT_ID_PREFIX_RE = /^reject[-_]always(?:[-_]|$)/i

/** 与 ApprovalStrip 的 isAlwaysOption / isRejectOption 同源的标签启发式
 *  （kind 与 optionId 都不带信息的老 host 兜底）。 */
const ALWAYS_LABEL_RE = /always|always_allow|alwaysAllow|始终|总是/i
const REJECT_LABEL_RE = /reject|拒绝/i

/** 全局 always-approve 行的标签特征。它本质是 AllowOnce 行，兜底分类时
 *  必须先认出它，绝不能因为标签里带 always 被当成 AllowAlways 目标。 */
const GLOBAL_ALWAYS_LABEL_RE = /always[-_ ]?approve|所有会话/i

type OptionKind = 'allow_once' | 'allow_always' | 'reject'

/** 把一个 option 归类到 ACP PermissionOptionKind 的三种目标之一。判据
 *  按信息量递减：kind 字段（serde snake_case）→ kebab optionId
 *  （prompter 的 allow-once / allow-always-* / always-allow /
 *  allow-edits-session / reject-once / reject-always-*）→ 标签启发式。
 *  无任何信号时按 ACP 缺省 AllowOnce 处理。 */
function optionKind(opt: PermissionOptionLike): OptionKind {
  const kind = typeof opt.kind === 'string' ? opt.kind : ''
  if (kind) {
    if (ALLOW_ONCE_RE.test(kind)) return 'allow_once'
    if (ALLOW_ALWAYS_KIND_RE.test(kind)) return 'allow_always'
    if (REJECT_KIND_RE.test(kind)) return 'reject'
  }
  const id = opt.optionId ?? ''
  if (ALLOW_ONCE_RE.test(id)) return 'allow_once'
  if (ALLOW_ALWAYS_ID_RE.test(id) || ALLOW_ALWAYS_ID_PREFIX_RE.test(id)) return 'allow_always'
  if (REJECT_KIND_RE.test(id) || REJECT_ID_PREFIX_RE.test(id)) return 'reject'
  const label = `${opt.label ?? ''} ${opt.name ?? ''}`
  if (GLOBAL_ALWAYS_LABEL_RE.test(label)) return 'allow_once'
  if (ALWAYS_LABEL_RE.test(label)) return 'allow_always'
  if (REJECT_LABEL_RE.test(label)) return 'reject'
  return 'allow_once'
}

/**
 * TUI resolve_initial_cursor（permission_cursor.rs）的 FE 镜像：新审批请求
 * 到达时，设置选出的目标行在「当前这组」选项里的下标（传入的应是卡上
 * 实际渲染的、过滤后的可见选项）。
 *
 * - `always_allow_all_sessions`（含未设置）：按身份找全局 always-approve
 *   行 —— TUI 匹配 is_enable_always_approve_option，不是按位置或 kind；
 *   找不到回落 0。
 * - `allow_once` / `allow_command_always` / `reject`：目标 kind 匹配的第
 *   一行，且永远跳过全局 always-approve 行（身份排除优先于一切 kind 判
 *   据——即使老 host 把它标成 AllowAlways，allow_command_always 也绝不
 *   会选中它；TUI 对 concrete target 同样跳过 YOLO 行）。
 * - 找不到对应选项一律回落 0（保持既有行为；与 TUI 的
 *   degrade-to-allow-once 有意不同，按任务书 D 的明确约定）。
 */
export function resolveInitialSelection(
  options: readonly PermissionOptionLike[],
  setting: DefaultSelectedPermission,
): number {
  if (setting !== 'always_allow_all_sessions') {
    const target: OptionKind =
      setting === 'allow_command_always' ? 'allow_always' : setting
    const idx = options.findIndex(
      (o) => o.optionId !== ENABLE_ALWAYS_APPROVE_OPTION_ID && optionKind(o) === target,
    )
    return idx === -1 ? 0 : idx
  }
  const yolo = options.findIndex((o) => o.optionId === ENABLE_ALWAYS_APPROVE_OPTION_ID)
  return yolo === -1 ? 0 : yolo
}