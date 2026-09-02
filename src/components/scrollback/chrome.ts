import type { ScrollEntry } from '../../api/types'
import type { BulletPaint } from '../../theme/accents'

/** 迷你 scrollback（子代理弹窗）注入的局部动作。缺省取主 store 动作——
 *  主 scrollback 行为不变；mini 条目不在主 entries 里，折叠/选中/查看器
 *  用组件内局部状态（任务 1：弹窗复用主渲染体系、不接主 store 选择器）。 */
export type EntryViewActions = {
  /** 工具行折叠切换（默认主 store toggleTool）。 */
  toggleTool?: (id: string) => void
  /** 思考行折叠切换（默认主 store toggleThought）。 */
  toggleThought?: (id: string) => void
  /** 用户行折叠切换（默认主 store toggleUser）。 */
  toggleUser?: (id: string) => void
  /** btw 区块折叠切换（默认主 store toggleBtw）。 */
  toggleBtw?: (id: string) => void
  /** Lifecycle hook 行折叠（默认主 store toggleLifecycle）。 */
  toggleLifecycle?: (id: string) => void
  /** 带 stop-hook 的回合标记折叠（默认主 store toggleSessionEvent）。 */
  toggleSessionEvent?: (id: string) => void
  /** 全文弹窗查看器（mini 点「查看」打开组件内局部 BlockBodyDialog——条目
   *  不在主 entries，主 viewer 查找不到；缺省主 store openViewer）。 */
  openViewer?: (id: string) => void
  /** 行选中（mini 局部选中；默认主 store selectEntry）。 */
  selectEntry?: (id: string) => void
  /** lite 裁掉的工具正文按需补全（默认主 store entries；mini 补本子代理视图）。 */
  fillToolBodies?: (id: string) => void
}

export type EntryViewProps = {
  e: ScrollEntry
  selected: boolean
  pendingFreeze: boolean
  now: number
  dense?: boolean
  denseNext?: boolean
  densePrev?: boolean
  inGroup?: boolean
  /** 迷你 scrollback 局部动作（见 EntryViewActions）。 */
  actions?: EntryViewActions
  /**
   * 迷你 scrollback 折叠覆盖（工具/用户 expanded、思考 displayMode 由
   * 弹窗局部状态决定，不写回 store）。渲染前合并进条目；主 scrollback
   * 不传 → 恒为 undefined，行为与 memo 比较完全不变。
   */
  patch?: Partial<ScrollEntry>
  /**
   * 相邻独立 image 行的组级 gallery 点击回调（主 scrollback 聚合容器
   * 传入；稳定引用由调用方保证）。缺省 → ImageEntry 退回 openViewer。
   */
  onOpenImage?: (entryId: string) => void
  /** 关闭本行的 hover/选中框（图片画廊组：框由组容器统一绘制）。 */
  noFrame?: boolean
  /**
   * 主 scrollback 的合并流式滚动固定：流式思考期间挂到思考 body 元素上，
   * 由父组件统一固定（每帧一次布局读写）；迷你 scrollback 不传 → 条目
   * 自己固定。恒为稳定引用（useRef 对象），memo 比较只做引用相等。
   */
  streamBodyRef?: { current: HTMLDivElement | null }
}

/** Shared chrome handed to per-kind entry renderers. */
export type EntryChrome = {
  shell: {
    e: ScrollEntry
    selected: boolean
    hovered: boolean
    onHover: (h: boolean) => void
    onSelect: () => void
    pendingFreeze: boolean
    now: number
    dense: boolean
    denseNext: boolean
    densePrev: boolean
    inGroup: boolean
    /** 关闭本行的 hover/选中框（图片画廊组：框由组容器统一绘制）。 */
    noFrame?: boolean
    /** 整块单击折叠；缺省则单击只选中。 */
    onFold?: () => void
  }
  bullet: BulletPaint
  caret: string | null
  bulletGlyph: string | undefined
  rowBtn: string
  openViewer: (id: string) => void
  toggleTool: (id: string) => void
  /**
   * lite 裁掉的工具正文按需补全（缺省 = 未接线：占位行只读不重试）。
   * mini 时间线传子代理视图版——条目不在主 entries 里。
   */
  fillToolBodies?: (id: string) => void
  toggleThought: (id: string) => void
  toggleUser: (id: string) => void
  toggleBtw: (id: string) => void
  cancelSubagent: (id: string) => void
  killTask: (id: string) => void
  liveText: string | undefined
  thoughtText: string | undefined
  bodyRef: { current: HTMLDivElement | null }
  /**
   * 相邻图片画廊：主 scrollback 聚合连续的独立 image 行后传入——点击
   * 某张图打开组级 lightbox（按 entry id 定位组内索引）。缺省（迷你
   * scrollback）退回 openViewer。
   */
  onOpenImage?: (entryId: string) => void
  /** 迷你 scrollback（子代理弹窗）：消息操作行隐藏会话级动作（fork）。 */
  inMini: boolean
  /** 会话工作目录（historyCwd ?? cwd）——工具行路径按 surface 打印时用作
   *  相对基准（TUI path_for_tool_surface 的 cwd）。 */
  cwd?: string
}
