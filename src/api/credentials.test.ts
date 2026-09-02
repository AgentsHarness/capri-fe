import { afterEach, describe, expect, it } from 'vitest'
import {
  PAGE_SLOT,
  dropHost,
  loadHostToken,
  loadHostTokens,
  loadHubToken,
  loadRouteChoices,
  saveHostToken,
  saveHubToken,
  saveRouteChoice,
} from './credentials'

/**
 * 两把钥匙两个槽是本整个方案的存储前提：hub 密钥与某台 host 的近路密钥
 * 必须互不覆盖，host 的钥匙按 hostId 分格存。
 */
describe('credentials 双槽', () => {
  afterEach(() => localStorage.clear())

  it('写 host 槽绝不动 hub 槽，反之亦然', () => {
    saveHubToken('hub-key')
    saveHostToken('mba', 'host-key')

    expect(loadHubToken()).toBe('hub-key')
    expect(loadHostToken('mba')).toBe('host-key')

    // hub 换密钥（服务端轮换 / 退出登录）不该抹掉任何一台 host 的钥匙
    saveHubToken('hub-key-2')
    expect(loadHostToken('mba')).toBe('host-key')

    // 反过来，某台 host 的钥匙被拒而清除，也不该影响 hub 槽
    saveHostToken('mba', '')
    expect(loadHostToken('mba')).toBe('')
    expect(loadHubToken()).toBe('hub-key-2')
  })

  it('各台 host 的钥匙互相独立', () => {
    saveHostToken('mba', 'k-mba')
    saveHostToken('mbp', 'k-mbp')
    expect(loadHostTokens()).toEqual({ mba: 'k-mba', mbp: 'k-mbp' })
    saveHostToken('mba', '')
    expect(loadHostTokens()).toEqual({ mbp: 'k-mbp' })
  })

  it('空串与首尾空白：写入即清除 / 被裁剪', () => {
    saveHubToken('  spaced  ')
    expect(loadHubToken()).toBe('spaced')
    saveHubToken('   ')
    expect(loadHubToken()).toBe('')
    expect(localStorage.getItem('capri-fe-token')).toBeNull()
  })

  it('存坏数据不炸（JSON 语法合法但类型非法）', () => {
    localStorage.setItem('capri-fe.hostTokens', '"not-a-map"')
    expect(loadHostTokens()).toEqual({})
    localStorage.setItem('capri-fe.hostTokens', '["a"]')
    expect(loadHostTokens()).toEqual({})
    localStorage.setItem('capri-fe.hostTokens', '{"mba":123,"mbp":" ok "}')
    expect(loadHostTokens()).toEqual({ mbp: 'ok' })
  })

  it('PAGE_SLOT 认不出 hostId 时的保留格', () => {
    saveHostToken(PAGE_SLOT, 'page-key')
    expect(loadHostToken(PAGE_SLOT)).toBe('page-key')
    // 保留格不能和真实 hostId 撞车
    expect(loadHostToken('@page')).toBe(loadHostToken(PAGE_SLOT))
  })

  it('dropHost：解除配对清掉钥匙与通路选择', () => {
    saveHostToken('mba', 'k')
    saveRouteChoice('mba', 'relay')
    expect(loadRouteChoices()).toEqual({ mba: 'relay' })
    dropHost('mba')
    expect(loadHostToken('mba')).toBe('')
    expect(loadRouteChoices()).toEqual({})
  })
})

describe('通路选择', () => {
  afterEach(() => localStorage.clear())

  it('auto 是「删掉覆盖」而不是存一个 auto', () => {
    saveRouteChoice('mba', 'relay')
    saveRouteChoice('mba', 'auto')
    expect(loadRouteChoices()).toEqual({})
  })

  it('只认 direct / relay，其余脏值丢弃', () => {
    localStorage.setItem('capri-fe.routeChoice', '{"a":"relay","b":"bogus","c":"direct"}')
    expect(loadRouteChoices()).toEqual({ a: 'relay', c: 'direct' })
  })
})
