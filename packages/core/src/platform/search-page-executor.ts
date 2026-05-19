import type { SearchResult } from '../domain/types.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'

export interface SearchPageExecutor {
  fetchHtml(url: string, platformKey: string): Promise<string>
  fetchRenderedHtml?(url: string, platformKey: string, options?: RenderPageOptions): Promise<string>
  fetchText?(url: string, platformKey: string, options?: FetchTextOptions): Promise<string>
}

export interface RenderPageOptions {
  scrollSteps?: number
  scrollDelayMs?: number
  expandText?: string[]
  commentSort?: 'newest'
}

export interface FetchTextOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export class DisabledSearchPageExecutor implements SearchPageExecutor {
  async fetchHtml(): Promise<string> {
    return ''
  }
}

export class PlaywrightSearchPageExecutor implements SearchPageExecutor {
  private browser?: BrowserContextManager

  constructor(browser?: BrowserContextManager) {
    this.browser = browser
  }

  async fetchHtml(url: string, platformKey = 'default'): Promise<string> {
    const { chromium } = await import('playwright')
    const context = this.browser
      ? await chromium.launchPersistentContext(this.browser.profileFor(platformKey).userDataDir, { executablePath: chromium.executablePath(), headless: true })
      : await chromium.launchPersistentContext('', { executablePath: chromium.executablePath(), headless: true })
    try {
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(800)
      return await page.content()
    } finally {
      await context.close()
    }
  }

  async fetchRenderedHtml(url: string, platformKey: string, options: RenderPageOptions = {}): Promise<string> {
    const { chromium } = await import('playwright')
    const context = this.browser
      ? await chromium.launchPersistentContext(this.browser.profileFor(platformKey).userDataDir, { executablePath: chromium.executablePath(), headless: true })
      : await chromium.launchPersistentContext('', { executablePath: chromium.executablePath(), headless: true })
    try {
      const page = context.pages()[0] ?? await context.newPage()
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(800)
      if (options.commentSort === 'newest') {
        await trySelectYoutubeNewestComments(page)
      }
      const steps = Math.max(1, Math.floor(options.scrollSteps ?? (platformKey === 'youtube' ? 8 : 3)))
      const delay = Math.max(0, Math.floor(options.scrollDelayMs ?? 650))
      for (let index = 0; index < steps; index += 1) {
        await page.evaluate(() => window.scrollBy(0, Math.max(document.documentElement.clientHeight, 900)))
        await page.waitForTimeout(delay)
      }
      const expandText = options.expandText ?? (platformKey === 'youtube' ? ['Show more', 'Read more', '展开', '更多'] : [])
      if (expandText.length > 0) {
        await page.evaluate((labels) => {
          const normalized = labels.map((label) => label.toLowerCase())
          const buttons = [...document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape button')]
          for (const button of buttons.slice(0, 80)) {
            const text = button.textContent?.trim().toLowerCase() ?? ''
            if (!text || !normalized.some((label) => text.includes(label))) continue
            ;(button as HTMLElement).click()
          }
        }, expandText)
        await page.waitForTimeout(500)
      }
      return await page.content()
    } finally {
      await context.close()
    }
  }

  async fetchText(url: string, platformKey: string, options: FetchTextOptions = {}): Promise<string> {
    const { chromium } = await import('playwright')
    const context = this.browser
      ? await chromium.launchPersistentContext(this.browser.profileFor(platformKey).userDataDir, { executablePath: chromium.executablePath(), headless: true })
      : await chromium.launchPersistentContext('', { executablePath: chromium.executablePath(), headless: true })
    try {
      const response = await context.request.fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        data: options.body,
        timeout: 30000
      })
      return await response.text()
    } finally {
      await context.close()
    }
  }
}

async function trySelectYoutubeNewestComments(page: { evaluate: <T, A>(pageFunction: (arg: A) => T, arg: A) => Promise<T>; waitForTimeout: (timeout: number) => Promise<void> }): Promise<void> {
  const clickedSort = await page.evaluate((labels) => {
    const normalized = labels.map((label) => label.toLowerCase())
    const candidates = [...document.querySelectorAll('button, tp-yt-paper-button, yt-sort-filter-sub-menu-renderer')]
    for (const candidate of candidates.slice(0, 120)) {
      const text = candidate.textContent?.trim().toLowerCase() ?? ''
      const aria = candidate.getAttribute('aria-label')?.toLowerCase() ?? ''
      if (!normalized.some((label) => text.includes(label) || aria.includes(label))) continue
      ;(candidate as HTMLElement).click()
      return true
    }
    return false
  }, ['sort by', '排序'])
  if (!clickedSort) return
  await page.waitForTimeout(350)
  await page.evaluate((labels) => {
    const normalized = labels.map((label) => label.toLowerCase())
    const candidates = [...document.querySelectorAll('tp-yt-paper-item, ytd-menu-service-item-renderer, yt-formatted-string, button')]
    for (const candidate of candidates.slice(0, 160)) {
      const text = candidate.textContent?.trim().toLowerCase() ?? ''
      if (!normalized.some((label) => text.includes(label))) continue
      ;(candidate as HTMLElement).click()
      return true
    }
    return false
  }, ['newest first', 'latest', '最新'])
  await page.waitForTimeout(700)
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeResultUrl(rawUrl: string): string | null {
  try {
    if (rawUrl.startsWith('/url?') || rawUrl.startsWith('https://www.google.com/url?')) {
      const url = new URL(rawUrl, 'https://www.google.com')
      const target = url.searchParams.get('q') || url.searchParams.get('url')
      return target && /^https?:\/\//i.test(target) ? target : null
    }
    if (rawUrl.startsWith('/')) return null
    if (!/^https?:\/\//i.test(rawUrl)) return null
    return rawUrl
  } catch {
    return null
  }
}

const platformResultBases: Record<string, string> = {
  douyin: 'https://www.douyin.com',
  xiaohongshu: 'https://www.xiaohongshu.com',
  tiktok: 'https://www.tiktok.com',
  instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com',
  twitter: 'https://x.com',
  reddit: 'https://www.reddit.com',
  weibo: 'https://weibo.com',
  zhihu: 'https://www.zhihu.com',
  kuaishou: 'https://www.kuaishou.com'
}

const platformResultDomains: Record<string, string[]> = {
  douyin: ['douyin.com', 'iesdouyin.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.watch'],
  twitter: ['x.com', 'twitter.com'],
  reddit: ['reddit.com'],
  weibo: ['weibo.com'],
  zhihu: ['zhihu.com'],
  kuaishou: ['kuaishou.com']
}

function normalizePlatformResultUrl(platformKey: string, rawUrl: string): string | null {
  try {
    const base = platformResultBases[platformKey]
    const normalized = rawUrl.startsWith('/') && base
      ? new URL(rawUrl, base).toString()
      : normalizeResultUrl(rawUrl)
    if (!normalized) return null
    const host = new URL(normalized).hostname.toLowerCase()
    const domains = platformResultDomains[platformKey]
    if (domains && !domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return null
    return normalized
  } catch {
    return null
  }
}

function isBlockedUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return (
    lower.includes('/search?') ||
    lower.includes('accounts.google') ||
    lower.includes('support.google') ||
    lower.includes('policies.google') ||
    lower.includes('webcache.googleusercontent') ||
    lower.includes('bing.com/search') ||
    lower.includes('go.microsoft.com') ||
    lower.includes('/login') ||
    lower.includes('/signin')
  )
}

function buildResult(platformKey: string, url: string, title: string, snippet: string, index: number): SearchResult {
  return {
    id: `${platformKey}-${Buffer.from(`${url}-${index}`).toString('base64url')}`,
    platformKey,
    title: title.slice(0, 120),
    url,
    snippet: snippet.slice(0, 260),
    relevance: 0.4,
    createdAt: new Date().toISOString()
  }
}

function pushUnique(results: SearchResult[], result: SearchResult, limit: number): void {
  if (results.length >= limit) return
  if (results.some((item) => item.url === result.url)) return
  results.push(result)
}

function parseGoogleResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const blockPattern = /<div[^>]+class=["'][^"']*(?:g|MjjYud)[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*(?:g|MjjYud)[^"']*["']|<\/body>|$)/gi
  let block: RegExpExecArray | null
  let index = 0
  while ((block = blockPattern.exec(html)) && results.length < limit) {
    const body = block[1]
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(body)
    const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(body)
    if (!anchor || !heading) continue
    const url = normalizeResultUrl(decodeEntities(anchor[1]))
    const title = decodeEntities(stripTags(heading[1]))
    const snippetMatch = /<div[^>]+(?:class|data-sncf)=["'][^"']*(?:VwiC3b|IsZvec|kb0PBd|snippet)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(body)
    const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1])) : ''
    if (!url || isBlockedUrl(url) || !title) continue
    pushUnique(results, buildResult('google', url, title, snippet, index), limit)
    index += 1
  }
  return results
}

function parseBingResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const itemPattern = /<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  let item: RegExpExecArray | null
  let index = 0
  while ((item = itemPattern.exec(html)) && results.length < limit) {
    const body = item[1]
    const anchor = /<h2[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(body)
    if (!anchor) continue
    const url = normalizeResultUrl(decodeEntities(anchor[1]))
    const title = decodeEntities(stripTags(anchor[2]))
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(body)
    const snippet = snippetMatch ? decodeEntities(stripTags(snippetMatch[1])) : ''
    if (!url || isBlockedUrl(url) || !title) continue
    pushUnique(results, buildResult('bing', url, title, snippet, index), limit)
    index += 1
  }
  return results
}

function parseYoutubeResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const anchorPattern = /<a\b[^>]*(?:id=["']video-title["'][^>]*)?href=["']([^"']*\/watch\?v=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  let index = 0
  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const href = decodeEntities(match[1])
    const url = href.startsWith('http') ? href : `https://www.youtube.com${href.startsWith('/') ? '' : '/'}${href}`
    const titleAttr = /title=["']([^"']+)["']/i.exec(match[0])
    const title = decodeEntities(stripTags(titleAttr?.[1] || match[2]))
    if (!title) continue
    pushUnique(results, buildResult('youtube', url, title, '', index), limit)
    index += 1
  }
  return results
}

function parseBilibiliResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const anchorPattern = /<a\b[^>]*href=["']([^"']*(?:bilibili\.com\/video\/|\/video\/)BV[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  let index = 0
  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    let href = decodeEntities(match[1])
    if (href.startsWith('//')) href = `https:${href}`
    if (href.startsWith('/')) href = `https://www.bilibili.com${href}`
    const titleAttr = /title=["']([^"']+)["']/i.exec(match[0])
    const title = decodeEntities(stripTags(titleAttr?.[1] || match[2]))
    if (!/^https?:\/\//i.test(href) || !title) continue
    pushUnique(results, buildResult('bilibili', href, title, '', index), limit)
    index += 1
  }
  return results
}

export function parseSearchResultHtml(platformKey: string, html: string, limit: number): SearchResult[] {
  if (!html.trim()) return []
  if (platformKey === 'google') return parseGoogleResults(html, limit).slice(0, limit)
  if (platformKey === 'bing') return parseBingResults(html, limit).slice(0, limit)
  if (platformKey === 'youtube') return parseYoutubeResults(html, limit).slice(0, limit)
  if (platformKey === 'bilibili') return parseBilibiliResults(html, limit).slice(0, limit)

  const now = new Date().toISOString()
  const results: SearchResult[] = []
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  let index = 0

  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const rawUrl = normalizePlatformResultUrl(platformKey, decodeEntities(match[1]))
    const title = decodeEntities(stripTags(match[2]))
    if (!title || title.length < 3) continue
    if (!rawUrl || isBlockedUrl(rawUrl)) continue

    results.push({
      id: `${platformKey}-${Buffer.from(`${rawUrl}-${index}`).toString('base64url')}`,
      platformKey,
      title: title.slice(0, 120),
      url: rawUrl,
      snippet: '',
      relevance: 0.4,
      createdAt: now
    })
    index += 1
  }

  return results
}
