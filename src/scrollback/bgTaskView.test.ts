// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { preambleDescLines, taskViewToEntry } from './bgTaskView'
import type { ViewerTask } from '../store/chat/typesPublic'

describe('preambleDescLines', () => {
  it('空描述返回空数组', () => {
    expect(preambleDescLines('  \n ')).toEqual([])
  })

  it('裁掉行尾空白并折叠连续空行', () => {
    expect(preambleDescLines('a  \n\n\n b \n\t\nc')).toEqual(['a', '', ' b', '', 'c'])
  })

  it('保留首尾非空行顺序', () => {
    expect(preambleDescLines('\nfirst\nsecond\n')).toEqual(['first', 'second'])
  })
})

describe('taskViewToEntry', () => {
  const base: ViewerTask = { taskId: '1234567890ab', output: 'hello' }

  it('无标题时用 taskId 前缀合成标题', () => {
    expect(taskViewToEntry(base).title).toBe('Task 12345678')
  })

  it('失败优先于运行中与完成', () => {
    const e = taskViewToEntry({ ...base, running: true, completed: true, failed: true })
    expect(e.status).toBe('failed')
    expect(e.running).toBe(true)
  })

  it('未结束且未失败为 started，结束后为 completed', () => {
    expect(taskViewToEntry({ ...base, running: true }).status).toBe('started')
    expect(taskViewToEntry({ ...base, completed: true }).status).toBe('completed')
  })

  it('保留视图里的标题 / 命令 / 输出与合成 id', () => {
    const e = taskViewToEntry({ ...base, title: 'Build', command: 'make' })
    expect(e).toMatchObject({
      id: 'task_1234567890ab',
      kind: 'bg_task',
      title: 'Build',
      command: 'make',
      output: 'hello',
    })
  })
})
