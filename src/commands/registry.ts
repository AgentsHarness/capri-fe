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
import type { AgentCommand } from '../api/types'
import { slashRecencyScore } from './recency'
import { cachedSkills } from './skills'

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

/** /hooks /plugins /skills /marketplace — extensions modal on its tab. */
function openExtensionsCmd(tab: ExtensionsTab) {
  useChatStore.getState().openExtensions(tab)
}

/**
 * Send a prompt to the agent now, or queue it while a turn is running
 * (TUI mid-turn queue semantics — same as /loop).
 */
function sendPrompt(text: string) {
  const st = useChatStore.getState()
  if (st.conn === 'busy') {
    // Tag with the active session so the queue never drains into another.
    usePromptQueue.getState().enqueue(
      {
        text,
        blocks: [{ type: 'text', text }],
      },
      st.sessionId ?? '',
    )
    return
  }
  void st.send(text)
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
    argHint: '[interval] [prompt...]',
    run: (args) => {
      const sp = args.search(/\s/)
      const interval = (sp === -1 ? args : args.slice(0, sp)).trim()
      const promptText = (sp === -1 ? '' : args.slice(sp + 1)).trim()
      if (!interval || !promptText) {
        err('用法: /loop [间隔] [提示词...]，例如 /loop 5m 检查测试状态')
        return
      }
      // The FE cannot call agent tools directly — the interval is passed
      // through verbatim and the agent creates the scheduler task.
      const text = `请创建一个定时任务（用 scheduler_create 工具）：每 ${interval} 执行一次：${promptText}`
      const st = useChatStore.getState()
      if (st.conn === 'busy') {
        // Mid-turn: queue like any Enter prompt; auto-sends at turn end.
        // Tag with the active session so it never drains into another.
        usePromptQueue.getState().enqueue(
          {
            text,
            blocks: [{ type: 'text', text }],
          },
          st.sessionId ?? '',
        )
        return
      }
      void st.send(text)
    },
  },
  {
    name: 'plan',
    description: '进入计划模式（plan 中再次执行无效，Shift+Tab 退出）',
    run: () => void useChatStore.getState().togglePlanMode(),
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
  {
    name: 'workflows',
    description: '打开工作流运行面板',
    run: () => useChatStore.getState().setWorkflowPanelOpen(true),
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
        // No wire toggle for memory in the web FE — route through the
        // agent prompt path (architecture limitation: the FE cannot call
        // agent tools directly).
        sendPrompt(a === 'on' ? '请开启记忆' : '请关闭记忆')
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
      // No wire method for consolidation — prompt-path only (see /memory).
      // The host's /api/memory-rewrite endpoint exists for a future direct
      // call; the FE currently cannot invoke it meaningfully.
      sendPrompt('请执行记忆整合（memory consolidation）')
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
      sendPrompt(`请记住：${note}（写入记忆）`)
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
