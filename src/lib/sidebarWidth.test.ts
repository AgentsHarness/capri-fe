import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebarWidth'

beforeEach(() => {
  localStorage.clear()
})

describe('clampSidebarWidth', () => {
  it('非数值回落默认宽度', () => {
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(clampSidebarWidth('oops')).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('低于下限抬到最小宽度', () => {
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('高于上限压到最大宽度', () => {
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('合法值取整（存储读回的是字符串）', () => {
    expect(clampSidebarWidth(300.6)).toBe(301)
    expect(clampSidebarWidth('320')).toBe(320)
  })
})

describe('loadSidebarWidth / saveSidebarWidth', () => {
  it('未存储时用默认宽度', () => {
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('读回合法值，脏数据/越界值回落或钳制', () => {
    localStorage.setItem('capri-fe.sidebarWidth', '420')
    expect(loadSidebarWidth()).toBe(420)

    localStorage.setItem('capri-fe.sidebarWidth', 'oops')
    expect(loadSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH)

    localStorage.setItem('capri-fe.sidebarWidth', '9999')
    expect(loadSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('写入前钳制', () => {
    saveSidebarWidth(9999)
    expect(localStorage.getItem('capri-fe.sidebarWidth')).toBe(String(SIDEBAR_MAX_WIDTH))
  })
})
