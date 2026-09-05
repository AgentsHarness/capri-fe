import { describe, expect, it, vi } from 'vitest'
import { gitRpc } from './git'
import type { TransportCore } from '../transport'

function coreWithShell(stdout: string, status = 200): TransportCore & { fetch: ReturnType<typeof vi.fn> } {
  return {
    mode: 'local',
    url: (path) => `http://host.test${path}`,
    apiBase: () => 'http://host.test',
    prefsOrigin: () => 'http://host.test',
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, exitCode: 0, stdout }), { status }),
    ),
  }
}

describe('gitRpc.gitLog host shell adapter', () => {
  it('通过 host shell 执行 git log，并解析父提交与引用', async () => {
    const stdout = [
      'abcdef1234567890\x00abcdef1\x00Alice\x00alice@example.com\x001700000000\x001111111 222222222\x00HEAD -> main, origin/main\x00merge commit\x1e',
      '1111111111111111\x001111111\x00Bob\x00bob@example.com\x001699999000\x00\x00\x00first commit\x1e',
    ].join('')
    const core = coreWithShell(stdout)

    const result = await gitRpc.gitLog.call(core, {
      cwd: '/work',
      maxCount: 20,
      skip: 2,
      branch: 'feature/mobile git',
    })

    expect(result).toEqual({
      ok: true,
      commits: [
        {
          hash: 'abcdef1234567890',
          shortHash: 'abcdef1',
          author: 'Alice',
          email: 'alice@example.com',
          timestamp: 1700000000,
          date: new Date(1700000000 * 1000).toISOString(),
          parents: ['1111111', '222222222'],
          refs: 'HEAD -> main, origin/main',
          message: 'merge commit',
        },
        {
          hash: '1111111111111111',
          shortHash: '1111111',
          author: 'Bob',
          email: 'bob@example.com',
          timestamp: 1699999000,
          date: new Date(1699999000 * 1000).toISOString(),
          message: 'first commit',
          parents: [],
        },
      ],
    })
    expect(core.fetch).toHaveBeenCalledWith(
      'http://host.test/api/shell',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('git log --max-count=20 --skip=2'),
      }),
    )
    const body = JSON.parse(core.fetch.mock.calls[0][1].body as string) as { command: string; cwd: string }
    expect(body).toMatchObject({ cwd: '/work' })
    // branch 作为 revision 参数（历史上误作 pathspec `-- <branch>`）
    expect(body.command).toContain("'feature/mobile git'")
    expect(body.command).not.toContain('-- ')
  })

  it('解析多行 body 并去除尾部换行；空 body 省略字段', async () => {
    const stdout =
      'aaa\x00aaa\x00A\x00a@x\x001700000000\x00\x00\x00subject line\x00body line1\nbody line2\n\x1e' +
      'bbb\x00bbb\x00B\x00b@x\x001700000001\x00\x00\x00no body\x00\n\x1e'
    const core = coreWithShell(stdout)

    const result = await gitRpc.gitLog.call(core, { cwd: '/work' })
    expect(result.commits[0]).toMatchObject({ message: 'subject line', body: 'body line1\nbody line2' })
    expect(result.commits[1]).not.toHaveProperty('body')
    const body = JSON.parse(core.fetch.mock.calls[0][1].body as string) as { command: string }
    expect(body.command).toContain('%s%x00%b%x1e')
  })

  it('range 优先于 branch 作为 revision 参数（未推送列表用）', async () => {
    const core = coreWithShell('')
    await gitRpc.gitLog.call(core, { cwd: '/work', range: '@{upstream}..HEAD', branch: 'main' })
    const body = JSON.parse(core.fetch.mock.calls[0][1].body as string) as { command: string }
    expect(body.command).toContain("'@{upstream}..HEAD'")
    expect(body.command).not.toContain("'main'")
  })

  it('host 返回非零退出码时抛出 git 错误', async () => {
    const core = coreWithShell('', 200)
    core.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, exitCode: 128, stderr: 'not a git repository' }), {
        status: 200,
      }),
    )

    await expect(gitRpc.gitLog.call(core, { cwd: '/tmp' })).rejects.toThrow('not a git repository')
  })
})

describe('gitRpc.gitRepoState', () => {
  it('POST /api/git/state 并返回 state', async () => {
    const state = {
      mergeInProgress: true,
      rebaseInProgress: false,
      cherryPickInProgress: false,
      conflicts: ['f.txt'],
      conflictCount: 1,
    }
    const core = {
      mode: 'local',
      url: (path: string) => `http://host.test${path}`,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, state }), { status: 200 })),
    } as unknown as TransportCore & { fetch: ReturnType<typeof vi.fn> }

    const result = await gitRpc.gitRepoState.call(core, { cwd: '/work' })
    expect(result).toEqual(state)
    expect(core.fetch).toHaveBeenCalledWith(
      'http://host.test/api/git/state',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ cwd: '/work' }) }),
    )
  })

  it('非 git 目录 → 抛错', async () => {
    const core = {
      mode: 'local',
      url: (path: string) => `http://host.test${path}`,
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: 'fatal: not a git repository' }), { status: 200 }),
      ),
    } as unknown as TransportCore & { fetch: ReturnType<typeof vi.fn> }

    await expect(gitRpc.gitRepoState.call(core, { cwd: '/tmp' })).rejects.toThrow('not a git repository')
  })
})
