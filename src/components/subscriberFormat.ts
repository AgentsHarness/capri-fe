/**
 * 在线订阅者面板（SubscribersPanel）的纯展示换算。
 *
 * 单独成文件有两个原因：面板组件只导出组件（Fast Refresh 要求），而这些
 * 换算是可以直接单测的字符串逻辑。
 */

/** User-Agent → 一句能读的浏览器/系统描述（认不出的原样截断显示）。 */
export function describeUserAgent(ua?: string): string {
  if (!ua) return '未知浏览器'
  const browser =
    /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : /Capri/i.test(ua)
                ? 'Capri'
                : ''
  const os =
    /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : ''
  if (browser && os) return `${browser} · ${os}`
  if (browser) return browser
  if (os) return os
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua
}

/** 连接时长：<1 分钟 / N 分钟 / N 小时 M 分。 */
export function fmtConnectedFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`
}
