import { describe, expect, it } from 'vitest'
import { contextUrgencyColor } from './contextColor'

describe('contextUrgencyColor', () => {
  const FG = 'var(--color-gn-fg)'
  const USER = 'var(--color-gn-accent-user)'
  const WARN = 'var(--color-gn-warning)'
  const ERROR = 'var(--color-gn-accent-error)'

  it('边界档位（档位边界返回端点色或 0% 混合）', () => {
    expect(contextUrgencyColor(0)).toBe(FG)
    // pct<=50 分支返回 t=1 的混合（0% FG）
    expect(contextUrgencyColor(50)).toBe(`color-mix(in srgb, ${FG} 0%, ${USER})`)
    expect(contextUrgencyColor(65)).toBe(USER)
    expect(contextUrgencyColor(75)).toBe(`color-mix(in srgb, ${USER} 0%, ${WARN})`)
    expect(contextUrgencyColor(85)).toBe(WARN)
    expect(contextUrgencyColor(95)).toBe(`color-mix(in srgb, ${WARN} 0%, ${ERROR})`)
  })

  it('档位内线性混合（color-mix 语义）', () => {
    // 25% → FG→USER 混合，t = 25/50 = 0.5
    expect(contextUrgencyColor(25)).toBe(`color-mix(in srgb, ${FG} ${Math.round((1 - 0.5) * 100)}%, ${USER})`)
    // 70% → USER→WARN 混合，t = (70-65)/10 = 0.5
    expect(contextUrgencyColor(70)).toBe(`color-mix(in srgb, ${USER} ${50}%, ${WARN})`)
    // 90% → WARN→ERROR 混合，t = (90-85)/10 = 0.5
    expect(contextUrgencyColor(90)).toBe(`color-mix(in srgb, ${WARN} ${50}%, ${ERROR})`)
  })

  it('越界值落在端点色', () => {
    expect(contextUrgencyColor(-5)).toBe(FG)
    expect(contextUrgencyColor(150)).toBe(ERROR)
  })
})