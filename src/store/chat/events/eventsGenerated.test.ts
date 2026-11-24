import { describe, expect, it } from 'vitest'
import { HOST_EVENT_TRAITS, SILENT_HOST_TYPES } from '../../../api/types/events.generated'
import { SILENT_HOST_EVENT_TYPES } from './kinds'

/**
 * events.generated.ts 来自 acp-hub/wire/events/events.json；kinds.ts 的
 * SILENT_HOST_EVENT_TYPES 保留逐条 DEV 理由。两边必须一致：generated 里
 * 标成 ignored 的每一条都要有理由，标成其它 render 的都不能混进静默表。
 */
describe('events.generated 与静默清单一致', () => {
  it('每个生成期静默类型都有登记理由', () => {
    const missing = [...SILENT_HOST_TYPES].filter((t) => !SILENT_HOST_EVENT_TYPES.has(t))
    expect(missing).toEqual([])
  })

  it('非 ignored 的生成类型不在静默清单里', () => {
    const stray = Object.entries(HOST_EVENT_TRAITS)
      .filter(([type, trait]) => trait.render !== 'ignored' && SILENT_HOST_EVENT_TYPES.has(type))
      .map(([type]) => type)
    expect(stray).toEqual([])
  })
})
