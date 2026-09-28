import { beforeEach, describe, expect, it, vi } from 'vitest'

// 参数要写出元组，否则 mock.calls[0][1] 会被 tsc -b 判越界（见 AGENTS.md）。
const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(
    async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('apiFetch 未被本用例桩住')
    },
  ),
}))

vi.mock('./client', () => ({ transport: { apiFetch } }))

import { createLocalDir, listLocalDirs } from './localFs'

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sentBody(call = 0): Record<string, unknown> {
  const init = apiFetch.mock.calls[call][1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

beforeEach(() => {
  apiFetch.mockReset()
})

describe('listLocalDirs', () => {
  it('POST /api/local/dirs 带 path，返回宿主原生路径与子目录', async () => {
    apiFetch.mockResolvedValue(
      reply({
        ok: true,
        path: 'D:\\aiwork',
        home: 'C:\\Users\\ben',
        dirs: [
          { name: 'src', path: 'D:\\aiwork\\src' },
          { name: 'bad' }, // 缺 path：丢掉
          'nope', // 不是对象：丢掉
        ],
      }),
    )

    const res = await listLocalDirs('/d/aiwork')

    expect(sentBody()).toEqual({ path: '/d/aiwork' })
    expect(apiFetch).toHaveBeenCalledWith('/api/local/dirs', expect.objectContaining({ method: 'POST' }))
    expect(res).toEqual({
      ok: true,
      path: 'D:\\aiwork',
      home: 'C:\\Users\\ben',
      dirs: [{ name: 'src', path: 'D:\\aiwork\\src' }],
    })
  })

  it('path 省略 → 发空串让宿主落主目录', async () => {
    apiFetch.mockResolvedValue(reply({ ok: true, path: '/home/u', home: '/home/u', dirs: [] }))
    await listLocalDirs()
    expect(sentBody()).toEqual({ path: '' })
  })

  it('路径不存在：host 的 400 + 人话 + 归一化后的 path 原样透出（弹窗据此拦下）', async () => {
    apiFetch.mockResolvedValue(
      reply({ ok: false, error: '目录不存在：D:\\aiwork（由 /d/aiwork 归一化）', path: 'D:\\aiwork' }, 400),
    )
    const res = await listLocalDirs('/d/aiwork')
    expect(res).toEqual({
      ok: false,
      error: '目录不存在：D:\\aiwork（由 /d/aiwork 归一化）',
      path: 'D:\\aiwork',
    })
  })

  it('旧 host 没这条端点（404）→ 提示升级 host，而不是干巴的 404', async () => {
    apiFetch.mockResolvedValue(reply({}, 404))
    const res = await listLocalDirs('/home/u')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('需要升级 host')
  })

  it('非 JSON 响应体降级成状态码文案；网络异常也变成人话', async () => {
    apiFetch.mockResolvedValue(new Response('boom', { status: 502 }))
    const res = await listLocalDirs('/home/u')
    if (!res.ok) expect(res.error).toContain('502')

    apiFetch.mockRejectedValue(new Error('Failed to fetch'))
    const res2 = await listLocalDirs('/home/u')
    expect(res2).toEqual({ ok: false, error: 'Failed to fetch' })
  })

  it('宿主没回 path → 算失败（弹窗不该拿空路径当目录）', async () => {
    apiFetch.mockResolvedValue(reply({ ok: true, dirs: [] }))
    const res = await listLocalDirs('/home/u')
    if (!res.ok) expect(res.error).toContain('没有返回目录路径')
    else throw new Error('want failure')
  })
})

describe('createLocalDir', () => {
  it('POST /api/local/mkdir 带 parent/name，返回新目录路径', async () => {
    apiFetch.mockResolvedValue(reply({ ok: true, path: 'D:\\aiwork\\newproj' }))
    const res = await createLocalDir('D:\\aiwork', 'newproj')
    expect(sentBody()).toEqual({ parent: 'D:\\aiwork', name: 'newproj' })
    expect(res).toEqual({ ok: true, path: 'D:\\aiwork\\newproj' })
  })

  it('重名（409）→ 透出 host 的冲突文案', async () => {
    apiFetch.mockResolvedValue(reply({ ok: false, error: '同名目录或文件已存在：/home/u/proj' }, 409))
    const res = await createLocalDir('/home/u', 'proj')
    expect(res).toEqual({ ok: false, error: '同名目录或文件已存在：/home/u/proj' })
  })

  it('旧 host 没这条端点（404）→ 提示升级 host', async () => {
    apiFetch.mockResolvedValue(reply({}, 404))
    const res = await createLocalDir('/home/u', 'proj')
    if (!res.ok) expect(res.error).toContain('需要升级 host')
    else throw new Error('want failure')
  })
})
