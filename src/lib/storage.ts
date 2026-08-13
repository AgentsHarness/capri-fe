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

const store = window.localStorage

/** 读取并解析 JSON；缺失或损坏时返回 fallback（不抛异常）。 */
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = store.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 序列化写入；失败（配额/隐私模式）静默降级。 */
export function saveJSON(key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    /* 静默降级 */
  }
}

/** 读取原始字符串；无值或不可读时返回 null。 */
export function loadStr(key: string): string | null {
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

/** 写入原始字符串。 */
export function saveStr(key: string, value: string): void {
  try {
    store.setItem(key, value)
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
    store.removeItem(key)
  } catch {
    /* 静默降级 */
  }
}
