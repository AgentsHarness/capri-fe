/**
 * 流式淡入视图的短暂交接缓存（模块级，按 entry id 存放）。
 *
 * 思考块收口时直播行会被卸载、退出快照随即挂载。若快照从零开始，刚
 * 结束的淡入会整块重播（先变暗再收起）。这里让 SmoothStreamText 在
 * 每个视图更新时把当前 view 留在缓存里，退出快照按同一 id 接手，从
 * 原来的 pending / fading 片段继续铺完，再开始收起高度。
 *
 * 只在 live scrollback 的思考行使用；TTL + 容量上限兜底，避免长期堆积。
 */
import type { StreamTextView } from './streamTextFade'
import { streamClockNow } from './streamTextFade'

/** 缓存条目超过该年龄视为过期：延迟入组的思考不该接一段早已结束的淡入。 */
export const STREAM_FADE_CACHE_TTL_MS = 3000
/** 同时保留的条目上限（正常只有一个正在流式的思考）。 */
const STREAM_FADE_CACHE_MAX = 8

type CachedFadeView = {
  view: StreamTextView
  at: number
}

const cache = new Map<string, CachedFadeView>()

export function rememberStreamFade(
  key: string,
  view: StreamTextView,
  at = streamClockNow(),
): void {
  cache.delete(key)
  cache.set(key, { view, at })
  while (cache.size > STREAM_FADE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 读取可接手的视图；过期条目顺手清掉。peek 不改变缓存归属。 */
export function peekStreamFade(
  key: string,
  now = streamClockNow(),
): StreamTextView | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (now - entry.at > STREAM_FADE_CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return entry.view
}

export function clearStreamFade(key: string): void {
  cache.delete(key)
}

/** 测试用：清空全部缓存。 */
export function resetStreamFadeCache(): void {
  cache.clear()
}
