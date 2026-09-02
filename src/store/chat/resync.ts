import type { ChatState } from './types'
import { loadHistoryWithTaskProbe } from './loadHistory'

/**
 * hub 慢消费者保护（resync）→ 全量重建。
 *
 * transport（localTransport.handleResyncFrame）收到 {"type":"resync",
 * "fromSeq":N} 后已中止在途 gap-pull、清空乱序缓冲并把选中 host 的
 * seq 水位前跳到 fromSeq-1；这里触发仓库既有的全量重建路径
 * loadHistory：清空 scrollback 后从 host 持久化历史重放最新一轮
 * （continueSession 切回繁忙会话用的就是同一条路径，天然覆盖进行中
 * 回合）。重建窗口（historyLoading）期间到达的 live 事件由 init 的
 * 缓冲 + loadHistory 的 replayHistoryWindowBuffer 按 epoch-ms 边界与
 * 稳定事件键去重回放，不会重复渲染；transport 侧事件仍受 seq 水位
 * 门控（seq <= lastSeq 直接丢弃）按序放出。
 */
export function handleResyncRebuild(get: () => ChatState): void {
  // 防抖：重建（含历史上翻页加载）进行中直接忽略后续 resync。本次
  // 重建本就覆盖“现在”，更晚的 fromSeq 不带来增量信息；transport 对
  // 每帧 resync 都独立前跳水位并中止 gap-pull，忽略不会丢事件，
  // 也保证绝不并发重建。
  if (get().historyLoading || get().historyLoadingMore) return
  const { sessionId, cwd } = get()
  // 无活动会话（hub 首屏未选 host / 尚未 hello）：没有可重建的视图，
  // transport 已重置序号状态，直接忽略。
  if (!sessionId || !cwd) return
  // 与快照同时探一次在跑任务：全量重建同样要跳过仍在跑任务的那行
  // `Task started`（见 loadHistoryWithTaskProbe）。
  void loadHistoryWithTaskProbe(get, sessionId, cwd)
}
