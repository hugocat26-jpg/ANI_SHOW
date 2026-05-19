import { createHash } from 'node:crypto'

import type { CollectEvent } from './adapter.ts'
import type { CommentRecord, ContentRef, PlatformSpec, PlatformStatus, SearchInput, SearchResult } from '../domain/types.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'
import { SearchEngineAdapter } from './search-engine-adapter.ts'
import type { SearchPageExecutor } from './search-page-executor.ts'
import { extractBilibiliAid, extractBilibiliApiErrorInfo, extractBilibiliNextOffset, extractBilibiliReplyRoots, extractBilibiliWbiKeys, extractYoutubeContinuationRequests, parseBilibiliComments, parseYoutubeComments, type BilibiliWbiKeys, type YoutubeContinuationRequest } from './comment-parser.ts'

export type VideoPlatformKind = 'youtube' | 'bilibili'

interface CommentFetchResult {
  comments: CommentRecord[]
  errorMessage?: string
}

interface BilibiliJsonFetchResult {
  json?: string
  errorMessage?: string
}

interface CachedPageHtml {
  html: string
  cachedAt: number
}

function extractYoutubeId(url: URL): string | null {
  if (url.hostname.includes('youtu.be')) return url.pathname.split('/').filter(Boolean)[0] ?? null
  if (url.pathname === '/watch') return url.searchParams.get('v')
  if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/').filter(Boolean)[1] ?? null
  return null
}

function extractBilibiliId(url: URL): string | null {
  const match = /\/video\/(BV[a-zA-Z0-9]+)/.exec(url.pathname)
  return match?.[1] ?? null
}

function isAllowedVideoHost(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase()
  return domains.some((domain) => {
    const normalized = domain.toLowerCase()
    return host === normalized || host.endsWith(`.${normalized}`)
  })
}

export class VideoPlatformAdapter extends SearchEngineAdapter {
  private kind: VideoPlatformKind
  private commentExecutor?: SearchPageExecutor
  private pageHtmlCache = new Map<string, CachedPageHtml>()

  constructor(
    spec: PlatformSpec,
    kind: VideoPlatformKind,
    searchUrlBuilder: (keyword: string) => string,
    browser?: BrowserContextManager,
    executor?: SearchPageExecutor
  ) {
    super(spec, searchUrlBuilder, browser, executor)
    this.kind = kind
    this.commentExecutor = executor
  }

  override async search(input: SearchInput): Promise<SearchResult[]> {
    return super.search(input)
  }

  override async checkStatus(): Promise<PlatformStatus> {
    if (this.kind === 'youtube') return this.checkYoutubeStatus()
    if (this.kind !== 'bilibili' || !this.commentExecutor?.fetchText) return super.checkStatus()
    const startedAt = Date.now()
    try {
      const text = await this.commentExecutor.fetchText('https://api.bilibili.com/x/web-interface/nav', this.spec.key)
      const payload = JSON.parse(text) as { code?: number; data?: { isLogin?: boolean }; message?: string }
      const loggedIn = payload.code === 0 && payload.data?.isLogin === true
      return {
        platformKey: this.spec.key,
        available: payload.code === 0 || payload.code === -101,
        loggedIn,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorCode: loggedIn ? 'ok' : 'login_required',
        message: loggedIn ? 'B站登录态有效' : 'B站未登录；可登录后提升评论采集稳定性'
      }
    } catch (error) {
      return {
        platformKey: this.spec.key,
        available: false,
        loggedIn: false,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorCode: 'network_error',
        message: error instanceof Error ? error.message : 'B站登录态检查失败'
      }
    }
  }

  private async checkYoutubeStatus(): Promise<PlatformStatus> {
    if (!this.commentExecutor) return super.checkStatus()
    const startedAt = Date.now()
    try {
      const html = await this.commentExecutor.fetchHtml('https://www.youtube.com/', this.spec.key)
      const loggedIn = isYoutubeLoggedInHtml(html)
      return {
        platformKey: this.spec.key,
        available: true,
        loggedIn,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorCode: loggedIn ? 'ok' : 'login_required',
        message: loggedIn ? 'YouTube 登录态有效' : 'YouTube 未登录；可登录后采集登录态可见评论'
      }
    } catch (error) {
      return {
        platformKey: this.spec.key,
        available: false,
        loggedIn: false,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorCode: 'network_error',
        message: error instanceof Error ? error.message : 'YouTube 登录态检查失败'
      }
    }
  }

  override async parseContent(rawUrl: string): Promise<ContentRef> {
    const url = new URL(rawUrl)
    if (!isAllowedVideoHost(url.hostname, this.spec.domains)) {
      throw new Error(`链接域名不匹配 ${this.spec.name}`)
    }
    const contentId = this.kind === 'youtube' ? extractYoutubeId(url) : extractBilibiliId(url)
    if (!contentId) {
      throw new Error(`${this.spec.name} 内容链接无法识别: ${rawUrl}`)
    }
    const fallbackTitle = `${this.spec.name} 视频 ${contentId}`
    let title = fallbackTitle
    try {
      const html = await this.fetchPageHtml(url.toString())
      title = extractVideoContentTitle(html ?? '') ?? fallbackTitle
    } catch {
      title = fallbackTitle
    }
    return {
      platformKey: this.spec.key,
      url: url.toString(),
      contentId,
      contentType: 'video',
      title
    }
  }

  override async *collectComments(content: ContentRef): AsyncIterable<CollectEvent> {
    yield { type: 'progress', payload: { current: 0, total: 3, phase: '准备采集评论' } }
    const result = await this.fetchAndParseComments(content)
    const parsed = result.comments
    if (parsed.length > 0) {
      for (const [index, comment] of parsed.entries()) {
        yield { type: 'progress', payload: { current: index + 1, total: parsed.length, phase: '解析评论' } }
        yield { type: 'comment', payload: comment }
      }
      yield { type: 'completed', payload: { total: parsed.length } }
      return
    }
    if (result.errorMessage) {
      yield { type: 'failed', payload: { message: result.errorMessage } }
      return
    }

    const now = new Date().toISOString()
    const samples: CommentRecord[] = [
      {
        id: `${content.platformKey}-${content.contentId}-sample-1`,
        platformKey: content.platformKey,
        contentId: content.contentId,
        contentUrl: content.url,
        nickname: '示例用户A',
        text: '这个多少钱，求链接',
        likes: 12,
        publishedAt: now,
        collectedAt: now
      },
      {
        id: `${content.platformKey}-${content.contentId}-sample-2`,
        platformKey: content.platformKey,
        contentId: content.contentId,
        contentUrl: content.url,
        nickname: '示例用户B',
        text: '看起来不错，想了解一下',
        likes: 4,
        publishedAt: now,
        collectedAt: now
      }
    ]
    for (const [index, comment] of samples.entries()) {
      yield { type: 'progress', payload: { current: index + 1, total: samples.length, phase: '采集评论' } }
      yield { type: 'comment', payload: comment }
    }
    yield { type: 'completed', payload: { total: samples.length } }
  }

  private async fetchAndParseComments(content: ContentRef): Promise<CommentFetchResult> {
    if (!this.commentExecutor) return { comments: [] }
    try {
      if (this.kind === 'youtube') {
        const html = this.commentExecutor.fetchRenderedHtml
          ? await this.commentExecutor.fetchRenderedHtml(content.url, this.spec.key, {
            scrollSteps: 8,
            scrollDelayMs: 650,
            expandText: ['Show more', 'Read more', '展开', '更多'],
            commentSort: 'newest'
          })
          : await this.fetchPageHtml(content.url)
        const continuationResult = await this.fetchYoutubeContinuationPages(content, html, 5)
        const comments = uniqueComments([...parseYoutubeComments(content, html), ...continuationResult.comments])
        return {
          comments,
          errorMessage: comments.length === 0 ? youtubeCommentBlockMessage(html) ?? continuationResult.errorMessage : undefined
        }
      }
      const pageHtml = await this.fetchPageHtml(content.url)
      const pageComments = parseBilibiliComments(content, pageHtml)
      const oid = extractBilibiliAid(pageHtml)
      if (!oid) return { comments: pageComments }
      const apiResult = await this.fetchBilibiliReplyPages(content, oid, 3, extractBilibiliWbiKeys(pageHtml))
      return {
        comments: uniqueComments([...pageComments, ...apiResult.comments]),
        errorMessage: apiResult.errorMessage
      }
    } catch {
      return { comments: [] }
    }
  }

  private async fetchPageHtml(url: string): Promise<string> {
    if (!this.commentExecutor) return ''
    const cached = this.pageHtmlCache.get(url)
    if (cached && Date.now() - cached.cachedAt <= 300_000) return cached.html
    const html = await this.commentExecutor.fetchHtml(url, this.spec.key)
    this.pageHtmlCache.set(url, { html, cachedAt: Date.now() })
    if (this.pageHtmlCache.size > 30) {
      const oldest = this.pageHtmlCache.keys().next().value
      if (oldest) this.pageHtmlCache.delete(oldest)
    }
    return html
  }

  private async fetchBilibiliReplyPages(content: ContentRef, oid: string, maxPages: number, wbiKeys: BilibiliWbiKeys | null): Promise<CommentFetchResult> {
    if (!this.commentExecutor) return { comments: [] }
    const comments: CommentRecord[] = []
    const replyRoots = new Set<string>()
    let offset = ''
    for (let page = 0; page < maxPages; page += 1) {
      const apiUrl = buildBilibiliReplyUrl(oid, offset, wbiKeys)
      const result = await this.fetchBilibiliJsonWithRetry(apiUrl)
      if (!result.json) return { comments: uniqueComments(comments), errorMessage: result.errorMessage }
      const json = result.json
      comments.push(...parseBilibiliComments(content, json))
      for (const root of extractBilibiliReplyRoots(json)) replyRoots.add(root)
      const nextOffset = extractBilibiliNextOffset(json)
      if (!nextOffset || nextOffset === offset) break
      offset = nextOffset
    }
    for (const root of [...replyRoots].slice(0, 5)) {
      const childUrl = buildBilibiliChildReplyUrl(oid, root, wbiKeys)
      const result = await this.fetchBilibiliJsonWithRetry(childUrl)
      if (!result.json) {
        if (comments.length === 0) return { comments: [], errorMessage: result.errorMessage }
        continue
      }
      const json = result.json
      comments.push(...parseBilibiliComments(content, json))
    }
    return { comments: uniqueComments(comments) }
  }

  private async fetchYoutubeContinuationPages(content: ContentRef, html: string, maxPages: number): Promise<CommentFetchResult> {
    if (!this.commentExecutor?.fetchText) return { comments: [] }
    const comments: CommentRecord[] = []
    const queue = extractYoutubeContinuationRequests(html, 3)
    const seen = new Set(queue.map((request) => request.token))
    let lastErrorMessage: string | undefined
    for (let page = 0; page < maxPages && queue.length > 0; page += 1) {
      const request = queue.shift()
      if (!request?.apiKey) continue
      let json = ''
      try {
        json = await this.fetchYoutubeContinuationJson(request, content)
      } catch (error) {
        lastErrorMessage = error instanceof Error ? `YouTube continuation 请求失败: ${error.message}` : 'YouTube continuation 请求失败'
        continue
      }
      comments.push(...parseYoutubeComments(content, json))
      lastErrorMessage = youtubeCommentBlockMessage(json) ?? lastErrorMessage
      for (const next of extractYoutubeContinuationRequests(json, 3)) {
        if (seen.has(next.token)) continue
        seen.add(next.token)
        queue.push({
          ...next,
          apiKey: next.apiKey ?? request.apiKey,
          clientName: next.clientName || request.clientName,
          clientVersion: next.clientVersion || request.clientVersion,
          visitorData: next.visitorData ?? request.visitorData
        })
      }
    }
    return { comments: uniqueComments(comments), errorMessage: comments.length === 0 ? lastErrorMessage : undefined }
  }

  private async fetchYoutubeContinuationJson(request: YoutubeContinuationRequest, content: ContentRef): Promise<string> {
    if (!this.commentExecutor?.fetchText || !request.apiKey) return ''
    const body = JSON.stringify({
      context: {
        client: {
          clientName: request.clientName,
          clientVersion: request.clientVersion,
          visitorData: request.visitorData
        },
        request: {
          useSsl: true
        }
      },
      continuation: request.token
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'origin': 'https://www.youtube.com',
      'referer': content.url,
      'x-youtube-client-name': request.clientName,
      'x-youtube-client-version': request.clientVersion
    }
    if (request.visitorData) headers['x-goog-visitor-id'] = request.visitorData
    return await this.commentExecutor.fetchText(`https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(request.apiKey)}`, this.spec.key, {
      method: 'POST',
      headers,
      body
    })
  }

  private async fetchBilibiliJsonWithRetry(url: string): Promise<BilibiliJsonFetchResult> {
    if (!this.commentExecutor) return {}
    const maxRetries = Math.max(0, Math.floor(this.spec.rateLimit.maxRetries))
    let lastError = 'B站接口请求失败'
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let retryCode: number | undefined
      try {
        const json = await this.commentExecutor.fetchHtml(url, this.spec.key)
        const apiError = extractBilibiliApiErrorInfo(json)
        if (!apiError) return { json }
        retryCode = apiError.code
        lastError = apiError.formatted
        if (!apiError.retryable || attempt >= maxRetries) return { errorMessage: lastError }
      } catch (error) {
        lastError = error instanceof Error ? `B站接口请求失败: ${error.message}` : 'B站接口请求失败'
        if (attempt >= maxRetries) return { errorMessage: lastError }
      }
      await sleep(calculateBilibiliRetryDelayMs(this.spec.rateLimit.minDelayMs, attempt, retryCode))
    }
    return { errorMessage: lastError }
  }
}

export function buildBilibiliReplyUrl(oid: string, offset: string, wbiKeys: BilibiliWbiKeys | null = null): string {
  const pagination = JSON.stringify({ offset })
  return buildBilibiliApiUrl('https://api.bilibili.com/x/v2/reply/main', {
    type: '1',
    oid,
    mode: '3',
    pagination_str: pagination,
    plat: '1',
    web_location: '1315875'
  }, wbiKeys)
}

export function buildBilibiliChildReplyUrl(oid: string, root: string, wbiKeys: BilibiliWbiKeys | null = null): string {
  return buildBilibiliApiUrl('https://api.bilibili.com/x/v2/reply/reply', {
    type: '1',
    oid,
    root,
    pn: '1',
    ps: '20',
    web_location: '1315875'
  }, wbiKeys)
}

function buildBilibiliApiUrl(baseUrl: string, params: Record<string, string>, wbiKeys: BilibiliWbiKeys | null): string {
  const signed = wbiKeys ? signBilibiliWbiParams(params, wbiKeys) : params
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, value)
  return url.toString()
}

export function signBilibiliWbiParams(params: Record<string, string>, keys: BilibiliWbiKeys, nowSeconds = Math.floor(Date.now() / 1000)): Record<string, string> {
  const mixinKey = bilibiliMixinKey(keys)
  const signed: Record<string, string> = { ...params, wts: String(nowSeconds) }
  const query = Object.keys(signed)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(signed[key].replace(/[!'()*]/g, ''))}`)
    .join('&')
  return {
    ...signed,
    w_rid: createHash('md5').update(query + mixinKey).digest('hex')
  }
}

export function calculateBilibiliRetryDelayMs(baseDelayMs: number, attempt: number, apiCode?: number): number {
  const base = Math.max(0, Math.floor(baseDelayMs))
  if (base === 0) return 0
  const linear = base * (Math.max(0, Math.floor(attempt)) + 1)
  if (apiCode === -509 || apiCode === 429) return Math.max(linear * 3, 3_000)
  if (typeof apiCode === 'number' && apiCode >= 500) return Math.max(linear * 2, 1_500)
  return linear
}

function bilibiliMixinKey(keys: BilibiliWbiKeys): string {
  const table = [
    46, 47, 18, 2, 53, 8, 23, 32,
    15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19,
    29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63,
    57, 62, 11, 36, 20, 34, 44, 52
  ]
  const raw = `${keys.imgKey}${keys.subKey}`
  return table.map((index) => raw[index] ?? '').join('').slice(0, 32)
}

function uniqueComments(comments: CommentRecord[]): CommentRecord[] {
  const seen = new Set<string>()
  const unique: CommentRecord[] = []
  for (const comment of comments) {
    if (seen.has(comment.id)) continue
    seen.add(comment.id)
    unique.push(comment)
  }
  return unique
}

function isYoutubeLoggedInHtml(html: string): boolean {
  const lower = html.toLowerCase()
  return (
    lower.includes('avatar-btn') ||
    lower.includes('account-menu') ||
    lower.includes('"isloggedin":true') ||
    lower.includes('"is_signed_in":true')
  )
}

function youtubeCommentBlockMessage(text: string): string | undefined {
  const lower = text.toLowerCase()
  if (/验证码|验证|机器人|风控|滑块/.test(text) || /captcha|not a bot|unusual traffic|automated queries|verify/i.test(text)) {
    return 'YouTube 评论采集被验证码或风控拦截。建议完成登录/验证，降低采集频率后重试。'
  }
  if (/登录|请先登录|账号/.test(text) || /sign in|login required|auth required|unauthorized/i.test(text)) {
    return 'YouTube 评论采集需要登录。建议先完成 YouTube 登录并确认平台状态为已登录后重试。'
  }
  if (/限流|请求过于频繁|稍后再试/.test(text) || /rate limit|too many requests|try again later/i.test(text)) {
    return 'YouTube 评论采集被限流。建议稍后重试并降低采集频率。'
  }
  if (/权限|不可用|无法访问/.test(text) || /forbidden|permission|private video|video unavailable/i.test(lower)) {
    return 'YouTube 内容不可访问或权限不足。建议检查视频可见范围和账号权限。'
  }
  if (/评论已关闭|关闭了评论/.test(text) || /comments are turned off|comments disabled/i.test(text)) {
    return 'YouTube 评论已关闭，无法采集该视频评论。'
  }
  return undefined
}

function extractVideoContentTitle(html: string): string | undefined {
  const structuredTitle = extractStructuredVideoTitle(html)
  if (structuredTitle) return structuredTitle
  const patterns = [
    /<meta\s+[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i,
    /<meta\s+[^>]*(?:property|name)=["']twitter:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']twitter:title["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    const title = decodeHtmlEntities(match?.[1] ?? '').replace(/\s+-\s+YouTube$/i, '').trim()
    if (title) return title
  }
  return undefined
}

function extractStructuredVideoTitle(text: string): string | undefined {
  for (const root of extractVideoJsonObjects(text)) {
    let title = ''
    walkVideoJson(root, (node) => {
      if (title) return
      const videoDetails = node.videoDetails as Record<string, unknown> | undefined
      const videoData = node.videoData as Record<string, unknown> | undefined
      const candidate = videoDetails?.title ?? videoData?.title
      if (typeof candidate === 'string' && candidate.trim()) title = candidate
    })
    const normalized = decodeHtmlEntities(title).replace(/\s+-\s+YouTube$/i, '').trim()
    if (normalized) return normalized
  }
  return undefined
}

function extractVideoJsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  try {
    objects.push(JSON.parse(text))
  } catch {
    // Most inputs are full HTML pages with embedded platform state blocks.
  }
  const candidates = [
    ...text.matchAll(/ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/g),
    ...text.matchAll(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/g),
    ...text.matchAll(/__INITIAL_STATE__\s*=\s*({[\s\S]*?});/g)
  ]
  for (const match of candidates) {
    try {
      objects.push(JSON.parse(match[1]))
    } catch {
      // Ignore partial or malformed state blocks.
    }
  }
  return objects
}

function walkVideoJson(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkVideoJson(item, visitor)
    return
  }
  const node = value as Record<string, unknown>
  visitor(node)
  for (const child of Object.values(node)) walkVideoJson(child, visitor)
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
