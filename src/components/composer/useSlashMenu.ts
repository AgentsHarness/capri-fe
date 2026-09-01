import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useChatStore } from '../../store/chat'
import { transport } from '../../api/client'
import {
  filterSlashCommands,
  isSlashLiteral,
  matchSlash,
  type SlashCommand,
} from '../../commands/registry'
import { bumpSlashRecency } from '../../commands/recency'
import { cachedSkills, setCachedSkills } from '../../commands/skills'

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
}

/**
 * TUI slash commands (`/` prefix) — hook 形态。Menu shows while the
 * command word is being typed (no space yet) and the input starts with
 * "/" — shell mode is mutually exclusive. Busy does NOT suppress it
 * (commands are local actions). 菜单 JSX（SlashMenu）由 Composer 渲染；
 * 键盘路由（textarea onKeyDown）消费本 hook 的选择器与执行器。
 * 例外：`\/…` 与「行首空格 + /…」是原文发送写法（TUI 没有的 FE 逃生口），
 * 菜单不开、Enter 直接当普通 prompt 发送（发送前去掉前缀）。首词不匹配
 * 任何命令的 `/…` 行同样放行（TUI 在这里报错，FE 选择发出去）。
 */
export function useSlashMenu(opts: SlashMenuOpts) {
  const { text, setText, taRef, composerChromeRef, shellMode, clearChips } = opts
  const [slashSel, setSlashSel] = useState(0)
  /** Menu dismissed (Esc / click outside); re-arms when input clears. */
  const [slashDismissed, setSlashDismissed] = useState(false)

  /**
   * 「这行是原文」的显式写法（`\/…` 或行首空白 + `/…`）：菜单不开、
   * Enter 不查命令，发送前把前缀还原掉。
   */
  const slashLiteral = isSlashLiteral(text)

  const slashOpen =
    !shellMode &&
    !slashDismissed &&
    !slashLiteral &&
    text.startsWith('/') &&
    !text.slice(1).includes(' ')
  // Agent-advertised commands (ACP available_commands_update) feed the
  // menu — subscribed here so the list refreshes when they arrive.
  const agentCommands = useChatStore((s) => s.agentCommands)
  // Skills join the menu below the commands (TUI 1.0.9 grouping) and ride a
  // module-wide cache, so a render tick forces the memo to recompute once
  // the cache updates.
  const [skillsTick, setSkillsTick] = useState(0)
  const conn = useChatStore((s) => s.conn)
  const selectedHostId = useChatStore((s) => s.selectedHostId)
  const skillsInflight = useRef(false)

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

  // ① 连接就绪 / 切换 host 后取。Composer 挂载那一帧 conn 还是 'connecting'，
  // 此时 extensions 请求会连同 /settings、/hosts 一起被 abort（transport 在
  // 连接重建时统一取消在途请求），只按 [] 拉一次的话技能就永久缺失。
  useEffect(() => {
    if (conn === 'connecting' || conn === 'offline') return
    refreshSkills()
  }, [conn, selectedHostId, refreshSkills])

  // ② 兜底：菜单打开时缓存还是空的（①那次也失败了），每次开启补拉一次。
  useEffect(() => {
    if (slashOpen && cachedSkills().length === 0) refreshSkills()
  }, [slashOpen, refreshSkills])
  const slashMatches = useMemo(
    () => (slashOpen ? filterSlashCommands(text, agentCommands) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slashOpen, text, agentCommands, skillsTick],
  )
  const slashList = useMemo(
    () => slashMatches.map((m) => m.cmd),
    [slashMatches],
  )
  const slashSelClamped = Math.min(slashSel, Math.max(0, slashList.length - 1))

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

  /**
   * Enter on a `/…` line → what should actually run.
   * - menu up with matches: the highlighted row (TUI semantics, so `/clea`
   *   still executes `/clear` — that is the typo guard);
   * - otherwise: exact name/alias match on the typed line;
   * - neither → null: the line is NOT a command and the caller sends it to
   *   the agent as a plain prompt (FE 放行；TUI 在这里会追加错误行).
   */
  const resolveSlashLine = (
    input: string,
  ): { cmd: SlashCommand; args: string } | null => {
    if (slashOpen && slashList.length > 0) {
      return { cmd: slashList[slashSelClamped], args: '' }
    }
    return matchSlash(input)
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
    slashSel,
    setSlashSel,
    slashSelClamped,
    slashList,
    slashMatches,
    runSlashCommand,
    resolveSlashLine,
    setSlashDismissed,
  }
}
