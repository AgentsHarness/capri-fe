import { describe, expect, it } from 'vitest'
import { placePanel } from './menuPlacement'

describe('placePanel', () => {
  it('右对齐到能放下的触发元素', () => {
    expect(placePanel(341, 320, 390)).toEqual({ left: 21, width: 320 })
  })

  it('触发元素换行到左侧时夹到左内边距', () => {
    expect(placePanel(85, 269, 320)).toEqual({ left: 8, width: 269 })
    expect(placePanel(41, 256, 320)).toEqual({ left: 8, width: 256 })
  })

  it('面板比视口宽时收窄到两侧内边距之间', () => {
    expect(placePanel(300, 500, 320)).toEqual({ left: 8, width: 304 })
  })

  it('触发元素贴右边缘时保留右侧内边距', () => {
    expect(placePanel(390, 320, 390)).toEqual({ left: 62, width: 320 })
  })
})
