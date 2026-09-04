import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { applyToolsetSettings, ensureToolsetSettings } from '../store/settings'
import { QuestionModal } from './QuestionModal'

const transportMock = vi.hoisted(() => ({
  settings: vi.fn(),
  onEvent: () => () => {},
}))
vi.mock('../api/client', () => ({ transport: transportMock }))

const respondXaiMock = vi.fn(async () => {})
const dismissXaiMock = vi.fn(async () => {})

const ANCHOR_ID = 'capri-xai-question-anchor'

/** 一张单题卡片（requestId r1）。卡片 portal 到 Composer 的 anchor。 */
function renderCard(params: Record<string, unknown>) {
  if (!document.getElementById(ANCHOR_ID)) {
    const anchor = document.createElement('div')
    anchor.id = ANCHOR_ID
    document.body.appendChild(anchor)
  }
  useChatStore.setState({
    xaiRequests: [
      {
        requestId: 'r1',
        method: 'x.ai/ask_user_question',
        params: {
          questions: [
            {
              question: 'Q?',
              options: [{ label: 'A', description: 'opt A' }],
            },
          ],
          ...params,
        },
      },
    ],
    respondXai: respondXaiMock,
    dismissXai: dismissXaiMock,
  })
  return render(<QuestionModal />)
}

afterEach(() => {
  applyToolsetSettings(undefined)
  transportMock.settings.mockReset()
  transportMock.settings.mockResolvedValue({})
  document.getElementById(ANCHOR_ID)?.remove()
  document.body.querySelectorAll('input').forEach((el) => el.remove())
})

describe('QuestionModal timeout 呈现', () => {
  it('wire 无 deadline + 配置开启 → 按配置秒数实时倒计时并逐秒递减', async () => {
    vi.useFakeTimers()
    try {
      transportMock.settings.mockResolvedValue({
        toolset: { ask_user_question: { timeout_enabled: true, timeout_secs: 45 } },
      })
      await ensureToolsetSettings()
      renderCard({})
      const status = () => screen.getByRole('status')
      // deadline = 请求到达 + 45s，先显示满值。
      expect(status().textContent).toContain('提问倒计时 0:45')
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(status().textContent).toContain('提问倒计时 0:40')
    } finally {
      vi.useRealTimers()
    }
  })

  it('wire 无 deadline + timeout 关闭 → 不显示任何超时提示', async () => {
    transportMock.settings.mockResolvedValue({
      toolset: { ask_user_question: { timeout_enabled: false, timeout_secs: 45 } },
    })
    await ensureToolsetSettings()
    renderCard({})
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull())
    expect(screen.queryByText(/自动放弃/)).toBeNull()
    expect(screen.queryByText(/倒计时|超时/)).toBeNull()
  })

  it('wire 无 deadline + 未配置 → 按 agent 默认 1800 秒倒计时', async () => {
    transportMock.settings.mockResolvedValue({})
    await ensureToolsetSettings()
    renderCard({})
    // 1800s = 30:00。
    expect(screen.getByRole('status').textContent).toContain('提问倒计时 30:00')
  })

  it('wire 带 deadlineAt（未来扩展）→ 真实倒计时，到点等待 agent 收尾', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      transportMock.settings.mockResolvedValue({})
      await ensureToolsetSettings()
      renderCard({ deadlineAt: 1_700_000_000_000 + 120_000 })
      const status = () => screen.getByRole('status')
      expect(status().textContent).toContain('提问倒计时 2:00')
      // 推进过 deadline：倒计时归零，等待 agent 收尾（FE 不自动应答）
      act(() => {
        vi.advanceTimersByTime(121_000)
      })
      expect(status().textContent).toContain('提问已超时，等待 agent 收尾…')
      expect(respondXaiMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('wire deadlineAt 已过期 → 直接显示已超时（保留过期 deadline，不回退配置预算）', async () => {
    transportMock.settings.mockResolvedValue({
      toolset: { ask_user_question: { timeout_enabled: true, timeout_secs: 45 } },
    })
    await ensureToolsetSettings()
    renderCard({ deadlineAt: 1000 }) // 早已过期
    await waitFor(() =>
      expect(screen.getByText('提问已超时，等待 agent 收尾…')).not.toBeNull(),
    )
    expect(screen.queryByText(/倒计时/)).toBeNull()
  })
})
describe('QuestionModal 键盘选择 + 提交', () => {
  beforeEach(() => {
    respondXaiMock.mockClear()
    dismissXaiMock.mockClear()
  })

  const twoOptions = {
    questions: [
      {
        question: 'Q?',
        options: [
          { label: 'A', description: 'opt A' },
          { label: 'B', description: 'opt B' },
        ],
      },
    ],
  }

  it('最后一题按 Enter → 提交刚选中的那一项（不是上一次渲染的旧选择）', async () => {
    renderCard(twoOptions)
    await waitFor(() => expect(screen.getByText('Q?')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'Q?': ['A'] },
      }),
    )
  })

  it('点击选项直接选中该项并提交', async () => {
    renderCard(twoOptions)
    await waitFor(() => expect(screen.getByText('Q?')).not.toBeNull())
    fireEvent.click(screen.getByText('B'))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'Q?': ['B'] },
      }),
    )
  })

  it('多题：第一题 Enter 只前进到下一题，最后一题才提交（含各题选择）', async () => {
    renderCard({
      questions: [
        { question: 'Q1?', options: [{ label: 'A1' }, { label: 'A2' }] },
        { question: 'Q2?', options: [{ label: 'B1' }, { label: 'B2' }] },
      ],
    })
    await waitFor(() => expect(screen.getByText('Q1?')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(respondXaiMock).not.toHaveBeenCalled()
    // 前进到第二题，聚焦第 2 项后 Enter → 提交两题
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'Q1?': ['A1'], 'Q2?': ['B2'] },
      }),
    )
  })

  it('多选卡片：Space 切换不提交，提交按钮走当前选择', async () => {
    renderCard({
      questions: [
        { question: 'M?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      ],
    })
    await waitFor(() => expect(screen.getByText('M?')).not.toBeNull())
    fireEvent.keyDown(window, { key: ' ' })
    expect(respondXaiMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'M?': ['X'] },
      }),
    )
  })

  it('选项无 preview 时不渲染预览容器', async () => {
    renderCard({
      questions: [
        { question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    })
    await waitFor(() => expect(screen.getByText('Q?')).not.toBeNull())
    expect(screen.queryByText('选项说明')).toBeNull()
  })

  it('存在 preview 选项时预留固定预览框，切换选项时稳定展示相应预览或占位', async () => {
    renderCard({
      questions: [
        {
          question: 'Q?',
          options: [
            { label: 'Opt1', preview: 'Preview content 1' },
            { label: 'Opt2' },
          ],
        },
      ],
    })
    await waitFor(() => expect(screen.getByText('Q?')).not.toBeNull())
    // 初始游标在 Opt1，展示预览框及 Opt1 说明
    expect(screen.getByText(/选项说明/)).not.toBeNull()
    expect(screen.getByText('Preview content 1')).not.toBeNull()

    // 移动游标至 Opt2（无 preview）：预览框不消失，展示占位文案
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByText('该选项无详细说明')).not.toBeNull())
    expect(screen.getByText(/选项说明/)).not.toBeNull()
  })
})
