import { describe, expect, it } from 'vitest'
import { highlightCommand, type CommandSpan, type CommandTone } from './highlightCommand'

function toneOf(spans: CommandSpan[], text: string): CommandTone | undefined {
  return spans.find((s) => s.text === text)?.tone
}

describe('highlightCommand', () => {
  const src = 'if true; then echo "hi" # note\necho $HOME $((2))'

  it('关键字、内建、字符串、注释、变量、数字各有色调，拼回去等于原文', () => {
    const spans = highlightCommand(src)
    expect(spans.map((s) => s.text).join('')).toBe(src)
    expect(toneOf(spans, 'if')).toBe('keyword')
    expect(toneOf(spans, 'echo')).toBe('builtin')
    expect(toneOf(spans, '"hi"')).toBe('string')
    expect(toneOf(spans, '# note')).toBe('comment')
    expect(toneOf(spans, '$HOME')).toBe('variable')
    expect(toneOf(spans, '2')).toBe('number')
    // `true` / `false` 与数字同一档（常量）
    expect(toneOf(spans, 'true')).toBe('number')
  })

  it('外部命令、子命令、flag、路径、运算符上色', () => {
    const raw = 'git status -s && ls -la /tmp'
    const spans = highlightCommand(raw)
    expect(spans.map((s) => s.text).join('')).toBe(raw)
    expect(toneOf(spans, 'git')).toBe('command')
    expect(toneOf(spans, 'status')).toBe('command')
    expect(toneOf(spans, '-s')).toBe('flag')
    expect(toneOf(spans, '&&')).toBe('operator')
    expect(toneOf(spans, 'ls')).toBe('builtin')
    expect(toneOf(spans, '-la')).toBe('flag')
    expect(toneOf(spans, '/tmp')).toBe('path')
  })

  it('参数位上的 shell 词不上色，--stat 不拆成内建', () => {
    const done = highlightCommand('echo done')
    expect(toneOf(done, 'echo')).toBe('builtin')
    expect(toneOf(done, 'done')).toBeUndefined()

    const test = highlightCommand('pnpm test --watch')
    expect(toneOf(test, 'pnpm')).toBe('command')
    expect(toneOf(test, 'test')).toBe('command')
    expect(toneOf(test, '--watch')).toBe('flag')

    const stat = highlightCommand('git diff --stat')
    expect(toneOf(stat, '--stat')).toBe('flag')
    expect(stat.some((s) => s.text === 'stat' && s.tone === 'builtin')).toBe(false)
  })

  it('heredoc 结束后的下一行命令仍从命令位开始', () => {
    const raw = 'cat <<EOF\nhello\nEOF\ngit status'
    const spans = highlightCommand(raw)
    expect(spans.map((s) => s.text).join('')).toBe(raw)
    expect(spans.find((s) => s.tone === 'string')?.text).toContain('hello')
    expect(toneOf(spans, 'git')).toBe('command')
  })

  it('引号里的 < 与 & 留在文本里，不变成实体', () => {
    const raw = 'echo "a <b> & c"'
    const spans = highlightCommand(raw)
    expect(spans.map((s) => s.text).join('')).toBe(raw)
    expect(spans.find((s) => s.tone === 'string')?.text).toBe('"a <b> & c"')
  })

  it('heredoc 整段是字符串，跨行状态不断', () => {
    const raw = 'cat <<EOF\nhello\nEOF'
    const spans = highlightCommand(raw)
    expect(spans.map((s) => s.text).join('')).toBe(raw)
    expect(spans.find((s) => s.tone === 'string')?.text).toContain('hello')
  })

  it('空命令不产出 span', () => {
    expect(highlightCommand('')).toEqual([])
  })
})
