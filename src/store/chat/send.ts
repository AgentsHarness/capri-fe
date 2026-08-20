import type { ContentBlock } from '../../api/types'
import { transport, AgentTurnError } from '../../api/client'
import { qid, usePromptQueue } from '../promptQueue'
import type { ChatState, SetState } from './types'
import { nid } from './ids'
import {
  clearStreamBuf,
  flushStreamBuf,
  sealAssistantStream,
  sealThought,
} from './stream'
import { armTurnBlipWatchdog, turnIsLive } from './turn'
import { pushToast } from '../toast'
import { captureAsyncScope, isAsyncScopeCurrent } from './globals'

export async function sendPrompt(
  set: SetState,
  get: () => ChatState,
  text: string,
  blocks?: ContentBlock[],
  opts?: { fromShell?: boolean; promptId?: string }
): Promise<void> {
    const t = text.trim()
    if (!t) return
    // 空状态（无活动会话）：发送消息即开始新对话 — 先用空状态选择的
    // 工作目录创建会话（目录留空 → 宿主默认），POST /api/session 响应
    // 携带 sessionId，锚定后直接发送本条消息。
    const initial = get()
    let sendScope = captureAsyncScope(get, initial.sessionId, initial.cwd)
    if (!initial.sessionId) {
      const emptyCwd = initial.emptyCwd?.trim()
      const hostAtStart = initial.hostId
      try {
        const createdSessionId = await get().newSession(emptyCwd || undefined)
        // A new-session response is only usable by the request that created
        // it. A host switch can otherwise leave this prompt targeting the new
        // host's unrelated active session.
        if (
          !createdSessionId ||
          get().sessionId !== createdSessionId ||
          get().hostId !== hostAtStart
        ) {
          return
        }
        sendScope = captureAsyncScope(get, createdSessionId, get().cwd)
      } catch (e) {
        if (get().hostId !== hostAtStart) return
        const msg = e instanceof Error ? e.message : String(e)
        set({
          entries: [
            ...get().entries,
            { id: nid(), kind: 'error', text: `创建会话失败: ${msg}` },
          ],
        })
        return
      }
    }
    // 忙时守卫：当前会话已有活动回合（流式中 / 回合未收口，含恢复的
    // 在飞会话 turnStartedAt 未清）时走 server-authoritative 入队——
    // enqueue 立即 fire-and-forget 发 session/prompt（带 `_meta.promptId`，
    // agent 把它插进权威队列），本地插乐观回显行；RPC 失败（含竞态
    // 409）→ 行保留 degraded + 渲染错误行，手动重发。sendFollowUp /
    // slash 命令 / sendQueuedHead 竞态下忙时调用 send 也走这里。
    const live = get()
    sendScope = captureAsyncScope(get, live.sessionId, live.cwd)
    if (live.sessionId && live.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      return
    }
    if (live.sessionId && turnIsLive(live)) {
      usePromptQueue.getState().enqueue(
        {
          text: t,
          blocks:
            blocks && blocks.length > 0 ? blocks : [{ type: 'text', text: t }],
        },
        live.sessionId,
      )
      return
    }
    // 流式缓冲先落库：上一回合的思考文本完整后再收口/追加用户行。
    flushStreamBuf(set, get)
    // Seal any leftover thought from prior turn, then append the user row.
    // Tag the user row so the live user_chunk echo merges into it (not a
    // 2nd row). NO pre-created Thinking… shell: TUI pre-creates the
    // thinking block at stream_start (first chunk), so between send and
    // the first token the status line reads "Waiting for response…".
    // A new turn closes any stale stream — seal assistant (text +
    // streaming:false) and thought before the pointers drop.
    const sealedAsst = sealAssistantStream(get())
    const sealed = sealThought(sealedAsst)
    const userId = nid()
    // 回合身份：mint 一个 promptId 走 wire（TUI 同款——agent 在
    // PromptResponse / SessionNotification 的 `_meta` 上回显），终端事件
    // 按它做 exact-pid 匹配，杜绝上一回合的迟到 prompt_complete/done
    // 收口新回合（"Worked for 0.0s" 假标记）。降级行重发沿用原 id
    // （agent queue_meta 身份一致）；旧 host 忽略该字段 → 事件无 pid，
    // 匹配退回 legacy。与队列 promptId 同源（promptQueue 的 qid）。
    const promptId = opts?.promptId ?? qid()
    // Shell-mode submissions (Composer `!` mode → prompt path) mark the
    // user row so the scrollback renders it with the TUI `$ ` prefix.
    const userEntry = {
      id: userId,
      kind: 'user' as const,
      text: t,
      ts: Date.now(),
      ...(opts?.fromShell ? { isShell: true } : {}),
    }
    set({
      ...sealed,
      entries: [...sealed.entries, userEntry],
      openAssistantId: undefined,
      openThoughtId: undefined,
      currentStreamStartMs: undefined,
      lastCompletedTurn: undefined,
      pendingOptimisticUserId: userId,
      lastSentPromptId: userId,
      conn: 'busy',
      statusText: 'Waiting for response…',
      awaitingNext: false,
      turnStartedAt: Date.now(),
      currentPromptId: promptId,
      // A manual send starts a new turn: the previous turn's suggestion
      // chips are retired (TUI clears follow_ups at turn start).
      followUps: undefined,
      followUpsResponseId: undefined,
      // 新回合开始：上一回合的速率数字失效（host 在 user_message_chunk
      // 时静默复位，不发事件）。
      genRate: undefined,
    })
    try {
      // Optional image blocks (Composer image chips): the caller passes
      // the full block list; default is the plain text prompt.
      // promptId：本回合身份（普通发送 mint 新 id；降级行重发保持与
      // 镜像行同 id，agent 侧 queue_meta 一致）。
      await transport.prompt(
        blocks && blocks.length > 0 ? blocks : [{ type: 'text', text: t }],
        // 显式绑定会话列表选中的会话：请求确定发往 get().sessionId
        // （与 sendQueuedToSession 一致），而不是依赖 host 的活动会话——
        // 避免 host 活动会话与 FE 列表选中会话在竞态窗口内不一致时发错会话。
        { promptId, sessionId: get().sessionId },
      )
    } catch (e) {
      if (!isAsyncScopeCurrent(get, sendScope)) return
      const msg = e instanceof Error ? e.message : String(e)
      // drop empty thinking shell on failure
      const s = get()
      const after = sealThought(s)
      // 回合失败 ≠ 连接失败：HTTP 错误响应说明 host 活着，错误来自 agent
      // （host 只是透传，如模型 API 400 "Internal Error"）——滚动一条错误
      // 行即可，连接保持就绪、不亮红色 Host 横幅。只有网络级失败（fetch
      // 拒绝 = host 不可达，即 AgentTurnError 之外的异常）才进 host 错误
      // 处理（conn: 'error' + 横幅）。
      if (!(e instanceof AgentTurnError)) {
        // 网络级失败（fetch 拒绝）。但 POST /api/prompt（回合 RPC）与
        // live 通道（SSE/WS，回合输出）是两条独立连接——三种情形：
        // 1) 回合已被 live 通道收口（done/turn_completed 先到，turnStartedAt
        //    已清）：回合结果以 live 通道为准，SSE 侧已渲染过该渲染的
        //    （成功标记或错误行）——HTTP 拒绝只是陈旧通道的产物，静默返回。
        // 2) 回合仍在 live 通道上运行（自 turnStartedAt 以来有事件送达）：
        //    fetch 失败只是通道瞬断（host 重启 / 代理抖动 / HTTP/2 reset），
        //    输出照常流——不渲染错误行、不翻转 conn，武装看门狗兜底
        //    （仅当回合卡死且通道断开才补错误态）。
        // 3) 回合从未启动（本回合零 live 事件）：真 host 不可达 / prompt
        //    丢失——保留原硬错误处理（conn: 'error' + 横幅）。
        const started = s.turnStartedAt
        if (started == null) return
        const lastLive = transport.lastLiveEventAt()
        if (lastLive != null && lastLive >= started) {
          armTurnBlipWatchdog(set, get, msg)
          return
        }
        // 网络级失败（host 不可达）：丢弃未落库的流式缓冲并取消 rAF，
        // 避免残留 flush 在错误态之后把 conn 重新顶回 busy。host 级
        // 失败（会话无关）不滚时间线错误行——横幅就地设置，不依赖
        // live error 事件（SSE 与 POST 是两条独立连接，事件可能迟到
        // 甚至缺失）。statusText 不写错误（stat/composer 不参与），
        // 清空以防 stat 残留陈旧连接文案。
        clearStreamBuf()
        get().setLayerError('host', {
          level: 'error',
          message: msg,
          at: Date.now(),
        })
        set({
          ...after,
          pendingOptimisticUserId: undefined,
          conn: 'error',
          statusText: '',
          awaitingNext: false,
          turnStartedAt: undefined,
          currentPromptId: undefined,
        })
        return
      }
      // 代理超时（524 Cloudflare / 504 nginx / 408）≠ agent 拒绝：这是
      // 反代等不到源站响应头（Cloudflare ~100s）主动掐断阻塞的 POST。
      // 新 host 已改为受理即返回，不会再触发；此分支是旧 host（阻塞到
      // 回合结束）的防御——host 的 handler 早已 detach（ctx.Done()）、
      // 回合在后台照常跑、输出继续走 live 通道，回合结果由 live 通道
      // 收口（成功或 SSE 错误事件）。渲染 "prompt failed (524)" 只会
      // 污染已正常完成的回合。与网络瞬断同构：不渲染错误行，武装看门狗
      // 兜底——仅当回合卡死且 live 通道断开才补错误态。turnStartedAt
      // 已清说明 live 通道已收口过（结果已渲染），静默返回。
      if (
        e instanceof AgentTurnError &&
        (e.status === 524 || e.status === 504 || e.status === 408 || e.status === 599)
      ) {
        if (s.turnStartedAt == null) return
        armTurnBlipWatchdog(set, get, msg)
        return
      }
      // host 的 SSE error 事件（同文本）通常先于 HTTP 响应到达、已滚过
      // 一行——按文本去重，避免同一回合错误出现两行。
      const last = after.entries[after.entries.length - 1]
      const dup = last && last.kind === 'error' && last.text === msg
      set({
        ...after,
        pendingOptimisticUserId: undefined,
        conn: s.conn === 'busy' ? 'ready' : s.conn,
        // unreachable（502/传输断）：agent 可能不可达——host 不再自动
        // 重启，给恢复提示；rejected：agent 报错，直接显示错误文本。
        statusText:
          e instanceof AgentTurnError && e.kind === 'unreachable'
            ? 'agent 连接异常，可重启 agent'
            : msg,
        // 新回合开始：清空分层横幅。
        layerErrors: {},
        awaitingNext: false,
        turnStartedAt: undefined,
        currentPromptId: undefined,
        entries: dup
          ? after.entries
          : [...after.entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  }
