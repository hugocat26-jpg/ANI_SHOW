import path from 'node:path'

import type { PlatformSpec, PlatformStatus } from '../domain/types.ts'

export interface BrowserProfileInfo {
  platformKey: string
  userDataDir: string
}

export interface LoginWindowResult {
  success: boolean
  message: string
  profile: BrowserProfileInfo
}

export class BrowserContextManager {
  private rootDir: string

  constructor(rootDir = path.join(process.cwd(), 'userData', 'profiles')) {
    this.rootDir = rootDir
  }

  profileFor(platformKey: string): BrowserProfileInfo {
    return {
      platformKey,
      userDataDir: path.join(this.rootDir, platformKey)
    }
  }

  createLoginHint(spec: PlatformSpec): string {
    if (!spec.requiresLogin && !spec.loginUrl) return `${spec.name} 通常无需登录即可搜索`
    if (!spec.requiresLogin && spec.loginUrl) return `${spec.name} 可选登录；登录态将保存在 ${this.profileFor(spec.key).userDataDir}`
    return `${spec.name} 需要用户在独立浏览器窗口中完成登录，登录态将保存在 ${this.profileFor(spec.key).userDataDir}`
  }

  inferStatusFromSpec(spec: PlatformSpec): PlatformStatus {
    return {
      platformKey: spec.key,
      available: true,
      loggedIn: !spec.requiresLogin,
      latencyMs: null,
      checkedAt: new Date().toISOString(),
      errorCode: spec.requiresLogin ? 'login_required' : 'ok',
      message: this.createLoginHint(spec)
    }
  }

  async openLoginWindow(spec: PlatformSpec, loginUrl?: string, timeoutMs = 10 * 60 * 1000): Promise<LoginWindowResult> {
    const profile = this.profileFor(spec.key)
    if (!spec.requiresLogin && !loginUrl) {
      return { success: true, message: `${spec.name} 无需登录`, profile }
    }
    if (!loginUrl) {
      return { success: false, message: `${spec.name} 未配置登录地址`, profile }
    }

    const { chromium } = await import('playwright')
    const context = await chromium.launchPersistentContext(profile.userDataDir, {
      executablePath: chromium.executablePath(),
      headless: false,
      viewport: { width: 1280, height: 860 }
    })
    try {
      const page = context.pages()[0] ?? await context.newPage()
      try {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      } catch (error) {
        return {
          success: false,
          message: `${spec.name} 登录页暂时无法打开：${readableBrowserError(error)}`,
          profile
        }
      }
      try {
        await waitForLoginWindowClose(context, timeoutMs)
      } catch (error) {
        if (!isBrowserClosedError(error)) throw error
      }
      return {
        success: true,
        message: `${spec.name} 登录窗口已关闭，正在复查登录态`,
        profile
      }
    } finally {
      await context.close()
    }
  }
}

async function waitForLoginWindowClose(context: { on: (event: 'close', listener: () => void) => void; off: (event: 'close', listener: () => void) => void }, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  await Promise.race([
    new Promise<void>((resolve) => {
      const onClose = () => {
        if (timeout) clearTimeout(timeout)
        context.off('close', onClose)
        resolve()
      }
      context.on('close', onClose)
      timeout = setTimeout(() => {
        context.off('close', onClose)
        resolve()
      }, timeoutMs)
    })
  ])
}

function isBrowserClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /Target page, context or browser has been closed|Browser has been closed|Context closed/i.test(message)
}

function readableBrowserError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/Call log:[\s\S]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/ERR_CONNECTION_CLOSED|ECONNRESET|socket hang up|Target page, context or browser has been closed/i.test(text)) {
    return '网络连接被平台关闭，可能是平台风控、代理/网络不稳定或访问被阻断；请稍后重试。'
  }
  if (/Timeout|timed out|Navigation timeout/i.test(text)) return '页面加载超时，请稍后重试。'
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(text)) return '域名解析失败，请检查网络、DNS 或代理设置。'
  return text || '未知网络错误'
}
