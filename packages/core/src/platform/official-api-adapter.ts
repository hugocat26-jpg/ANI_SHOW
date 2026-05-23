import type { CollectEvent } from './adapter.ts'
import { MetadataOnlyPlatformAdapter } from './adapter.ts'
import type { ContentRef, PlatformConnectorPublicConfig, PlatformSpec, PlatformStatus, SearchInput, SearchResult } from '../domain/types.ts'

export interface PlatformConnectorRuntimeConfig {
  publicConfig?: PlatformConnectorPublicConfig
  apiKey?: string
}

export type PlatformConnectorConfigProvider = (platformKey: string) => PlatformConnectorRuntimeConfig | undefined
export type ApiFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export type OfficialApiErrorCode = 'invalid_request' | 'auth_failed' | 'permission_denied' | 'quota_exhausted' | 'rate_limited' | 'server_error' | 'network_error'

export class OfficialApiError extends Error {
  code: OfficialApiErrorCode
  status: number
  retryable: boolean

  constructor(message: string, code: OfficialApiErrorCode, status: number, retryable: boolean) {
    super(message)
    this.name = 'OfficialApiError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

export class OfficialApiPlatformAdapter extends MetadataOnlyPlatformAdapter {
  private getConfig: PlatformConnectorConfigProvider
  private fetchFn: ApiFetch

  constructor(spec: PlatformSpec, getConfig: PlatformConnectorConfigProvider, fetchFn: ApiFetch = defaultFetch) {
    super(spec)
    this.getConfig = getConfig
    this.fetchFn = fetchFn
  }

  override async checkStatus(): Promise<PlatformStatus> {
    const startedAt = Date.now()
    const config = this.getConfig(this.spec.key)
    const apiKey = config?.apiKey
    const enabled = config?.publicConfig?.enabled === true
    return {
      platformKey: this.spec.key,
      available: enabled && Boolean(apiKey),
      loggedIn: Boolean(apiKey),
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      errorCode: enabled && apiKey ? 'ok' : 'login_required',
      message: enabled && apiKey
        ? `${this.spec.name} 官方 API 配置可用`
        : `${this.spec.name} 官方 API 尚未启用或缺少 API Key`
    }
  }

  override async search(input: SearchInput): Promise<SearchResult[]> {
    const keyword = input.keyword.trim()
    if (!keyword) return []
    const config = this.requireConfig()
    const requestUrl = this.buildSearchUrl(keyword, Math.min(input.limit, 10), config)
    const response = await this.fetchFn(requestUrl, { headers: { accept: 'application/json' } })
    if (!response.ok) throw await officialApiError(this.spec.name, response)
    const payload = await response.json()
    return this.parseSearchResults(payload, keyword, input.limit)
  }

  override async parseContent(url: string): Promise<ContentRef> {
    const parsed = new URL(url)
    return {
      platformKey: this.spec.key,
      url: parsed.toString(),
      contentId: parsed.searchParams.get('v') ?? parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.toString(),
      contentType: this.spec.key === 'youtube_data_api' ? 'video' : 'unknown'
    }
  }

  override async *collectComments(_input: ContentRef): AsyncIterable<CollectEvent> {
    yield { type: 'failed', payload: { message: `${this.spec.name} 评论 API 采集尚未启用` } }
  }

  private requireConfig(): Required<Pick<PlatformConnectorRuntimeConfig, 'publicConfig' | 'apiKey'>> {
    const config = this.getConfig(this.spec.key)
    if (config?.publicConfig?.enabled !== true) throw new Error(`${this.spec.name} 官方 API 未启用`)
    if (!config.apiKey) throw new Error(`${this.spec.name} 缺少 API Key`)
    return { publicConfig: config.publicConfig, apiKey: config.apiKey }
  }

  private buildSearchUrl(keyword: string, limit: number, config: Required<Pick<PlatformConnectorRuntimeConfig, 'publicConfig' | 'apiKey'>>): string {
    if (this.spec.key === 'youtube_data_api') {
      const url = new URL(config.publicConfig.apiBaseUrl ?? 'https://www.googleapis.com/youtube/v3/search')
      url.searchParams.set('part', url.searchParams.get('part') ?? 'snippet')
      url.searchParams.set('type', url.searchParams.get('type') ?? 'video')
      url.searchParams.set('q', keyword)
      url.searchParams.set('maxResults', String(Math.max(1, Math.min(limit, 10))))
      url.searchParams.set('key', config.apiKey)
      return url.toString()
    }
    const url = new URL(config.publicConfig.apiBaseUrl ?? 'https://www.googleapis.com/customsearch/v1')
    url.searchParams.set('q', keyword)
    url.searchParams.set('num', String(Math.max(1, Math.min(limit, 10))))
    url.searchParams.set('key', config.apiKey)
    return url.toString()
  }

  private parseSearchResults(payload: unknown, keyword: string, limit: number): SearchResult[] {
    if (!payload || typeof payload !== 'object') return []
    const items = Array.isArray((payload as { items?: unknown }).items) ? (payload as { items: unknown[] }).items : []
    return items.slice(0, limit).map((item, index) => {
      const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const snippet = value.snippet && typeof value.snippet === 'object' ? value.snippet as Record<string, unknown> : undefined
      const id = value.id && typeof value.id === 'object' ? value.id as Record<string, unknown> : undefined
      const videoId = typeof id?.videoId === 'string' ? id.videoId : undefined
      const title = typeof snippet?.title === 'string' ? snippet.title : typeof value.title === 'string' ? value.title : `${keyword} API 结果`
      const summary = typeof snippet?.description === 'string' ? snippet.description : typeof value.snippet === 'string' ? value.snippet : ''
      const link = typeof value.link === 'string'
        ? value.link
        : videoId
          ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
          : `https://${this.spec.domains[0]}/`
      return {
        id: `${this.spec.key}-${Buffer.from(`${link}-${index}`).toString('base64url')}`,
        platformKey: this.spec.key,
        title,
        url: link,
        snippet: summary,
        relevance: 0.8 - index * 0.02,
        createdAt: new Date().toISOString()
      }
    })
  }
}

async function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const response = await fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>
  }
}

async function officialApiError(platformName: string, response: { status: number; json(): Promise<unknown> }): Promise<OfficialApiError> {
  const payload = await safeJson(response)
  const providerMessage = officialApiProviderMessage(payload)
  const reason = officialApiReason(payload)
  const classified = classifyOfficialApiHttpError(response.status, reason, providerMessage)
  const details = providerMessage ? `平台返回：${providerMessage}` : `HTTP ${response.status}`
  return new OfficialApiError(
    `${platformName} 官方 API ${classified.title}。${details}。${classified.advice}`,
    classified.code,
    response.status,
    classified.retryable
  )
}

async function safeJson(response: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function officialApiProviderMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error.slice(0, 300)
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    if (typeof value.message === 'string') return value.message.slice(0, 300)
    if (typeof value.status === 'string') return value.status.slice(0, 300)
  }
  return undefined
}

function officialApiReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  if (!error || typeof error !== 'object') return undefined
  const errors = (error as { errors?: unknown }).errors
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (item && typeof item === 'object') {
        const reason = (item as { reason?: unknown }).reason
        if (typeof reason === 'string' && reason.trim()) return reason
      }
    }
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'string' ? status : undefined
}

function classifyOfficialApiHttpError(status: number, reason?: string, message?: string): { code: OfficialApiErrorCode; title: string; advice: string; retryable: boolean } {
  const text = `${reason ?? ''} ${message ?? ''}`.toLowerCase()
  if (status === 400) {
    return {
      code: 'invalid_request',
      title: '请求参数无效',
      advice: '请检查 API Base URL、搜索引擎 ID、查询参数和平台接入配置。',
      retryable: false
    }
  }
  if (status === 401) {
    return {
      code: 'auth_failed',
      title: '认证失败',
      advice: '请检查 API Key 是否正确、是否已启用对应官方 API。',
      retryable: false
    }
  }
  if (status === 403) {
    const quota = /quota|daily|limit|exceed|rate|配额|超限/.test(text)
    return quota
      ? {
          code: 'quota_exhausted',
          title: '配额已耗尽',
          advice: '请等待官方配额重置，或在平台接入配置中更换/提升配额后再试。',
          retryable: false
        }
      : {
          code: 'permission_denied',
          title: '权限不足',
          advice: '请检查 API Key 的项目权限、服务启用状态和请求来源限制。',
          retryable: false
        }
  }
  if (status === 408 || status === 409 || status === 425 || status === 429) {
    return {
      code: status === 429 && /quota|daily|exceed|配额/.test(text) ? 'quota_exhausted' : 'rate_limited',
      title: status === 429 && /quota|daily|exceed|配额/.test(text) ? '配额已耗尽' : '请求过于频繁',
      advice: '建议降低请求频率、增加请求间隔，稍后重试。',
      retryable: status !== 429 || !/quota|daily|exceed|配额/.test(text)
    }
  }
  if (status >= 500) {
    return {
      code: 'server_error',
      title: '服务端暂时异常',
      advice: '可稍后重试；若持续失败，请查看官方 API 状态页。',
      retryable: true
    }
  }
  return {
    code: 'network_error',
    title: '请求失败',
    advice: '请稍后重试，或检查网络、代理和平台接入配置。',
    retryable: true
  }
}
