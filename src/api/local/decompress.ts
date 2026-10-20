/**
 * 压缩帧的降级提示。
 *
 * hub 的 WS 帧可能用 deflate 压缩（`?c=1`）。没有 DecompressionStream 的
 * 旧浏览器只能丢弃这些帧——告警一次就够，别让每条帧都刷一遍控制台。
 */
let warned = false

export function warnNoDecompressionOnce(): void {
  if (warned) return
  warned = true
  console.warn('deflate 解压不可用，丢弃压缩帧')
}
