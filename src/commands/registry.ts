/**
 * ── TUI slash command port (/help, /model, /theme, …) ─────────────────
 * The TUI's `/<command> [args]` system: input starting with "/" opens a
 * fuzzy command menu (SlashMenu); a full `/name args` line Enter also
 * executes. Commands run LOCALLY against existing store / transport
 * capabilities — an unknown command appends an error row and is NEVER
 * sent to the agent (TUI semantics).
 */
import { loadBool, saveBool } from '../lib/storage'
import { useChatStore, type ExtensionsTab } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { THEMES, useThemeStore } from '../store/theme'
import type { ThemeId } from '../theme/tokens'
import type { AgentCommand, ContentBlock } from '../api/types'
import {
  imagineInstruction,
  imagineUsageMessage,
  imagineVideoInstruction,
  imagineVideoUsageMessage,
} from './imagine'
import { slashRecencyScore } from './recency'
import { cachedSkills } from './skills'
import { fmtBytes } from '../format'
import { renderTranscript, safeExportFilename } from '../lib/exportTranscript'

export type SlashCommand = {
  name: string
  aliases?: string[]
  description: string
  argHint?: string
  /**
   * Command origin. Local commands omit it; agent-advertised commands
   * (ACP `available_commands_update`) set `'agent'` so the menu can tag
   * them and their `run` sends the raw `/name args` line to the agent.
   * Skills (GET /api/extensions) set `'skill'` — the menu sinks them
   * below the commands (TUI 1.0.9 grouping).
   */
  source?: 'local' | 'agent' | 'skill'
  run: (args: string) => void | Promise<void>
}

/** One filtered row for the slash menu (ranked, low score = better). */
export type SlashMatch = { cmd: SlashCommand; score: number }

/** ── feedback helpers (existing UI patterns only) ──────────────────── */
function err(text: string) {
  useChatStore.getState().appendLocalEntry({ kind: 'error', text })
}
function note(text: string) {
  useChatStore.getState().appendLocalEntry({ kind: 'session_event', text })
}
function status(text: string) {
  useChatStore.setState({ statusText: text })
}

// ── /multiline input mode (TUI /multiline) ─────────────────────────
// Persisted in localStorage; the composer reads it on every Enter to
// decide Enter/Shift+Enter semantics (off = Enter sends, on = Enter
// inserts a newline). Default off.
const MULTILINE_KEY = 'acpfe.multiline'

export function isMultilineEnabled(): boolean {
  return loadBool(MULTILINE_KEY, false)
}

function setMultilineEnabled(on: boolean): void {
  saveBool(MULTILINE_KEY, on)
}

/** /hooks /plugins /skills /marketplace /workflows — extensions modal on its tab. */
function openExtensionsCmd(tab: ExtensionsTab) {
  useChatStore.getState().openExtensions(tab)
}

// ── /workflow（TUI slash/commands/workflow.rs + shell resolve 对齐）────
// 单复数是两个命令：/workflow（复数带 s 是目录浏览）是操作命令——
// `runs` 打开运行面板；pause/resume/stop/save 复用 store 的
// workflowControl / saveWorkflowScript；其余形式（launch、裸调用）原文
// 透传给 shell（TUI PassThrough），busy 时由 sendPrompt 进队列。
// Shell 接受的 manage op（xai-grok-shell slash_commands.rs resolve）：
// `/workflow pause|resume|stop|save [run]` 与倒序 `/workflow <run> pause`
// （op 大小写不敏感）；`runs` 仅在无附加参数时是 op，带参数时仍是
// 名为 runs 的 workflow 的 launch。
const WORKFLOW_MANAGE_OPS = new Set(['pause', 'resume', 'stop', 'save'])
type WorkflowManageOp = 'pause' | 'resume' | 'stop' | 'save'

/** run handle 按 runId 或名称匹配（TUI 建议填充的是 run.name）。 */
function findWorkflowRun(handle: string) {
  const q = handle.toLowerCase()
  return Object.values(useChatStore.getState().workflowRuns).find(
    (r) => r.runId.toLowerCase() === q || r.name.toLowerCase() === q,
  )
}

/** 缺少/未知 run handle 时给中文提示，不猜一个 run（TUI manage_run_items
 *  只把本会话已知的 run 列入建议）。 */
function workflowRunMissingHint(handle: string | undefined) {
  const runs = Object.values(useChatStore.getState().workflowRuns)
  if (handle) {
    err(
      runs.length > 0
        ? `未找到工作流运行「${handle}」。当前运行: ${runs.map((r) => r.name).join('、')}`
        : `未找到工作流运行「${handle}」（当前会话没有运行记录）`,
    )
    return
  }
  err(
    runs.length > 0
      ? `用法: /workflow pause|resume|stop|save <运行 ID 或名称>。当前运行: ${runs
          .map((r) => r.name)
          .join('、')}`
      : '用法: /workflow pause|resume|stop|save <运行 ID 或名称> — 当前会话没有运行记录，先用 /workflow <名称> 启动一个 workflow',
  )
}

function runWorkflowControl(op: WorkflowManageOp, handle: string) {
  const st = useChatStore.getState()
  if (!handle) {
    workflowRunMissingHint(undefined)
    return
  }
  const run = findWorkflowRun(handle)
  if (!run) {
    workflowRunMissingHint(handle)
    return
  }
  if (op === 'save') {
    void st.saveWorkflowScript(run.runId)
    return
  }
  st.workflowControl(run.runId, op)
}

/**
 * Send a prompt to the agent now, or queue it while a turn is running
 * (TUI mid-turn queue semantics — same as /loop). `blocks` overrides the
 * wire content (e.g. /imagine 的 image_gen 指令块) while the scrollback
 * keeps `text`; undefined → a plain text block from `text`.
 */
function sendPrompt(text: string, blocks?: ContentBlock[]) {
  const st = useChatStore.getState()
  if (st.conn === 'busy') {
    // Tag with the active session so the queue never drains into another.
    usePromptQueue.getState().enqueue(
      {
        text,
        blocks: blocks && blocks.length > 0 ? blocks : [{ type: 'text', text }],
      },
      st.sessionId ?? '',
    )
    return
  }
  if (blocks && blocks.length > 0) void st.send(text, blocks)
  else void st.send(text)
}

/**
 * Parse a `/goal --budget` token amount: bare number, or K/M suffix
 * (case-insensitive: "500k" = 500_000, "2M" = 2_000_000). Returns
 * undefined when the amount is not a finite non-negative number.
 */
export function parseBudgetTokens(raw: string): number | undefined {
  const m = raw.trim().match(/^([\d.]+)([kKmM])?$/)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return undefined
  const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1
  return Math.round(n * mult)
}

// ── /loop（TUI slash/commands/loop_cmd.rs 语义移植）─────────────────
// 只把形如 `^\d+[smhd]$` 且数字非 0 的首 token 当 interval（仅用于即时
// 回执预览）；不匹配时整串都是 prompt，留给 agent 推导真实调度。
// `/loop` 不再自造中文指令：原文 `/loop <args>` 透传给 host，由 shell
// 的 PROMPT_COMMANDS 通道（gate: Scheduler）拦截并展开。
const LOOP_INTERVAL_RE = /^([1-9]\d*)([smhd])$/

function isLoopIntervalToken(token: string): boolean {
  const m = LOOP_INTERVAL_RE.exec(token)
  if (!m) return false
  // TUI rejects tokens that overflow u64; mirror with safe-integer check.
  return Number.isSafeInteger(Number(m[1]))
}

function parseLoopArgs(args: string): { interval?: string; promptText: string } {
  const trimmed = args.trim()
  const sp = trimmed.search(/\s/)
  const first = sp === -1 ? trimmed : trimmed.slice(0, sp)
  const rest = sp === -1 ? '' : trimmed.slice(sp + 1).trim()
  if (rest && isLoopIntervalToken(first)) return { interval: first, promptText: rest }
  return { promptText: trimmed }
}

/** "5m" → "5 分钟"（回执文案用，中文无单复数区分）。 */
function loopIntervalToHuman(token: string): string {
  const m = LOOP_INTERVAL_RE.exec(token)
  if (!m) return token
  const unit = { s: '秒', m: '分钟', h: '小时', d: '天' }[m[2] as 's' | 'm' | 'h' | 'd']
  return `${Number(m[1])} ${unit}`
}

/**
 * Composer registers its model-menu opener here so `/model` with no args
 * can open the exact same menu the model caption button uses.
 */
let modelMenuOpener: (() => void) | null = null
export function registerModelMenuOpener(fn: (() => void) | null): void {
  modelMenuOpener = fn
}

/**
 * App registers the McpPanel opener here so `/mcps` can open the panel
 * (its open state lives in App, not the store).
 */
let mcpPanelOpener: (() => void) | null = null
export function registerMcpPanelOpener(fn: (() => void) | null): void {
  mcpPanelOpener = fn
}

/** Switch model with the composer menu's effort semantics (default effort). */
function switchModelWithDefault(modelId: string) {
  const st = useChatStore.getState()
  const m = st.models.find((x) => x.modelId === modelId)
  const efforts = m?.reasoningEfforts ?? []
  const def = efforts.find((e) => e.default) ?? efforts[0]
  void st.setModel(modelId, def?.value)
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh']
/** /theme no-arg cycle order (concrete themes then auto). */
const THEME_ORDER: ThemeId[] = [
  'groknight',
  'grokday',
  'tokyonight',
  'rosepine-moon',
  'oscura-midnight',
  'auto',
]

export const slashCommands: SlashCommand[] = [
  {
    name: 'new',
    aliases: ['clear'],
    description: '新建会话',
    run: () => void useChatStore.getState().newSession(),
  },
  {
    name: 'resume',
    description: '打开会话历史，选择要恢复的会话',
    run: () => void useChatStore.getState().openHistory(),
  },
  {
    name: 'model',
    description: '切换模型（无参数打开模型菜单）',
    argHint: '[name]',
    run: (args) => {
      const st = useChatStore.getState()
      if (!args.trim()) {
        modelMenuOpener?.()
        return
      }
      const q = args.trim().toLowerCase()
      let m = st.models.find(
        (x) =>
          x.modelId.toLowerCase() === q ||
          (x.name ?? '').toLowerCase() === q,
      )
      if (!m) {
        m = st.models.find(
          (x) =>
            x.modelId.toLowerCase().includes(q) ||
            (x.name ?? '').toLowerCase().includes(q),
        )
      }
      if (!m) {
        err(
          st.models.length > 0
            ? `未找到模型「${args.trim()}」。可用: ${st.models
                .map((x) => x.modelId)
                .join(', ')}`
            : `未找到模型「${args.trim()}」（暂无可用模型）`,
        )
        return
      }
      switchModelWithDefault(m.modelId)
    },
  },
  {
    name: 'effort',
    description: '设置推理强度',
    argHint: '[low|medium|high|xhigh]',
    run: (args) => {
      const st = useChatStore.getState()
      const level = args.trim().toLowerCase()
      if (!level) {
        err('用法: /effort [low|medium|high|xhigh]')
        return
      }
      if (!EFFORT_LEVELS.includes(level)) {
        err(`无效强度「${args.trim()}」。可选: ${EFFORT_LEVELS.join(' / ')}`)
        return
      }
      const cur = (st.modelName || '').trim()
      const m = st.models.find(
        (x) =>
          x.modelId.toLowerCase() === cur.toLowerCase() ||
          (x.name ?? '').toLowerCase() === cur.toLowerCase(),
      )
      if (!m) {
        err(`无法确定当前模型「${cur || '未知'}」— 先用 /model 选择模型`)
        return
      }
      const offered = m.reasoningEfforts ?? []
      if (
        offered.length > 0 &&
        !offered.some((e) => e.value === level || e.id === level)
      ) {
        err(
          `当前模型不支持强度「${level}」。可选: ${offered
            .map((e) => e.value || e.id)
            .join(' / ')}`,
        )
        return
      }
      void st.setModel(m.modelId, level)
    },
  },
  {
    name: 'theme',
    description: '切换主题（无参数循环切换）',
    argHint: '[name]',
    run: (args) => {
      const themeStore = useThemeStore.getState()
      if (!args.trim()) {
        const i = THEME_ORDER.indexOf(themeStore.preference)
        const next = THEME_ORDER[(i + 1) % THEME_ORDER.length]
        themeStore.setTheme(next)
        status(`主题: ${next}`)
        return
      }
      const q = args.trim().toLowerCase()
      const byId = THEME_ORDER.find((id) => id === q)
      const byName = THEMES.find((t) => t.name.toLowerCase().includes(q))
      const match = byId ?? byName?.id
      if (!match) {
        err(`未找到主题「${args.trim()}」。可用: ${THEME_ORDER.join(' / ')}`)
        return
      }
      themeStore.setTheme(match)
      status(`主题: ${match}`)
    },
  },
  {
    name: 'compact',
    description: '压缩当前会话上下文',
    argHint: '[note]',
    run: (args) =>
      void useChatStore.getState().compactSession(args.trim() || undefined),
  },
  {
    name: 'rewind',
    description: '回退会话到历史检查点',
    run: () => useChatStore.getState().openRewind(),
  },
  {
    name: 'delete',
    description: '删除当前会话（需确认）',
    run: () => {
      const st = useChatStore.getState()
      if (!st.sessionId || !st.cwd) {
        err('删除失败: 无活动会话')
        return
      }
      const title = st.sessionTitle?.trim() || st.sessionId.slice(0, 8)
      // deleteSession has no built-in confirm — guard here (TUI asks too).
      if (!window.confirm(`确定删除会话「${title}」？删除后不可恢复。`)) return
      void st.deleteSession(st.sessionId, st.cwd)
    },
  },
  {
    name: 'rename',
    description: '重命名当前会话',
    argHint: '[title]',
    run: (args) => {
      const st = useChatStore.getState()
      if (!st.sessionId) {
        err('重命名失败: 无活动会话')
        return
      }
      let title = args.trim()
      if (!title) {
        title = (window.prompt('新的会话标题', st.sessionTitle ?? '') ?? '').trim()
        if (!title) return
      }
      void st.renameSession(title)
    },
  },
  {
    name: 'fork',
    description: '派生当前会话（--worktree 在隔离 git worktree 中派生）',
    argHint: '[--worktree|--no-worktree]',
    run: (args) => {
      // TUI parse_fork_args parity: leading flags only; an unknown bareword
      // starts the directive — the FE has no first-prompt channel for a
      // fork, so reject it instead of silently ignoring the text.
      let worktree: boolean | undefined
      let rest = args.trimStart()
      for (;;) {
        const m = rest.match(/^(\S+)\s*([\s\S]*)$/)
        if (!m) break
        const [, flag, after] = m
        if (flag === '--worktree') {
          if (worktree === false) {
            err('--worktree 与 --no-worktree 互斥')
            return
          }
          if (worktree === true) {
            err('--worktree 重复指定')
            return
          }
          worktree = true
        } else if (flag === '--no-worktree') {
          if (worktree === true) {
            err('--worktree 与 --no-worktree 互斥')
            return
          }
          if (worktree === false) {
            err('--no-worktree 重复指定')
            return
          }
          worktree = false
        } else {
          break
        }
        rest = after.trimStart()
      }
      if (rest) {
        err('FE 暂不支持 fork 首条提示；请先 fork，再在新会话中发送该内容')
        return
      }
      void useChatStore.getState().forkSession(worktree === undefined ? {} : { worktree })
    },
  },
  {
    name: 'recap',
    description: '生成「我在哪」摘要',
    run: () => void useChatStore.getState().requestRecap(),
  },
  {
    name: 'btw',
    description: '旁路提问：不打断当前回合，答案以独立区块展示',
    argHint: '<question>',
    run: (args) => {
      const q = args.trim()
      if (!q) {
        err('用法: /btw <问题>，例如 /btw 这个改动会影响哪些文件')
        return
      }
      // 与 /loop 不同：busy 中也必须立即发出（旁路问题不占 prompt 队列、
      // 不排队）——走 store 的 askBtw 直发 x.ai/btw。
      void useChatStore.getState().askBtw(q)
    },
  },
  {
    name: 'search',
    aliases: ['find', 'grep'],
    description: '搜索工作区文件内容（结果按文件分组，复制 路径:行号）',
    argHint: '[pattern]',
    run: (args) => {
      // With args: open the modal mid-search on the pattern (TUI /search).
      useChatStore.getState().openContentSearch(args.trim())
    },
  },
  {
    name: 'session-info',
    description: '查看当前会话信息（弹窗：ID/模型/上下文/回合等）',
    run: () => void useChatStore.getState().openSessionInfo(),
  },
  {
    name: 'context',
    description: '查看上下文明细（占比/分类/估算）',
    run: () => void useChatStore.getState().openContext(),
  },
  {
    name: 'loop',
    description: '创建定时任务',
    argHint: '[interval] <prompt>',
    run: (args) => {
      const trimmed = args.trim()
      const { interval, promptText } = parseLoopArgs(trimmed)
      if (!promptText) {
        err('用法: /loop [间隔] [提示词...]，例如 /loop 5m 检查测试状态；不写间隔时 agent 会询问运行频率')
        return
      }
      // 原文透传（TUI PROMPT_COMMANDS 通道）：shell 收到以 /loop 开头的
      // prompt 会拦截并展开成 loop_schedule_instruction（scheduler gate
      // 通过时），fire mode 由 host 决定。与 agent 广播命令的 pass-through
      // run 一致——busy 时由 sendPrompt 走 prompt 队列。
      note(
        interval
          ? `已请求定时任务：每 ${loopIntervalToHuman(interval)} · ${promptText}（实际调度以 agent 创建的 scheduler_create 为准）`
          : `已请求定时任务：调度中… · ${promptText}（agent 会确认运行频率并创建 scheduler_create）`,
      )
      sendPrompt(`/loop ${trimmed}`)
    },
  },
  // ── /imagine（TUI slash/commands/imagine.rs 语义移植）─────────────
  // shell 把 imagine / imagine-video 烧成 PAGER_COMMAND_KEYS 保留名
  // （xai-grok-shell slash_commands.rs:487-597），agent 不广播、同名
  // skill 也占用不了——只能本地实现。指令文本复刻自 xai-grok-tools-api
  // 的 imagine_instruction / imagine_video_instruction（见 imagine.ts，
  // agent 侧改名需同步）。TUI 效果：显示文本是用户敲的
  // `/imagine <描述>`，发给模型的是指令块——send 的 text/blocks 分离
  // 与 InjectSkill 的 display_text/prompt_blocks 同构。工具可用性由
  // agent 侧决定（无 image_gen 或档位受限时 agent 会直接说明）。
  {
    name: 'imagine',
    description: '根据文字描述生成图片',
    argHint: '<description>',
    run: (args) => {
      const prompt = args.trim()
      if (!prompt) {
        note(imagineUsageMessage())
        return
      }
      sendPrompt(`/imagine ${prompt}`, [
        { type: 'text', text: imagineInstruction(prompt) },
      ])
    },
  },
  {
    name: 'imagine-video',
    description: '根据文字描述生成视频（从一张源图开始）',
    argHint: '<description>',
    run: (args) => {
      const prompt = args.trim()
      if (!prompt) {
        note(imagineVideoUsageMessage())
        return
      }
      sendPrompt(`/imagine-video ${prompt}`, [
        { type: 'text', text: imagineVideoInstruction(prompt) },
      ])
    },
  },
  {
    name: 'plan',
    description: '进入计划模式（已进入时提示用 /view-plan，Shift+Tab 退出）',
    run: () => {
      const st = useChatStore.getState()
      // TUI dispatch_enter_plan_mode parity: re-running /plan while
      // already in plan (incl. the plan·auto / plan·always overlays) is
      // a no-op with a "use /view-plan" toast — the flag check mirrors
      // store togglePlanMode's own guard.
      if (st.planMode === true || st.permissionMode === 'plan') {
        status('已在 plan 模式，用 /view-plan 查看当前 plan')
        return
      }
      void st.togglePlanMode()
    },
  },
  {
    name: 'view-plan',
    aliases: ['show-plan', 'plan-view'],
    description: '查看当前会话的 plan 正文（弹窗）',
    run: () => {
      const st = useChatStore.getState()
      if (!st.sessionId) {
        err('查看失败: 无活动会话')
        return
      }
      // 弹窗自己按优先级取正文（host plan.md → 待应答审批请求 → 滚动区
      // exit_plan_mode 工具输出），都没有才显示空态/任务清单兜底；这里不
      // 预设「有没有 plan」的判断——TUI 也是先打开预览再报 no plan。
      st.openPlanViewer()
    },
  },
  {
    name: 'copy',
    description: '复制最近一条助手回复到剪贴板',
    run: async () => {
      const st = useChatStore.getState()
      const last = [...st.entries]
        .reverse()
        .find((e) => e.kind === 'assistant' && !!e.text.trim())
      if (!last || last.kind !== 'assistant') {
        err('没有可复制的助手回复')
        return
      }
      try {
        await navigator.clipboard.writeText(last.text)
        status('已复制最近一条回复到剪贴板')
      } catch (e) {
        status(`复制失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  },
  {
    name: 'export',
    description: '导出当前会话为 Markdown（无参数复制到剪贴板，带文件名下载）',
    argHint: '[filename]',
    run: async (args) => {
      const st = useChatStore.getState()
      if (!st.sessionId) {
        err('没有可导出的会话')
        return
      }
      // FE 历史是分页加载的：只导出已加载部分，文件头/末尾如实标注
      // 可能还有未上翻加载的更早历史（TUI 服务端全量 transcript 在
      // Web 端不可得，host 亦无 export 端点——纯前端实现）。
      const md = renderTranscript(
        st.entries,
        {
          sessionId: st.sessionId,
          cwd: st.cwd,
          title: st.sessionTitle,
          modelName: st.modelName,
          historyLoadedStart: st.historyLoadedStart,
          historyHasMore: st.historyHasMore,
        },
        st.liveStream,
      )
      if (!md) {
        err('没有可导出的对话内容')
        return
      }
      const filename = args.trim()
      if (!filename) {
        try {
          await navigator.clipboard.writeText(md)
          status('已复制会话转录到剪贴板')
        } catch (e) {
          status(`复制失败: ${e instanceof Error ? e.message : String(e)}`)
        }
        return
      }
      try {
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = safeExportFilename(filename)
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        status(`已导出为 ${a.download}（${fmtBytes(blob.size)}）`)
      } catch (e) {
        status(`导出失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  },
  {
    name: 'timestamps',
    description: '切换滚动区时间戳显示',
    run: () => useChatStore.getState().toggleTimestamps(),
  },
  {
    name: 'multiline',
    description: '切换多行输入（on: Enter 换行、Shift+Enter 发送）',
    run: (args) => {
      const a = args.trim().toLowerCase()
      const next = a === 'on' ? true : a === 'off' ? false : !isMultilineEnabled()
      setMultilineEnabled(next)
      status(
        next
          ? 'multiline: 开（Enter 换行，Shift+Enter 发送）'
          : 'multiline: 关（Enter 发送，Shift+Enter 换行）',
      )
    },
  },
  {
    name: 'help',
    description: '显示全部命令',
    run: () => {
      const lines = mergedSlashCommands().map((c) => {
        const names = [c.name, ...(c.aliases ?? [])]
          .map((n) => `/${n}`)
          .join(' / ')
        return `${names}${c.argHint ? ` ${c.argHint}` : ''} — ${c.description}`
      })
      note(`可用命令:\n${lines.join('\n')}`)
    },
  },
  // ── 模式 / 权限（Shift+Tab 循环的斜杠入口）────────────────────────
  {
    name: 'always',
    aliases: ['always-approve'],
    description: '切换始终允许模式（再执行关闭；plan 下叠加为 plan·always）',
    run: () => void useChatStore.getState().setAlwaysApproveMode(),
  },
  {
    name: 'auto',
    description: '切换自动模式（再执行关闭；plan 下叠加为 plan·auto）',
    run: () => void useChatStore.getState().setAutoMode(),
  },
  {
    name: 'permissions-reset',
    description: '重置已记忆的权限规则',
    run: () => void useChatStore.getState().resetPermissions(),
  },
  {
    name: 'goal',
    description: '设置 / 查看 / 管理自主目标',
    argHint: '[objective | status|pause|resume|clear]',
    run: (args) => {
      const st = useChatStore.getState()
      const a = args.trim()
      if (!a) {
        // 无参 = status（与真 TUI 一致：/goal 无参查询当前目标状态）。
        st.goalStatus()
        return
      }
      const lower = a.toLowerCase()
      if (lower === 'status') {
        st.goalStatus()
        return
      }
      if (lower === 'pause') {
        st.goalPause()
        return
      }
      if (lower === 'resume') {
        st.goalResume()
        return
      }
      if (lower === 'clear') {
        st.goalClear()
        return
      }
      // 其余按目标描述处理: `<objective> [--budget <tokens>]`。budget 是
      // token 预算，由 host 的 goal 引擎强制执行（剥离后单独传参，不再
      // 拼进描述文字）。
      const budgetMatch = a.match(/--budget\s+([\d.]+[kKmM]?)/i)
      const objective = budgetMatch ? a.slice(0, budgetMatch.index).trim() : a
      if (!objective) {
        err(
          '用法: /goal <目标描述> [--budget <tokens>] 或 /goal status|pause|resume|clear',
        )
        return
      }
      const budget = budgetMatch ? parseBudgetTokens(budgetMatch[1]) : undefined
      void st.goalSet(objective, budget)
    },
  },
  // ── workflow（TUI /workflow 单数 + /workflows 复数语义）──────────────
  {
    name: 'workflow',
    description: '启动已保存的 workflow、查看运行列表、管理运行（pause/resume/stop/save）',
    argHint: '<名称> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [名称]',
    run: (args) => {
      const trimmed = args.trim()
      // `/workflow runs`：精确 op（大小写不敏感，TUI workflow.rs run）→
      // 打开运行面板。带附加参数时不拦截（shell 当作名为 runs 的 launch）。
      if (trimmed.toLowerCase() === 'runs') {
        useChatStore.getState().setWorkflowPanelOpen(true)
        return
      }
      const tokens = trimmed.split(/\s+/).filter(Boolean)
      const [first, second] = tokens
      const firstOp = first && WORKFLOW_MANAGE_OPS.has(first.toLowerCase())
        ? (first.toLowerCase() as WorkflowManageOp)
        : undefined
      if (firstOp) {
        // op 前置：run handle 取整段剩余文本（shell 的 run_id 允许空格）。
        runWorkflowControl(firstOp, tokens.slice(1).join(' '))
        return
      }
      // 倒序形式 `/workflow <run> pause`（shell second_is_final_op，必须
      // 恰好两个 token，否则仍是 launch）。
      if (tokens.length === 2 && second && WORKFLOW_MANAGE_OPS.has(second.toLowerCase())) {
        runWorkflowControl(second.toLowerCase() as WorkflowManageOp, first)
        return
      }
      // launch 与裸调用（文本概览由 shell 给）：原样透传，与 TUI
      // PassThrough("/workflow [args]") 一致；busy 时 sendPrompt 进队列。
      sendPrompt(trimmed ? `/workflow ${trimmed}` : '/workflow')
    },
  },
  {
    name: 'workflows',
    description: '浏览已安装的 workflow 目录',
    run: () => openExtensionsCmd('workflows'),
  },
  // ── memory system (TUI /memory /flush /dream /remember) ────────────
  {
    name: 'memory',
    aliases: ['mem'],
    description: '浏览/管理记忆（on|off 开关记忆）',
    argHint: '[on|off]',
    run: (args) => {
      const a = args.trim().toLowerCase()
      if (a === 'on' || a === 'off') {
        // 走 session 内置 slash 通道：human prompt 以 / 开头时由 agent
        // 侧解析为 BuiltinAction::MemoryToggle（与 TUI 键入 /memory on
        // 同路径），无需 ext 端点。
        sendPrompt(`/memory ${a}`)
        return
      }
      // No args → browse modal (cached memory_files list, read-only).
      useChatStore.getState().openMemory()
    },
  },
  {
    name: 'flush',
    description: '立即保存当前会话知识到记忆',
    run: () => void useChatStore.getState().memoryFlush(),
  },
  {
    name: 'dream',
    description: '执行记忆整合（consolidation）',
    run: () => {
      // 走 session 内置 /dream slash 命令（BuiltinAction::Dream →
      // run_dream_slash_command）。memory ext 只暴露 flush/rewrite，没有
      // consolidation 端点——发字面命令与 TUI 键入 /dream 同路径。
      sendPrompt('/dream')
    },
  },
  {
    name: 'remember',
    description: '记一条笔记到记忆',
    argHint: '[note]',
    run: (args) => {
      const note = args.trim()
      if (!note) {
        err('用法: /remember <笔记内容>，例如 /remember 暂存部署使用 eu-west 集群')
        return
      }
      // POST /api/memory-rewrite → _x.ai/memory/rewrite：LLM 改写不落盘
      // （host 无保存端点，TUI 的落盘是本地文件写入），结果作为滚动区
      // 反馈呈现。
      void useChatStore.getState().rememberNote(note)
    },
  },
  // ── MCP 管理（TUI /mcps）────────────────────────────────────────────
  {
    name: 'mcps',
    description: 'MCP 服务器管理（列表/增删/启停/认证）',
    run: () => mcpPanelOpener?.(),
  },
  // ── 扩展模态（TUI /hooks /plugins /skills /marketplace）─────────────
  {
    name: 'hooks',
    description: '打开扩展面板 — Hooks',
    run: () => openExtensionsCmd('hooks'),
  },
  {
    name: 'plugins',
    description: '打开扩展面板 — Plugins',
    run: () => openExtensionsCmd('plugins'),
  },
  {
    name: 'skills',
    description: '打开扩展面板 — Skills',
    run: () => openExtensionsCmd('skills'),
  },
  {
    name: 'marketplace',
    description: '打开扩展面板 — Marketplace',
    run: () => openExtensionsCmd('marketplace'),
  },
  // ── 设置（TUI F2 / /settings）───────────────────────────────────────
  {
    name: 'settings',
    aliases: ['config', 'preferences', 'prefs'],
    description: '打开设置',
    run: () => useChatStore.getState().openSettings(),
  },
]

/**
 * Merge the local registry with the agent's advertised commands (TUI
 * `CommandRegistry::apply_acp_commands`, slash/registry.rs):
 *   - local commands always win — an agent name colliding with a local
 *     name OR alias (case-insensitive) is skipped entirely;
 *   - agent commands append after the local list (advertisement order,
 *     duplicates within the agent list dropped);
 *   - an agent command's `run` sends the raw `/name args` line as a
 *     USER MESSAGE (TUI `AcpSlashCommand::run` → `PassThrough` →
 *     `enqueue_prompt_with_skill_tokens`); while a turn is running it
 *     goes through the existing queue (same as any prompt).
 */
export function mergedSlashCommands(
  agentCommandsOverride?: AgentCommand[],
): SlashCommand[] {
  const agentCommands = agentCommandsOverride ?? useChatStore.getState().agentCommands
  const claimed = new Set<string>()
  for (const c of slashCommands) {
    claimed.add(c.name.toLowerCase())
    for (const a of c.aliases ?? []) claimed.add(a.toLowerCase())
  }
  const out: SlashCommand[] = [...slashCommands]
  for (const ac of agentCommands) {
    const name = ac.name.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (claimed.has(key)) continue // local wins (TUI skips colliding ACP names)
    claimed.add(key)
    out.push({
      name,
      description: ac.description || name,
      argHint: ac.argHint,
      source: 'agent',
      // TUI semantics: the raw `/name args` line is passed through to the
      // agent as a user prompt — the agent parses the slash command itself.
      run: (args) => {
        const trimmed = args.trim()
        sendPrompt(trimmed ? `/${name} ${trimmed}` : `/${name}`)
      },
    })
  }
  // Skills sink below the commands (TUI slash/mod.rs MenuGroup: Command <
  // BundledSkill < OtherSkill — "there can be far more of them than fit on
  // screen"). Invoked the same way as agent commands: the `/name args`
  // line goes to the agent as a prompt. If the agent already advertises a
  // skill as an ACP command, that entry wins (claimed-dedupe).
  for (const sk of cachedSkills()) {
    const name = (sk?.name ?? '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (claimed.has(key)) continue
    claimed.add(key)
    out.push({
      name,
      description:
        sk.enabled === false
          ? `技能（${sk.scope || 'skill'}，已停用）`
          : `技能${sk.scope ? ` · ${sk.scope}` : ''}`,
      source: 'skill',
      run: (args) => {
        const trimmed = args.trim()
        sendPrompt(trimmed ? `/${name} ${trimmed}` : `/${name}`)
      },
    })
  }
  return out
}

/**
 * Parse "/name args" — exact match on name/aliases (case-insensitive),
 * over the merged local + agent command list.
 * Returns null for "/" alone and for unknown commands (the caller appends
 * an error row and never sends).
 */
export function matchSlash(
  input: string,
): { cmd: SlashCommand; args: string } | null {
  const t = input.trimStart()
  if (!t.startsWith('/')) return null
  const body = t.slice(1)
  const sp = body.search(/\s/)
  const name = (sp === -1 ? body : body.slice(0, sp)).toLowerCase()
  if (!name) return null
  const args = sp === -1 ? '' : body.slice(sp).trim()
  const cmd = mergedSlashCommands().find(
    (c) => c.name === name || (c.aliases ?? []).includes(name),
  )
  return cmd ? { cmd, args } : null
}

/**
 * Fuzzy filter for the slash menu: substring over name+aliases+description,
 * ranked (name prefix < name contains < alias prefix < alias contains <
 * description). Stable by command name within a rank. Considers the merged
 * local + agent command list. The agent list is passed in explicitly when
 * the caller subscribes to it (so the memo recomputes when it changes).
 */
export function filterSlashCommands(
  input: string,
  agentCommands?: AgentCommand[],
): SlashMatch[] {
  const q = input.slice(1).split(/\s/)[0].trim().toLowerCase()
  const commands = mergedSlashCommands(agentCommands)
  if (!q) {
    // TUI bare-`/` menu key (slash/mod.rs MenuKey): group first (commands
    // < skills), then recency (commands only — "nothing ranks skills"),
    // then name. Stable sort with the list index as the final tiebreak so
    // never-used commands keep their registry order.
    const now = Date.now()
    return commands
      .map((cmd, idx) => ({ cmd, idx }))
      .sort((a, b) => {
        const aSkill = a.cmd.source === 'skill' ? 1 : 0
        const bSkill = b.cmd.source === 'skill' ? 1 : 0
        if (aSkill !== bSkill) return aSkill - bSkill
        if (aSkill === 0) {
          const ra = slashRecencyScore(a.cmd.name, now)
          const rb = slashRecencyScore(b.cmd.name, now)
          if (ra !== rb) return rb - ra
        } else {
          const na = a.cmd.name.localeCompare(b.cmd.name)
          if (na !== 0) return na
        }
        return a.idx - b.idx
      })
      .map(({ cmd }) => ({ cmd, score: 0 }))
  }
  const out: SlashMatch[] = []
  for (const cmd of commands) {
    const name = cmd.name
    const aliases = cmd.aliases ?? []
    if (
      !`${name} ${aliases.join(' ')} ${cmd.description}`
        .toLowerCase()
        .includes(q)
    ) {
      continue
    }
    let score: number
    if (name.startsWith(q)) score = 0
    else if (name.includes(q)) score = 1
    else if (aliases.some((a) => a.startsWith(q))) score = 2
    else if (aliases.some((a) => a.includes(q))) score = 3
    else score = 4
    out.push({ cmd, score })
  }
  // Ranked matches: score first, then recency (TUI fuzzy sort puts MRU
  // right after the match score), then name.
  const now = Date.now()
  out.sort(
    (a, b) =>
      a.score - b.score ||
      slashRecencyScore(b.cmd.name, now) - slashRecencyScore(a.cmd.name, now) ||
      a.cmd.name.localeCompare(b.cmd.name),
  )
  return out
}
