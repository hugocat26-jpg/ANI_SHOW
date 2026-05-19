import type { CollectEvent } from './adapter.ts'
import type { CommentRecord, ContentRef, PlatformSpec, PlatformStatus, SearchInput, SearchResult } from '../domain/types.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'
import { MetadataOnlyPlatformAdapter } from './adapter.ts'
import { extractInstagramPageCursor, extractKuaishouPageCursor, extractRedditMoreChildren, extractShortVideoCursor, extractWeiboPageCursor, extractXiaohongshuPageCursor, extractZhihuPageCursor, parseGenericHtmlComments, parseInstagramComments, parseKuaishouComments, parseRedditComments, parseShortVideoComments, parseWeiboComments, parseXiaohongshuComments, parseZhihuComments } from './comment-parser.ts'
import { DisabledSearchPageExecutor, parseSearchResultHtml, type SearchPageExecutor } from './search-page-executor.ts'

interface RedditCommentFetchResult {
  comments: CommentRecord[]
  errorMessage?: string
  warningMessage?: string
}

export class SearchEngineAdapter extends MetadataOnlyPlatformAdapter {
  private searchUrlBuilder: (keyword: string) => string
  private executor: SearchPageExecutor

  constructor(
    spec: PlatformSpec,
    searchUrlBuilder: (keyword: string) => string,
    browser?: BrowserContextManager,
    executor: SearchPageExecutor = new DisabledSearchPageExecutor()
  ) {
    super(spec, browser)
    this.searchUrlBuilder = searchUrlBuilder
    this.executor = executor
  }

  override async checkStatus(): Promise<PlatformStatus> {
    const startedAt = Date.now()
    try {
      const statusUrl = platformStatusUrl(this.spec)
      const html = await this.executor.fetchHtml(statusUrl, this.spec.key)
      const loggedIn = inferLoggedInFromHtml(html)
      const loginRequired = inferLoginRequiredFromHtml(html)
      const shouldLogin = this.spec.requiresLogin || this.spec.capabilities.includes('login')
      const cookieLoggedIn = shouldLogin && !loggedIn && this.executor.hasAuthCookies
        ? await this.executor.hasAuthCookies(this.spec.key, statusUrl).catch(() => false)
        : false
      const effectiveLoggedIn = loggedIn || cookieLoggedIn
      return {
        platformKey: this.spec.key,
        available: true,
        loggedIn: effectiveLoggedIn || (!shouldLogin && !loginRequired),
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorCode: effectiveLoggedIn || (!shouldLogin && !loginRequired) ? 'ok' : 'login_required',
        message: effectiveLoggedIn
          ? `${this.spec.name} 登录态有效`
          : shouldLogin
            ? `${this.spec.name} 未确认登录态；如搜索或评论受限，请先登录/验证`
            : `${this.spec.name} 可访问`
      }
    } catch (error) {
      return {
        platformKey: this.spec.key,
        available: false,
        loggedIn: false,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorCode: 'network_error',
        message: readablePlatformError(error, `${this.spec.name} 状态检查失败`)
      }
    }
  }

  async search(input: SearchInput): Promise<SearchResult[]> {
    const keyword = input.keyword.trim()
    if (!keyword) return []
    const searchUrl = this.searchUrlBuilder(keyword)

    try {
      const html = await this.executor.fetchHtml(searchUrl, this.spec.key)
      const parsed = parseSearchResultHtml(this.spec.key, html, input.limit)
      if (parsed.length > 0) return parsed
    } catch {
      // Search engines frequently block automation. Keep a deterministic fallback
      // so the rest of the pipeline can still be validated and persisted.
    }

    const topics = [
      '购买需求与评价',
      '价格渠道与推荐',
      '避坑经验与真实反馈'
    ]
    return topics.slice(0, Math.max(1, Math.min(input.limit, topics.length))).map((topic, index) => ({
      id: `${this.spec.key}-${Buffer.from(`${keyword}-${index}`).toString('base64url')}`,
      platformKey: this.spec.key,
      title: `${keyword} ${topic}`,
      url: this.searchUrlBuilder(`${keyword} ${topic}`),
      snippet: `${this.spec.name} 搜索入口已接入。后续迭代将通过 Playwright 抽取真实 SERP 标题、摘要和目标链接。`,
      relevance: 0.35 - index * 0.05,
      createdAt: new Date().toISOString()
    }))
  }

  override async parseContent(rawUrl: string): Promise<ContentRef> {
    const parsed = new URL(rawUrl)
    if (!isAllowedPlatformHost(parsed.hostname, this.spec.domains)) {
      throw new Error(`链接域名不匹配 ${this.spec.name}`)
    }

    let title: string | undefined
    try {
      const html = await this.executor.fetchHtml(parsed.toString(), this.spec.key)
      title = extractContentTitle(html, this.spec.key)
    } catch {
      // Content pages often require login or block automation. Keep the parsed
      // reference usable so the pipeline can persist and retry later.
    }

    return {
      platformKey: this.spec.key,
      url: parsed.toString(),
      contentId: extractPlatformContentId(this.spec.key, parsed),
      contentType: inferContentType(this.spec.key),
      title
    }
  }

  override async *collectComments(content: ContentRef): AsyncIterable<CollectEvent> {
    yield { type: 'progress', payload: { current: 0, total: 1, phase: '准备采集评论' } }
    try {
      let redditErrorMessage = ''
      if (this.spec.key === 'reddit' && this.executor.fetchText) {
        const redditResult = await this.collectRedditComments(content)
        redditErrorMessage = redditResult.errorMessage ?? ''
        if (redditResult.comments.length > 0) {
          if (redditResult.warningMessage) {
            yield { type: 'progress', payload: { current: 0, total: redditResult.comments.length, phase: redditResult.warningMessage } }
          }
          for (const [index, comment] of redditResult.comments.entries()) {
            yield { type: 'progress', payload: { current: index + 1, total: redditResult.comments.length, phase: '解析 Reddit 评论' } }
            yield { type: 'comment', payload: comment }
          }
          yield { type: 'completed', payload: { total: redditResult.comments.length } }
          return
        }
      }

      const html = this.executor.fetchRenderedHtml
        ? await this.executor.fetchRenderedHtml(content.url, this.spec.key, {
          scrollSteps: 4,
          scrollDelayMs: 600,
          expandText: ['展开', '更多', '查看', 'Show more', 'Read more', 'View replies']
        })
        : await this.executor.fetchHtml(content.url, this.spec.key)
      const platformComments = this.spec.key === 'xiaohongshu'
        ? await this.collectXiaohongshuComments(content, html)
        : ['douyin', 'tiktok'].includes(this.spec.key)
          ? await this.collectShortVideoComments(content, html)
          : this.spec.key === 'instagram'
            ? await this.collectInstagramComments(content, html)
            : this.spec.key === 'weibo'
              ? await this.collectWeiboComments(content, html)
              : this.spec.key === 'zhihu'
                ? await this.collectZhihuComments(content, html)
                : this.spec.key === 'kuaishou' ? await this.collectKuaishouComments(content, html) : []
      const comments = platformComments.length > 0 ? platformComments : parseGenericHtmlComments(content, html)
      if (this.spec.key === 'xiaohongshu' && platformComments.length > 0) {
        const pageCursor = extractXiaohongshuPageCursor(html)
        if (pageCursor.hasMore || pageCursor.cursor) {
          yield { type: 'progress', payload: { current: 1, total: 2, phase: '识别到小红书后续评论页' } }
        }
      }
      if (['douyin', 'tiktok'].includes(this.spec.key) && platformComments.length > 0) {
        const pageCursor = extractShortVideoCursor(html)
        if (pageCursor.hasMore || pageCursor.cursor) {
          yield { type: 'progress', payload: { current: 1, total: 2, phase: `识别到${this.spec.name}后续评论页` } }
        }
      }
      if (this.spec.key === 'instagram' && platformComments.length > 0) {
        const pageCursor = extractInstagramPageCursor(html)
        if (pageCursor.hasMore || pageCursor.cursor) {
          yield { type: 'progress', payload: { current: 1, total: 2, phase: '识别到 Instagram 后续评论页' } }
        }
      }
      if (this.spec.key === 'weibo' && platformComments.length > 0) {
        const pageCursor = extractWeiboPageCursor(html)
        if (pageCursor.hasMore || pageCursor.cursor) {
          yield { type: 'progress', payload: { current: 1, total: 2, phase: '识别到微博后续评论页' } }
        }
      }
      if (this.spec.key === 'zhihu' && platformComments.length > 0) {
        const pageCursor = extractZhihuPageCursor(html)
        if (pageCursor.hasMore || pageCursor.cursor) {
          yield { type: 'progress', payload: { current: 1, total: 2, phase: '识别到知乎后续评论页' } }
        }
      }
      if (this.spec.key === 'kuaishou' && platformComments.length > 0) {
        const pageCursor = extractKuaishouPageCursor(html)
        if (pageCursor.hasMore || pageCursor.cursor) {
          yield { type: 'progress', payload: { current: 1, total: 2, phase: '识别到快手后续评论页' } }
        }
      }
      const xiaohongshuError = this.spec.key === 'xiaohongshu' ? xiaohongshuErrorMessage(html) : ''
      if (comments.length === 0 && xiaohongshuError) {
        yield { type: 'failed', payload: { message: xiaohongshuError } }
        return
      }
      const shortVideoError = ['douyin', 'tiktok'].includes(this.spec.key) ? shortVideoErrorMessage(this.spec.name, html) : ''
      if (comments.length === 0 && shortVideoError) {
        yield { type: 'failed', payload: { message: shortVideoError } }
        return
      }
      const instagramError = this.spec.key === 'instagram' ? instagramErrorMessage(html) : ''
      if (comments.length === 0 && instagramError) {
        yield { type: 'failed', payload: { message: instagramError } }
        return
      }
      const weiboError = this.spec.key === 'weibo' ? weiboErrorMessage(html) : ''
      if (comments.length === 0 && weiboError) {
        yield { type: 'failed', payload: { message: weiboError } }
        return
      }
      const zhihuError = this.spec.key === 'zhihu' ? zhihuErrorMessage(html) : ''
      if (comments.length === 0 && zhihuError) {
        yield { type: 'failed', payload: { message: zhihuError } }
        return
      }
      const kuaishouError = this.spec.key === 'kuaishou' ? kuaishouErrorMessage(html) : ''
      if (comments.length === 0 && kuaishouError) {
        yield { type: 'failed', payload: { message: kuaishouError } }
        return
      }
      if (comments.length === 0 && redditErrorMessage) {
        yield { type: 'failed', payload: { message: redditErrorMessage } }
        return
      }
      for (const [index, comment] of comments.entries()) {
        yield { type: 'progress', payload: { current: index + 1, total: Math.max(1, comments.length), phase: '解析评论' } }
        yield { type: 'comment', payload: comment }
      }
      yield { type: 'completed', payload: { total: comments.length } }
    } catch (error) {
      yield {
        type: 'failed',
        payload: {
          message: error instanceof Error
            ? `${this.spec.name} 评论采集失败: ${error.message}`
            : `${this.spec.name} 评论采集失败`
        }
      }
    }
  }

  private async collectRedditComments(content: ContentRef): Promise<RedditCommentFetchResult> {
    try {
      const json = await this.executor.fetchText?.(redditJsonUrl(content.url), this.spec.key, {
        headers: {
          accept: 'application/json'
        }
      })
      const comments = json ? parseRedditComments(content, json) : []
      const moreChildren = json ? extractRedditMoreChildren(json, Math.max(0, 50 - comments.length)) : []
      let warningMessage = ''
      if (moreChildren.length > 0 && comments.length < 50) {
        try {
          const moreJson = await this.executor.fetchText?.(redditMoreChildrenUrl(content.url, content.contentId, moreChildren), this.spec.key, {
            headers: {
              accept: 'application/json'
            }
          })
          if (moreJson) comments.push(...parseRedditComments(content, moreJson, 50 - comments.length))
        } catch (error) {
          warningMessage = `${redditRecoveryMessage(error)}已保留首屏可解析评论。`
        }
      }
      return { comments: uniqueComments(comments), warningMessage }
    } catch (error) {
      return {
        comments: [],
        errorMessage: redditErrorMessage(error)
      }
    }
  }

  private async collectXiaohongshuComments(content: ContentRef, html: string): Promise<CommentRecord[]> {
    const comments = parseXiaohongshuComments(content, html)
    const pageCursor = extractXiaohongshuPageCursor(html)
    if (comments.length === 0 || !pageCursor.cursor || !pageCursor.hasMore || !this.executor.fetchText) {
      return comments
    }
    try {
      const nextPage = await this.executor.fetchText(xiaohongshuCommentsPageUrl(content, pageCursor.cursor), this.spec.key, {
        headers: {
          accept: 'application/json',
          referer: content.url,
          'x-requested-with': 'XMLHttpRequest'
        }
      })
      comments.push(...parseXiaohongshuComments(content, nextPage, Math.max(0, 50 - comments.length)))
    } catch {
      // Follow-up pages are opportunistic; parsed first-page comments remain useful.
    }
    return uniqueComments(comments)
  }

  private async collectZhihuComments(content: ContentRef, html: string): Promise<CommentRecord[]> {
    const comments = parseZhihuComments(content, html)
    const pageCursor = extractZhihuPageCursor(html)
    if (comments.length === 0 || !pageCursor.cursor || !pageCursor.hasMore || !this.executor.fetchText) {
      return comments
    }
    const nextUrl = zhihuCommentsPageUrl(content, pageCursor.cursor)
    if (!nextUrl) return comments
    try {
      const nextPage = await this.executor.fetchText(nextUrl, this.spec.key, {
        headers: {
          accept: 'application/json',
          referer: content.url
        }
      })
      comments.push(...parseZhihuComments(content, nextPage, Math.max(0, 50 - comments.length)))
    } catch {
      // Zhihu follow-up pages are opportunistic; parsed first-page comments remain useful.
    }
    return uniqueComments(comments)
  }

  private async collectWeiboComments(content: ContentRef, html: string): Promise<CommentRecord[]> {
    const comments = parseWeiboComments(content, html)
    const pageCursor = extractWeiboPageCursor(html)
    if (comments.length === 0 || !pageCursor.cursor || !pageCursor.hasMore || !this.executor.fetchText) {
      return comments
    }
    const nextUrl = weiboCommentsPageUrl(content, pageCursor.cursor)
    if (!nextUrl) return comments
    try {
      const nextPage = await this.executor.fetchText(nextUrl, this.spec.key, {
        headers: {
          accept: 'application/json',
          referer: content.url
        }
      })
      comments.push(...parseWeiboComments(content, nextPage, Math.max(0, 50 - comments.length)))
    } catch {
      // Weibo follow-up pages are opportunistic; parsed first-page comments remain useful.
    }
    return uniqueComments(comments)
  }

  private async collectInstagramComments(content: ContentRef, html: string): Promise<CommentRecord[]> {
    const comments = parseInstagramComments(content, html)
    const pageCursor = extractInstagramPageCursor(html)
    if (comments.length === 0 || !pageCursor.cursor || !pageCursor.hasMore || !this.executor.fetchText) {
      return comments
    }
    try {
      const nextPage = await this.executor.fetchText(instagramCommentsPageUrl(content, pageCursor.cursor), this.spec.key, {
        headers: {
          accept: 'application/json',
          referer: content.url
        }
      })
      comments.push(...parseInstagramComments(content, nextPage, Math.max(0, 50 - comments.length)))
    } catch {
      // Instagram follow-up pages are opportunistic; parsed first-page comments remain useful.
    }
    return uniqueComments(comments)
  }

  private async collectShortVideoComments(content: ContentRef, html: string): Promise<CommentRecord[]> {
    const comments = parseShortVideoComments(content, html)
    const pageCursor = extractShortVideoCursor(html)
    if (comments.length === 0 || !pageCursor.cursor || !pageCursor.hasMore || !this.executor.fetchText) {
      return comments
    }
    const nextUrl = shortVideoCommentsPageUrl(content, pageCursor.cursor)
    if (!nextUrl) return comments
    try {
      const nextPage = await this.executor.fetchText(nextUrl, this.spec.key, {
        headers: {
          accept: 'application/json',
          referer: content.url
        }
      })
      comments.push(...parseShortVideoComments(content, nextPage, Math.max(0, 50 - comments.length)))
    } catch {
      // Short-video follow-up pages are opportunistic; parsed first-page comments remain useful.
    }
    return uniqueComments(comments)
  }

  private async collectKuaishouComments(content: ContentRef, html: string): Promise<CommentRecord[]> {
    const comments = parseKuaishouComments(content, html)
    const pageCursor = extractKuaishouPageCursor(html)
    if (comments.length === 0 || !pageCursor.cursor || !pageCursor.hasMore || !this.executor.fetchText) {
      return comments
    }
    try {
      const nextPage = await this.executor.fetchText(kuaishouCommentsPageUrl(content, pageCursor.cursor), this.spec.key, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: 'https://www.kuaishou.com',
          referer: content.url
        },
        body: JSON.stringify(kuaishouCommentsPageBody(content, pageCursor.cursor))
      })
      comments.push(...parseKuaishouComments(content, nextPage, Math.max(0, 50 - comments.length)))
    } catch {
      // Kuaishou follow-up pages are opportunistic; parsed first-page comments remain useful.
    }
    return uniqueComments(comments)
  }
}

function isAllowedPlatformHost(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^www\./, '')
    return host === normalized || host.endsWith(`.${normalized}`)
  })
}

function platformStatusUrl(spec: PlatformSpec): string {
  if (spec.loginUrl) return spec.loginUrl
  const domain = spec.domains[0] ?? ''
  return domain ? `https://${domain}` : 'https://example.com'
}

function readablePlatformError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/╔[\s\S]*?╚[═]+╝/g, '')
    .replace(/Call log:[\s\S]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/Executable doesn't exist|ms-playwright|playwright install/i.test(text)) {
    return '浏览器内核未就绪，请使用最新安装包重新安装后再试。'
  }
  if (/ERR_CONNECTION_CLOSED|ECONNRESET|socket hang up|Target page, context or browser has been closed/i.test(text)) {
    return '网络连接被平台关闭，可能是平台风控、代理/网络不稳定或访问被阻断；请稍后重试，或先登录/完成验证。'
  }
  if (/Timeout|timed out|Navigation timeout/i.test(text)) return '平台页面加载超时，请稍后重试。'
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(text)) return '域名解析失败，请检查网络、DNS 或代理设置。'
  return text || fallback
}

function inferLoggedInFromHtml(html: string): boolean {
  const text = html.toLowerCase()
  return (
    /id=["']avatar|class=["'][^"']*(avatar|account|profile|user-menu|user_info|user-info)/i.test(html) ||
    /退出登录|退出|我的主页|个人主页|消息中心|私信|账号设置|log out|logout|sign out|profile|account settings/i.test(text) ||
    /"islogin"\s*:\s*true|"isloggedin"\s*:\s*true|"is_logged_in"\s*:\s*true|"loggedin"\s*:\s*true/i.test(text)
  )
}

function inferLoginRequiredFromHtml(html: string): boolean {
  return /登录后|请登录|立即登录|扫码登录|密码登录|login|log in|sign in|signin/i.test(html)
}

function inferContentType(platformKey: string): ContentRef['contentType'] {
  if (['douyin', 'tiktok', 'kuaishou'].includes(platformKey)) return 'video'
  if (['xiaohongshu', 'instagram'].includes(platformKey)) return 'image_text'
  if (['facebook', 'twitter', 'reddit', 'weibo', 'zhihu'].includes(platformKey)) return 'post'
  return 'unknown'
}

function extractPlatformContentId(platformKey: string, url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean)
  const query = url.searchParams

  if (platformKey === 'xiaohongshu') {
    return segmentAfter(segments, 'explore')
      ?? segmentAfter(segments, 'discovery')
      ?? query.get('noteId')
      ?? fallbackContentId(url)
  }

  if (platformKey === 'reddit') {
    return segmentAfter(segments, 'comments') ?? fallbackContentId(url)
  }

  if (platformKey === 'tiktok') {
    return segmentAfter(segments, 'video') ?? fallbackContentId(url)
  }

  if (platformKey === 'douyin') {
    return segmentAfter(segments, 'video')
      ?? segmentAfter(segments, 'note')
      ?? query.get('modal_id')
      ?? query.get('aweme_id')
      ?? fallbackContentId(url)
  }

  if (platformKey === 'instagram') {
    return segmentAfter(segments, 'p')
      ?? segmentAfter(segments, 'reel')
      ?? segmentAfter(segments, 'tv')
      ?? fallbackContentId(url)
  }

  if (platformKey === 'facebook') {
    return query.get('v')
      ?? query.get('story_fbid')
      ?? segmentAfter(segments, 'posts')
      ?? segmentAfter(segments, 'videos')
      ?? lastSegment(segments)
      ?? fallbackContentId(url)
  }

  if (platformKey === 'twitter') {
    return segmentAfter(segments, 'status') ?? fallbackContentId(url)
  }

  if (platformKey === 'weibo') {
    return query.get('id') ?? lastSegment(segments) ?? fallbackContentId(url)
  }

  if (platformKey === 'zhihu') {
    const questionId = segmentAfter(segments, 'question')
    const answerId = segmentAfter(segments, 'answer')
    if (questionId && answerId) return `${questionId}-${answerId}`
    return answerId ?? questionId ?? fallbackContentId(url)
  }

  if (platformKey === 'kuaishou') {
    return segmentAfter(segments, 'short-video')
      ?? segmentAfter(segments, 'photo')
      ?? segmentAfter(segments, 'works')
      ?? query.get('photoId')
      ?? query.get('photo_id')
      ?? query.get('fid')
      ?? fallbackContentId(url)
  }

  return lastSegment(segments) ?? fallbackContentId(url)
}

function segmentAfter(segments: string[], marker: string): string | null {
  const index = segments.findIndex((segment) => segment.toLowerCase() === marker.toLowerCase())
  return index >= 0 ? (segments[index + 1] ?? null) : null
}

function lastSegment(segments: string[]): string | null {
  return segments.at(-1) ?? null
}

function fallbackContentId(url: URL): string {
  return Buffer.from(url.toString()).toString('base64url')
}

function redditJsonUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl)
  const sort = redditCommentSort(parsed)
  parsed.pathname = parsed.pathname.replace(/\/?$/, '.json')
  parsed.searchParams.set('limit', '50')
  parsed.searchParams.set('sort', sort)
  return parsed.toString()
}

function redditMoreChildrenUrl(rawUrl: string, contentId: string, children: string[]): string {
  const parsed = new URL(rawUrl)
  const sort = redditCommentSort(parsed)
  parsed.pathname = '/api/morechildren.json'
  parsed.search = ''
  parsed.searchParams.set('api_type', 'json')
  parsed.searchParams.set('link_id', `t3_${contentId}`)
  parsed.searchParams.set('children', children.join(','))
  parsed.searchParams.set('sort', sort)
  return parsed.toString()
}

function redditErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) : 0
  const statusText = status ? `${status} ${message}` : message
  if (status === 404 || /404|not found|deleted|removed|不存在|已删除/i.test(statusText)) return `Reddit 评论采集失败: 帖子不存在、已删除或无法访问。建议检查链接是否有效。原始错误: ${statusText}`
  if (status === 429 || /429|too many|rate/i.test(statusText)) return `Reddit 评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。原始错误: ${statusText}`
  if ([401, 403].includes(status) || /401|403|forbidden|unauthorized|permission|private|quarantined|banned/i.test(statusText)) return `Reddit 评论采集失败: 权限受限、私密社区或隔离社区不可访问。建议检查帖子可见性、社区限制或登录状态后重试。原始错误: ${statusText}`
  if (status >= 500 || /5\d\d|server|bad gateway|service unavailable/i.test(statusText)) return `Reddit 评论采集失败: Reddit 服务端暂时不可用。建议稍后自动重试或降低采集频率。原始错误: ${statusText}`
  if (/timeout|timed out|network|fetch failed|econnreset|enotfound|dns/i.test(statusText)) return `Reddit 评论采集失败: 网络连接异常。建议检查网络或稍后重试。原始错误: ${statusText}`
  return `Reddit 评论采集失败: ${statusText}`
}

function redditRecoveryMessage(error: unknown): string {
  const message = redditErrorMessage(error)
  return message.replace(/^Reddit 评论采集失败: /, 'Reddit 后续评论展开失败: ')
}

function redditCommentSort(url: URL): string {
  const requested = url.searchParams.get('sort')?.toLowerCase()
  const allowed = new Set(['confidence', 'top', 'new', 'controversial', 'old', 'qa', 'live'])
  return requested && allowed.has(requested) ? requested : 'new'
}

function xiaohongshuCommentsPageUrl(content: ContentRef, cursor: string): string {
  const parsed = new URL(content.url)
  const sourceUrl = new URL(content.url)
  parsed.pathname = '/api/sns/web/v2/comment/page'
  parsed.search = ''
  parsed.searchParams.set('note_id', content.contentId)
  parsed.searchParams.set('cursor', cursor)
  parsed.searchParams.set('top_comment_id', '')
  const xsecToken = sourceUrl.searchParams.get('xsec_token')
  const xsecSource = sourceUrl.searchParams.get('xsec_source')
  if (xsecToken) parsed.searchParams.set('xsec_token', xsecToken)
  if (xsecSource) parsed.searchParams.set('xsec_source', xsecSource)
  return parsed.toString()
}

function zhihuCommentsPageUrl(content: ContentRef, cursor: string): string | null {
  try {
    const parsed = new URL(cursor, content.url)
    if (!isAllowedPlatformHost(parsed.hostname, ['zhihu.com'])) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function weiboCommentsPageUrl(content: ContentRef, cursor: string): string | null {
  try {
    if (/^https?:\/\//i.test(cursor) || cursor.startsWith('/')) {
      const parsed = new URL(cursor, content.url)
      if (!isAllowedPlatformHost(parsed.hostname, ['weibo.com'])) return null
      return parsed.toString()
    }
    const parsed = new URL(content.url)
    parsed.pathname = '/ajax/statuses/buildComments'
    parsed.search = ''
    parsed.searchParams.set('id', content.contentId)
    parsed.searchParams.set('is_reload', '1')
    parsed.searchParams.set('is_show_bulletin', '2')
    parsed.searchParams.set('is_mix', '0')
    parsed.searchParams.set('count', '20')
    parsed.searchParams.set('max_id', cursor)
    return parsed.toString()
  } catch {
    return null
  }
}

function instagramCommentsPageUrl(content: ContentRef, cursor: string): string {
  const parsed = new URL(content.url)
  parsed.pathname = '/graphql/query/'
  parsed.search = ''
  parsed.searchParams.set('query_hash', '97b41c52301f77ce508f55e66d17620e')
  parsed.searchParams.set('variables', JSON.stringify({
    shortcode: content.contentId,
    first: 24,
    after: cursor
  }))
  return parsed.toString()
}

function shortVideoCommentsPageUrl(content: ContentRef, cursor: string): string | null {
  try {
    const parsed = new URL(content.url)
    const sourceParams = new URLSearchParams(parsed.search)
    parsed.search = ''
    if (content.platformKey === 'douyin') {
      parsed.pathname = '/aweme/v1/web/comment/list/'
      parsed.searchParams.set('aweme_id', content.contentId)
      parsed.searchParams.set('device_platform', sourceParams.get('device_platform') ?? 'webapp')
      parsed.searchParams.set('aid', sourceParams.get('aid') ?? '6383')
    } else if (content.platformKey === 'tiktok') {
      parsed.pathname = '/api/comment/list/'
      parsed.searchParams.set('item_id', content.contentId)
      parsed.searchParams.set('aid', sourceParams.get('aid') ?? '1988')
    } else {
      return null
    }
    parsed.searchParams.set('cursor', cursor)
    parsed.searchParams.set('count', '20')
    copyKnownShortVideoRiskParams(sourceParams, parsed.searchParams)
    return parsed.toString()
  } catch {
    return null
  }
}

function kuaishouCommentsPageUrl(content: ContentRef, _cursor: string): string {
  const parsed = new URL(content.url)
  parsed.pathname = '/graphql'
  parsed.search = ''
  return parsed.toString()
}

function kuaishouCommentsPageBody(content: ContentRef, cursor: string): Record<string, unknown> {
  return {
    operationName: 'visionCommentList',
    variables: {
      photoId: content.contentId,
      pcursor: cursor
    },
    query: 'query visionCommentList($photoId: String, $pcursor: String) { visionCommentList(photoId: $photoId, pcursor: $pcursor) { commentCount pcursor rootComments { commentId content timestamp likedCount author { id name } } } }'
  }
}

function copyKnownShortVideoRiskParams(source: URLSearchParams, target: URLSearchParams): void {
  for (const key of ['msToken', 'X-Bogus', '_signature', 'verifyFp', 'fp', 'webid']) {
    const value = source.get(key)
    if (value && !target.has(key)) target.set(key, value)
  }
}

function xiaohongshuErrorMessage(html: string): string {
  if (/验证码|风控|滑块|验证|captcha|verify/i.test(html)) {
    return '小红书评论采集失败: 触发验证码或风控校验。建议先登录并完成验证，降低采集频率后重试。'
  }
  if (/请求过于频繁|访问频繁|限流|too many|rate limit/i.test(html)) {
    return '小红书评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。'
  }
  if (/登录后|请登录|login|sign in/i.test(html)) {
    return '小红书评论采集失败: 需要登录后访问评论。建议先完成小红书登录后重试。'
  }
  return ''
}

function shortVideoErrorMessage(platformName: string, html: string): string {
  if (/验证码|风控|滑块|验证|captcha|verify|security check/i.test(html)) {
    return `${platformName} 评论采集失败: 触发验证码或风控校验。建议先登录并完成验证，降低采集频率后重试。`
  }
  if (/请求过于频繁|访问频繁|限流|too many|rate limit/i.test(html)) {
    return `${platformName} 评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。`
  }
  if (/登录后|请登录|login|sign in/i.test(html)) {
    return `${platformName} 评论采集失败: 需要登录后访问评论。建议先完成平台登录后重试。`
  }
  return ''
}

function instagramErrorMessage(html: string): string {
  if (/challenge|checkpoint|captcha|verify|security check|验证码|验证/i.test(html)) {
    return 'Instagram 评论采集失败: 触发验证或风控校验。建议先登录并完成验证，降低采集频率后重试。'
  }
  if (/too many|rate limit|temporarily blocked|try again later|限流|请求过于频繁/i.test(html)) {
    return 'Instagram 评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。'
  }
  if (/log in|login|sign in|登录/i.test(html)) {
    return 'Instagram 评论采集失败: 需要登录后访问评论。建议先完成 Instagram 登录后重试。'
  }
  if (/forbidden|private|not available|permission|权限/i.test(html)) {
    return 'Instagram 评论采集失败: 内容不可见或权限受限。建议检查账号权限、帖子可见范围后重试。'
  }
  return ''
}

function weiboErrorMessage(html: string): string {
  if (/验证码|安全验证|访问验证|verify|captcha|security check/i.test(html)) {
    return '微博评论采集失败: 触发验证码或风控校验。建议先登录并完成验证，降低采集频率后重试。'
  }
  if (/请求过于频繁|访问频繁|操作频繁|限流|too many|rate limit/i.test(html)) {
    return '微博评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。'
  }
  if (/登录后|请登录|login|sign in/i.test(html)) {
    return '微博评论采集失败: 需要登录后访问评论。建议先完成微博登录后重试。'
  }
  if (/没有权限|权限|forbidden|permission|内容不存在|已删除/i.test(html)) {
    return '微博评论采集失败: 内容不可见或权限受限。建议检查账号权限、微博可见范围后重试。'
  }
  return ''
}

function zhihuErrorMessage(html: string): string {
  if (/验证码|安全验证|验证|captcha|verify|security check/i.test(html)) {
    return '知乎评论采集失败: 触发验证码或风控校验。建议先登录并完成验证，降低采集频率后重试。'
  }
  if (/请求过于频繁|访问频繁|操作频繁|限流|too many|rate limit/i.test(html)) {
    return '知乎评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。'
  }
  if (/登录后|请登录|login|sign in/i.test(html)) {
    return '知乎评论采集失败: 需要登录后访问评论。建议先完成知乎登录后重试。'
  }
  if (/没有权限|权限|forbidden|permission|内容不存在|已删除|404/i.test(html)) {
    return '知乎评论采集失败: 内容不可见或权限受限。建议检查账号权限、内容可见范围后重试。'
  }
  return ''
}

function kuaishouErrorMessage(html: string): string {
  if (/验证码|安全验证|验证|captcha|verify|security check|滑块/i.test(html)) {
    return '快手评论采集失败: 触发验证码或风控校验。建议先登录并完成验证，降低采集频率后重试。'
  }
  if (/请求过于频繁|访问频繁|操作频繁|限流|too many|rate limit/i.test(html)) {
    return '快手评论采集失败: 请求过于频繁。建议稍后重试或降低采集频率。'
  }
  if (/登录后|请登录|login|sign in/i.test(html)) {
    return '快手评论采集失败: 需要登录后访问评论。建议先完成快手登录后重试。'
  }
  if (/没有权限|权限|forbidden|permission|内容不存在|已删除|404/i.test(html)) {
    return '快手评论采集失败: 内容不可见或权限受限。建议检查账号权限、内容可见范围后重试。'
  }
  return ''
}

function uniqueComments(comments: CommentRecord[]): CommentRecord[] {
  const seen = new Set<string>()
  const unique: CommentRecord[] = []
  for (const comment of comments) {
    const key = `${comment.id}:${comment.text}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(comment)
  }
  return unique
}

function extractContentTitle(html: string, platformKey: string): string | undefined {
  const structuredTitle = extractStructuredContentTitle(html, platformKey)
  if (structuredTitle) return structuredTitle
  const candidates = [
    /<meta\s+[^>]*(?:property|name)=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i,
    /<meta\s+[^>]*(?:property|name)=["']twitter:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']twitter:title["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ]
  for (const pattern of candidates) {
    const match = html.match(pattern)
    const title = match?.[1] ? decodeHtmlText(match[1]).trim() : ''
    if (title) return title
  }
  return undefined
}

function extractStructuredContentTitle(text: string, platformKey: string): string | undefined {
  for (const root of extractPageJsonObjects(text)) {
    let title = ''
    walkPageJson(root, (node) => {
      if (title) return
      title = titleFromStructuredNode(platformKey, node)
    })
    const normalized = normalizeStructuredTitle(title)
    if (normalized) return normalized
  }
  return undefined
}

function titleFromStructuredNode(platformKey: string, node: Record<string, unknown>): string {
  const containers = [
    node.note,
    node.noteData,
    node.note_data,
    node.aweme_detail,
    node.awemeDetail,
    node.itemStruct,
    (node.itemInfo as Record<string, unknown> | undefined)?.itemStruct,
    node.video,
    node.photo,
    node.feed,
    node.status,
    node.question,
    node.answer,
    node.article,
    node.media
  ]
  for (const container of containers) {
    if (container && typeof container === 'object' && !Array.isArray(container)) {
      const title = titleFromRecord(platformKey, container as Record<string, unknown>)
      if (title) return title
    }
  }
  return titleFromRecord(platformKey, node)
}

function titleFromRecord(platformKey: string, node: Record<string, unknown>): string {
  const keysByPlatform: Record<string, string[]> = {
    xiaohongshu: ['title', 'display_title', 'displayTitle', 'desc', 'description'],
    douyin: ['desc', 'description', 'title', 'caption'],
    tiktok: ['desc', 'description', 'title', 'caption'],
    instagram: ['caption', 'text', 'title'],
    weibo: ['text_raw', 'textRaw', 'title', 'text'],
    zhihu: ['title', 'questionTitle', 'question_title', 'excerpt'],
    kuaishou: ['caption', 'title', 'desc', 'description', 'content'],
    reddit: ['title']
  }
  const keys = keysByPlatform[platformKey] ?? ['title', 'desc', 'description']
  for (const key of keys) {
    const value = node[key]
    if (typeof value === 'string' && value.trim()) return value
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>
      if (typeof nested.text === 'string' && nested.text.trim()) return nested.text
      if (typeof nested.content === 'string' && nested.content.trim()) return nested.content
    }
  }
  return ''
}

function extractPageJsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  try {
    objects.push(JSON.parse(text))
  } catch {
    // Full HTML pages commonly carry state in script blocks instead.
  }
  const candidates = [
    ...text.matchAll(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/g),
    ...text.matchAll(/__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/g),
    ...text.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g)
  ]
  for (const match of candidates) {
    try {
      objects.push(JSON.parse(match[1]))
    } catch {
      // Ignore malformed or partial state blocks.
    }
  }
  return objects
}

function walkPageJson(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkPageJson(item, visitor)
    return
  }
  const node = value as Record<string, unknown>
  visitor(node)
  for (const child of Object.values(node)) walkPageJson(child, visitor)
}

function normalizeStructuredTitle(value: string): string | undefined {
  const normalized = decodeHtmlText(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length < 4 || normalized.length > 180) return undefined
  if (/^(登录|注册|关注|分享|点赞|收藏|评论|reply|share|like|login|sign in)$/i.test(normalized)) return undefined
  return normalized
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
}
