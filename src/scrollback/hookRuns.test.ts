import { describe, expect, it } from 'vitest'
import type { HookGroup, HookRun } from '../api/types'
import {
  cleanHookError,
  countHookRuns,
  groupHookCounts,
  hookCountsTotal,
  hookElapsedLabel,
  hookSuffixText,
  hookTextLines,
  parseHookExecution,
  parseHookRuns,
  splitHookAnnotation,
  stopHookSummaryParts,
  truncateHookText,
  hookSuffixParts,
} from './hookRuns'

const ok = (name = 'h', ms = 6): HookRun => ({
  name,
  status: { type: 'success', elapsedMs: ms },
})
const blocked = (name = 'h'): HookRun => ({
  name,
  status: { type: 'blocked', detail: 'denied', elapsedMs: 1 },
})
const failed = (name = 'h'): HookRun => ({
  name,
  status: { type: 'failed', error: 'exit 1', elapsedMs: 1 },
})
const skipped = (name = 'h'): HookRun => ({ name, status: { type: 'skipped' } })

describe('parseHookRuns / parseHookExecution', () => {
  it('三种 wire 拼法 + Failed+blocked → Blocked', () => {
    expect(
      parseHookRuns([
        { name: 'a', status: { status: 'success', elapsed_ms: 6 } },
        { name: 'b', status: 'skipped' },
        { name: 'c', Failed: { error: 'boom', elapsed_ms: 3 } },
        { name: 'd', status: { status: 'failed', error: 'deny', elapsed_ms: 2, blocked: true } },
      ]),
    ).toEqual([
      { name: 'a', status: { type: 'success', elapsedMs: 6 } },
      { name: 'b', status: { type: 'skipped' } },
      { name: 'c', status: { type: 'failed', error: 'boom', elapsedMs: 3 } },
      { name: 'd', status: { type: 'blocked', detail: 'deny', elapsedMs: 2 } },
    ])
  })

  it('空批次 / 全 skipped → null；缺 event_name → null', () => {
    expect(parseHookExecution({ event_name: 'stop', runs: [] })).toBeNull()
    expect(
      parseHookExecution({
        event_name: 'stop',
        runs: [{ name: 'h', status: 'skipped' }],
      }),
    ).toBeNull()
    expect(parseHookExecution({ runs: [{ name: 'h', status: 'success' }] })).toBeNull()
  })

  it('camel/snake 字段与 hoisted status', () => {
    const batch = parseHookExecution({
      eventName: 'pre_tool_use',
      toolName: 'list_dir',
      promptId: 'p1',
      runs: [{ name: 'h', status: 'success', elapsedMs: 4, output: 'hi' }],
    })
    expect(batch).toEqual({
      event: 'pre_tool_use',
      toolName: 'list_dir',
      promptId: 'p1',
      runs: [{ name: 'h', status: { type: 'success', elapsedMs: 4 }, output: 'hi' }],
    })
  })
})

describe('counts / suffix', () => {
  it('skipped 不计；compact 把 blocked 算进分子', () => {
    const counts = countHookRuns([ok(), blocked(), failed(), skipped()])
    expect(counts).toEqual({ success: 1, blocked: 1, failed: 1 })
    expect(hookCountsTotal(counts)).toBe(3)
    expect(hookSuffixText(hookSuffixParts(counts, 'compact'))).toBe('  [hooks: 2/1]')
    expect(hookSuffixText(hookSuffixParts(counts, 'labeled'))).toBe(
      '  [hooks: 1 ok, 1 blocked, 1 failed]',
    )
  })

  it('groupHookCounts 跨成员累加', () => {
    expect(
      groupHookCounts([
        { hooks: { pre: [ok()], post: [failed()] } },
        { hooks: { pre: [blocked()] } },
        {},
      ]),
    ).toEqual({ success: 1, blocked: 1, failed: 1 })
  })

  it('stop 摘要：bold 事件名 + 两空格 + compact；全 skipped 组省略', () => {
    const groups: HookGroup[] = [
      { event: 'stop_failure', runs: [failed(), skipped()] },
      { event: 'stop', runs: [ok(), ok()] },
      { event: 'stop_cancelled', runs: [skipped()] },
    ]
    const parts = stopHookSummaryParts(groups)
    expect(hookSuffixText(parts)).toBe('stop_failure  [hooks: 1]  stop  [hooks: 2]')
    expect(parts?.[0]).toMatchObject({ text: 'stop_failure', bold: true, tone: 'muted' })
    expect(stopHookSummaryParts([{ event: 'stop', runs: [skipped()] }])).toBeNull()
  })
})

describe('expanded text helpers', () => {
  it('120 列裁切带 …；最多 3 行', () => {
    expect(truncateHookText('a'.repeat(121)).endsWith('…')).toBe(true)
    expect(truncateHookText('a'.repeat(121)).length).toBe(121)
    expect(hookTextLines('a\nb\nc\nd')).toEqual(['a', 'b', 'c'])
  })

  it('剥 hook 名称前缀；缺 elapsed 显示空而非 0ms', () => {
    expect(cleanHookError("hook 'probe' exit 1", 'probe')).toBe('exit 1')
    expect(cleanHookError('exit 1', 'probe')).toBe('exit 1')
    expect(hookElapsedLabel(12)).toBe(' (12ms)')
    expect(hookElapsedLabel(undefined)).toBe('')
  })
})

describe('splitHookAnnotation', () => {
  it('⚠ 前缀 → warning，并吃掉其后的空白', () => {
    expect(splitHookAnnotation('⚠ `list_dir` blocked by hook `p`')).toEqual({
      lead: 'warning',
      text: '`list_dir` blocked by hook `p`',
    })
    // 带 U+FE0F 变体选择符的写法同样识别。
    expect(splitHookAnnotation('⚠️  held queue')).toEqual({
      lead: 'warning',
      text: 'held queue',
    })
  })

  it('↩ 前缀 → blocked（与 hook run 的 blocked 图标同形）', () => {
    expect(splitHookAnnotation('↩ Stop blocked by hook `p`, continuing: x')).toEqual({
      lead: 'blocked',
      text: 'Stop blocked by hook `p`, continuing: x',
    })
  })

  it('无前缀原样返回；句中同字符不误伤', () => {
    expect(splitHookAnnotation('Worked for 27s')).toEqual({
      lead: null,
      text: 'Worked for 27s',
    })
    expect(splitHookAnnotation('note ⚠ kept')).toEqual({
      lead: null,
      text: 'note ⚠ kept',
    })
  })
})
