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
      headless: false,
      viewport: { width: 1280, height: 860 }
    })
    try {
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(timeoutMs)
      return {
        success: true,
        message: `${spec.name} 登录窗口已关闭，登录态已保存到独立 Profile`,
        profile
      }
    } finally {
      await context.close()
    }
  }
}
