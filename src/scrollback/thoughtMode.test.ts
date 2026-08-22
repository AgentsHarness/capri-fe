import { describe, expect, it } from 'vitest'
import {
  nextThoughtMode,
  thoughtDisplayMode,
  thoughtModeStepDown,
  thoughtModeStepUp,
} from './thoughtMode'

describe('thoughtDisplayMode', () => {
  it('缺失 displayMode → collapsed（FE 默认）', () => {
    expect(thoughtDisplayMode({})).toBe('collapsed')
  })

  it('legacy open:true → expanded', () => {
    expect(thoughtDisplayMode({ open: true })).toBe('expanded')
    expect(thoughtDisplayMode({ open: false })).toBe('collapsed')
  })

  it('displayMode 优先于 open', () => {
    expect(thoughtDisplayMode({ displayMode: 'truncated', open: true })).toBe('truncated')
    expect(thoughtDisplayMode({ displayMode: 'collapsed', open: true })).toBe('collapsed')
  })
})

describe('nextThoughtMode', () => {
  it('collapsed → expanded（首击展开全文）', () => {
    expect(nextThoughtMode('collapsed')).toBe('expanded')
  })

  it('truncated / expanded → collapsed（再击收起）', () => {
    expect(nextThoughtMode('truncated')).toBe('collapsed')
    expect(nextThoughtMode('expanded')).toBe('collapsed')
  })
})

describe('thoughtModeStepUp / thoughtModeStepDown', () => {
  it('任意模式 → expanded / collapsed', () => {
    expect(thoughtModeStepUp('collapsed')).toBe('expanded')
    expect(thoughtModeStepUp('expanded')).toBe('expanded')
    expect(thoughtModeStepDown('expanded')).toBe('collapsed')
    expect(thoughtModeStepDown('truncated')).toBe('collapsed')
  })
})