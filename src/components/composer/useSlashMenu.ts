import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useChatStore } from '../../store/chat'
import { transport } from '../../api/client'
import {
  filterSlashArgs,
  filterSlashCommands,
  isSlashInvocationComplete,
  isSlashLiteral,
  matchSlash,
  parseSlashLine,
  slashCommandInsertText,
  type SlashCommand,
} from '../../commands/registry'
import { bumpSlashRecency } from '../../commands/recency'
import { cachedSkills, setCachedSkills } from '../../commands/skills'
import { cachedWorkflows, setCachedWorkflows } from '../../commands/workflows'

type SlashMenuOpts = {
  /** 当前草稿文本（菜单是否打开、命令过滤的输入源）。 */
  text: string
  setText: (updater: string | ((t: string) => string)) => void
  taRef: RefObject<HTMLTextAreaElement | null>
  /** Composer chrome 外点关闭判定用。 */
  composerChromeRef: RefObject<HTMLDivElement | null>
  /** shell 模式与斜杠菜单互斥。 */
  shellMode: boolean
  /** 执行命令后是否清空 chips（@/chip 域的缓冲联动）。 */
  clearChips: () => void
  /** 程序性改写文本后的光标落点（接受补全用）。 */
  setPendingCaret: (pos: number) => void
}

/** 下拉当前处于哪一层：命令词本身，还是它的参数。 */
export type SlashPhase = 'command' | 'args'

/**
 * TUI slash commands (`/` prefix) — hook 形态。两层下拉对齐 TUI slash 模块：
 * 命令阶段（输入还没敲到分隔符）过滤命令；分隔符之后若该命令声明了
 * `suggestArgs`，下拉换成参数阶段（TUI `SlashCommand::suggest_args`）。命令行
 * 的插入文本对 takes-args 的命令带尾空格，所以接受它是补全而不是执行 ——
 * `/effort` + Enter 因此先展开成 `/effort ` 并列出强度档，不再回一条「用法」
 * 错误（TUI `is_command_complete` / `is_typed_slash_selected` 同一套判定）。
 *
 * 菜单 JSX（SlashMenu）由 Composer 渲染；键盘路由消费本 hook 的 `slashEnter`
 * （Enter）与 `acceptSelected`（Tab / 鼠标）。例外不变：`\/…` 与「行首空格 +
 * /…」是原文写法（TUI 没有的 FE 逃生口），菜单不开、Enter 直接当普通 prompt
 * 发送；首词不匹配任何命令的 `/…` 行同样放行（TUI 在这里追加错误行）。
 */
export function useSlashMenu(opts: SlashMenuOpts) {
  const {
    text,
    setText,
    taRef,
    composerChromeRef,
    shellMode,
    clearChips,
    setPendingCaret,
  } = opts
  const [slashSel, setSlashSel] = useState(0)
  /** Menu dismissed (Esc / click outside); re-arms when input clears. */
  const [slashDismissed, setSlashDismissed] = useState(false)

  /**
   * 「这行是原文」的显式写法（`\/…` 或行首空白 + `/…`）：菜单不开、
   * Enter 不查命令，发送前把前缀还原掉。
   */
  const slashLiteral = isSlashLiteral(text)

  /** 这一行本身是不是斜杠命令草稿（与菜单是否被关掉无关）。 */
  const slashLine = !shellMode && !slashLiteral && text.startsWith('/')
  const eligible = slashLine && !slashDismissed

  // Agent-advertised commands (ACP available_commands_update) feed the
  // menu — subscribed here so the list refreshes when they arrive.
  const agentCommands = useChatStore((s) => s.agentCommands)
  // Skills and the workflow catalog ride module-wide caches (the filters
  // below are synchronous), so a render tick forces the memos to recompute
  // once a fetch lands.
  const [skillsTick, setSkillsTick] = useState(0)
  const [workflowsTick, setWorkflowsTick] = useState(0)
  const conn = useChatStore((s) => s.conn)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const skillsInflight = useRef(false)
  const workflowsInflight = useRef(false)

  /** 拉一次扩展列表。失败保持静默（菜单照常跑），留给下面两个触发点重试。 */
  const refreshSkills = useCallback(() => {
    if (skillsInflight.current) return
    skillsInflight.current = true
    void transport
      .extensions()
      .then((d) => {
        setCachedSkills(Array.isArray(d?.skills) ? d.skills : [])
        setSkillsTick((t) => t + 1)
      })
      .catch(() => {
        /* offline / no host yet — retried on the next trigger */
      })
      .finally(() => {
        skillsInflight.current = false
      })
  }, [])

  /** x.ai/workflows/list —— 只为 `/workflow` 的参数候选拉，进过那一层才发热。 */
  const refreshWorkflows = useCallback(() => {
    if (workflowsInflight.current) return
    workflowsInflight.current = true
    void transport
      .workflowsList({ sessionId: useChatStore.getState().sessionId ?? undefined })
      .then((d) => {
        setCachedWorkflows(Array.isArray(d?.workflows) ? d.workflows : [])
        setWorkflowsTick((t) => t + 1)
      })
      .catch(() => {
        /* offline / no host — 下一次进参数阶段再试 */
      })
      .finally(() => {
        workflowsInflight.current = false
      })
  }, [])

  // ① 连接就绪 / 切换 host 后取。Composer 挂载那一帧 conn 还是 'connecting'，
  // 此时 extensions 请求会连同 /settings、/hosts 一起被 abort（transport 在
  // 连接重建时统一取消在途请求），只按 [] 拉一次的话技能就永久缺失。
  useEffect(() => {
    if (conn === 'connecting' || conn === 'offline') return
    refreshSkills()
  }, [conn, selectedHostId, refreshSkills])

  // ② 兜底：菜单打开时缓存还是空的（①那次也失败了），每次开启补拉一次。
  useEffect(() => {
    if (eligible && cachedSkills().length === 0) refreshSkills()
  }, [eligible, refreshSkills])

  // ── 两层候选：命令阶段 / 参数阶段 ─────────────────────────────────
  const parts = useMemo(
    () => (eligible ? parseSlashLine(text, agentCommands) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligible, text, agentCommands, skillsTick],
  )
  /** 命令词后已有分隔符，且这条命令声明了参数候选。 */
  const inArgsPhase = !!parts?.cmd.suggestArgs && !parts.inCommand
  const slashMatches = useMemo(
    () =>
      eligible && !inArgsPhase && !text.slice(1).includes(' ')
        ? filterSlashCommands(text, agentCommands)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligible, inArgsPhase, text, agentCommands, skillsTick],
  )
  const slashArgMatches = useMemo(
    () => (eligible && inArgsPhase ? filterSlashArgs(text, agentCommands) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligible, inArgsPhase, text, agentCommands, workflowsTick],
  )
  const phase: SlashPhase = inArgsPhase ? 'args' : 'command'
  const rowCount = inArgsPhase ? slashArgMatches.length : slashMatches.length
  /** 命令阶段零匹配也要开（页脚要说「没有匹配 — Enter 按原文发送」）；
   *  参数阶段没有候选就收起，不打扰继续输入。 */
  const slashOpen = eligible && (inArgsPhase ? slashArgMatches.length > 0 : true)
  const slashSelClamped = Math.min(slashSel, Math.max(0, rowCount - 1))

  useEffect(() => {
    if (inArgsPhase && parts?.cmd.name === 'workflow' && cachedWorkflows().length === 0) {
      refreshWorkflows()
    }
  }, [inArgsPhase, parts, refreshWorkflows])

  /** Execute a slash command (menu pick or typed line) — clears the buffer. */
  const runSlashCommand = async (cmd: SlashCommand, args: string) => {
    // TUI slash MRU: every execution refreshes the recency score that
    // orders the bare `/` menu (slash/mru.rs).
    bumpSlashRecency(cmd.name)
    setSlashDismissed(true)
    setText('')
    clearChips()
    try {
      await cmd.run(args)
    } catch (e) {
      useChatStore.getState().appendLocalEntry({
        kind: 'error',
        text: `/${cmd.name} 执行失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
    taRef.current?.focus()
  }

  /** 把 [start, end) 换成 `insert` 并回传新整行（TUI accept_slash_completion）。 */
  const spliceLine = (start: number, end: number, insert: string): string => {
    const next = text.slice(0, start) + insert + text.slice(end)
    setText(next)
    setSlashSel(0)
    setPendingCaret(next.length)
    return next
  }

  /** 接受当前高亮行：只改写文本、不执行（Tab / 鼠标点击走这条）。 */
  const acceptSelected = (index = slashSelClamped): string | null => {
    if (!slashOpen) return null
    if (inArgsPhase) {
      const row = slashArgMatches[index]
      if (!row || !parts) return null
      return spliceLine(parts.argsStart, text.length, row.arg.insertText)
    }
    const cmd = slashMatches[index]?.cmd
    if (!cmd) return null
    return spliceLine(0, text.length, slashCommandInsertText(cmd))
  }

  /** 整行执行：能解析成命令且参数完备才消费，否则交回 caller 发原文。 */
  const executeLine = (line: string): boolean => {
    const hit = matchSlash(line)
    if (!hit || !isSlashInvocationComplete(line)) return false
    void runSlashCommand(hit.cmd, hit.args)
    return true
  }

  /**
   * Enter on a `/…` line — TUI `agent_view/prompt.rs` 的斜杠下拉分支：
   * - 命令阶段、输入词与高亮命令完全一致且参数完备 → 直接执行；
   * - 其余一律先接受高亮行：插入文本带尾空格 = 进下一层并保持展开
   *   （`/effort ` → 强度档），不带 = 接受完就地执行（`/clea` → `/clear`）；
   * - 菜单被 Esc 关过后 Enter 撞上「参数还没给」的行 → 重新展开菜单，
   *   既不报错也不把命令当原文发给 agent。
   * 返回 false = 本 hook 没消费，caller 按普通 prompt 发送。
   */
  const slashEnter = (index = slashSelClamped): boolean => {
    if (slashOpen && rowCount > 0) {
      const before = text
      if (inArgsPhase) {
        const row = slashArgMatches[index]
        const next = acceptSelected(index)
        if (next == null || !row) return false
        // 参数行的尾空格 = 还要接着输入（`/workflow pause `、`/loop 5m `）。
        if (row.arg.insertText.endsWith(' ')) return true
        return executeLine(next)
      }
      const cmd = slashMatches[index]?.cmd
      if (!cmd) return false
      if (isExactTypedCommand(before, cmd) && isSlashInvocationComplete(before)) {
        void runSlashCommand(cmd, '')
        return true
      }
      const chains = !!cmd.argHint
      const next = acceptSelected(index)
      if (next == null) return false
      if (chains) return true
      return executeLine(next)
    }
    // 命令阶段零匹配：FE 放行（TUI 在这里追加错误行），交回 caller 发送原文。
    if (slashOpen) return false
    if (!slashLine) return false
    // 菜单关着（Esc 过 / 外点掉）：参数还没给 → 补全并重新展开，既不报错
    // 也不把命令当原文发给 agent。命令层的行先补出分隔符再展开。
    const hit = matchSlash(text)
    if (hit && hit.cmd.suggestArgs && !isSlashInvocationComplete(text)) {
      if (parseSlashLine(text, agentCommands)?.inCommand) {
        spliceLine(0, text.length, slashCommandInsertText(hit.cmd))
        setSlashDismissed(false)
        return true
      }
      if (filterSlashArgs(text, agentCommands).length > 0) {
        setSlashDismissed(false)
        return true
      }
    }
    if (hit) {
      void runSlashCommand(hit.cmd, hit.args)
      return true
    }
    return false
  }

  // Re-arm the menu when the input no longer starts with "/" (fresh
  // slash reopens; Esc/click dismissals survive continued typing).
  useEffect(() => {
    if (!text.startsWith('/')) setSlashDismissed(false)
  }, [text])

  // Click outside the composer chrome dismisses the slash menu.
  useEffect(() => {
    if (!slashOpen) return
    const onDown = (e: MouseEvent) => {
      if (
        composerChromeRef.current &&
        !composerChromeRef.current.contains(e.target as Node)
      ) {
        setSlashDismissed(true)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [slashOpen, composerChromeRef])

  return {
    slashOpen,
    slashLiteral,
    slashPhase: phase,
    slashSel,
    setSlashSel,
    slashSelClamped,
    slashRowCount: rowCount,
    slashMatches,
    slashArgMatches,
    /** 参数阶段属于哪条命令（表头显示它的名字）。 */
    slashArgCommand: inArgsPhase ? parts?.cmd : undefined,
    runSlashCommand,
    acceptSelected,
    slashEnter,
    setSlashDismissed,
  }
}

/** 输入的首词是否正好就是这条命令（名字或别名，大小写不敏感）。 */
function isExactTypedCommand(line: string, cmd: SlashCommand): boolean {
  const token = line.slice(1).split(/\s/)[0].toLowerCase()
  return (
    cmd.name.toLowerCase() === token ||
    (cmd.aliases ?? []).some((a) => a.toLowerCase() === token)
  )
}
