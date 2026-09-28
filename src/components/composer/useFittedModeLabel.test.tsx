import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  fitsFullWidth,
  projectFullWidth,
  useFittedModeLabel,
} from './useFittedModeLabel'

function rect(width: number, left: number): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: 0,
    width,
    height: 0,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

describe('projectFullWidth', () => {
  it('已显示完整名时用实测宽度，不重复加差值', () => {
    expect(projectFullWidth(300, true, 40)).toBe(300)
  })

  it('显示短名时补回两段文本的宽度差（否则判定会在两个名字间来回跳）', () => {
    expect(projectFullWidth(260, false, 40)).toBe(300)
  })

  it('差值为负时不倒扣，避免把放不下的行算成放得下', () => {
    expect(projectFullWidth(260, false, -10)).toBe(260)
  })
})

describe('fitsFullWidth', () => {
  it('正好占满算放得下，超出 1px 以上才算放不下', () => {
    expect(fitsFullWidth(277, 277)).toBe(true)
    expect(fitsFullWidth(278, 277)).toBe(true)
    expect(fitsFullWidth(280, 277)).toBe(false)
  })
})

/**
 * 底栏实测：内容（模型名 + 完整模式名）超过 max-w-[75%] 的可用宽度才退到
 * 短名；放得下时显示完整名——按屏幕宽度一刀切会把宽屏也缩掉。
 */
describe('useFittedModeLabel', () => {
  const refs = (contentW: number, availW: number, delta: number) => {
    const row = document.createElement('div')
    const child = document.createElement('div')
    row.appendChild(child)
    Object.defineProperty(row, 'clientWidth', { value: availW })
    row.getBoundingClientRect = () => rect(availW, 0)
    child.getBoundingClientRect = () => rect(contentW, 0)
    const fullProbe = document.createElement('span')
    fullProbe.getBoundingClientRect = () => rect(contentW, 0)
    const shortProbe = document.createElement('span')
    shortProbe.getBoundingClientRect = () => rect(contentW - delta, 0)
    return {
      rowRef: { current: row },
      fullProbeRef: { current: fullProbe },
      shortProbeRef: { current: shortProbe },
    }
  }

  const render = (contentW: number, availW: number, delta = 28) => {
    const r = refs(contentW, availW, delta)
    return renderHook(() =>
      useFittedModeLabel({
        ...r,
        full: 'always-approve',
        short: 'always',
        contentKey: `${contentW}|${availW}`,
      }),
    )
  }

  it('内容溢出可用宽度 → 短名（截图里的手机宽度）', () => {
    expect(render(292, 277).result.current).toBe('always')
  })

  it('放得下 → 完整名（宽屏不该被缩写）', () => {
    expect(render(292, 675).result.current).toBe('always-approve')
  })

  it('内容刚好卡在可用宽度上 → 完整名', () => {
    expect(render(277, 277).result.current).toBe('always-approve')
  })

  it('行内没有可用宽度（jsdom 零布局）→ 完整名，不误缩', () => {
    expect(render(0, 0).result.current).toBe('always-approve')
  })

  it('data-probe 探针不计入内容宽度', () => {
    const r = refs(292, 675, 28)
    const probe = document.createElement('span')
    probe.setAttribute('data-probe', '')
    probe.getBoundingClientRect = () => rect(2000, 0)
    r.rowRef.current.appendChild(probe)
    const { result } = renderHook(() =>
      useFittedModeLabel({
        ...r,
        full: 'always-approve',
        short: 'always',
        contentKey: 'probe',
      }),
    )
    expect(result.current).toBe('always-approve')
  })
})
