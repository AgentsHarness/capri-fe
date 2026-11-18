/**
 * 桌面会话侧边栏宽度（px）：拖右缘调宽，localStorage 持久化。
 *
 * 默认 288 即原 `w-72`。下限 260 保证头部「会话 + 目录/标记 + 刷新/搜索
 * + new」一行放得下（都是 shrink-0，再窄会被 aside 的 overflow-hidden
 * 裁掉）；上限 560 避免主滚动区在 1280px 屏幕上被压得过窄。
 */

import { loadStr, saveStr } from './storage'
import { KEY } from './keys'

export const SIDEBAR_DEFAULT_WIDTH = 288
export const SIDEBAR_MIN_WIDTH = 260
export const SIDEBAR_MAX_WIDTH = 560

/** 任意输入 → 合法宽度；非数值回落默认值（存储里可能是脏数据）。 */
export function clampSidebarWidth(width: unknown): number {
  const n = typeof width === 'number' ? width : Number(width)
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n)))
}

/** 读持久化宽度；缺失/损坏都回落默认值。 */
export function loadSidebarWidth(): number {
  const raw = loadStr(KEY.sidebarWidth)
  return raw == null || raw.trim() === '' ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(raw)
}

export function saveSidebarWidth(width: number): void {
  saveStr(KEY.sidebarWidth, String(clampSidebarWidth(width)))
}
