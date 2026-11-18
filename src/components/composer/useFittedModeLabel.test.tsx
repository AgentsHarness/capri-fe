import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  fitsFullWidth,
  projectFullWidth,
  rowAvailableWidth,
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
 * 底栏实测：内容（模型名 + 完整模式名）超过行可用宽度才退到短名；
 * 放得下时显示完整名——按屏幕宽度一刀切会把宽屏也缩掉。
 */
describe('useFittedModeLabel', () => {
  const refs = (
    contentW: number,
    availW: number,
    delta: number,
    modelDelta = 0,
  ) => {
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
    // 模型名 span：scrollWidth 比 clientWidth 多出的部分就是被截掉的宽度。
    const modelName = document.createElement('span')
    Object.defineProperty(modelName, 'clientWidth', { value: 100 })
    Object.defineProperty(modelName, 'scrollWidth', {
      value: 100 + modelDelta,
    })
    return {
      rowRef: { current: row },
      fullProbeRef: { current: fullProbe },
      shortProbeRef: { current: shortProbe },
      modelNameRef: { current: modelName },
    }
  }

  const render = (
    contentW: number,
    availW: number,
    delta = 28,
    modelDelta = 0,
  ) => {
    const r = refs(contentW, availW, delta, modelDelta)
    return renderHook(() =>
      useFittedModeLabel({
        ...r,
        full: 'always-approve',
        short: 'always',
        contentKey: `${contentW}|${availW}|${modelDelta}`,
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

  it('窄视口但内容放得下 → 完整名（不按屏幕宽度一刀切）', () => {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    try {
      expect(render(200, 300).result.current).toBe('always-approve')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: original })
    }
  })

  it('窄视口且内容溢出 → 才退到短名', () => {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    try {
      expect(render(400, 300).result.current).toBe('always')
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: original })
    }
  })

  it('模型名被截断时，把截掉的宽度补回来再判断模式名', () => {
    // 当前可见内容 260 + 模式名差值 28 = 288，看似能放进 300；
    // 但模型名还差 30px 才完整，补回去是 318 → 必须用短名。
    expect(render(260, 300, 28, 30).result.current).toBe('always')
  })

  it('模型名完整时，同样的行宽仍用完整模式名', () => {
    expect(render(260, 300, 28, 0).result.current).toBe('always-approve')
  })

  it('可用宽度取行上限，不取短名收缩后的 clientWidth', () => {
    // 显示短名时行盒子收缩到 300，但 containing block 800 × 75% = 600；
    // 完整内容 560 在 600 内，应该能回到完整名。
    const r = refs(560, 300, 28)
    const box = document.createElement('div')
    Object.defineProperty(box, 'clientWidth', { value: 800 })
    Object.defineProperty(r.rowRef.current, 'offsetParent', { value: box })
    r.rowRef.current.style.maxWidth = '75%'
    const { result } = renderHook(() =>
      useFittedModeLabel({
        ...r,
        full: 'always-approve',
        short: 'always',
        contentKey: 'box',
      }),
    )
    expect(result.current).toBe('always-approve')
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

describe('rowAvailableWidth', () => {
  it('按 max-width 百分比 × containing block 算上限', () => {
    const box = document.createElement('div')
    Object.defineProperty(box, 'clientWidth', { value: 800 })
    const row = document.createElement('div')
    row.style.maxWidth = '75%'
    Object.defineProperty(row, 'clientWidth', { value: 300 })
    Object.defineProperty(row, 'offsetParent', { value: box })
    expect(rowAvailableWidth(row)).toBe(600)
  })

  it('max-width 是像素时直接用它', () => {
    const box = document.createElement('div')
    Object.defineProperty(box, 'clientWidth', { value: 800 })
    const row = document.createElement('div')
    row.style.maxWidth = '420px'
    Object.defineProperty(row, 'clientWidth', { value: 300 })
    Object.defineProperty(row, 'offsetParent', { value: box })
    expect(rowAvailableWidth(row)).toBe(420)
  })

  it('右侧偏移从 containing block 里扣掉（底栏 right-2）', () => {
    const box = document.createElement('div')
    Object.defineProperty(box, 'clientWidth', { value: 330 })
    const row = document.createElement('div')
    row.style.maxWidth = '100%'
    row.style.right = '8px'
    Object.defineProperty(row, 'clientWidth', { value: 300 })
    Object.defineProperty(row, 'offsetParent', { value: box })
    expect(rowAvailableWidth(row)).toBe(322)
  })

  it('max-width 是 calc 时仍按 right 偏移算（与底栏同值）', () => {
    const box = document.createElement('div')
    Object.defineProperty(box, 'clientWidth', { value: 330 })
    const row = document.createElement('div')
    row.style.maxWidth = 'calc(100% - 8px)'
    row.style.right = '8px'
    Object.defineProperty(row, 'clientWidth', { value: 300 })
    Object.defineProperty(row, 'offsetParent', { value: box })
    expect(rowAvailableWidth(row)).toBe(322)
  })

  it('没有 containing block 时退回 clientWidth', () => {
    const row = document.createElement('div')
    row.style.maxWidth = '75%'
    Object.defineProperty(row, 'clientWidth', { value: 300 })
    expect(rowAvailableWidth(row)).toBe(300)
  })
})
