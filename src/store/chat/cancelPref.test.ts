import { beforeEach, describe, expect, it } from 'vitest'
import { CANCEL_SUBAGENTS_PREF_KEY, loadCancelSubagentsPref } from './cancelPref'

describe('loadCancelSubagentsPref', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('无存储值 → null（不弹面板也不直接取消）', () => {
    expect(loadCancelSubagentsPref()).toBeNull()
  })

  it("'true' → true", () => {
    window.localStorage.setItem(CANCEL_SUBAGENTS_PREF_KEY, 'true')
    expect(loadCancelSubagentsPref()).toBe(true)
  })

  it("'false' → false", () => {
    window.localStorage.setItem(CANCEL_SUBAGENTS_PREF_KEY, 'false')
    expect(loadCancelSubagentsPref()).toBe(false)
  })

  it('非布尔字符串 → false', () => {
    window.localStorage.setItem(CANCEL_SUBAGENTS_PREF_KEY, 'yes')
    expect(loadCancelSubagentsPref()).toBe(false)
  })
})