import type { SessionRow } from '../../store/chat/sessionRows'

/** 组内默认显示的普通会话行数（置顶/待办不占名额，超出折叠为"加载更多"）。 */
export const WORKSPACE_ROWS_LIMIT = 4

/** 行/分组操作菜单的宽度：⋮ 按它左移对齐按钮右缘，菜单本身也按它渲染。 */
export const MENU_W = 176

/** 点击"加载更多"每次追加的行数，循环直到组内会话全部显示；
 *  展开超过默认基准（WORKSPACE_ROWS_LIMIT + 置顶/待办数）后出现
 *  "收起"，点击回到默认基准。 */
export const LOAD_MORE_STEP = 10

/** 工作区活跃窗口：最新活动在 6 小时内的默认展开，超过默认收起。 */
export const WORKSPACE_ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000

/** 工作区组：行是单一行投影（live 事实源 + workspace 兜底），见 sessionRows。 */
export type MergedGroup = {
  cwd: string
  label: string
  sessions: SessionRow[]
}

/**
 * 列表分区（两种展示形态共用渲染）：
 * - workspace：按 cwd 分组，key = cwd
 * - marked：按类型分组（思考中 / 置顶 / 待办），key = 类型
 */
export type ListSection = {
  key: string
  label: string
  sessions: SessionRow[]
  /** 仅 workspace 形态：工作目录全路径（组菜单「新建会话」/ 置顶目录）。 */
  cwd?: string
  kind: 'workspace' | 'running' | 'pinned' | 'todo'
}
