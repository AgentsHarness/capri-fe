import { describe, expect, it } from 'vitest'
import { blendColor, waveBrightness } from './wave'

describe('waveBrightness', () => {
  it('sin² 波形 ∈ [0,1]，相位随行偏移', () => {
    const b = waveBrightness(0, 0)
    expect(b).toBeGreaterThanOrEqual(0)
    expect(b).toBeLessThanOrEqual(1)
    // 同一 tick 不同行相位不同
    expect(waveBrightness(1, 0)).not.toBe(waveBrightness(1, 8))
  })

  it('行相位 = row/waveRows 整周期（waveRows 行一轮）', () => {
    expect(waveBrightness(0, 0, 16)).toBeCloseTo(waveBrightness(0, 16, 16))
  })

  it('自定义速度影响周期', () => {
    // t = tick*speed：整波周期在 t=2π
    expect(waveBrightness(0, 0, 32, 0.15)).not.toBe(waveBrightness(1, 0, 32, 0.15))
  })

  it('waveRows <= 1 时按 1 兜底', () => {
    expect(waveBrightness(0, 0, 0)).toBe(waveBrightness(0, 0, 1))
  })
})

describe('blendColor', () => {
  it('t 钳制到 [0,1]，端点直接返回', () => {
    expect(blendColor('bg', 'fg', 0)).toBe('bg')
    expect(blendColor('bg', 'fg', 1)).toBe('fg')
    expect(blendColor('bg', 'fg', -1)).toBe('bg')
    expect(blendColor('bg', 'fg', 2)).toBe('fg')
  })

  it('中间值 → color-mix 百分比', () => {
    expect(blendColor('bg', 'fg', 0.5)).toBe('color-mix(in srgb, fg 50%, bg)')
    expect(blendColor('bg', 'fg', 0.235)).toBe('color-mix(in srgb, fg 24%, bg)')
  })
})