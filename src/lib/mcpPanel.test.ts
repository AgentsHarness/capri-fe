import { describe, expect, it } from 'vitest'
import {
  formatResult,
  parseArgsInput,
  parseEnvInput,
  parseHeadersInput,
  rowMatchesQuery,
  rowStatus,
  type McpRow,
} from './mcpPanel'

describe('parseArgsInput', () => {
  it('空输入返回 undefined', () => {
    expect(parseArgsInput('   ')).toBeUndefined()
  })

  it('JSON 字符串数组按元素返回', () => {
    expect(parseArgsInput('["-y","pkg"]')).toEqual(['-y', 'pkg'])
  })

  it('JSON 非字符串数组退回空格切分（保留原样 tokens）', () => {
    expect(parseArgsInput('[1,2]')).toEqual(['[1,2]'])
  })

  it('普通命令行按空白切分', () => {
    expect(parseArgsInput('  a  b\tc ')).toEqual(['a', 'b', 'c'])
  })
})

describe('parseEnvInput', () => {
  it('空输入返回空对象', () => {
    expect(parseEnvInput('\n  \n')).toEqual({})
  })

  it('按第一个 = 切分，值里允许再出现 =', () => {
    expect(parseEnvInput('A=1\nKEY=x=y')).toEqual({ A: '1', KEY: 'x=y' })
  })

  it('缺少 = 或 = 在行首时报错', () => {
    expect(parseEnvInput('A=1\nBAD')).toContain('BAD')
    expect(parseEnvInput('=v')).toContain('=v')
  })
})

describe('parseHeadersInput', () => {
  it('空输入返回 undefined', () => {
    expect(parseHeadersInput('')).toBeUndefined()
  })

  it('按第一个冒号切分', () => {
    expect(parseHeadersInput('Authorization: Bearer a:b\nX-Test: 1')).toEqual({
      Authorization: 'Bearer a:b',
      'X-Test': '1',
    })
  })

  it('缺冒号 / 空名报错', () => {
    expect(typeof parseHeadersInput('NoColon')).toBe('string')
    expect(typeof parseHeadersInput(': v')).toBe('string')
  })
})

describe('formatResult', () => {
  it('undefined 有专用文案，字符串原样', () => {
    expect(formatResult(undefined)).not.toBe('')
    expect(formatResult('ok')).toBe('ok')
  })

  it('对象按两空格缩进', () => {
    expect(formatResult({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('超长结果截断并标注总长度', () => {
    const out = formatResult('x'.repeat(6100))
    expect(out.length).toBeLessThan(6100)
    expect(out).toContain('6100')
  })
})

describe('rowStatus', () => {
  const base = { name: 's', fromList: true } as McpRow

  it('事件流状态优先于列表侧标记', () => {
    expect(rowStatus({ ...base, status: 'connected', authRequired: true })).toBe('connected')
  })

  it('无状态时按 setupRequired / authRequired 推导', () => {
    expect(rowStatus({ ...base, setupRequired: true })).toBe('setup_required')
    expect(rowStatus({ ...base, authRequired: true })).toBe('needs_auth')
    expect(rowStatus(base)).toBeUndefined()
  })
})

describe('rowMatchesQuery', () => {
  const base = { name: 'Files', fromList: true } as McpRow

  it('命中名称 / 命令 / URL / 工具展示名', () => {
    expect(rowMatchesQuery({ ...base, command: 'npx file-server' }, 'npx')).toBe(true)
    expect(rowMatchesQuery({ ...base, url: 'https://x/y' }, 'https')).toBe(true)
    expect(
      rowMatchesQuery(
        { ...base, tools: [{ name: 'read', displayName: 'Read File' }] },
        'file',
      ),
    ).toBe(true)
  })

  it('无命中返回 false', () => {
    expect(rowMatchesQuery({ ...base, tools: [{ name: 'read' }] }, 'write')).toBe(false)
    expect(rowMatchesQuery(base, 'other')).toBe(false)
  })
})
