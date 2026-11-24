/**
 * 写操作幂等键（v3 relay：host 对同一个 `(scope, key)` 最多执行一次）。
 *
 * 一次「用户动作」一个键：正常路径现 mint；有重试入口的动作把首次键存在
 * 对应 entry/state 里，重试沿用。键只出现在 `Idempotency-Key` 头，绝不
 * 进请求体。只读 POST（会话列表、历史页、任务列表等）不发键——大响应
 * 没必要进 host 的幂等缓存。
 */

let fallbackCounter = 0

/** 生成一个新的幂等键：优先 UUID v4，非安全上下文回退到随机串 + 计数器。 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER
  return `idem_${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

/**
 * 从 mutation 方法的 opts 里拆出调用方指定的键（重试复用），没有就现
 * mint。剩下的才是发给 host 的 body——idempotencyKey 绝不上 wire。
 */
export function idempotentBody<T extends object>(
  opts: T & { idempotencyKey?: string },
): { body: Record<string, unknown>; idempotencyKey: string } {
  const { idempotencyKey, ...body } = opts
  return {
    body: body as Record<string, unknown>,
    idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
  }
}
