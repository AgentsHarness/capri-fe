import type { TransportCore } from '../transport'
import { AgentTurnError } from '../transport'
import { assertRpcOk, readRpcJson } from './core'
import type { ContentBlock, PermissionScope } from '../types'

/**
 * POST /api/prompt 的超时上限（受理即返回后实际毫秒级；旧 host 阻塞式
 * 回合最长 30min）。调用方可按需用 prompt({ timeoutMs }) 覆盖。
 */
const PROMPT_TIMEOUT_MS = 30 * 60_000

/** 回合控制：发送 prompt、取消回合、权限/转发请求应答。 */
export const promptRpc = {
  /**
   * POST /api/prompt — host 已改为"受理即返回"：校验通过（含显式会话
   * 存在性）立即回 200 {ok:true}，不再等到回合结束。回合结果（成功 /
   * 失败 / 取消 + meta）全部经 live 通道（SSE/WS）的 done / error /
   * cancelled 事件送达，本响应不再携带 stopReason/meta（旧 host 才会在
   * 响应里透传 session/prompt 的 `_meta`，这里保留解析兼容）。
   *
   * `sessionId`（可选，缺省 = host 的 active 会话）：按会话发 prompt。
   * host bridge 是多会话的——带着目标 sessionId 的 prompt 会在那个会话
   * 里跑（可与当前 active 会话的回合并行），用于后台队列投递。
   *
   * `promptId`（可选，server-authoritative 队列）：有则作为 HTTP body
   * 的 `meta.promptId` 发出（host `promptBody.Meta` json:"meta"；host 再
   * 把它写成 agent 侧 session/prompt 的 `_meta.promptId`）。agent 从
   * promptId 提取 queue_meta 插进权威队列（busy 排队、回合结束自动 pop；
   * idle 直接运行），经 x.ai/queue/changed 广播回显。TUI pager 同款
   * wire（prompt_request_meta）。注意：HTTP 层键名是 `meta`（不是
   * `_meta`）——错写成 `_meta` 会被 host 静默丢弃，agent 自造 id，本地
   * 乐观行与广播行对不上就会在队列里显示成两条。旧 host 忽略该字段；
   * busy 时仍可能 409（竞态）——调用方（promptQueue.enqueue）渲染错误
   * 行、行保留手动重发（legacy 降级自动重发已移除）。
   *
   * 失败分类：新 host 下本响应只携带"受理前"的错误——参数校验 400、
   * 显式未知会话 404、网络级失败（fetch 拒绝 = host 不可达，保持普通
   * Error）。回合级失败（agent 拒绝如模型 API 400、传输中断）不再走
   * HTTP，由 live 通道的 error 事件（带 sessionId + source）送达。
   * 例外：旧 host（阻塞到回合结束）仍可能返回反代超时（524 Cloudflare /
   * 504 nginx / 408）——抛 AgentTurnError，store 依据 status 识别并走
   * 对应的重试/展示分支。
   */
  async prompt(this: TransportCore,
    blocks: ContentBlock[],
    opts: { sessionId?: string; timeoutMs?: number; promptId?: string } = {},
  ): Promise<{ stopReason?: string; meta?: Record<string, unknown> }> {
    const body: Record<string, unknown> = { blocks }
    if (opts.sessionId) body.sessionId = opts.sessionId
    // Host JSON 键是 `meta`（http.go promptBody），再转发为 agent `_meta`。
    if (opts.promptId) body.meta = { promptId: opts.promptId }
    const res = await this.fetch(
      this.url('/api/prompt'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      // 受理响应毫秒级返回；30min 上限只兜底死 relay（旧 host 阻塞到
      // 回合结束，最长 30min，也不会被误杀）。调用方可按需覆盖。
      { timeoutMs: opts.timeoutMs ?? PROMPT_TIMEOUT_MS },
    )
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      // 三档 wire 约定（host writeAgentError）：
      //   200 + {ok:false, error}            → agent 拒绝了请求（RPCError）
      //   502 + {ok:false, error}            → agent 不可达（传输级失败）
      //   其余非 2xx（400/404/409/500）       → host 语义/内部错误
      // 全部说明 host 活着 → 回合级错误；只有 fetch 网络拒绝才是 host 级。
      throw new AgentTurnError(
        res.status === 502 ? 'unreachable' : 'rejected',
        typeof data.error === 'string' && data.error
          ? data.error
          : `prompt failed (${res.status})`,
        res.status,
      )
    }
    const out: { stopReason?: string; meta?: Record<string, unknown> } = {}
    if (typeof data.stopReason === 'string') out.stopReason = data.stopReason
    if (
      data.meta &&
      typeof data.meta === 'object' &&
      !Array.isArray(data.meta) &&
      Object.keys(data.meta as Record<string, unknown>).length > 0
    ) {
      out.meta = data.meta as Record<string, unknown>
    }
    return out
  },

  /**
   * Cancel the running turn (POST /api/cancel). The agent defaults
   * `_meta.cancelSubagents` to TRUE when the flag is absent — a bare
   * cancel would silently stop every running subagent. Like the TUI
   * (xai-grok-pager always serializes the flag on session/cancel), the
   * FE sends it explicitly: `true` stops subagents too (cancel panel
   * "Stop running" / rewind), `false` keeps them running (send-now,
   * Ctrl+C, "Always continue" preference).
   */
  async cancel(this: TransportCore, opts: { cancelSubagents?: boolean } = {}, sessionId?: string): Promise<void> {
    const res = await this.fetch(this.url('/api/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cancelSubagents: opts.cancelSubagents ?? false,
        // 可选：指定目标会话（缺省 = host active 会话）。
        ...(sessionId ? { sessionId } : {}),
      }),
    })
    const data = await readRpcJson(res)
    // Empty/invalid success bodies remain valid for this command-style RPC;
    // non-2xx and explicit {ok:false} responses must still reach callers.
    assertRpcOk(res, data, 'cancel failed')
  },

  async respondPermission(this: TransportCore,
    requestId: string,
    optionId?: string,
    cancelled?: boolean,
    /**
     * Structured "always allow" scope (TUI BashCommandSelectedTerms) —
     * sent only when an always-allow option is selected. Host contract
     * (parallel): `scope: { commandParts: string[], isGlob: boolean }`,
     * parsed verbatim — field names must match exactly.
     */
    scope?: PermissionScope,
    /** Optional followup message on a reject (TUI RejectOnce followup). */
    followupMessage?: string,
  ) {
    const res = await this.fetch(this.url('/api/permission-response'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        optionId,
        cancelled,
        ...(scope ? { scope } : {}),
        ...(followupMessage ? { followupMessage } : {}),
      }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'permission failed')
  },

  async respondClientRequest(this: TransportCore, requestId: string, result?: Record<string, unknown>, error?: string) {
    const res = await this.fetch(this.url('/api/client-response'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, result, error }),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) throw new Error(data.error || 'client response failed')
  },
}
