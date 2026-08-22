import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadBool,
  loadJSON,
  loadStr,
  removeKey,
  saveBool,
  saveJSON,
  saveStr,
} from './storage'

beforeEach(() => {
  window.localStorage.clear()
})

describe('loadJSON / saveJSON', () => {
  it('JSON 往返', () => {
    saveJSON('k', { a: 1, list: ['x'] })
    expect(loadJSON('k', null)).toEqual({ a: 1, list: ['x'] })
  })

  it('缺失时返回 fallback', () => {
    expect(loadJSON('missing', { def: true })).toEqual({ def: true })
  })

  it('语法损坏时静默返回 fallback', () => {
    window.localStorage.setItem('broken', '{not json')
    expect(loadJSON('broken', 'fb')).toBe('fb')
  })

  it('合法 JSON 的原始类型会穿透（调用方需自行类型闸）', () => {
    window.localStorage.setItem('null-literal', 'null')
    expect(loadJSON('null-literal', 'fb')).toBeNull()
  })
})

describe('loadStr / saveStr', () => {
  it('字符串往返；缺失返回 null', () => {
    saveStr('s', 'value')
    expect(loadStr('s')).toBe('value')
    expect(loadStr('nope')).toBeNull()
  })
})

describe('loadBool / saveBool', () => {
  it("仅 'true' 为真，其余回落 fallback", () => {
    saveBool('b1', true)
    saveBool('b2', false)
    window.localStorage.setItem('b3', '1')
    expect(loadBool('b1', false)).toBe(true)
    expect(loadBool('b2', true)).toBe(false)
    expect(loadBool('b3', false)).toBe(false)
    expect(loadBool('missing', true)).toBe(true)
  })
})

describe('removeKey', () => {
  it('删除存在与不存在的 key 都安全', () => {
    saveStr('gone', 'x')
    removeKey('gone')
    expect(loadStr('gone')).toBeNull()
    expect(() => removeKey('gone')).not.toThrow()
  })
})
