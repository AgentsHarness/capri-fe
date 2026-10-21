/**
 * Bash-highlight a run-entry command (the `$` line above stdout).
 *
 * highlight.js 的 bash 语法只给引号、注释、变量、数字、heredoc 划界，
 * 外部命令（git、pnpm）和 flag 都是无 scope 的纯文本。这里在那些 span
 * 之外再扫一遍：命令位上的词、子命令、flag、运算符、路径。
 * 关键字和内建只在命令位上色，避免 `echo done`、`pnpm test` 把参数涂成语法词。
 * span 拼回去必须等于原文，对不上就整段退回纯文本。
 */

import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'

hljs.registerLanguage('bash', bash)

export type CommandTone =
  | 'keyword'
  | 'builtin'
  | 'command'
  | 'flag'
  | 'operator'
  | 'path'
  | 'string'
  | 'comment'
  | 'number'
  | 'variable'

export type CommandSpan = {
  text: string
  tone?: CommandTone
}

/** 只保留 highlight.js 真正按上下文划出的 scope。keyword / built_in 会命中参数位。 */
const SCOPE_TONE: Record<string, CommandTone> = {
  string: 'string',
  regexp: 'string',
  comment: 'comment',
  number: 'number',
  variable: 'variable',
}

function wordList(key: string): string[] {
  const keywords = hljs.getLanguage('bash')?.keywords
  if (!keywords || typeof keywords !== 'object' || Array.isArray(keywords)) return []
  const list = (keywords as Record<string, unknown>)[key]
  return Array.isArray(list) ? list.filter((w): w is string => typeof w === 'string') : []
}

const KEYWORDS = new Set(wordList('keyword'))
const LITERALS = new Set(wordList('literal'))
const BUILTINS = new Set(wordList('built_in'))

/** 这些词后面还是一条命令，而不是参数。 */
const TAKES_COMMAND = new Set(['sudo', 'command', 'exec', 'env', 'nohup', 'builtin', 'nice', 'eval'])
/** 关键字后面立刻是命令或命令列表。 */
const OPENS_COMMAND = new Set(['if', 'elif', 'while', 'until', 'then', 'else', 'do', 'time', 'coproc'])

const TWO_CHAR_OPS = new Set(['||', '&&', ';;', '>>', '<<', '>&', '<&', '>|', '|&', '&>'])
const ONE_CHAR_OPS = new Set(['|', '&', ';', '<', '>', '(', ')', '{', '}'])

type Mode = 'cmd' | 'sub' | 'arg' | 'forVar'

type State = {
  mode: Mode
  /** `for` / `case` 后面的 `in` 才是关键字。 */
  expectIn: boolean
}

type HlNode = string | { scope?: string; children?: HlNode[] }

function toneOf(scope: string | undefined): CommandTone | undefined {
  if (!scope) return undefined
  return SCOPE_TONE[scope.split('.')[0]]
}

function push(out: CommandSpan[], text: string, tone: CommandTone | undefined) {
  if (!text) return
  const prev = out[out.length - 1]
  if (prev && prev.tone === tone) {
    prev.text += text
    return
  }
  out.push(tone ? { text, tone } : { text })
}

function collect(node: HlNode, inherited: CommandTone | undefined, out: CommandSpan[]) {
  if (typeof node === 'string') {
    push(out, node, inherited)
    return
  }
  const tone = toneOf(node.scope) ?? inherited
  for (const child of node.children ?? []) collect(child, tone, out)
}

/** 引号、变量、数字占掉当前这个词的位置。注释不改变命令位。 */
function absorbAtom(tone: CommandTone, state: State) {
  if (tone === 'comment') return
  if (state.mode === 'cmd' || state.mode === 'sub' || state.mode === 'forVar') {
    state.mode = 'arg'
  }
}

function isPath(word: string): boolean {
  return word.includes('/') || word.startsWith('~') || /\.[A-Za-z0-9]+$/.test(word)
}

function classifyWord(word: string, state: State): CommandTone | undefined {
  if (state.mode === 'forVar') {
    state.mode = 'arg'
    state.expectIn = true
    return 'variable'
  }
  if (KEYWORDS.has(word) && state.mode === 'cmd') {
    if (word === 'for') {
      state.mode = 'forVar'
      state.expectIn = true
    } else if (word === 'case') {
      state.mode = 'arg'
      state.expectIn = true
    } else if (OPENS_COMMAND.has(word)) {
      state.mode = 'cmd'
    } else {
      state.mode = 'arg'
    }
    return 'keyword'
  }
  if (word === 'in' && state.expectIn) {
    state.expectIn = false
    state.mode = 'arg'
    return 'keyword'
  }
  if (state.mode === 'cmd') {
    if (BUILTINS.has(word)) {
      state.mode = TAKES_COMMAND.has(word) ? 'cmd' : 'arg'
      return 'builtin'
    }
    if (LITERALS.has(word)) {
      state.mode = 'arg'
      return 'number'
    }
    state.mode = 'sub'
    return 'command'
  }
  if (state.mode === 'sub' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(word)) {
    return 'command'
  }
  if (word.startsWith('-') && word.length > 1) {
    if (state.mode === 'sub') state.mode = 'arg'
    return 'flag'
  }
  if (/^\d+$/.test(word)) return 'number'
  if (isPath(word)) {
    if (state.mode === 'sub') state.mode = 'arg'
    return 'path'
  }
  if (state.mode === 'sub') state.mode = 'arg'
  return undefined
}

function paintOperator(op: string, state: State) {
  if (op === '(' || op === ')' || op === '{' || op === '}') {
    state.mode = 'cmd'
    return
  }
  if (op.startsWith('<') || op.startsWith('>')) {
    state.mode = 'arg'
    return
  }
  // `|` `||` `&&` `;` `&` `;;` `|&`
  state.mode = 'cmd'
}

/** 把 highlight.js 没上色的那一段切成词和运算符。每个字符都要落进某个 span。 */
function paintPlain(text: string, state: State, out: CommandSpan[]) {
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      const ws = text.slice(i, j)
      if (ws.includes('\n')) state.mode = 'cmd'
      push(out, ws, undefined)
      i = j
      continue
    }
    const two = text.slice(i, i + 2)
    if (TWO_CHAR_OPS.has(two)) {
      push(out, two, 'operator')
      paintOperator(two, state)
      i += 2
      continue
    }
    if (ONE_CHAR_OPS.has(c)) {
      push(out, c, 'operator')
      paintOperator(c, state)
      i += 1
      continue
    }
    let j = i + 1
    while (j < text.length && !/\s/.test(text[j]) && !ONE_CHAR_OPS.has(text[j])) j++
    const word = text.slice(i, j)
    const assign = state.mode === 'cmd' ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/.exec(word) : null
    if (assign) {
      push(out, assign[1], 'variable')
      push(out, assign[2], 'operator')
      if (assign[3]) push(out, assign[3], valueTone(assign[3]))
      i = j
      continue
    }
    push(out, word, classifyWord(word, state))
    i = j
  }
}

function valueTone(value: string): CommandTone | undefined {
  if (/^\d+$/.test(value)) return 'number'
  if (isPath(value)) return 'path'
  return undefined
}

function plain(command: string): CommandSpan[] {
  return [{ text: command }]
}

export function highlightCommand(command: string): CommandSpan[] {
  if (!command) return []
  try {
    const result = hljs.highlight(command, { language: 'bash' })
    const root = (result as { _emitter?: { root?: HlNode } })._emitter?.root
    if (!root) return plain(command)
    const pieces: CommandSpan[] = []
    collect(root, undefined, pieces)
    const state: State = { mode: 'cmd', expectIn: false }
    const out: CommandSpan[] = []
    for (const piece of pieces) {
      if (piece.tone) {
        push(out, piece.text, piece.tone)
        absorbAtom(piece.tone, state)
      } else {
        paintPlain(piece.text, state, out)
      }
    }
    if (out.map((s) => s.text).join('') !== command) return plain(command)
    return out
  } catch {
    return plain(command)
  }
}
