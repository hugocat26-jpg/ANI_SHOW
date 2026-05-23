import { createHash } from 'node:crypto'

import type { ContentRef, ManualImportCommentInput, ManualImportConflictStrategy, ManualImportInput, ManualImportTemplateType, PlatformSpec } from '../domain/types.ts'

const MAX_CSV_BYTES = 1_000_000
const MAX_CSV_ROWS = 1000
const MAX_TITLE_LENGTH = 300
const MAX_BODY_LENGTH = 200_000
const MAX_COMMENT_TEXT_LENGTH = 5000
const MAX_NICKNAME_LENGTH = 160
const MAX_SOURCE_URL_LENGTH = 2048

const HEADER_ALIASES: Record<string, keyof ManualImportCommentInput> = {
  author: 'nickname',
  buyer: 'nickname',
  name: 'nickname',
  nickname: 'nickname',
  reviewer: 'nickname',
  user: 'nickname',
  username: 'nickname',
  买家: 'nickname',
  昵称: 'nickname',
  用户: 'nickname',
  作者: 'nickname',
  body: 'text',
  comment: 'text',
  content: 'text',
  message: 'text',
  review: 'text',
  review_text: 'text',
  text: 'text',
  评价: 'text',
  评论: 'text',
  内容: 'text',
  留言: 'text',
  正文: 'text',
  like_count: 'likes',
  likes: 'likes',
  thumbs_up: 'likes',
  点赞: 'likes',
  点赞数: 'likes',
  date: 'publishedAt',
  created_at: 'publishedAt',
  published_at: 'publishedAt',
  publishedat: 'publishedAt',
  time: 'publishedAt',
  created: 'publishedAt',
  时间: 'publishedAt',
  创建时间: 'publishedAt',
  发布时间: 'publishedAt',
  content_url: 'contentUrl',
  contenturl: 'contentUrl',
  link: 'contentUrl',
  source_url: 'contentUrl',
  url: 'contentUrl',
  链接: 'contentUrl'
}

const TEMPLATE_SAMPLES: Record<ManualImportTemplateType, string> = {
  comment_csv: 'nickname,text,likes,published_at,url\r\nAlice,这个多少钱 求链接,8,2026-05-20T10:00:00.000Z,https://example.com/post\r\n',
  wechat_article_csv: 'author,comment,likes,time,link\r\nAlice,公众号文章里提到的型号多少钱,8,2026-05-20T10:00:00.000Z,https://mp.weixin.qq.com/s/demo\r\n',
  social_comments_csv: 'username,content,like_count,date,link\r\nAlice,想了解购买渠道,12,2026-05-20T10:00:00.000Z,https://example.com/post\r\n',
  commerce_reviews_csv: 'buyer,review,likes,created_at,url\r\nAlice,评价不错 想回购,3,2026-05-20T10:00:00.000Z,https://shop.example.com/item/1\r\n'
}

export function parseCommentCsv(csvText: string): ManualImportCommentInput[] {
  if (typeof csvText !== 'string') throw new Error('CSV 内容必须是字符串')
  const text = csvText.replace(/^\uFEFF/, '')
  if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) throw new Error('CSV 内容不能超过 1MB')
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []
  if (rows.length > MAX_CSV_ROWS + 1) throw new Error(`CSV 评论行数不能超过 ${MAX_CSV_ROWS}`)

  const headers = rows[0].map((header) => normalizeHeader(header))
  const mapped = headers.map((header) => HEADER_ALIASES[header])
  if (!mapped.includes('text')) throw new Error('CSV 必须包含评论内容字段')

  const comments: ManualImportCommentInput[] = []
  for (const row of rows.slice(1)) {
    const comment: Partial<ManualImportCommentInput> = {}
    for (let index = 0; index < mapped.length; index += 1) {
      const key = mapped[index]
      if (!key) continue
      const value = (row[index] ?? '').trim()
      if (!value) continue
      if (key === 'likes') {
        const parsed = Number.parseInt(value, 10)
        comment.likes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
      } else {
        comment[key] = value as never
      }
    }
    const normalized = normalizeManualComment(comment)
    if (normalized) comments.push(normalized)
  }
  return comments
}

export function normalizeManualImportInput(input: ManualImportInput): ManualImportInput {
  if (!input || typeof input !== 'object') throw new Error('手动导入参数必须是对象')
  const platformKey = assertString(input.platformKey, '平台 key', 1, 80)
  const templateType = normalizeTemplateType(input.templateType)
  const conflictStrategy = normalizeConflictStrategy(input.conflictStrategy)
  const sourceUrl = input.sourceUrl === undefined ? undefined : assertHttpUrl(input.sourceUrl, '来源链接', MAX_SOURCE_URL_LENGTH)
  const title = input.title === undefined ? undefined : assertString(input.title, '标题', 0, MAX_TITLE_LENGTH)
  const body = input.body === undefined ? undefined : assertString(input.body, '正文', 0, MAX_BODY_LENGTH)
  const comments = [...(input.comments ?? []), ...(input.csv ? parseCommentCsv(input.csv) : [])]
    .map((comment) => normalizeManualComment(comment))
    .filter((comment): comment is ManualImportCommentInput => Boolean(comment))
  if (!sourceUrl && !title && !body && comments.length === 0) throw new Error('手动导入至少需要来源链接、标题、正文或评论 CSV')
  return { platformKey, sourceUrl, title, body, templateType, conflictStrategy, comments }
}

export function contentRefFromManualImport(input: ManualImportInput, spec?: PlatformSpec): ContentRef {
  const sourceUrl = input.sourceUrl ?? `manual://${input.platformKey}/${stableHash(`${input.title ?? ''}\n${input.body ?? ''}`)}`
  return {
    platformKey: input.platformKey,
    url: sourceUrl,
    contentId: stableHash(sourceUrl),
    contentType: contentTypeForManualImport(input.platformKey, spec),
    title: input.title
  }
}

export function manualCommentId(contentId: string, comment: ManualImportCommentInput, index: number): string {
  return `manual-comment-${stableHash(`${contentId}\n${index}\n${comment.nickname ?? ''}\n${comment.text}`)}`
}

export function manualCommentFingerprint(comment: Pick<ManualImportCommentInput, 'nickname' | 'text' | 'contentUrl'>): string {
  return stableHash(`${comment.nickname ?? '手动导入用户'}\n${comment.text.trim()}`)
}

export function getManualImportTemplate(type: ManualImportTemplateType = 'comment_csv'): string {
  return TEMPLATE_SAMPLES[normalizeTemplateType(type)]
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  row.push(cell)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  return rows
}

function normalizeManualComment(input: Partial<ManualImportCommentInput>): ManualImportCommentInput | null {
  if (!input || typeof input !== 'object') return null
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) return null
  if (text.length > MAX_COMMENT_TEXT_LENGTH) throw new Error(`评论内容长度不能超过 ${MAX_COMMENT_TEXT_LENGTH}`)
  const nickname = typeof input.nickname === 'string' && input.nickname.trim()
    ? input.nickname.trim().slice(0, MAX_NICKNAME_LENGTH)
    : '手动导入用户'
  const likes = typeof input.likes === 'number' && Number.isFinite(input.likes) ? Math.max(0, Math.floor(input.likes)) : 0
  const publishedAt = typeof input.publishedAt === 'string' && Number.isFinite(Date.parse(input.publishedAt))
    ? new Date(input.publishedAt).toISOString()
    : new Date().toISOString()
  const contentUrl = typeof input.contentUrl === 'string' && input.contentUrl.trim()
    ? assertHttpUrl(input.contentUrl, '评论链接', MAX_SOURCE_URL_LENGTH)
    : undefined
  return { nickname, text, likes, publishedAt, contentUrl }
}

function contentTypeForManualImport(platformKey: string, spec?: PlatformSpec): ContentRef['contentType'] {
  if (platformKey === 'wechat_official_account') return 'post'
  if (spec?.category === 'video') return 'video'
  if (spec?.category === 'ecommerce') return 'post'
  return 'unknown'
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_')
}

function normalizeTemplateType(value: unknown): ManualImportTemplateType {
  if (value === undefined || value === null || value === '') return 'comment_csv'
  if (value === 'comment_csv' || value === 'wechat_article_csv' || value === 'social_comments_csv' || value === 'commerce_reviews_csv') return value
  throw new Error('手动导入模板类型无效')
}

function normalizeConflictStrategy(value: unknown): ManualImportConflictStrategy {
  if (value === undefined || value === null || value === '') return 'skip_duplicates'
  if (value === 'skip_duplicates' || value === 'replace_existing') return value
  throw new Error('手动导入冲突策略无效')
}

function assertString(value: unknown, label: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length < minLength) throw new Error(`${label} 不能为空`)
  if (trimmed.length > maxLength) throw new Error(`${label} 长度不能超过 ${maxLength}`)
  return trimmed
}

function assertHttpUrl(value: unknown, label: string, maxLength: number): string {
  const text = assertString(value, label, 1, maxLength)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${label} 必须是有效链接`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${label} 仅支持 HTTP/HTTPS`)
  return parsed.toString()
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}
