import { describe, expect, it } from 'vitest'
import { isRootedLocalPath, joinLocalPath, parentOfLocalPath } from './localPaths'

describe('isRootedLocalPath', () => {
  it('根 / ~ / 盘符 / UNC 算有起点', () => {
    for (const p of ['/home/u', '\\aiwork', '~', '~/proj', '~\\proj', 'C:/x', 'd:\\x', '//srv/share']) {
      expect(isRootedLocalPath(p)).toBe(true)
    }
  })

  it('相对路径（含 ./ 与单段）不算有起点', () => {
    for (const p of ['src', './src', '../x', '', '   ']) {
      expect(isRootedLocalPath(p)).toBe(false)
    }
  })
})

describe('joinLocalPath', () => {
  it('拼到当前目录上，丢掉尾部多余分隔符', () => {
    expect(joinLocalPath('/home/u', 'src')).toBe('/home/u/src')
    expect(joinLocalPath('/home/u/', 'src')).toBe('/home/u/src')
    expect(joinLocalPath('D:\\work', 'src')).toBe('D:\\work/src') // 交给 host 归一成 D:\work\src
  })

  it('还没有确认过的目录时原样返回相对草稿', () => {
    expect(joinLocalPath('', 'src')).toBe('src')
  })
})

describe('parentOfLocalPath', () => {
  it('POSIX：逐级向上，根没有上级', () => {
    expect(parentOfLocalPath('/home/u/ccwork')).toBe('/home/u')
    expect(parentOfLocalPath('/home/')).toBe('/')
    expect(parentOfLocalPath('/')).toBeUndefined()
    expect(parentOfLocalPath('  /home/u  ')).toBe('/home')
  })

  it('Windows：反斜杠与盘符（盘根没有上级）', () => {
    expect(parentOfLocalPath('D:\\aiwork\\src')).toBe('D:\\aiwork')
    expect(parentOfLocalPath('D:\\aiwork')).toBe('D:\\')
    expect(parentOfLocalPath('D:\\')).toBeUndefined()
    // 分隔符跟着输入走；正斜杠写法也照原样返回，host 再归一成 D:\
    expect(parentOfLocalPath('D:/aiwork')).toBe('D:/')
  })

  it('~ 与相对路径：单段没有上级', () => {
    expect(parentOfLocalPath('~/proj')).toBe('~')
    expect(parentOfLocalPath('~')).toBeUndefined()
    expect(parentOfLocalPath('src')).toBeUndefined()
    expect(parentOfLocalPath('')).toBeUndefined()
  })

  it('UNC：退到共享名', () => {
    expect(parentOfLocalPath('\\\\srv\\share\\dir')).toBe('\\\\srv\\share')
  })
})
