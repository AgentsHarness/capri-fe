import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useChatStore } from '../../store/chat'
import { transport } from '../../api/client'
import {
  filterSlashCommands,
  matchSlash,
  type SlashCommand,
} from '../../commands/registry'
import { bumpSlashRecency } from '../../commands/recency'
import { setCachedSkills } from '../../commands/skills'

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
 */
export function useSlashMenu(opts: SlashMenuOpts) {
  const { text, setText, taRef, composerChromeRef, shellMode, clearChips } = opts
  const [slashSel, setSlashSel] = useState(0)
  /** Menu dismissed (Esc / click outside); re-arms when input clears. */
  const [slashDismissed, setSlashDismissed] = useState(false)

  const slashOpen =
    !shellMode &&
    !slashDismissed &&
    text.startsWith('/') &&
    !text.slice(1).includes(' ')
  // Agent-advertised commands (ACP available_commands_update) feed the
  // menu — subscribed here so the list refreshes when they arrive.
  const agentCommands = useChatStore((s) => s.agentCommands)
  // Skills join the menu below the commands (TUI 1.0.9 grouping). The
  // extension list is fetched once per mount; the tick forces the memo
  // to recompute after the module-wide cache updates.
  const [skillsTick, setSkillsTick] = useState(0)
  useEffect(() => {
    let alive = true
    void transport
      .extensions()
      .then((d) => {
        if (!alive) return
        setCachedSkills(Array.isArray(d?.skills) ? d.skills : [])
        setSkillsTick((t) => t + 1)
      })
      .catch(() => {
        /* offline / no host — menu runs without skills */
      })
    return () => {
      alive = false
    }
  }, [])
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
   * Enter on a `/…` line: matched → execute; unknown → error row, the
   * input stays for editing and is NEVER sent to the agent (TUI).
   */
  const runSlashLine = async (input: string) => {
    const m = matchSlash(input)
    if (m) {
      await runSlashCommand(m.cmd, m.args)
      return
    }
    useChatStore.getState().appendLocalEntry({
      kind: 'error',
      text: `未知命令: ${input.split(/\s+/)[0]}。输入 /help 查看可用命令`,
    })
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
    slashSel,
    setSlashSel,
    slashSelClamped,
    slashList,
    slashMatches,
    runSlashCommand,
    runSlashLine,
    setSlashDismissed,
  }
}
