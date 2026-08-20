/**
 * 统一浏览器持久化层（localStorage 唯一出入口）。
 *
 * 所有 localStorage 读写经由此模块，理由：
 * - JSON 读写自动 try/catch：损坏数据/隐私模式/配额超限静默回退，
 *   调用方不需要防御性包裹；
 * - 布尔值统一 'true'/'false' 字符串语义，避免各处自造格式；
 * - key 由调用方持有（历史 key 名不可变——改名即丢用户数据，
 *   见各调用处常量注释）。
 */

/**
 * 取 localStorage 句柄。**必须懒取 + try/catch**：Safari 无痕、Chrome
 * 「阻止所有 Cookie」、被 sandbox 的 iframe 里，读 `window.localStorage`
 * 这个 getter 本身就抛 SecurityError。模块顶层直接取会在 import 期
 * 抛出——本模块被 theme/pins/transport 等启动路径导入，整个应用白屏，
 * 与本文件「隐私模式静默回退」的承诺相反。
 *
 * 不可用时回退到进程内 Map：语义降级为「本次会话内有效、刷新即失」，
 * 但读写路径全部照常工作，调用方无需分支。
 */
type KVStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function memoryStore(): KVStore {
  const mem = new Map<string, string>()
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  }
}

let cached: KVStore | null = null
function getStore(): KVStore {
  if (cached) return cached
  try {
    // 读 getter 可能抛；再做一次写探测，覆盖「getter 可读但写必抛」
    // 的无痕模式（旧 iOS Safari 配额为 0）。
    const ls = window.localStorage
    const probe = '__capri_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    cached = ls
  } catch {
    cached = memoryStore()
  }
  return cached
}

/**
 * 读取并解析 JSON；缺失或损坏时返回 fallback（不抛异常）。
 *
 * 注意：只兜 JSON「语法」损坏。若存储值是语法合法但类型非法的
 * 原始值（如字面 "null" / "123"），会原样穿透返回——需要对象/
 * 数组结构的调用方必须在拿到结果后自己补类型闸（见 historyPins/
 * historyView 的 load()）。
 */
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = getStore().getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 序列化写入；失败（配额/隐私模式）静默降级。 */
export function saveJSON(key: string, value: unknown): void {
  try {
    getStore().setItem(key, JSON.stringify(value))
  } catch {
    /* 静默降级 */
  }
}

/** 读取原始字符串；无值或不可读时返回 null。 */
export function loadStr(key: string): string | null {
  try {
    return getStore().getItem(key)
  } catch {
    return null
  }
}

/** 写入原始字符串。 */
export function saveStr(key: string, value: string): void {
  try {
    getStore().setItem(key, value)
  } catch {
    /* 静默降级 */
  }
}

/** 读取布尔（'true' → true，其余/缺失 → fallback）。 */
export function loadBool(key: string, fallback: boolean): boolean {
  const v = loadStr(key)
  if (v == null) return fallback
  return v === 'true'
}

/** 写入布尔（'true'/'false' 字符串，与既有存储格式兼容）。 */
export function saveBool(key: string, value: boolean): void {
  saveStr(key, value ? 'true' : 'false')
}

/** 删除 key（无值也安全）。 */
export function removeKey(key: string): void {
  try {
    getStore().removeItem(key)
  } catch {
    /* 静默降级 */
  }
}
