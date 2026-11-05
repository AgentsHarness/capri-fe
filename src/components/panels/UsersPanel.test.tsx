import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { UsersPanel } from './UsersPanel'

const { transportMock } = vi.hoisted(() => ({
  transportMock: {
    getConnectionMode: vi.fn(() => 'hub'),
    listUsers: vi.fn(),
  },
}))

vi.mock('../../api/client', () => ({ transport: transportMock }))
vi.mock('../../store/toast', () => ({ pushToast: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UsersPanel', () => {
  it('host 标签展示版本；老 host 无 version 时不渲染', async () => {
    transportMock.listUsers.mockResolvedValue([
      {
        id: 'u1',
        label: 'Alice',
        createdAt: 1760000000,
        hostCount: 2,
        hosts: [
          { hostId: 'h1', hostName: 'Office Mac', online: true, version: 'v0.5.0' },
          { hostId: 'h2', hostName: 'Old Mac', online: false },
        ],
      },
    ])

    render(<UsersPanel />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('Office Mac')).toBeInTheDocument()
    expect(screen.getByText('v0.5.0')).toBeInTheDocument()
    expect(screen.getByText('Old Mac')).toBeInTheDocument()
    expect(screen.getAllByText('在线')).toHaveLength(1)
  })
})
