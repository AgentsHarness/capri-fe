/**
 * ── TUI slash command port (/help, /model, /theme, …) ─────────────────
 * The TUI's `/<command> [args]` system: input starting with "/" opens a
 * fuzzy command menu (SlashMenu); a full `/name args` line Enter also
 * executes. Commands run LOCALLY against existing store / transport
 * capabilities — an unknown command appends an error row and is NEVER
 * sent to the agent (TUI semantics).
 */
import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { THEMES, useThemeStore } from '../store/theme'
import type { ThemeId } from '../theme/tokens'
import { transport } from '../api/localTransport'

export type SlashCommand = {
  name: string
  aliases?: string[]
  description: string
  argHint?: string
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

/**
 * Composer registers its model-menu opener here so `/model` with no args
 * can open the exact same menu the model caption button uses.
 */
let modelMenuOpener: (() => void) | null = null
export function registerModelMenuOpener(fn: (() => void) | null): void {
  modelMenuOpener = fn
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

/** /plan & /normal share the host /api/set-mode call. */
async function setModeCmd(modeId: string) {
  try {
    await transport.setMode(modeId)
    status(`已切换到 ${modeId} 模式`)
  } catch (e) {
    err(`切换模式失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

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
    description: '派生当前会话',
    run: () => void useChatStore.getState().forkSession(),
  },
  {
    name: 'recap',
    description: '生成「我在哪」摘要',
    run: () => void useChatStore.getState().requestRecap(),
  },
  {
    name: 'session-info',
    description: '查看当前会话信息',
    run: () => useChatStore.getState().openSessionInfo(),
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
        usePromptQueue.getState().enqueue({
          text,
          blocks: [{ type: 'text', text }],
        })
        return
      }
      void st.send(text)
    },
  },
  {
    name: 'plan',
    description: '切换到计划模式',
    run: () => void setModeCmd('plan'),
  },
  {
    name: 'normal',
    description: '切换到普通模式',
    run: () => void setModeCmd('normal'),
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
    name: 'help',
    description: '显示全部命令',
    run: () => {
      const lines = slashCommands.map((c) => {
        const names = [c.name, ...(c.aliases ?? [])]
          .map((n) => `/${n}`)
          .join(' / ')
        return `${names}${c.argHint ? ` ${c.argHint}` : ''} — ${c.description}`
      })
      note(`可用命令:\n${lines.join('\n')}`)
    },
  },
  // ── 模式 / 权限（Shift+Tab 循环的斜杠入口）────────────────────────
  // NOTE: 数组头部已有同名 /plan（走 set-mode）；此条目优先走
  // toggle-plan-mode，但 typed 输入由 matchSlash 命中首个条目，因此
  // 该入口实际由 Shift+Tab 与 store.togglePlanMode 使用。保留两版。
  {
    name: 'plan',
    description: '切换到计划模式（toggle-plan-mode）',
    run: () => void useChatStore.getState().togglePlanMode(),
  },
  {
    name: 'always-approve',
    description: '切换到始终允许模式',
    run: () => void useChatStore.getState().setAlwaysApproveMode(),
  },
  {
    name: 'auto',
    description: '切换到自动模式',
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
        // 无参 → 打开目标详情面板（与 GoalChip 点击共用同一面板）。
        if (!st.goalState) {
          err('/goal: 暂无目标状态（goal_updated 事件尚未到达）')
          return
        }
        st.setGoalPanelOpen(true)
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
      // 其余按目标描述处理: `<objective> [--budget <tokens>]` — budget
      // 从描述中剥离后随提示词路径一并传达（协议无 goal 控制 wire 方法，
      // 全部经由 update_goal 工具的提示词路径，见 chat.ts goalSet）。
      const budgetMatch = a.match(/--budget\s+([\d.]+[kKmM]?)/i)
      const objective = budgetMatch ? a.slice(0, budgetMatch.index).trim() : a
      if (!objective) {
        err(
          '用法: /goal <目标描述> [--budget <tokens>] 或 /goal status|pause|resume|clear',
        )
        return
      }
      const budgetNote = budgetMatch ? `，token 预算 ${budgetMatch[1]}` : ''
      st.goalSet(`${objective}${budgetNote}`)
    },
  },
  {
    name: 'workflows',
    description: '打开工作流运行面板',
    run: () => useChatStore.getState().setWorkflowPanelOpen(true),
  },
]

/**
 * Parse "/name args" — exact match on name/aliases (case-insensitive).
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
  const cmd = slashCommands.find(
    (c) => c.name === name || (c.aliases ?? []).includes(name),
  )
  return cmd ? { cmd, args } : null
}

/**
 * Fuzzy filter for the slash menu: substring over name+aliases+description,
 * ranked (name prefix < name contains < alias prefix < alias contains <
 * description). Stable by command name within a rank.
 */
export function filterSlashCommands(input: string): SlashMatch[] {
  const q = input.slice(1).split(/\s/)[0].trim().toLowerCase()
  if (!q) return slashCommands.map((cmd) => ({ cmd, score: 0 }))
  const out: SlashMatch[] = []
  for (const cmd of slashCommands) {
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
  out.sort(
    (a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name),
  )
  return out
}
