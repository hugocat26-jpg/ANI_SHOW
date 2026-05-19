import type { CommentRecord, ContentRef } from '../domain/types.ts'

export interface BilibiliApiErrorInfo {
  code: number
  message: string
  retryable: boolean
  formatted: string
}

export interface BilibiliWbiKeys {
  imgKey: string
  subKey: string
}

export interface YoutubeContinuationRequest {
  token: string
  apiKey: string | null
  clientName: string
  clientVersion: string
  visitorData?: string
}

export interface XiaohongshuPageCursor {
  cursor: string | null
  hasMore: boolean
}

function now(): string {
  return new Date().toISOString()
}

function createComment(content: ContentRef, id: string, nickname: string, text: string, likes = 0, publishedAt = ''): CommentRecord {
  return {
    id: `${content.platformKey}-${content.contentId}-${id}`,
    platformKey: content.platformKey,
    contentId: content.contentId,
    contentUrl: content.url,
    nickname: nickname || '未知用户',
    text,
    likes,
    publishedAt: publishedAt || now(),
    collectedAt: now()
  }
}

function walk(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor)
    return
  }
  const record = value as Record<string, unknown>
  visitor(record)
  for (const child of Object.values(record)) walk(child, visitor)
}

function textFromNode(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (!value || typeof value !== 'object') return ''
  const node = value as Record<string, unknown>
  if (typeof node.simpleText === 'string') return node.simpleText
  if (Array.isArray(node.runs)) {
    return node.runs
      .map((item) => typeof item === 'object' && item && 'text' in item ? String((item as Record<string, unknown>).text ?? '') : '')
      .join('')
  }
  return ''
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textFromNode(value).trim()
    if (text) return text
  }
  return ''
}

function parseCompactNumber(value: string): number {
  const normalized = value.trim().replaceAll(',', '')
  const match = normalized.match(/(\d+(?:\.\d+)?)/)
  if (!match) return 0
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return 0
  if (/[kK千]/.test(normalized)) return Math.round(amount * 1_000)
  if (/[mM]/.test(normalized)) return Math.round(amount * 1_000_000)
  if (/[wW万]/.test(normalized)) return Math.round(amount * 10_000)
  return Math.round(amount)
}

function extractJsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  try {
    objects.push(JSON.parse(text))
  } catch {
    // The input can also be a full HTML document with embedded JSON blocks.
  }
  const candidates = [
    ...text.matchAll(/ytInitialData\s*=\s*({[\s\S]*?});\s*<\/script>/g),
    ...text.matchAll(/__INITIAL_STATE__\s*=\s*({[\s\S]*?});/g),
    ...text.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g)
  ]
  for (const match of candidates) {
    try {
      objects.push(JSON.parse(match[1]))
    } catch {
      // Ignore malformed or partial script blocks.
    }
  }
  return objects
}

export function extractBilibiliAid(text: string): string | null {
  for (const root of extractJsonObjects(text)) {
    let aid: string | null = null
    walk(root, (node) => {
      if (aid) return
      const candidate = node.aid ?? node.avid ?? node.oid
      if (typeof candidate === 'number' || typeof candidate === 'string') {
        const value = String(candidate)
        if (/^\d+$/.test(value)) aid = value
      }
    })
    if (aid) return aid
  }
  return null
}

export function extractBilibiliWbiKeys(text: string): BilibiliWbiKeys | null {
  for (const root of extractJsonObjects(text)) {
    let keys: BilibiliWbiKeys | null = null
    walk(root, (node) => {
      if (keys) return
      const imgUrl = typeof node.img_url === 'string' ? node.img_url : typeof node.imgUrl === 'string' ? node.imgUrl : ''
      const subUrl = typeof node.sub_url === 'string' ? node.sub_url : typeof node.subUrl === 'string' ? node.subUrl : ''
      const imgKey = bilibiliKeyFromUrl(imgUrl)
      const subKey = bilibiliKeyFromUrl(subUrl)
      if (imgKey && subKey) keys = { imgKey, subKey }
    })
    if (keys) return keys
  }
  return null
}

function bilibiliKeyFromUrl(url: string): string {
  if (!url) return ''
  const match = /\/([^/?#]+)\.(?:png|jpg|jpeg|webp)$/i.exec(url)
  return match?.[1] ?? ''
}

export function extractBilibiliNextOffset(jsonText: string): string | null {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return null
  }
  let offset: string | null = null
  let isEnd = false
  walk(root, (node) => {
    if (offset || isEnd) return
    if (node.is_end === true || node.isEnd === true) {
      isEnd = true
      return
    }
    const candidate = node.next_offset ?? node.nextOffset
    if (typeof candidate === 'string' && candidate.trim()) offset = candidate
  })
  return isEnd ? null : offset
}

export function extractBilibiliReplyRoots(jsonText: string, limit = 5): string[] {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return []
  }
  const roots: string[] = []
  const seen = new Set<string>()
  walk(root, (node) => {
    if (roots.length >= limit) return
    const id = node.rpid ?? node.id
    const replyCount = Number(node.rcount ?? node.reply_count ?? 0)
    if ((typeof id === 'number' || typeof id === 'string') && replyCount > 0) {
      const value = String(id)
      if (!seen.has(value)) {
        seen.add(value)
        roots.push(value)
      }
    }
  })
  return roots
}

export function extractBilibiliApiErrorInfo(jsonText: string): BilibiliApiErrorInfo | null {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const record = root as Record<string, unknown>
  const code = Number(record.code ?? 0)
  if (!Number.isFinite(code) || code === 0) return null
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.msg === 'string' ? record.msg : 'B站接口返回错误'
  const retryable = isRetryableBilibiliApiCode(code, message)
  const suggestion = bilibiliApiSuggestion(code, message, retryable)
  return {
    code,
    message,
    retryable,
    formatted: `B站接口错误 ${code}: ${message}。${suggestion}`
  }
}

export function extractBilibiliApiError(jsonText: string): string | null {
  return extractBilibiliApiErrorInfo(jsonText)?.formatted ?? null
}

function isRetryableBilibiliApiCode(code: number, message: string): boolean {
  if (code === -101 || code === -352 || code === -412 || code === -403 || code === 403 || code === 404) return false
  if (code === -509 || code === 429 || code === 408 || code >= 500) return true
  return /限流|频率|稍后|繁忙|timeout|timed out|rate|too many/i.test(message)
}

function bilibiliApiSuggestion(code: number, message: string, retryable: boolean): string {
  if (code === -101 || /未登录|账号|登录|login/i.test(message)) {
    return '建议先登录 B站账号，并确认登录状态可访问该视频后再重试。'
  }
  if (code === -352 || code === -412 || /风控|验证码|校验|拦截|captcha/i.test(message)) {
    return '建议完成登录/验证，降低采集频率，稍后再重试。'
  }
  if (code === -403 || code === 403 || /权限|forbidden|permission/i.test(message)) {
    return '建议检查账号权限、视频可见范围或更换可访问账号后重试。'
  }
  if (retryable) {
    return '系统会自动重试；如仍失败，建议降低采集频率后再试。'
  }
  return '建议检查登录状态、访问权限或稍后重试。'
}

export function parseYoutubeComments(content: ContentRef, html: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(html)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      const renderer = node.commentRenderer as Record<string, unknown> | undefined
      if (renderer) {
        addYoutubeComment(comments, seen, content, {
          id: String(renderer.commentId ?? comments.length),
          nickname: firstText(renderer.authorText, renderer.author, renderer.authorName) || '未知用户',
          text: firstText(renderer.contentText, renderer.commentText, renderer.content),
          likes: parseCompactNumber(firstText(renderer.voteCount, renderer.likeCount, renderer.voteCountText))
        })
        return
      }

      const viewModel = node.commentViewModel as Record<string, unknown> | undefined
      if (viewModel) {
        addYoutubeComment(comments, seen, content, {
          id: String(viewModel.commentId ?? viewModel.commentKey ?? viewModel.key ?? comments.length),
          nickname: youtubeViewModelAuthor(viewModel),
          text: youtubeViewModelText(viewModel),
          likes: youtubeViewModelLikes(viewModel)
        })
        return
      }

      const entity = node.commentEntityPayload as Record<string, unknown> | undefined
      if (entity) {
        addYoutubeComment(comments, seen, content, {
          id: String(entity.commentId ?? entity.key ?? entity.id ?? comments.length),
          nickname: youtubeEntityAuthor(entity),
          text: youtubeEntityText(entity),
          likes: youtubeEntityLikes(entity)
        })
      }
    })
  }
  return comments
}

function addYoutubeComment(
  comments: CommentRecord[],
  seen: Set<string>,
  content: ContentRef,
  input: { id: string; nickname: string; text: string; likes: number }
): void {
  const text = input.text.trim()
  if (!text || comments.length >= 50) return
  const key = `${input.id}:${text}`
  if (seen.has(key)) return
  seen.add(key)
  comments.push(createComment(content, input.id, input.nickname || '未知用户', text, input.likes))
}

function youtubeViewModelText(node: Record<string, unknown>): string {
  const content = node.content as Record<string, unknown> | undefined
  const properties = node.properties as Record<string, unknown> | undefined
  return firstText(
    node.contentText,
    node.commentText,
    node.text,
    node.body,
    content?.content,
    content?.contentText,
    content?.text,
    properties?.content,
    properties?.contentText,
    properties?.text
  )
}

function youtubeViewModelAuthor(node: Record<string, unknown>): string {
  const author = node.author as Record<string, unknown> | undefined
  const properties = node.properties as Record<string, unknown> | undefined
  return firstText(
    node.authorText,
    node.authorName,
    node.author,
    author?.displayName,
    author?.name,
    author?.text,
    properties?.author,
    properties?.authorName,
    properties?.authorText
  ) || '未知用户'
}

function youtubeViewModelLikes(node: Record<string, unknown>): number {
  const toolbar = node.toolbar as Record<string, unknown> | undefined
  const properties = node.properties as Record<string, unknown> | undefined
  return parseCompactNumber(firstText(
    node.voteCount,
    node.likeCount,
    node.voteCountText,
    toolbar?.likeCount,
    toolbar?.voteCount,
    properties?.likeCount,
    properties?.voteCount
  ))
}

function youtubeEntityText(node: Record<string, unknown>): string {
  const properties = node.properties as Record<string, unknown> | undefined
  return firstText(
    node.content,
    node.contentText,
    node.text,
    properties?.content,
    properties?.contentText,
    properties?.text
  )
}

function youtubeEntityAuthor(node: Record<string, unknown>): string {
  const author = node.author as Record<string, unknown> | undefined
  const properties = node.properties as Record<string, unknown> | undefined
  return firstText(
    node.author,
    node.authorText,
    node.authorName,
    author?.displayName,
    author?.name,
    properties?.author,
    properties?.authorText,
    properties?.authorName
  ) || '未知用户'
}

function youtubeEntityLikes(node: Record<string, unknown>): number {
  const toolbar = node.toolbar as Record<string, unknown> | undefined
  const properties = node.properties as Record<string, unknown> | undefined
  return parseCompactNumber(firstText(
    node.likeCount,
    node.voteCount,
    toolbar?.likeCount,
    toolbar?.voteCount,
    properties?.likeCount,
    properties?.voteCount
  ))
}

export function extractYoutubeContinuationRequests(text: string, limit = 3): YoutubeContinuationRequest[] {
  const apiKey = extractYoutubeConfigValue(text, 'INNERTUBE_API_KEY')
  const clientName = extractYoutubeConfigValue(text, 'INNERTUBE_CLIENT_NAME') ?? 'WEB'
  const clientVersion = extractYoutubeConfigValue(text, 'INNERTUBE_CLIENT_VERSION') ?? '2.20250101.00.00'
  const visitorData = extractYoutubeConfigValue(text, 'VISITOR_DATA') ?? undefined
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (tokens.length >= limit) return
      const endpoint = node.continuationEndpoint as Record<string, unknown> | undefined
      const command = (endpoint?.continuationCommand ?? node.continuationCommand) as Record<string, unknown> | undefined
      const candidates = [
        command?.token,
        (node.nextContinuationData as Record<string, unknown> | undefined)?.continuation,
        (node.reloadContinuationData as Record<string, unknown> | undefined)?.continuation,
        (node.timedContinuationData as Record<string, unknown> | undefined)?.continuation
      ]
      for (const token of candidates) {
        if (tokens.length >= limit) return
        if (typeof token !== 'string' || !token || seen.has(token)) continue
        seen.add(token)
        tokens.push(token)
      }
    })
  }
  return tokens.map((token) => ({ token, apiKey, clientName, clientVersion, visitorData }))
}

function extractYoutubeConfigValue(text: string, key: string): string | null {
  const quoted = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text)
  if (quoted?.[1]) return quoted[1]
  const assigned = new RegExp(`${key}\\s*[:=]\\s*"([^"]+)"`).exec(text)
  return assigned?.[1] ?? null
}

export function parseBilibiliComments(content: ContentRef, jsonText: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return comments
  }
  walk(root, (node) => {
    if (comments.length >= limit) return
    const contentNode = node.content as Record<string, unknown> | undefined
    const memberNode = node.member as Record<string, unknown> | undefined
    const message = typeof contentNode?.message === 'string' ? contentNode.message : ''
    if (!message) return
    const id = String(node.rpid ?? node.id ?? comments.length)
    const nickname = String(memberNode?.uname ?? '未知用户')
    const likes = Number(node.like ?? 0) || 0
    const ctime = Number(node.ctime ?? 0)
    comments.push(createComment(content, id, nickname, message, likes, ctime ? new Date(ctime * 1000).toISOString() : ''))
  })
  return comments
}

export function parseGenericHtmlComments(content: ContentRef, html: string, limit = 30): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()

  const dataCommentPattern = /<[^>]+data-comment-text=["']([^"']+)["'][^>]*>/gi
  for (const match of html.matchAll(dataCommentPattern)) {
    if (comments.length >= limit) break
    const tag = match[0]
    const text = normalizeHtmlText(match[1])
    const nickname = normalizeHtmlText(readHtmlAttr(tag, 'data-comment-author') ?? readHtmlAttr(tag, 'data-author') ?? '')
    addGenericComment(comments, seen, content, nickname, text)
  }

  const blockPattern = /<(article|div|li|section)\b[^>]*(?:class|data-testid|role)=["'][^"']*(?:comment|reply|review|note|feed|post)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi
  for (const match of html.matchAll(blockPattern)) {
    if (comments.length >= limit) break
    const block = match[0]
    const inner = match[2]
    const nickname = extractNestedText(block, '(?:author|user|nickname|name)')
    const text = extractNestedText(block, '(?:comment|reply|review|content|text|body)')
      || normalizeHtmlText(stripHtml(inner))
    addGenericComment(comments, seen, content, nickname, text)
  }

  return comments
}

export function parseShortVideoComments(content: ContentRef, text: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      const body = shortVideoCommentText(node)
      if (!isUsefulGenericCommentText(body)) return
      const id = String(node.cid ?? node.comment_id ?? node.commentId ?? node.id ?? comments.length)
      const nickname = shortVideoNickname(node)
      const likes = parseCompactNumber(String(node.digg_count ?? node.diggCount ?? node.like_count ?? node.likeCount ?? node.likes ?? '0'))
      const time = shortVideoPublishedAt(node)
      const dedupe = `${id}:${body}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      comments.push(createComment(content, id, nickname, normalizeHtmlText(body), likes, time))
    })
  }
  return comments
}

export function extractShortVideoCursor(text: string): XiaohongshuPageCursor {
  let cursor: string | null = null
  let hasMore = false
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (!cursor) {
        const candidate = node.cursor ?? node.next_cursor ?? node.nextCursor ?? node.max_cursor ?? node.maxCursor
        if (typeof candidate === 'string' && candidate.trim()) cursor = candidate
        if (typeof candidate === 'number' && Number.isFinite(candidate)) cursor = String(candidate)
      }
      const more = node.has_more ?? node.hasMore ?? node.has_next ?? node.hasNext
      if (more === true || more === 1 || more === 'true') hasMore = true
    })
  }
  return { cursor, hasMore }
}

export function parseInstagramComments(content: ContentRef, text: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      if (!isInstagramCommentShape(node)) return
      const body = instagramCommentText(node)
      if (!isUsefulGenericCommentText(body)) return
      const id = String(node.id ?? node.pk ?? node.comment_id ?? node.commentId ?? comments.length)
      const nickname = instagramNickname(node)
      const likes = instagramLikeCount(node)
      const time = instagramPublishedAt(node)
      const dedupe = `${id}:${body}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      comments.push(createComment(content, id, nickname, normalizeHtmlText(body), likes, time))
    })
  }
  return comments
}

export function extractInstagramPageCursor(text: string): XiaohongshuPageCursor {
  let cursor: string | null = null
  let hasMore = false
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (!cursor) {
        const candidate = node.end_cursor ?? node.endCursor ?? node.next_cursor ?? node.nextCursor ?? node.cursor
        if (typeof candidate === 'string' && candidate.trim()) cursor = candidate
      }
      const more = node.has_next_page ?? node.hasNextPage ?? node.has_more ?? node.hasMore
      if (more === true || more === 1 || more === 'true') hasMore = true
    })
  }
  return { cursor, hasMore }
}

export function parseWeiboComments(content: ContentRef, text: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      if (!isWeiboCommentShape(node)) return
      const body = weiboCommentText(node)
      if (!isUsefulGenericCommentText(body)) return
      const id = String(node.id ?? node.idstr ?? node.comment_id ?? node.commentId ?? comments.length)
      const nickname = weiboNickname(node)
      const likes = parseCompactNumber(String(node.like_counts ?? node.likeCounts ?? node.likes ?? node.attitudes_count ?? '0'))
      const time = weiboPublishedAt(node)
      const dedupe = `${id}:${body}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      comments.push(createComment(content, id, nickname, normalizeHtmlText(stripHtml(body)), likes, time))
    })
  }
  return comments
}

export function extractWeiboPageCursor(text: string): XiaohongshuPageCursor {
  let cursor: string | null = null
  let hasMore = false
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (!cursor) {
        const candidate = node.max_id ?? node.maxId ?? node.next_cursor ?? node.nextCursor ?? node.cursor
        if (typeof candidate === 'string' && candidate.trim() && candidate !== '0') cursor = candidate
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) cursor = String(candidate)
      }
      const more = node.has_more ?? node.hasMore ?? node.has_next ?? node.hasNext
      if (more === true || more === 1 || more === 'true') hasMore = true
      const maxId = node.max_id ?? node.maxId
      if ((typeof maxId === 'number' && maxId > 0) || (typeof maxId === 'string' && maxId !== '0' && maxId.trim())) hasMore = true
    })
  }
  return { cursor, hasMore }
}

export function parseZhihuComments(content: ContentRef, text: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      if (!isZhihuCommentShape(node)) return
      const body = zhihuCommentText(node)
      if (!isUsefulGenericCommentText(body)) return
      const id = String(node.id ?? node.comment_id ?? node.commentId ?? comments.length)
      const nickname = zhihuNickname(node)
      const likes = parseCompactNumber(String(node.vote_count ?? node.voteCount ?? node.like_count ?? node.likeCount ?? node.likes ?? '0'))
      const time = zhihuPublishedAt(node)
      const dedupe = `${id}:${body}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      comments.push(createComment(content, id, nickname, normalizeHtmlText(stripHtml(body)), likes, time))
    })
  }
  return comments
}

export function extractZhihuPageCursor(text: string): XiaohongshuPageCursor {
  let cursor: string | null = null
  let hasMore = false
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      const paging = node.paging as Record<string, unknown> | undefined
      if (!cursor) {
        const candidate = node.next ?? node.next_url ?? node.nextUrl ?? node.cursor ?? paging?.next
        if (typeof candidate === 'string' && candidate.trim()) cursor = candidate
      }
      const isEnd = node.is_end ?? node.isEnd ?? paging?.is_end ?? paging?.isEnd
      if (isEnd === false || isEnd === 0 || isEnd === 'false') hasMore = true
      const more = node.has_more ?? node.hasMore ?? node.has_next ?? node.hasNext
      if (more === true || more === 1 || more === 'true') hasMore = true
    })
  }
  return { cursor, hasMore }
}

export function parseRedditComments(content: ContentRef, jsonText: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return comments
  }
  walk(root, (node) => {
    if (comments.length >= limit) return
    if (node.kind !== 't1') return
    const data = node.data as Record<string, unknown> | undefined
    const body = typeof data?.body === 'string' ? data.body : ''
    if (!isUsefulGenericCommentText(body)) return
    const id = String(data?.id ?? comments.length)
    const nickname = typeof data?.author === 'string' ? data.author : '未知用户'
    const likes = Number(data?.score ?? data?.ups ?? 0) || 0
    const createdUtc = Number(data?.created_utc ?? 0)
    comments.push(createComment(content, id, nickname, normalizeHtmlText(body), likes, createdUtc ? new Date(createdUtc * 1000).toISOString() : ''))
  })
  return comments
}

export function parseXiaohongshuComments(content: ContentRef, text: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      const body = xiaohongshuCommentText(node)
      if (!isUsefulGenericCommentText(body)) return
      const nickname = xiaohongshuNickname(node)
      const id = String(node.id ?? node.comment_id ?? node.commentId ?? node.note_id ?? comments.length)
      const likes = parseCompactNumber(String(node.like_count ?? node.likeCount ?? node.likes ?? node.like ?? '0'))
      const time = xiaohongshuPublishedAt(node)
      const dedupe = `${id}:${body}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      comments.push(createComment(content, id, nickname, normalizeHtmlText(body), likes, time))
    })
  }
  return comments
}

export function extractXiaohongshuPageCursor(text: string): XiaohongshuPageCursor {
  let cursor: string | null = null
  let hasMore = false
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (!cursor) {
        const candidate = node.cursor ?? node.next_cursor ?? node.nextCursor ?? node.end_cursor ?? node.endCursor
        if (typeof candidate === 'string' && candidate.trim()) cursor = candidate
      }
      const more = node.has_more ?? node.hasMore ?? node.has_next ?? node.hasNext
      if (more === true || more === 1 || more === 'true') hasMore = true
    })
  }
  return { cursor, hasMore }
}

export function parseKuaishouComments(content: ContentRef, text: string, limit = 50): CommentRecord[] {
  const comments: CommentRecord[] = []
  const seen = new Set<string>()
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (comments.length >= limit) return
      const body = kuaishouCommentText(node)
      if (!isUsefulGenericCommentText(body)) return
      const nickname = kuaishouNickname(node)
      const id = String(node.commentId ?? node.comment_id ?? node.cid ?? node.id ?? comments.length)
      const likes = parseCompactNumber(String(node.likedCount ?? node.likeCount ?? node.like_count ?? node.likes ?? node.like ?? '0'))
      const time = kuaishouPublishedAt(node)
      const dedupe = `${id}:${body}`
      if (seen.has(dedupe)) return
      seen.add(dedupe)
      comments.push(createComment(content, id, nickname, normalizeHtmlText(body), likes, time))
    })
  }
  return comments
}

export function extractKuaishouPageCursor(text: string): XiaohongshuPageCursor {
  let cursor: string | null = null
  let hasMore = false
  for (const root of extractJsonObjects(text)) {
    walk(root, (node) => {
      if (!cursor) {
        const candidate = node.pcursor ?? node.cursor ?? node.nextCursor ?? node.next_cursor
        if (typeof candidate === 'string' && candidate.trim() && candidate !== 'no_more') cursor = candidate
        if (typeof candidate === 'number' && Number.isFinite(candidate)) cursor = String(candidate)
      }
      const more = node.hasMore ?? node.has_more ?? node.hasNext ?? node.has_next
      if (more === true || more === 1 || more === 'true') hasMore = true
      if (typeof node.pcursor === 'string' && node.pcursor.trim() && node.pcursor !== 'no_more') hasMore = true
    })
  }
  return { cursor, hasMore }
}

export function extractRedditMoreChildren(jsonText: string, limit = 20): string[] {
  let root: unknown
  try {
    root = JSON.parse(jsonText)
  } catch {
    return []
  }
  const children: string[] = []
  const seen = new Set<string>()
  walk(root, (node) => {
    if (children.length >= limit || node.kind !== 'more') return
    const data = node.data as Record<string, unknown> | undefined
    const values = Array.isArray(data?.children) ? data.children : []
    for (const value of values) {
      if (children.length >= limit) break
      const id = typeof value === 'string' ? value : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      children.push(id)
    }
  })
  return children
}

function addGenericComment(
  comments: CommentRecord[],
  seen: Set<string>,
  content: ContentRef,
  nickname: string,
  text: string
): void {
  const normalized = normalizeHtmlText(text)
  if (!isUsefulGenericCommentText(normalized) || seen.has(normalized)) return
  seen.add(normalized)
  comments.push(createComment(content, `generic-${comments.length + 1}`, nickname || '未知用户', normalized))
}

function extractNestedText(html: string, classPattern: string): string {
  const pattern = new RegExp(`<[^>]+(?:class|data-testid)=["'][^"']*${classPattern}[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i')
  return normalizeHtmlText(stripHtml(pattern.exec(html)?.[1] ?? ''))
}

function readHtmlAttr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}=["']([^"']+)["']`, 'i').exec(tag)
  return match?.[1] ?? null
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function normalizeHtmlText(value: string): string {
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

function xiaohongshuCommentText(node: Record<string, unknown>): string {
  const candidates = [
    node.content,
    node.text,
    node.comment,
    node.comment_content,
    node.commentContent,
    node.desc
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return ''
}

function xiaohongshuNickname(node: Record<string, unknown>): string {
  const user = (node.user_info ?? node.userInfo ?? node.user) as Record<string, unknown> | undefined
  const candidate = user?.nickname ?? user?.nickName ?? user?.name ?? node.nickname ?? node.nickName
  return typeof candidate === 'string' && candidate.trim() ? candidate : '未知用户'
}

function xiaohongshuPublishedAt(node: Record<string, unknown>): string {
  const raw = node.create_time ?? node.createTime ?? node.time ?? node.timestamp
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
}

function kuaishouCommentText(node: Record<string, unknown>): string {
  const candidates = [
    node.content,
    node.text,
    node.comment,
    node.commentContent,
    node.comment_content
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return ''
}

function kuaishouNickname(node: Record<string, unknown>): string {
  const author = (node.author ?? node.user ?? node.userInfo ?? node.user_info) as Record<string, unknown> | undefined
  const candidate = author?.name
    ?? author?.userName
    ?? author?.username
    ?? author?.nickname
    ?? author?.nickName
    ?? node.userName
    ?? node.nickname
  return typeof candidate === 'string' && candidate.trim() ? candidate : '未知用户'
}

function kuaishouPublishedAt(node: Record<string, unknown>): string {
  const raw = node.timestamp ?? node.createTime ?? node.create_time ?? node.createdAt ?? node.created_at
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
}

function shortVideoCommentText(node: Record<string, unknown>): string {
  const candidates = [
    node.text,
    node.comment_text,
    node.commentText,
    node.content,
    node.comment,
    node.reply_comment
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return ''
}

function shortVideoNickname(node: Record<string, unknown>): string {
  const user = (node.user ?? node.user_info ?? node.userInfo ?? node.author) as Record<string, unknown> | undefined
  const candidate = user?.nickname ?? user?.nickName ?? user?.unique_id ?? user?.uniqueId ?? user?.name ?? node.nickname
  return typeof candidate === 'string' && candidate.trim() ? candidate : '未知用户'
}

function shortVideoPublishedAt(node: Record<string, unknown>): string {
  const raw = node.create_time ?? node.createTime ?? node.create_at ?? node.createAt ?? node.timestamp
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
}

function isInstagramCommentShape(node: Record<string, unknown>): boolean {
  const typename = typeof node.__typename === 'string' ? node.__typename.toLowerCase() : ''
  if (typename.includes('comment')) return true
  return Boolean(
    node.owner
      || node.user
      || node.comment_owner
      || node.commentOwner
      || node.comment_id
      || node.commentId
  )
}

function instagramCommentText(node: Record<string, unknown>): string {
  const candidates = [
    node.text,
    node.body,
    node.comment,
    node.content,
    node.caption
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return ''
}

function instagramNickname(node: Record<string, unknown>): string {
  const owner = (node.owner ?? node.user ?? node.comment_owner ?? node.commentOwner ?? node.author) as Record<string, unknown> | undefined
  const candidate = owner?.username
    ?? owner?.full_name
    ?? owner?.fullName
    ?? owner?.name
    ?? node.username
    ?? node.author
  return typeof candidate === 'string' && candidate.trim() ? candidate : '未知用户'
}

function instagramLikeCount(node: Record<string, unknown>): number {
  const edgeLikedBy = node.edge_liked_by as Record<string, unknown> | undefined
  const edgeLikes = node.edge_likes as Record<string, unknown> | undefined
  const raw = edgeLikedBy?.count ?? edgeLikes?.count ?? node.like_count ?? node.likeCount ?? node.likes
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') return parseCompactNumber(raw)
  return 0
}

function instagramPublishedAt(node: Record<string, unknown>): string {
  const raw = node.created_at
    ?? node.createdAt
    ?? node.created_time
    ?? node.createdTime
    ?? node.taken_at_timestamp
    ?? node.timestamp
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
}

function isWeiboCommentShape(node: Record<string, unknown>): boolean {
  return Boolean(
    node.user
      || node.screen_name
      || node.screenName
      || node.rootid
      || node.comment_id
      || node.commentId
      || node.floor_number
      || node.floorNumber
  )
}

function weiboCommentText(node: Record<string, unknown>): string {
  const candidates = [
    node.text_raw,
    node.textRaw,
    node.text,
    node.comment,
    node.content
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return ''
}

function weiboNickname(node: Record<string, unknown>): string {
  const user = (node.user ?? node.author) as Record<string, unknown> | undefined
  const candidate = user?.screen_name
    ?? user?.screenName
    ?? user?.name
    ?? node.screen_name
    ?? node.screenName
    ?? node.nickname
  return typeof candidate === 'string' && candidate.trim() ? candidate : '未知用户'
}

function weiboPublishedAt(node: Record<string, unknown>): string {
  const raw = node.created_at ?? node.createdAt ?? node.create_time ?? node.createTime ?? node.timestamp
  if (typeof raw === 'string') {
    if (/^\d+$/.test(raw)) {
      const numeric = Number(raw)
      return numeric > 0 ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString() : ''
    }
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
  }
  const value = typeof raw === 'number' ? raw : 0
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
}

function isZhihuCommentShape(node: Record<string, unknown>): boolean {
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  if (type.includes('comment')) return true
  return Boolean(
    node.comment_id
      || node.commentId
      || node.reply_to_author
      || node.replyToAuthor
      || node.author
  )
}

function zhihuCommentText(node: Record<string, unknown>): string {
  const candidates = [
    node.content,
    node.text,
    node.excerpt,
    node.comment
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return ''
}

function zhihuNickname(node: Record<string, unknown>): string {
  const author = (node.author ?? node.member ?? node.user) as Record<string, unknown> | undefined
  const member = author?.member as Record<string, unknown> | undefined
  const candidate = author?.name
    ?? author?.headline
    ?? member?.name
    ?? member?.headline
    ?? node.author_name
    ?? node.authorName
  return typeof candidate === 'string' && candidate.trim() ? candidate : '未知用户'
}

function zhihuPublishedAt(node: Record<string, unknown>): string {
  const raw = node.created_time ?? node.createdTime ?? node.created_at ?? node.createdAt ?? node.updated_time ?? node.timestamp
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0
  if (!Number.isFinite(value) || value <= 0) return ''
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString()
}

function isUsefulGenericCommentText(value: string): boolean {
  if (value.length < 4 || value.length > 500) return false
  if (/^(登录|注册|关注|分享|点赞|收藏|转发|评论|reply|share|like|login|sign in)$/i.test(value)) return false
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(value)
}
