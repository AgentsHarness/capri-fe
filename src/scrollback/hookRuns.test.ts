import { describe, expect, it } from 'vitest'
import type { HookRun } from '../api/types'
import {
  failedHookLine,
  failedHookLines,
  hookAnnotationKind,
  hookDisplayName,
  parseHookExecution,
  parseHookRuns,
  splitHookAnnotation,
  stripSpecPath,
} from './hookRuns'

const ok = (name = 'h', ms = 6): HookRun => ({
  name,
  status: { type: 'success', elapsedMs: ms },
})
const blocked = (name = 'h'): HookRun => ({
  name,
  status: { type: 'blocked', detail: 'denied', elapsedMs: 1 },
})
const failed = (name = 'h', error = 'exit 1'): HookRun => ({
  name,
  status: { type: 'failed', error, elapsedMs: 1 },
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

describe('failedHookLine — 一次失败一行（TUI failed_hook_line）', () => {
  it('只报 failed：success / skipped / blocked 都不出线', () => {
    expect(failedHookLine('pre_tool_use', ok())).toBeNull()
    expect(failedHookLine('pre_tool_use', skipped())).toBeNull()
    // deny 由 shell 的 annotation 负责，批次结果不再重复报一遍。
    expect(failedHookLine('pre_tool_use', blocked())).toBeNull()
    expect(failedHookLine('post_tool_use', failed('global/qa', 'exit code 1: lint'))).toBe(
      'post_tool_use hook (global/qa) failed, ignored: exit code 1: lint',
    )
  })

  it('带规格路径的名字剥成用户可见名；多行错误只取第一行', () => {
    expect(
      failedHookLine(
        'pre_tool_use',
        failed('global/lint:pre_tool_use[0].hooks[1]', 'timed out after 1000ms\nsecond line'),
      ),
    ).toBe('pre_tool_use hook (global/lint) failed, ignored: timed out after 1000ms')
  })

  it('配置层来源只报事件名（TUI HookDisplayName::Tier）', () => {
    // 托管策略层（root-owned / server-signed）：没有对用户有意义的名字。
    expect(failedHookLine('stop', failed('requirements/system:stop[0].hooks[0]'))).toBe(
      'stop hook failed, ignored: exit 1',
    )
    expect(failedHookLine('stop', failed('system_managed'))).toBe(
      'stop hook failed, ignored: exit 1',
    )
    // 用户文件层的真实名字照常带上。
    expect(failedHookLine('stop', failed('global/notify'))).toBe(
      'stop hook (global/notify) failed, ignored: exit 1',
    )
    // 空错误回落成不带原因的半句（TUI 同款）。
    expect(failedHookLine('stop', failed('global/x', ''))).toBe(
      'stop hook (global/x) failed, ignored',
    )
  })

  it('一批里按顺序收集全部失败行', () => {
    expect(
      failedHookLines({
        event: 'pre_tool_use',
        runs: [ok('a'), failed('global/one', 'boom'), skipped('c'), failed('global/two', 'bang')],
      }),
    ).toEqual([
      'pre_tool_use hook (global/one) failed, ignored: boom',
      'pre_tool_use hook (global/two) failed, ignored: bang',
    ])
  })
})

describe('hookDisplayName / hookDisplayLabel / stripSpecPath', () => {
  it('真实名字原样返回，规格尾巴剥掉', () => {
    expect(stripSpecPath('global/probe:pre_tool_use[0].hooks[0]')).toBe('global/probe')
    expect(stripSpecPath('global/probe')).toBe('global/probe')
    // 冒号后不是规格路径（如 agent 身份）时原样保留。
    expect(stripSpecPath('agent:explore')).toBe('agent:explore')
    expect(hookDisplayName('global/probe')).toBe('global/probe')
    expect(hookDisplayName('plugin/foo')).toBe('plugin/foo')
    expect(hookDisplayName('agent:explore')).toBe('agent:explore')
  })

  it('配置层没有用户可见名（分层文案由 shell 直接写进消息）', () => {
    for (const tier of ['system_managed', 'managed', 'requirements/user', 'user']) {
      expect(hookDisplayName(tier)).toBeNull()
    }
    // 带规格尾巴的配置层同样认得出（先剥尾再比对分层名）。
    expect(hookDisplayName('requirements/signed:stop[0].hooks[1]')).toBeNull()
  })
})

describe('hookAnnotationKind — 行 bullet 由 wire kind 决定', () => {
  it('tool_outcome 取工具行 bullet，其余（含缺失 / 未知）算 note', () => {
    expect(hookAnnotationKind('tool_outcome')).toBe('tool_outcome')
    expect(hookAnnotationKind('TOOL_OUTCOME')).toBe('tool_outcome')
    expect(hookAnnotationKind('note')).toBe('note')
    expect(hookAnnotationKind(undefined)).toBe('note')
    expect(hookAnnotationKind('something_new')).toBe('note')
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

  it('↩ 前缀 → blocked', () => {
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
    // 1.0.41 起 deny 行不再带 ⚠（含义由 bullet 承担）：无前缀是正常形态。
    expect(splitHookAnnotation('`web_fetch` blocked by global/qa: no')).toEqual({
      lead: null,
      text: '`web_fetch` blocked by global/qa: no',
    })
    expect(splitHookAnnotation('note ⚠ kept')).toEqual({
      lead: null,
      text: 'note ⚠ kept',
    })
  })
})
