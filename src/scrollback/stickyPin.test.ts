import { describe, expect, it } from 'vitest'
import { USER_COLLAPSED_MAX_LINES } from './userText'
import { fallbackStickyBandH, pickStickyPin, type StickyUserPos } from './stickyPin'

describe('fallbackStickyBandH', () => {
  it('默认参数 = padY*2 + ceil(fontSize*lineHeight*lines)', () => {
    expect(fallbackStickyBandH()).toBe(
      11 * 2 + Math.ceil(13.5 * 1.35 * USER_COLLAPSED_MAX_LINES),
    )
  })

  it('自定义参数', () => {
    expect(fallbackStickyBandH(5, 15, 1.5, 2)).toBe(5 * 2 + Math.ceil(15 * 1.5 * 2))
  })
})

describe('pickStickyPin', () => {
  const user = (top: number, h = 30): StickyUserPos => ({ id: `u@${top}`, top, bottom: top + h })

  it('无用户或 sticky 高度 <= 0 → 不钉', () => {
    expect(pickStickyPin([], 200, 60)).toEqual({ id: null, pushY: 0 })
    expect(pickStickyPin([user(100)], 200, 0)).toEqual({ id: null, pushY: 0 })
  })

  it('没有用户完全越过 pinLine → 不钉', () => {
    const us = [user(200), user(240)]
    expect(pickStickyPin(us, 150, 60)).toEqual({ id: null, pushY: 0 })
  })

  it('最后一个越过 pinLine 的用户且无下一个 → 钉住不动', () => {
    expect(pickStickyPin([user(100)], 150, 50)).toEqual({ id: 'u@100', pushY: 0 })
  })

  it('下一个用户还在 band 下方 → 钉当前，无推送', () => {
    // u0: 100-130, u1: 200-230; band = 150..190
    const us = [user(100), user(200)]
    expect(pickStickyPin(us, 150, 40)).toEqual({ id: 'u@100', pushY: 0 })
  })

  it('下一个用户进入 band → 按重叠量上推', () => {
    // u0: 100-130, u1: 160-190; band = 130..170，重叠 10
    const us = [user(100), user(160)]
    expect(pickStickyPin(us, 130, 40)).toEqual({ id: 'u@100', pushY: -10 })
  })

  it('下一个用户盖过 pinLine（overlap >= stickyH）→ 让位不钉', () => {
    // u0: 100-130, u1: 120-150; band = 130..155，重叠 35 >= 25
    const us = [user(100), user(120)]
    expect(pickStickyPin(us, 130, 25)).toEqual({ id: null, pushY: 0 })
  })

  it('钉「最后」完全越过 pinLine 的用户（中间的半越不选）', () => {
    // u0: 100-130（完全越过 200）, u1: 160-190（完全越过）, u2: 220-250
    // 选 u1；u2 top=220 进入 band 200..260 → 重叠 40 → 上推
    const us = [user(100), user(160), user(220)]
    expect(pickStickyPin(us, 200, 60)).toEqual({ id: 'u@160', pushY: -40 })
  })
})