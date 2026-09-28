import { transport } from './client'

/**
 * 宿主本地目录浏览 / 新建（host 的 POST /api/local/dirs、/api/local/mkdir）。
 *
 * 空状态的「选择工作目录」弹窗用它列宿主机目录：host 侧用 os.ReadDir 原生
 * 列举，不依赖 `!` shell 通道（`sh -c` 在 Windows 上没有 sh/find 就走不通），
 * 并按宿主平台归一化用户输入的路径（Windows 上 `/d/aiwork` → `D:\aiwork`）。
 * 每一项都带宿主原生形式的绝对路径，前端不拼路径，于是盘符 / 反斜杠 /
 * MSYS 写法都能用。
 *
 * 路径不存在、不是目录、没权限都是 400 + 人话 error（用户的正常输入状态），
 * 调用方据此拦下「随便输个不存在的路径也能选」；`~` 与空路径都落到宿主
 * 主目录。
 *
 * 请求走 transport.apiFetch（hub 模式下带 ?host= 交给 hub 中转到选中的
 * host，并带 FE token / 超时 / 在途 abort），不能裸 fetch 相对路径 ——
 * 否则会打到页面所在机器而不是选中的 host。
 */

export type LocalDirEntry = {
  name: string
  /** 宿主原生形式的绝对路径。 */
  path: string
}

export type ListLocalDirsResult =
  | { ok: true; path: string; home: string; dirs: LocalDirEntry[] }
  | {
      ok: false
      error: string
      /** 归一化后的路径（宿主能算出时带上）：`/d/aiwork` 失败时显示 `D:\aiwork`。 */
      path?: string
    }

export type CreateLocalDirResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

type LocalFsPayload = Record<string, unknown>

function asText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/** 只保留 name/path 都是非空字符串的条目（旧/新 host 都按这个形状读）。 */
function entriesFrom(data: LocalFsPayload): LocalDirEntry[] {
  if (!Array.isArray(data.dirs)) return []
  const out: LocalDirEntry[] = []
  for (const item of data.dirs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const name = asText(row.name)
    const path = asText(row.path)
    if (name && path) out.push({ name, path })
  }
  return out
}

/** 端点缺失（旧 host）时给一句能照做的提示，别只丢一个 404。 */
function endpointError(status: number, route: string, fallback: string): string {
  return status === 404
    ? `宿主不支持目录浏览（${route} 缺失）—— 需要升级 host`
    : fallback
}

async function postLocalFs(path: string, body: Record<string, unknown>) {
  const res = await transport.apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as LocalFsPayload
  return { res, data }
}

/**
 * 列出一个宿主本地路径的直接子目录。`path` 省略 / 空串 → 宿主主目录。
 * 从不抛：失败以 `{ok:false, error}` 返回，弹窗直接展示这句话。
 */
export async function listLocalDirs(path?: string): Promise<ListLocalDirsResult> {
  const route = '/api/local/dirs'
  try {
    const { res, data } = await postLocalFs(route, { path: path ?? '' })
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: asText(data.error) || endpointError(res.status, route, `目录读取失败 (${res.status})`),
        path: asText(data.path),
      }
    }
    const resolved = asText(data.path)
    if (!resolved) return { ok: false, error: '宿主没有返回目录路径' }
    return {
      ok: true,
      path: resolved,
      home: asText(data.home) ?? '',
      dirs: entriesFrom(data),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 在 `parent` 下新建一层目录（`name` 必须是一个目录名，不含路径分隔符）。
 * 已存在、名称非法等由宿主判定并回人话 error。从不抛。
 */
export async function createLocalDir(
  parent: string,
  name: string,
): Promise<CreateLocalDirResult> {
  const route = '/api/local/mkdir'
  try {
    const { res, data } = await postLocalFs(route, { parent, name })
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: asText(data.error) || endpointError(res.status, route, `新建文件夹失败 (${res.status})`),
      }
    }
    const created = asText(data.path)
    if (!created) return { ok: false, error: '宿主没有返回新目录路径' }
    return { ok: true, path: created }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
