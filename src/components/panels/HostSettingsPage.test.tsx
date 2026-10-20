import { describe, expect, it } from 'vitest'
import { credentialMatchesField, normalizeHubURL, saveNeedsRestart, saveStatusText } from './HostSettingsPage'

describe('Host 设置保存', () => {
  it('显示名改动不要求重启', () => {
    expect(saveNeedsRestart({ host_name: 'a' }, { host_name: 'b' })).toBe(false)
  })

  it('端口、绑定、钥匙、代理、grok 路径要求重启', () => {
    expect(saveNeedsRestart({ port: 8765 }, { port: 8766 })).toBe(true)
    expect(saveNeedsRestart({ bind: '127.0.0.1' }, { bind: '0.0.0.0' })).toBe(true)
    expect(saveNeedsRestart({ fe_token: '' }, { fe_token: 'k' })).toBe(true)
    expect(saveNeedsRestart({ proxy: '' }, { proxy: 'http://127.0.0.1:7890' })).toBe(true)
    expect(saveNeedsRestart({ no_proxy: '' }, { no_proxy: 'localhost' })).toBe(true)
    expect(saveNeedsRestart({ grok_bin: '' }, { grok_bin: '/usr/bin/grok' })).toBe(true)
  })

  it('不写协议的地址和已存的 https 地址算同一个 Hub', () => {
    expect(normalizeHubURL('hub.example.com')).toBe('https://hub.example.com')
    expect(credentialMatchesField('hub.example.com', 'https://hub.example.com')).toBe(true)
    expect(credentialMatchesField('https://other.example', 'https://hub.example.com')).toBe(false)
  })

  it('保存成功后提示手动重启，不声称 Host 正在重启', () => {
    expect(saveStatusText(false)).toBe('已保存。')
    const text = saveStatusText(true)
    expect(text).toContain('已保存')
    expect(text).toContain('托盘菜单')
    expect(text).not.toContain('正在重启')
  })
})
