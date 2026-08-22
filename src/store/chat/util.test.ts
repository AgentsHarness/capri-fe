import { describe, expect, it } from 'vitest'
import { nonBlankStr, wireTaskId } from './util'

describe('nonBlankStr', () => {
  it('非空修剪字符串；其余 undefined', () => {
    expect(nonBlankStr('  hi ')).toBe('hi')
    expect(nonBlankStr('')).toBeUndefined()
    expect(nonBlankStr('   ')).toBeUndefined()
    expect(nonBlankStr(42)).toBeUndefined()
    expect(nonBlankStr(null)).toBeUndefined()
    expect(nonBlankStr(undefined)).toBeUndefined()
  })
})

describe('wireTaskId', () => {
  it('首个非空候选字符串化', () => {
    expect(wireTaskId(undefined, '', 't1')).toBe('t1')
    expect(wireTaskId(42)).toBe('42')
    expect(wireTaskId(0n)).toBe('0')
    expect(wireTaskId(null, undefined)).toBe('')
    expect(wireTaskId()).toBe('')
  })
})