/**
 * 目录选择弹窗用的路径小工具（纯字符串，不碰任何平台 API）。
 *
 * 真正的路径归一化在 host 侧：`POST /api/local/dirs`（acp-host
 * `internal/server/http_local_fs.go`）用 os.ReadDir 原生列目录，并把用户
 * 输入解释成宿主原生路径（Windows 上 /d/aiwork → D:\aiwork）。前端只做两件
 * 与平台无关的事 —— 取「上级」、把相对草稿拼到当前目录上 —— 所以这里同时
 * 认得 `/` 与 `\`、`~` 与盘符，最终解释权归 host。
 */

/** 有起点的路径（根、`~`、盘符、UNC）：不需要再拼当前目录。 */
export function isRootedLocalPath(p: string): boolean {
  const t = p.trim()
  return (
    t.startsWith('/') ||
    t.startsWith('\\') ||
    t.startsWith('~') ||
    /^[A-Za-z]:/.test(t)
  )
}

/** 相对草稿拼到当前目录上；base 为空（还没有确认过的目录）时原样返回。 */
export function joinLocalPath(base: string, rel: string): string {
  const b = base.trim().replace(/[/\\]+$/, '')
  const r = rel.trim()
  return b ? `${b}/${r}` : r
}

/**
 * 路径的上级目录；已在根 / 盘根、或只有一段（相对）路径时返回 undefined
 * （上级按钮据此置灰）。返回的是「可以再交给 host 归一化」的字面形式，分隔符
 * 跟着输入走：`D:\x` 的上级是 `D:\`，`~/x` 的上级是 `~`。
 */
export function parentOfLocalPath(p: string): string | undefined {
  const t = p.trim().replace(/[/\\]+$/, '')
  if (!t) return undefined
  const slash = t.lastIndexOf('/')
  const backslash = t.lastIndexOf('\\')
  const idx = Math.max(slash, backslash)
  if (idx < 0) return undefined
  const sep = slash > backslash ? '/' : '\\'
  const head = t.slice(0, idx)
  if (!head) return '/' // "/foo" → 根
  if (/^[A-Za-z]:$/.test(head)) return head + sep // "D:\foo" → "D:\"
  return head
}
