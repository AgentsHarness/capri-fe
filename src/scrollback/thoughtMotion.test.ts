import { describe, expect, it } from 'vitest'
import { easeThoughtValue, thoughtBodyTarget } from './thoughtMotion'

describe('thoughtBodyTarget', () => {
  it('内容不足上限：高度跟随内容，不滚动', () => {
    expect(thoughtBodyTarget(60, 100)).toEqual({ height: 60, scrollTop: 0 })
  })

  it('内容超过上限：高度封顶，滚动量等于超出部分', () => {
    expect(thoughtBodyTarget(260, 100)).toEqual({ height: 100, scrollTop: 160 })
  })

  it('空内容与零上限都归一为非负', () => {
    expect(thoughtBodyTarget(0, 100)).toEqual({ height: 0, scrollTop: 0 })
    expect(thoughtBodyTarget(80, 0)).toEqual({ height: 0, scrollTop: 80 })
  })
})

describe('easeThoughtValue', () => {
  it('按比例逼近但不越过目标', () => {
    expect(easeThoughtValue(0, 100, 0.5, 100)).toBe(50)
    expect(easeThoughtValue(90, 100, 0.5, 100)).toBe(95)
  })

  it('单帧位移钳制在上限内', () => {
    expect(easeThoughtValue(0, 1000, 0.5, 24)).toBe(24)
    expect(easeThoughtValue(1000, 0, 0.5, 24)).toBe(976)
  })

  it('差距小于半像素直接落到目标，避免无限逼近', () => {
    expect(easeThoughtValue(99.8, 100, 0.5, 24)).toBe(100)
    expect(easeThoughtValue(100.2, 100, 0.5, 24)).toBe(100)
  })

  it('最慢也走 1px，长尾不会卡住', () => {
    expect(easeThoughtValue(0.1, 2, 0.01, 24)).toBe(1.1)
  })
})
