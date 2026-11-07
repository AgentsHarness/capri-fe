import type { ContentBlock } from '../../api/types'
import { useChatStore } from '../../store/chat'
import { usePromptQueue } from '../../store/promptQueue'
import { pushToast } from '../../store/toast'
import { transport } from '../../api/client'
import { escapeSlash } from '../../commands/registry'

type SendQueuedOptions = {
  sendLocal: (
    text: string,
    blocks: ContentBlock[],
    opts?: { promptId?: string },
  ) => Promise<unknown>
  pushHistory: (text: string, isShell?: boolean) => void
  setInterjectTarget: (target: { id?: string } | null) => void
}

/**
 * 队列行「立即发送」：agent-owned 行走 interject，降级行 cancel-then-send。
 * 返回 null = 这次点击没有接手；接手则返回派发完成的 promise。
 */
export function useSendQueuedItem({
  sendLocal,
  pushHistory,
  setInterjectTarget,
}: SendQueuedOptions) {
  const sendQueuedItem = (id?: string, skipConfirm = false): Promise<void> | null => {
    const st = useChatStore.getState()
    if (st.sessionId && st.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      return null
    }
    const q = usePromptQueue.getState()
    if (q.sending) return null

    if (!skipConfirm) {
      const hasPendingReqs = st.xaiRequests.length > 0 || st.pending.length > 0
      if (hasPendingReqs) {
        setInterjectTarget({ id })
        return null
      }
    }

    // Stale-queue guard: the queue is tagged with the session it was
    // queued in. If that session is no longer active (a sessionId change
    // path missed the tracking subscription, or the host switched
    // sessions), NEVER deliver it here — swap to the active session's
    // queue instead (the stray queue stays stashed under its own id).
    const activeSession = useChatStore.getState().sessionId ?? ''
    if (q.sessionId != null && q.sessionId !== activeSession) {
      q.switchSession(activeSession || undefined)
      return null
    }
    const item = id ? q.queue.find((x) => x.id === id) : q.queue[0]
    if (!item) return null
    q.setSending(true)
    return (async () => {
      try {
        if (!item.degraded) {
          // agent-owned 行（乐观回显 / 已确认）→ send-now via interject
          // （提升为下一个运行；运行中回合可能被 agent 取消、该行立即
          // 开跑）。
          //
          // 失败不能静默：正常情况下 queue_changed 广播会校正镜像，但链路
          // 断了广播也来不了——行会一直显示"已发"，实际 agent 从没收到。
          // 失败即标 degraded（FE-owned，带失败原因），用户可以手动重发。
          try {
            await transport.queueInterject(
              {
                id: item.id,
                ...(item.version != null ? { expectedVersion: item.version } : {}),
              },
              activeSession,
            )
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            usePromptQueue.getState().markDegraded(item.id, msg)
            pushToast(`立即发送失败（未送达）：${msg}`)
          }
          return
        }
        // RPC 失败降级行（FE-owned，agent 从没见过）→ cancel-then-send
        // 兜底：取消运行中回合（后台任务继续），然后发送该行。
        if (useChatStore.getState().conn === 'busy') {
          await useChatStore.getState().cancel()
          for (
            let i = 0;
            i < 50 && useChatStore.getState().conn === 'busy';
            i++
          ) {
            await new Promise((r) => setTimeout(r, 10))
          }
        }
        if (!usePromptQueue.getState().queue.some((x) => x.id === item.id)) return
        q.removeAt(item.id)
        try {
          // Resend the wire text from the blocks (an image-only row's text
          // block is empty — the images ride along in blocks[1..]).
          const firstBlock = item.blocks[0]
          // ContentBlock has an open `{ type: string; … }` arm — cast after
          // the discriminant check to get the string-typed text.
          const resendText =
            firstBlock && firstBlock.type === 'text'
              ? (firstBlock as { type: 'text'; text: string }).text
              : item.text
          const sendPromise = sendLocal(resendText, item.blocks, {
            promptId: item.id,
          })
          q.setSending(false)
          await sendPromise
          // Re-arm the `\/` escape in history (queued text is already
          // unescaped; a leading `/` here can only be a literal prompt).
          if (useChatStore.getState().conn !== 'error') pushHistory(escapeSlash(item.text))
        } catch {
          const active = useChatStore.getState().sessionId
          if (active) usePromptQueue.getState().requeueFront(active, item)
        } finally {
          q.setSending(false)
        }
      } finally {
        q.setSending(false)
      }
    })()
  }


  return sendQueuedItem
}
