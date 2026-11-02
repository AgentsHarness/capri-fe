import type { ContentBlock } from '../../api/types'
import { transport, AgentTurnError } from '../../api/client'
import { qid, isBashBlocks, userRowText, usePromptQueue } from '../promptQueue'
import type { ChatState, SetState } from './types'
import { createEmptyStateWorktree } from './emptyWorktree'
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
import { blockGuestWrite } from './guestMode'

/** 未送达错误行的固定前缀：重发时按它识别并清掉旧行。 */
export const UNDELIVERED_PREFIX = '消息未送达'

/**
 * 把一条用户行标成「未送达」。重发入口（行内按钮 / 错误行）都靠这个标记
 * 判断回收哪一条；send() 重发时会重新画行，标记自然消失。
 */
export function markUndelivered(
  entries: ChatState['entries'],
  userId: string | undefined,
): ChatState['entries'] {
  if (!userId) return entries
  return entries.map((e) =>
    e.kind === 'user' && e.id === userId ? { ...e, undelivered: true } : e,
  )
}

export async function sendPrompt(
  set: SetState,
  get: () => ChatState,
  text: string,
  blocks?: ContentBlock[],
  opts?: { fromShell?: boolean; promptId?: string }
): Promise<void> {
    if (blockGuestWrite(get())) return
    const t = text.trim()
    // Image-only prompts (Composer thumbnails, no text) are sendable —
    // the images are the content. Without image blocks an empty prompt
    // is a no-op.
    const hasImages = blocks?.some((b) => b.type === 'image') ?? false
    if (!t && !hasImages) return
    // 空状态（无活动会话）：发送消息即开始新对话 — 先用空状态选择的
    // 工作目录创建会话（目录留空 → 宿主默认），POST /api/session 响应
    // 携带 sessionId，锚定后直接发送本条消息。
    const initial = get()
    let sendScope = captureAsyncScope(get, initial.sessionId, initial.cwd)
    if (!initial.sessionId) {
      const emptyCwd = initial.emptyCwd?.trim()
      const hostAtStart = initial.hostId
      // 建 worktree 在飞时再次回车：不重复建（第二个 worktree 会白占一个
      // 目录），提示用户等这次收口。
      if (initial.emptyWorktreeBusy) {
        pushToast('正在创建 worktree，请稍候')
        return
      }
      // 空状态的 worktree 开关：真正建 worktree 放在这一刻（首条消息），
      // 而不是用户点开关时——TUI 的 worktree 模式同款语义：开关只表达
      // 意图，发消息才落盘。建失败不建会话，开关留在原处方便改目录重试。
      let createdWorktree: string | undefined
      let startCwd = emptyCwd
      if (initial.emptyWorktree && emptyCwd) {
        set({ emptyWorktreeBusy: true })
        try {
          startCwd = await createEmptyStateWorktree({
            sourcePath: emptyCwd,
            ...(initial.emptyWorktreeLabel?.trim()
              ? { label: initial.emptyWorktreeLabel.trim() }
              : {}),
          })
          createdWorktree = startCwd
        } catch (e) {
          if (get().hostId !== hostAtStart) return
          const msg = e instanceof Error ? e.message : String(e)
          set({ emptyWorktreeBusy: false })
          pushToast(`创建 worktree 失败：${msg}`)
          return
        }
        set({ emptyWorktreeBusy: false })
        if (get().hostId !== hostAtStart) return
      }
      try {
        const createdSessionId = await get().newSession(startCwd || undefined)
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
        // worktree 建好了但会话没建起来：把它当成新的工作目录、关掉开关，
        // 重发时直接在它里面建会话——否则重试会再建一个 worktree，把刚建
        // 好的那份留在盘上没人用（newSession 的复位已把 emptyCwd 清掉）。
        const orphaned = createdWorktree
          ? `（worktree 已建在 ${createdWorktree}，重发即在该目录中开始）`
          : ''
        set({
          ...(createdWorktree
            ? {
                emptyCwd: createdWorktree,
                emptyWorktree: false,
                emptyWorktreeLabel: undefined,
              }
            : {}),
          entries: [
            ...get().entries,
            { id: nid(), kind: 'error', text: `创建会话失败: ${msg}${orphaned}` },
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
    // slash 命令 / sendQueuedItem 竞态下忙时调用 send 也走这里。
    const live = get()
    sendScope = captureAsyncScope(get, live.sessionId, live.cwd)
    if (live.sessionId && live.historyLoading) {
      pushToast('正在切换会话，请稍候再发送')
      return
    }
    if (live.sessionId && turnIsLive(live)) {
      // 忙时发送（TUI queue 语义）：只入 agent 权威队列——transcript 不
      // 插乐观行，排队消息由 composer 上方的内联队列区展示（可收起为
      // "N queued"）。回合收口后 agent pop 队首，queue_changed 带
      // running_prompt_id → adoptTurn 渲染该条的用户行。
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
    // （agent queue_meta 身份一致）；v2 host 保证回显该字段（缺失按不匹配
    // 处理）。与队列 promptId 同源（promptQueue 的 qid）。
    const promptId = opts?.promptId ?? qid()
    // Shell-mode submissions (Composer `!` mode → prompt path) mark the
    // user row so the scrollback renders it with the TUI `$ ` prefix.
    // 块里带 `bash_command` 也算（调用方没传 fromShell 时不至于掉标）。
    const userEntry = {
      id: userId,
      kind: 'user' as const,
      // 正文为空但有附图（纯图片 prompt）时按每张图给一个 `[image]` 标记，
      // 用户行才不是一条空白；wire 上发的仍是真 blocks，标记不外传。
      text: userRowText(t, blocks),
      ts: Date.now(),
      ...(opts?.fromShell || isBashBlocks(blocks) ? { isShell: true } : {}),
    }
    // 降级行手动重发沿用原 promptId：先移除当初忙时渲染的乐观排队行
    // （行 id = promptId），否则重发后 transcript 出现两条同文用户行。
    const baseEntries = opts?.promptId
      ? sealed.entries.filter((e) => !(e.id === promptId && e.kind === 'user'))
      : sealed.entries
    set({
      ...sealed,
      entries: [...baseEntries, userEntry],
      openAssistantId: undefined,
      openThoughtId: undefined,
      currentStreamStartMs: undefined,
      lastCompletedTurn: undefined,
      pendingOptimisticUserId: userId,
      lastSentPromptId: userId,
      conn: 'busy',
      phaseText: 'Waiting for response…',
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
      // 200 = host 已受理（hub 等的是 host 的 respond，host 又受理即返回）。
      // 这是「消息确实出去了」的正面证据：断线时前端可以据此判断回合是
      // 真的在跑（等输出即可），而不是发不出去。只在同一回合仍有效时写，
      // 换会话/换 host 后的迟到响应不能污染新视图。
      if (isAsyncScopeCurrent(get, sendScope) && get().currentPromptId === promptId) {
        set({ promptAcceptedAt: Date.now() })
      }
    } catch (e) {
      if (!isAsyncScopeCurrent(get, sendScope)) return
      const msg = e instanceof Error ? e.message : String(e)
      // drop empty thinking shell on failure
      const s = get()
      const after = sealThought(s)
      // 回合失败 ≠ 连接失败：HTTP 错误响应说明 host 活着，错误来自 agent
      // （host 只是透传，如模型 API 400 "Internal Error"）——滚动一条错误
      // 行即可，连接保持就绪、不亮红色 Host 提示。只有网络级失败（fetch
      // 拒绝 = host 不可达，即 AgentTurnError 之外的异常）才进 host 错误
      // 处理（conn: 'error' + 顶栏提示）。
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
        //    丢失——保留原硬错误处理（conn: 'error' + 顶栏提示）。
        const started = s.turnStartedAt
        if (started == null) return
        const lastLive = transport.lastLiveEventAt()
        if (lastLive != null && lastLive >= started) {
          armTurnBlipWatchdog(set, get, msg)
          return
        }
        // 网络级失败（host 不可达）：丢弃未落库的流式缓冲并取消 rAF，
        // 避免残留 flush 在错误态之后把 conn 重新顶回 busy。host 级
        // 失败（会话无关）不滚时间线错误行——提示就地设置，不依赖
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
          // 保留回合身份并标记用户行：这条 prompt 谁都没收到，重发入口
          // 按同一个 promptId 复用身份（host 侧同号去重）。清掉的话用户
          // 只剩顶部一条「host 已离线」，没有任何可点的恢复动作。
          currentPromptId: promptId,
          entries: markUndelivered(after.entries, userId),
          pendingOptimisticUserId: undefined,
          conn: 'error',
          statusText: '',
          awaitingNext: false,
          turnStartedAt: undefined,
          promptAcceptedAt: undefined,
        })
        return
      }
      // host 的 SSE error 事件（同文本）通常先于 HTTP 响应到达、已滚过
      // 一行——按文本去重，避免同一回合错误出现两行。
      const last = after.entries[after.entries.length - 1]
      const dup = last && last.kind === 'error' && last.text === msg
      // hub 中继的快速失败：host 正在重连 / 不可达时，hub 不等回合结束
      // 就直接回 503（AgentTurnError.status）。这条 prompt 根本没离开
      // hub——判定只看状态码，不依赖错误文案（hub 可能换措辞）。
      const offline503 =
        e instanceof AgentTurnError && e.status === 503
      const undeliveredMsg = offline503
        ? `${UNDELIVERED_PREFIX}：${msg}`
        : msg
      set({
        ...after,
        pendingOptimisticUserId: undefined,
        conn: s.conn === 'busy' ? 'ready' : s.conn,
        // unreachable（502/传输断）：agent 可能不可达——host 不再自动
        // 重启，给恢复提示；rejected：agent 报错，直接显示错误文本。
        // 503 是 hub 层的中继失败，状态行说清「未送达 + hub 的原话」。
        statusText: offline503
          ? undeliveredMsg
          : e instanceof AgentTurnError && e.kind === 'unreachable'
            ? 'agent 连接异常，可重启 agent'
            : msg,
        // 503 是 hub 层失败：host-offline 横幅正是这条错误的来源，别清掉
        // （恢复在线时 refreshHosts 会按 id 清除）。其余回合级错误说明
        // host 活着，清空分层错误栈。
        layerErrors: offline503 ? s.layerErrors : {},
        awaitingNext: false,
        turnStartedAt: undefined,
        // hub 回 503 说明这条 prompt 根本没离开 hub：回合身份留着，用户行
        // 与错误行都挂重试，两条入口都指回 resendUndeliveredPrompt（同
        // promptId，host 侧同号去重）。
        ...(offline503 ? { currentPromptId: promptId } : { currentPromptId: undefined }),
        promptAcceptedAt: undefined,
        entries: offline503
          ? [
              ...markUndelivered(after.entries, userId),
              {
                id: nid(),
                kind: 'error',
                text: undeliveredMsg,
                action: 'resend' as const,
              },
            ]
          : dup
            ? after.entries
            : [...after.entries, { id: nid(), kind: 'error', text: msg }],
      })
    }
  }
