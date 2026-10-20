/**
 * 「分享只读链接」的目标与单例 opener。
 *
 * 会话行右键菜单只需要「把这一条会话交给弹窗」，不必各自挂一份 modal；
 * 弹窗宿主（ShareGuestHost）在挂载时注册自己，App 的完整壳里挂一次。
 * 类型/函数单独成文件，ShareGuestModal.tsx 保持只导出组件（Fast Refresh）。
 */

export type ShareTarget = {
  hostId: string
  hostName: string
  sessionId: string
  cwd: string
  title?: string
}

let shareOpener: ((target: ShareTarget) => void) | null = null

export function registerShareGuestOpener(
  fn: ((target: ShareTarget) => void) | null,
): void {
  shareOpener = fn
}

/** 打开分享弹窗；宿主没挂（访客壳 / 未进入主界面）时返回 false。 */
export function openShareGuest(target: ShareTarget): boolean {
  if (!shareOpener) return false
  shareOpener(target)
  return true
}
