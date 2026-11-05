/**
 * `/settings` 页固定操作的 Host。
 *
 * - 页面 origin 本身就是这台 capri-host 时（tray 打开的内嵌页面），以它为准；
 * - 页面没有自身近路（例如从 hub 域名打开）时，用托盘通过 `?host=` 显式带上
 *   的目标兜底。
 *
 * 返回 null 表示无从确定，只能保持现状。hub 的默认 Host 是「最近心跳的那台」，
 * 多台在线时会漂移，绝不能把「没选 Host」当成「交给 hub 默认 Host」。
 */
export function settingsHostTarget(search: string, pageHostId: string | null): string | null {
  const fromUrl = new URLSearchParams(search).get('host')?.trim()
  return pageHostId || fromUrl || null
}
