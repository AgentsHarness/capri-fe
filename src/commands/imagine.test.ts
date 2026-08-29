import { describe, expect, it, vi } from 'vitest'
import { beforeEach } from 'vitest'

vi.mock('../store/chat', () => ({
  useChatStore: {
    getState: vi.fn(),
    setState: vi.fn(),
  },
}))
vi.mock('../store/promptQueue', () => ({
  usePromptQueue: {
    getState: vi.fn(),
  },
}))

import { useChatStore } from '../store/chat'
import { usePromptQueue } from '../store/promptQueue'
import { slashCommands } from './registry'
import {
  IMAGE_GEN_TOOL_NAME,
  IMAGE_TO_VIDEO_TOOL_NAME,
  imagineInstruction,
  imagineUsageMessage,
  imagineVideoInstruction,
  imagineVideoUsageMessage,
} from './imagine'

interface FakeChat {
  conn: string
  sessionId: string | null
  appendLocalEntry: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

let fake: FakeChat

beforeEach(() => {
  fake = {
    conn: 'idle',
    sessionId: 's1',
    appendLocalEntry: vi.fn(),
    send: vi.fn(() => Promise.resolve()),
  }
  vi.mocked(useChatStore.getState).mockReturnValue(fake as never)
  vi.mocked(useChatStore.setState).mockImplementation((partial) => {
    Object.assign(fake, partial as unknown as Record<string, unknown>)
    return fake as never
  })
  vi.mocked(usePromptQueue.getState).mockReturnValue({
    enqueue: vi.fn(),
  } as never)
})

const run = (name: string, args = '') => {
  const cmd = slashCommands.find((c) => c.name === name)
  if (!cmd) throw new Error(`no command ${name}`)
  return cmd.run(args)
}

const queued = () => vi.mocked(usePromptQueue.getState)()

describe('imagineInstruction / imagineUsageMessage', () => {
  it('usage 与 xai-grok-tools-api 原文一致', () => {
    expect(imagineUsageMessage()).toBe(
      'Usage: /imagine <description>\nProvide a text description to generate an image.',
    )
  })

  it('指令：要求立即调用 image_gen、prompt 逐字嵌入、产物回呈现位置', () => {
    const text = imagineInstruction('一只戴帽子的柴犬')
    expect(text).toContain('Call the image_gen tool immediately')
    expect(text).toContain('verbatim')
    expect(text).toContain('where the image was saved')
    expect(text).toContain(`Prompt: 一只戴帽子的柴犬`)
  })

  it('空白/超长 prompt 原样嵌入（trim 是调用方职责，与 TUI run 一致）', () => {
    const long = 'x'.repeat(5000)
    const text = imagineInstruction(`  ${long}  `)
    expect(text).toContain(`Prompt:   ${long}  `)
    expect(text.length).toBeGreaterThan(5000)
  })
})

describe('imagineVideoInstruction / imagineVideoUsageMessage', () => {
  it('usage 与 xai-grok-tools-api 原文一致', () => {
    expect(imagineVideoUsageMessage()).toBe(
      'Usage: /imagine-video <description>\nProvide a text description to generate a video.',
    )
  })

  it('视频工作流要点齐全：image_to_video 默认、reference_to_video 按需、aspect_ratio/时长/产物路径', () => {
    const text = imagineVideoInstruction('a cat playing piano')
    expect(text).toContain('User prompt: a cat playing piano')
    expect(text).toContain(IMAGE_GEN_TOOL_NAME)
    expect(text).toContain(IMAGE_TO_VIDEO_TOOL_NAME)
    expect(text).toContain('reference_to_video')
    expect(text).toContain('aspect_ratio')
    expect(text).toContain('6s or 10s')
    expect(text).toContain('mention the final output path')
    expect(IMAGE_TO_VIDEO_TOOL_NAME).toBe('image_to_video')
  })
})

describe('slash command runs — /imagine', () => {
  it('无参数（含纯空白）→ note() 输出 usage，不发请求', () => {
    run('imagine')
    run('imagine', '   ')
    expect(fake.appendLocalEntry).toHaveBeenCalledTimes(2)
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'session_event',
      text: imagineUsageMessage(),
    })
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('有参数 → 显示文本与内容块分离：send 收到 /imagine 原文 + image_gen 指令块', () => {
    run('imagine', '  一只戴帽子的柴犬  ')
    expect(fake.send).toHaveBeenCalledTimes(1)
    expect(fake.send).toHaveBeenCalledWith(
      '/imagine 一只戴帽子的柴犬',
      [{ type: 'text', text: imagineInstruction('一只戴帽子的柴犬') }],
    )
    // 分离生效：显示文本不是指令文本，指令只在 blocks 里。
    const [display, blocks] = fake.send.mock.calls[0] as [
      string,
      Array<{ type: string; text: string }>,
    ]
    expect(display).toBe('/imagine 一只戴帽子的柴犬')
    expect(display).not.toContain('image_gen')
    expect(blocks[0].text).toContain(IMAGE_GEN_TOOL_NAME)
    expect(blocks[0].text).toContain('一只戴帽子的柴犬')
  })

  it('busy（回合进行中）→ 走 prompt 队列（/loop 同款），不打断当前回合', () => {
    fake.conn = 'busy'
    run('imagine', '一只戴帽子的柴犬')
    expect(fake.send).not.toHaveBeenCalled()
    expect(queued().enqueue).toHaveBeenCalledWith(
      {
        text: '/imagine 一只戴帽子的柴犬',
        blocks: [{ type: 'text', text: imagineInstruction('一只戴帽子的柴犬') }],
      },
      's1',
    )
  })
})

describe('slash command runs — /imagine-video', () => {
  it('无参数 → note() 输出 video usage，不发请求', () => {
    run('imagine-video')
    expect(fake.appendLocalEntry).toHaveBeenCalledWith({
      kind: 'session_event',
      text: imagineVideoUsageMessage(),
    })
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('有参数 → send 收到 /imagine-video 原文 + 视频工作流指令块', () => {
    run('imagine-video', 'a cat playing piano')
    expect(fake.send).toHaveBeenCalledWith(
      '/imagine-video a cat playing piano',
      [{ type: 'text', text: imagineVideoInstruction('a cat playing piano') }],
    )
    const [, blocks] = fake.send.mock.calls[0] as [
      string,
      Array<{ type: string; text: string }>,
    ]
    expect(blocks[0].text).toContain(IMAGE_TO_VIDEO_TOOL_NAME)
  })
})