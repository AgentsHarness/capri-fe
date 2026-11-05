/**
 * 本端正在进行的模型切换（`sessionId + modelId` → 未完成请求数）。
 *
 * 为什么需要它：host 在 `/api/set-model` 的 HTTP 响应**之前**就广播 typed
 * `model_changed`（bridge.go dispatchSessionUpdateKind 的顺序），所以发起
 * 切换的这个标签页会先收到广播、后收到响应。广播的落行守卫看的是「当前
 * modelName 是否已等于新名字」，此刻还是旧名字，守卫不成立；随后 setModel
 * 又写一行乐观行——同一个动作两行。
 *
 * 这里在请求期间登记目标，广播处理时只更新模型身份、不落行，把这一行留给
 * setModel（它还知道上下文窗口后缀与 warning 文案）。别的标签页没有登记，
 * 仍按广播落行，远端切换的提示不丢。
 *
 * 用计数而不是布尔：同一模型可能有并发切换（快速连点），每个请求只清自己
 * 那一次。
 */
const inFlight = new Map<string, number>()

function key(sessionId: string, modelId: string): string {
  return `${sessionId}\u0000${modelId}`
}

export function beginModelSwitch(sessionId: string, modelId: string): void {
  const k = key(sessionId, modelId)
  inFlight.set(k, (inFlight.get(k) ?? 0) + 1)
}

export function endModelSwitch(sessionId: string, modelId: string): void {
  const k = key(sessionId, modelId)
  const left = (inFlight.get(k) ?? 1) - 1
  if (left > 0) inFlight.set(k, left)
  else inFlight.delete(k)
}

export function isModelSwitchInFlight(sessionId: string, modelId: string): boolean {
  return (inFlight.get(key(sessionId, modelId)) ?? 0) > 0
}

/** 测试用：清空所有登记（生产路径只靠 begin/end 成对释放）。 */
export function resetModelSwitchEcho(): void {
  inFlight.clear()
}
