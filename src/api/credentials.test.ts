import { afterEach, describe, expect, it } from 'vitest'
import {
  PAGE_SLOT,
  adoptSharedToken,
  dropHost,
  loadGuestToken,
  loadHostToken,
  loadHostTokens,
  loadHubToken,
  loadRouteChoices,
  saveGuestToken,
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
    expect(localStorage.getItem('capri-fe.token')).toBeNull()
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

describe('访客槽与管理员槽互不覆盖', () => {
  afterEach(() => localStorage.clear())

  it('写访客令牌不动 hub 槽，写 hub 令牌不动访客槽', () => {
    saveGuestToken('g_tok')
    expect(loadHubToken()).toBe('')
    saveHubToken('admin-key')
    expect(loadGuestToken()).toBe('g_tok')
    saveHubToken('')
    expect(loadGuestToken()).toBe('g_tok')
  })

  it('清空访客令牌留下空串，hub 槽不受影响', () => {
    saveHubToken('admin-key')
    saveGuestToken('g_tok')
    saveGuestToken('  ')
    expect(loadGuestToken()).toBe('')
    expect(loadHubToken()).toBe('admin-key')
  })
})

/**
 * 分享链接采纳：`#g=<token>` 写进**访客槽**、fragment 立刻清掉。管理员那把
 * 留在 hub 槽不动——两个身份各有自己的格子，退出访客直接切回去即可，不需要
 * 备份/恢复。
 */
describe('访客分享链接（#g=）', () => {
  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    history.replaceState(null, '', '/')
  })

  it('采纳 fragment 里的令牌进访客槽、清掉 hash、不动管理员那把', () => {
    saveHubToken('admin-key')
    history.replaceState(null, '', '/#g=g_guest_token')

    expect(adoptSharedToken()).toBe('g_guest_token')

    // 令牌进访客槽（切到访客视图时出示这把）
    expect(loadGuestToken()).toBe('g_guest_token')
    // 管理员那把原封不动
    expect(loadHubToken()).toBe('admin-key')
    // fragment 被清掉：刷新 / 复制地址都不再带令牌
    expect(location.hash).toBe('')
  })

  it('重复采纳同一个令牌：幂等', () => {
    saveGuestToken('g_same')
    history.replaceState(null, '', '/#g=g_same')
    adoptSharedToken()
    expect(loadGuestToken()).toBe('g_same')
  })

  it('没有 #g= 时不动任何槽', () => {
    saveHubToken('admin-key')
    saveGuestToken('g_kept')
    history.replaceState(null, '', '/#g=')
    expect(adoptSharedToken()).toBeNull()
    expect(loadHubToken()).toBe('admin-key')
    expect(loadGuestToken()).toBe('g_kept')
  })

  it('URL 编码的令牌按原文采纳', () => {
    history.replaceState(null, '', '/#g=g_a%2Bb')
    expect(adoptSharedToken()).toBe('g_a+b')
    expect(loadGuestToken()).toBe('g_a+b')
  })
})
