import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AIService,
  AIAnalysisQueue,
  AIProviderError,
  ApplicationCore,
  BrowserContextManager,
  CompliancePolicy,
  LeadMinerRepository,
  MetadataOnlyPlatformAdapter,
  OfficialApiPlatformAdapter,
  OfficialApiError,
  PlainSecretCodec,
  PlatformRegistry,
  SearchEngineAdapter,
  VideoPlatformAdapter,
  TaskOrchestrator,
  buildIntentAnalysisPrompt,
  buildBilibiliReplyUrl,
  calculateBilibiliRetryDelayMs,
  canBatchCollectPlatform,
  canLoginPlatform,
  canSearchPlatform,
  createBuiltinPlatformRegistry,
  createDefaultApplicationCore,
  codeFromHttpStatus,
  estimateModelCostUsd,
  extractBilibiliAid,
  extractBilibiliApiError,
  extractBilibiliApiErrorInfo,
  extractBilibiliNextOffset,
  extractBilibiliReplyRoots,
  extractBilibiliWbiKeys,
  extractInstagramPageCursor,
  extractKuaishouPageCursor,
  extractRedditMoreChildren,
  extractShortVideoCursor,
  extractWeiboPageCursor,
  extractXiaohongshuPageCursor,
  extractYoutubeContinuationRequests,
  extractZhihuPageCursor,
  getManualImportTemplate,
  isAllowedPlatformFinalUrl,
  isAuthCookie,
  listModelPricing,
  normalizeAIProviderBaseUrl,
  normalizeIntentResult,
  parseBilibiliComments,
  parseInstagramComments,
  parseKuaishouComments,
  parseCommentCsv,
  parseRedditComments,
  parseShortVideoComments,
  parseWeiboComments,
  parseXiaohongshuComments,
  parseYoutubeComments,
  parseZhihuComments,
  parseSearchResultHtml,
  platformExpansionTargetSpecs,
  requiresSingleItemCollection,
  signBilibiliWbiParams,
  type LLMClient,
  type ApiFetch,
  type LeadRecord,
  type PlatformSpec,
  type PlatformStatus,
  type SecretCodec,
  type SearchInput,
  type SearchResult,
  type SearchPageExecutor
} from '../packages/core/src/index.ts'

test('built-in platform registry includes domestic and international targets', () => {
  const app = createDefaultApplicationCore()
  const keys = app.platforms.keys()

  assert.ok(keys.includes('google'))
  assert.ok(keys.includes('youtube'))
  assert.ok(keys.includes('douyin'))
  assert.ok(keys.includes('xiaohongshu'))
  assert.ok(keys.includes('reddit'))
  assert.ok(keys.includes('zhihu'))

  const searchable = app.platforms.byCapability('search').map((spec) => spec.key)
  assert.ok(searchable.includes('google'))
  assert.ok(searchable.includes('tiktok'))
  assert.ok(app.platforms.get('youtube').spec.capabilities.includes('login'))
})

test('built-in platform specs expose governance manifest metadata', () => {
  const app = createDefaultApplicationCore()
  const xiaohongshu = app.platforms.get('xiaohongshu').spec
  const google = app.platforms.get('google').spec
  const youtube = app.platforms.get('youtube').spec

  assert.equal(xiaohongshu.riskLevel, 'high')
  assert.equal(xiaohongshu.authMode, 'required_login')
  assert.equal(xiaohongshu.connectorKind, 'logged_in_web')
  assert.match(xiaohongshu.complianceNotes ?? '', /个人账号|批量采集/)
  assert.equal(google.riskLevel, 'low')
  assert.equal(google.authMode, 'none')
  assert.equal(google.integrationStatus, 'active')
  assert.equal(youtube.connectorKind, 'hybrid')
})

test('platform expansion targets describe roadmap integration modes', () => {
  const statuses = new Set(platformExpansionTargetSpecs.map((spec) => spec.integrationStatus))
  const byKey = new Map(platformExpansionTargetSpecs.map((spec) => [spec.key, spec]))

  assert.ok(statuses.has('planned'))
  assert.ok(statuses.has('manual_import'))
  assert.ok(statuses.has('official_api_preferred'))
  assert.equal(byKey.get('google_custom_search_api')?.connectorKind, 'official_api')
  assert.equal(byKey.get('wechat_official_account')?.integrationStatus, 'manual_import')
  assert.equal(byKey.get('linkedin')?.riskLevel, 'high')
  assert.ok(platformExpansionTargetSpecs.every((spec) => spec.complianceNotes && spec.roadmapNotes))
})

test('platform capability policy separates active execution from roadmap targets', async () => {
  const activeGoogle = createDefaultApplicationCore().platforms.get('google').spec
  const manualWechat = platformExpansionTargetSpecs.find((spec) => spec.key === 'wechat_official_account')
  const apiGoogle = platformExpansionTargetSpecs.find((spec) => spec.key === 'google_custom_search_api')
  const highRiskTarget = platformExpansionTargetSpecs.find((spec) => spec.key === 'linkedin')

  assert.ok(manualWechat)
  assert.ok(apiGoogle)
  assert.ok(highRiskTarget)
  assert.equal(canSearchPlatform(activeGoogle), true)
  assert.equal(canSearchPlatform(manualWechat), false)
  assert.equal(canLoginPlatform(manualWechat), false)
  assert.equal(canSearchPlatform(apiGoogle), false)
  assert.equal(canBatchCollectPlatform(highRiskTarget), false)
  assert.equal(requiresSingleItemCollection(highRiskTarget), false)

  const registry = new PlatformRegistry()
  registry.register(new MetadataOnlyPlatformAdapter({
    key: 'planned-search',
    name: 'Planned Search',
    category: 'search_engine',
    domains: ['planned.example'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 1, maxRetries: 0 },
    integrationStatus: 'planned',
    riskLevel: 'low',
    authMode: 'none',
    connectorKind: 'public_web'
  }))
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(), new LeadMinerRepository(':memory:'), new BrowserContextManager())
  await assert.rejects(
    () => app.searchAcrossPlatforms('咖啡机', ['planned-search']),
    /未开放搜索能力/
  )
})

test('platform connector configs persist api keys and manual import templates', () => {
  const repository = new LeadMinerRepository(':memory:', new PlainSecretCodec())
  const saved = repository.savePlatformConnectorConfig({
    platformKey: 'google_custom_search_api',
    enabled: true,
    apiBaseUrl: 'https://www.googleapis.com/customsearch/v1',
    apiKey: 'sk-platform-1234',
    quotaPerDay: 100,
    minDelayMs: 250,
    updatedAt: new Date().toISOString()
  })

  assert.equal(saved.apiKeySet, true)
  assert.equal(saved.apiKeyPreview, '...1234')
  assert.equal(saved.secretStorage, 'legacy_plain')
  assert.equal(repository.getPlatformConnectorSecret('google_custom_search_api'), 'sk-platform-1234')

  const updated = repository.savePlatformConnectorConfig({
    platformKey: 'wechat_official_account',
    enabled: true,
    apiKey: 'env:WECHAT_IMPORT_TOKEN',
    importTemplate: {
      fields: ['url', 'title', 'body', 'published_at'],
      requiredFields: ['url', 'body'],
      sample: 'url,title,body,published_at'
    },
    updatedAt: new Date().toISOString()
  })

  assert.equal(updated.secretStorage, 'external_env')
  assert.deepEqual(updated.importTemplate?.requiredFields, ['url', 'body'])
  assert.equal(repository.listPlatformConnectorConfigs().length, 2)
  repository.close()
})

test('application validates platform connector config boundaries', () => {
  const app = createDefaultApplicationCore()

  const saved = app.savePlatformConnectorConfig({
    platformKey: 'youtube_data_api',
    enabled: true,
    apiKey: 'env:YOUTUBE_DATA_API_KEY',
    quotaPerDay: 5000,
    minDelayMs: 300
  })
  assert.equal(saved.platformKey, 'youtube_data_api')
  assert.equal(saved.secretStorage, 'external_env')
  assert.ok(app.listAuditLogs().some((event) => event.action === 'platform.connector.save'))

  assert.throws(
    () => app.savePlatformConnectorConfig({
      platformKey: 'unknown-platform',
      enabled: true
    }),
    /平台不存在/
  )
  assert.throws(
    () => app.savePlatformConnectorConfig({
      platformKey: 'youtube_data_api',
      enabled: true,
      quotaPerDay: 0
    }),
    /每日配额/
  )
})

test('official api adapter searches google and youtube payloads with connector config', async () => {
  const requestedUrls: string[] = []
  const fetchFn: ApiFetch = async (url) => {
    requestedUrls.push(url)
    if (url.includes('youtube')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            items: [{
              id: { videoId: 'video123' },
              snippet: { title: 'YouTube API Result', description: 'video summary' }
            }]
          }
        }
      }
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          items: [{
            title: 'Google API Result',
            link: 'https://example.com/result',
            snippet: 'search summary'
          }]
        }
      }
    }
  }
  const google = platformExpansionTargetSpecs.find((spec) => spec.key === 'google_custom_search_api')
  const youtube = platformExpansionTargetSpecs.find((spec) => spec.key === 'youtube_data_api')
  assert.ok(google)
  assert.ok(youtube)

  const googleAdapter = new OfficialApiPlatformAdapter({ ...google, integrationStatus: 'active' }, () => ({
    publicConfig: { platformKey: google.key, enabled: true, apiBaseUrl: 'https://www.googleapis.com/customsearch/v1?cx=cx-1', apiKeySet: true, secretStorage: 'external_env', updatedAt: new Date().toISOString() },
    apiKey: 'google-key'
  }), fetchFn)
  const youtubeAdapter = new OfficialApiPlatformAdapter({ ...youtube, integrationStatus: 'active' }, () => ({
    publicConfig: { platformKey: youtube.key, enabled: true, apiKeySet: true, secretStorage: 'external_env', updatedAt: new Date().toISOString() },
    apiKey: 'youtube-key'
  }), fetchFn)

  const googleResults = await googleAdapter.search({ keyword: '咖啡机', platformKeys: [google.key], limit: 5 })
  const youtubeResults = await youtubeAdapter.search({ keyword: '咖啡机', platformKeys: [youtube.key], limit: 5 })

  assert.equal(googleResults[0].title, 'Google API Result')
  assert.equal(youtubeResults[0].url, 'https://www.youtube.com/watch?v=video123')
  assert.ok(requestedUrls.some((url) => url.includes('key=google-key') && url.includes('cx=cx-1')))
  assert.ok(requestedUrls.some((url) => url.includes('key=youtube-key') && url.includes('type=video')))
})

test('official api adapter classifies quota and auth errors with retry advice', async () => {
  const google = platformExpansionTargetSpecs.find((spec) => spec.key === 'google_custom_search_api')
  assert.ok(google)
  const quotaAdapter = new OfficialApiPlatformAdapter({ ...google, integrationStatus: 'active' }, () => ({
    publicConfig: { platformKey: google.key, enabled: true, apiKeySet: true, secretStorage: 'external_env', updatedAt: new Date().toISOString() },
    apiKey: 'google-key'
  }), async () => ({
    ok: false,
    status: 403,
    async json() {
      return {
        error: {
          message: 'Daily Limit Exceeded',
          errors: [{ reason: 'dailyLimitExceeded' }]
        }
      }
    }
  }))
  await assert.rejects(
    () => quotaAdapter.search({ keyword: '咖啡机', platformKeys: [google.key], limit: 5 }),
    (error) => {
      assert.ok(error instanceof OfficialApiError)
      assert.equal(error.code, 'quota_exhausted')
      assert.equal(error.retryable, false)
      assert.match(error.message, /配额已耗尽|配额重置/)
      return true
    }
  )

  const authAdapter = new OfficialApiPlatformAdapter({ ...google, integrationStatus: 'active' }, () => ({
    publicConfig: { platformKey: google.key, enabled: true, apiKeySet: true, secretStorage: 'external_env', updatedAt: new Date().toISOString() },
    apiKey: 'bad-key'
  }), async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: { message: 'API key not valid' } }
    }
  }))
  await assert.rejects(
    () => authAdapter.search({ keyword: '咖啡机', platformKeys: [google.key], limit: 5 }),
    (error) => {
      assert.ok(error instanceof OfficialApiError)
      assert.equal(error.code, 'auth_failed')
      assert.equal(error.retryable, false)
      assert.match(error.message, /认证失败|API Key/)
      return true
    }
  )
})

test('application registers enabled official api connector as searchable platform', async () => {
  const registry = createBuiltinPlatformRegistry(new BrowserContextManager())
  const repository = new LeadMinerRepository(':memory:', new PlainSecretCodec())
  repository.savePlatformConnectorConfig({
    platformKey: 'google_custom_search_api',
    enabled: true,
    apiBaseUrl: 'https://www.googleapis.com/customsearch/v1?cx=cx-1',
    apiKey: 'env:GOOGLE_CSE_KEY',
    quotaPerDay: 100,
    minDelayMs: 300,
    updatedAt: new Date().toISOString()
  })
  const previous = process.env.GOOGLE_CSE_KEY
  process.env.GOOGLE_CSE_KEY = 'configured-key'
  try {
    const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())
    assert.ok(app.platforms.keys().includes('google_custom_search_api'))
    assert.equal(canSearchPlatform(app.platforms.get('google_custom_search_api').spec), true)
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_CSE_KEY
    else process.env.GOOGLE_CSE_KEY = previous
    repository.close()
  }
})

test('official api connector usage records success and failure visibility', async () => {
  class MockOfficialApiAdapter extends MetadataOnlyPlatformAdapter {
    shouldFail = false

    override async search(input: SearchInput): Promise<SearchResult[]> {
      if (this.shouldFail) throw new Error('quota exhausted')
      return [{
        id: 'official-api-result',
        platformKey: this.spec.key,
        title: input.keyword,
        url: 'https://example.com/result',
        snippet: 'ok',
        relevance: 1,
        createdAt: new Date().toISOString()
      }]
    }
  }
  const repository = new LeadMinerRepository(':memory:')
  repository.savePlatformConnectorConfig({
    platformKey: 'mock_official_api',
    enabled: true,
    apiKey: 'sk-test',
    quotaPerDay: 2,
    updatedAt: new Date().toISOString()
  })
  const adapter = new MockOfficialApiAdapter({
    key: 'mock_official_api',
    name: 'Mock Official API',
    category: 'search_engine',
    domains: ['example.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 },
    authMode: 'api_key',
    riskLevel: 'low',
    connectorKind: 'official_api',
    integrationStatus: 'active'
  })
  const registry = new PlatformRegistry()
  registry.register(adapter)
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())

  await app.searchAcrossPlatforms('咖啡机', ['mock_official_api'])
  let config = app.listPlatformConnectorConfigs().find((item) => item.platformKey === 'mock_official_api')
  assert.equal(config?.usedToday, 1)
  assert.equal(config?.remainingToday, 1)
  assert.equal(config?.lastStatus, 'ok')

  adapter.shouldFail = true
  await assert.rejects(() => app.searchAcrossPlatforms('咖啡机', ['mock_official_api']), /quota exhausted/)
  config = app.listPlatformConnectorConfigs().find((item) => item.platformKey === 'mock_official_api')
  assert.equal(config?.usedToday, 2)
  assert.equal(config?.remainingToday, 0)
  assert.equal(config?.lastStatus, 'failed')
  assert.match(config?.lastError ?? '', /quota exhausted/)
})

test('official api connector usage records structured failure guidance', async () => {
  class FailingOfficialApiAdapter extends MetadataOnlyPlatformAdapter {
    override async search(): Promise<SearchResult[]> {
      throw new OfficialApiError('Google API 配额耗尽', 'quota_exhausted', 403, false)
    }
  }
  const repository = new LeadMinerRepository(':memory:')
  repository.savePlatformConnectorConfig({
    platformKey: 'mock_quota_api',
    enabled: true,
    apiKey: 'sk-test',
    quotaPerDay: 10,
    updatedAt: new Date().toISOString()
  })
  const registry = new PlatformRegistry()
  registry.register(new FailingOfficialApiAdapter({
    key: 'mock_quota_api',
    name: 'Mock Quota API',
    category: 'search_engine',
    domains: ['example.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 },
    authMode: 'api_key',
    riskLevel: 'low',
    connectorKind: 'official_api',
    integrationStatus: 'active'
  }))
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())

  await assert.rejects(() => app.searchAcrossPlatforms('咖啡机', ['mock_quota_api']), /配额耗尽/)

  const config = app.listPlatformConnectorConfigs().find((item) => item.platformKey === 'mock_quota_api')
  assert.equal(config?.lastStatus, 'failed')
  assert.equal(config?.lastErrorCode, 'quota_exhausted')
  assert.equal(config?.lastRetryable, false)
  assert.ok(config?.quotaResetAt)
  assert.equal(config?.remainingToday, 9)
  repository.close()
})

test('official api usage history aggregates daily totals without exposing secrets', () => {
  const repository = new LeadMinerRepository(':memory:')
  repository.savePlatformConnectorConfig({
    platformKey: 'history_api',
    enabled: true,
    apiKey: 'history-secret-value',
    quotaPerDay: 10,
    updatedAt: new Date('2026-05-27T00:00:00.000Z').toISOString()
  })

  repository.recordPlatformConnectorUsage('history_api', 'ok', undefined, new Date('2026-05-26T10:00:00.000Z'))
  repository.recordPlatformConnectorUsage('history_api', 'failed', 'Quota hit for project', new Date('2026-05-26T11:00:00.000Z'), { errorCode: 'quota_exhausted', retryable: false, quotaResetAt: '2026-05-27T00:00:00.000Z' })
  repository.recordPlatformConnectorUsage('history_api', 'failed', 'Temporary outage', new Date('2026-05-27T09:00:00.000Z'), { errorCode: 'server_error', retryable: true })

  const history = repository.listPlatformConnectorUsageHistory(7, new Date('2026-05-27T12:00:00.000Z'))

  assert.equal(history.days, 7)
  assert.equal(history.rows.length, 2)
  assert.deepEqual(history.totals, {
    totalRequests: 3,
    successCount: 1,
    failureCount: 2,
    quotaExhaustedCount: 1,
    retryableFailureCount: 1
  })
  assert.equal(history.rows.find((row) => row.date === '2026-05-26')?.quotaExhaustedCount, 1)
  assert.equal(history.rows.find((row) => row.date === '2026-05-27')?.retryableFailureCount, 1)
  assert.equal(JSON.stringify(history).includes('history-secret-value'), false)
  repository.close()
})

test('manual import parser accepts comment CSV aliases and quoted commas', () => {
  const comments = parseCommentCsv([
    '昵称,评论,点赞数,发布时间,链接',
    'Alice,"想买, 求链接",12,2026-05-20T10:00:00.000Z,https://mp.weixin.qq.com/s/demo',
    'Bob,价格多少,3,,'
  ].join('\r\n'))

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, 'Alice')
  assert.equal(comments[0].text, '想买, 求链接')
  assert.equal(comments[0].likes, 12)
  assert.equal(comments[0].contentUrl, 'https://mp.weixin.qq.com/s/demo')
  assert.equal(comments[1].nickname, 'Bob')
})

test('manual import templates parse social and commerce aliases', () => {
  const social = parseCommentCsv(getManualImportTemplate('social_comments_csv'))
  const commerce = parseCommentCsv(getManualImportTemplate('commerce_reviews_csv'))

  assert.equal(social[0].nickname, 'Alice')
  assert.match(social[0].text, /购买渠道/)
  assert.equal(social[0].likes, 12)
  assert.equal(commerce[0].nickname, 'Alice')
  assert.match(commerce[0].text, /回购/)
  assert.equal(commerce[0].likes, 3)
})

test('application imports manual WeChat article comments and saves leads locally', async () => {
  const app = createDefaultApplicationCore()
  const preview = app.previewManualContent({
    platformKey: 'wechat_official_account',
    templateType: 'wechat_article_csv',
    sourceUrl: 'https://mp.weixin.qq.com/s/kSalNSfzqqKRcFqHopdW0A',
    title: '咖啡机选购指南',
    csv: [
      'author,comment,likes',
      'Alice,这个多少钱 求链接,8',
      'Bob,先收藏看看,1',
      'Bob,先收藏看看,1'
    ].join('\n')
  })
  assert.equal(preview.templateType, 'wechat_article_csv')
  assert.equal(preview.conflictStrategy, 'skip_duplicates')
  assert.equal(preview.parsedComments, 3)
  assert.equal(preview.newComments, 2)
  assert.equal(preview.duplicates, 1)
  assert.equal(preview.updatableDuplicates, 0)

  const result = await app.importManualContent({
    platformKey: 'wechat_official_account',
    sourceUrl: 'https://mp.weixin.qq.com/s/kSalNSfzqqKRcFqHopdW0A',
    title: '咖啡机选购指南',
    csv: [
      'author,comment,likes',
      'Alice,这个多少钱 求链接,8',
      'Bob,先收藏看看,1',
      'Bob,先收藏看看,1'
    ].join('\n')
  })

  assert.equal(result.content.platformKey, 'wechat_official_account')
  assert.equal(result.content.contentType, 'post')
  assert.equal(result.commentsImported, 2)
  assert.equal(result.duplicatesSkipped, 1)
  assert.ok(result.leadsGenerated >= 1)
  assert.equal(app.repository.listComments(result.content.contentId).length, 2)
  assert.ok(app.repository.listLeads().some((lead) => lead.nickname === 'Alice' && lead.platformKey === 'wechat_official_account'))
  assert.ok(app.repository.listTasks().some((task) => task.type === 'manual_import' && task.status === 'completed'))
  assert.ok(app.listAuditLogs().some((event) => event.action === 'manual_import.completed'))

  const secondPreview = app.previewManualContent({
    platformKey: 'wechat_official_account',
    sourceUrl: 'https://mp.weixin.qq.com/s/kSalNSfzqqKRcFqHopdW0A',
    csv: [
      'author,comment,likes',
      'Alice,这个多少钱 求链接,8'
    ].join('\n')
  })
  assert.equal(secondPreview.newComments, 0)
  assert.equal(secondPreview.duplicates, 1)
})

test('manual import can update duplicate comment metadata when conflict strategy allows it', async () => {
  const app = createDefaultApplicationCore()
  await app.importManualContent({
    platformKey: 'wechat_official_account',
    sourceUrl: 'https://mp.weixin.qq.com/s/conflict-demo',
    title: '冲突合并演示',
    csv: [
      'author,comment,likes,time',
      'Alice,想要购买链接,1,2026-05-20T10:00:00.000Z'
    ].join('\n')
  })

  const preview = app.previewManualContent({
    platformKey: 'wechat_official_account',
    sourceUrl: 'https://mp.weixin.qq.com/s/conflict-demo',
    conflictStrategy: 'replace_existing',
    csv: [
      'author,comment,likes,time',
      'Alice,想要购买链接,9,2026-05-21T10:00:00.000Z'
    ].join('\n')
  })
  assert.equal(preview.duplicates, 1)
  assert.equal(preview.updatableDuplicates, 1)

  const result = await app.importManualContent({
    platformKey: 'wechat_official_account',
    sourceUrl: 'https://mp.weixin.qq.com/s/conflict-demo',
    conflictStrategy: 'replace_existing',
    csv: [
      'author,comment,likes,time',
      'Alice,想要购买链接,9,2026-05-21T10:00:00.000Z'
    ].join('\n')
  })
  const comments = app.repository.listComments(result.content.contentId)
  assert.equal(result.commentsImported, 0)
  assert.equal(result.duplicatesUpdated, 1)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].likes, 9)
  assert.equal(comments[0].publishedAt, '2026-05-21T10:00:00.000Z')
})

test('AI service expands keywords and scores high intent leads with rule fallback', () => {
  const ai = new AIService()
  const plan = ai.expandKeywords('咖啡机', ['zh-CN', 'en-US'])

  assert.ok(plan.keywords.includes('咖啡机 怎么选'))
  assert.ok(plan.keywords.includes('咖啡机 review'))

  const intent = ai.analyzeIntent({
    platformKey: 'xiaohongshu',
    contentUrl: 'https://example.test/post/1',
    nickname: 'Alice',
    text: '这个多少钱，求链接',
    likes: 12
  })
  const score = ai.scoreLead(intent, 12)

  assert.equal(intent.level, 'high')
  assert.equal(score.suggestedAction, '优先跟进')
  assert.ok(score.reason.includes('基础分'))
  assert.ok(score.score >= 90)

  const lead = ai.commentToLead({
    id: 'comment-1',
    platformKey: 'youtube',
    contentId: 'video-1',
    contentUrl: 'https://example.test/video',
    nickname: 'Alice',
    text: '多少钱，求链接',
    likes: 12,
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString()
  })
  assert.equal(lead?.intentLevel, 'high')
  assert.ok(lead?.scoreReason.includes('关键词加分'))
  assert.ok((lead?.score ?? 0) >= 90)
})

test('model pricing estimates known provider costs', () => {
  const deepseekCost = estimateModelCostUsd('deepseek', 'deepseek-chat', 1_000_000, 1_000_000, 1)
  const openaiCost = estimateModelCostUsd('openai', 'gpt-4.1-mini', 1_000_000, 1_000_000, 1)
  const catalog = listModelPricing()

  assert.equal(deepseekCost, 0.42)
  assert.equal(openaiCost, 2)
  assert.equal(estimateModelCostUsd('deepseek', 'deepseek-chat', 1_000, 1_000, 0), 0)
  assert.ok(catalog.some((item) => item.provider === 'dashscope'))
  assert.equal(typeof catalog[0].modelPattern, 'string')
})

test('custom model pricing overrides built-in pricing and persists', async () => {
  const app = createDefaultApplicationCore()
  const saved = app.saveCustomModelPricing([{
    provider: 'openai',
    modelPattern: 'gpt-4\\.1-mini',
    inputUsdPerMillionTokens: 10,
    outputUsdPerMillionTokens: 20
  }])
  app.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-price-1234',
    enabled: true
  })

  assert.equal(saved[0].source, 'custom')
  assert.equal(app.currentModelPricing()?.source, 'custom')
  assert.equal(app.currentModelPricing()?.inputUsdPerMillionTokens, 10)
  assert.ok(app.listAuditLogs().some((event) => event.action === 'ai.model_pricing.save'))

  app.ai.commentToLeadWithMeta = async (comment) => ({
    lead: app.ai.commentToLead(comment),
    source: 'model'
  })
  const now = new Date().toISOString()
  await app.analyzeComments([{
    id: 'custom-price-comment',
    platformKey: 'youtube',
    contentId: 'v1',
    contentUrl: 'https://example.test/v1',
    nickname: 'Alice',
    text: '多少钱，想买',
    likes: 0,
    publishedAt: now,
    collectedAt: now
  }])

  assert.ok((app.getAIAnalysisStats()?.estimatedCostUsd ?? 0) > 0.002)
})

test('AI provider configs are persisted without exposing api keys', () => {
  const app = createDefaultApplicationCore()
  const saved = app.saveAIProviderConfig({
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-secret-1234',
    enabled: true
  })

  assert.equal(saved.provider, 'deepseek')
  assert.equal(saved.apiKeySet, true)
  assert.equal(saved.apiKeyPreview, '...1234')
  assert.equal(saved.secretStorage, 'legacy_plain')
  assert.equal('apiKey' in saved, false)
  assert.equal(app.listAIProviders()[0].apiKeyPreview, '...1234')
  assert.equal(app.ai.currentProvider()?.provider, 'deepseek')
  assert.equal(app.currentModelPricing()?.provider, 'deepseek')
  assert.ok(app.listModelPricing().length >= 4)
  assert.equal(app.listAuditLogs()[0].action, 'ai.provider.save')
})

test('AI provider base urls reject private and off-provider hosts', () => {
  const app = createDefaultApplicationCore()

  assert.equal(normalizeAIProviderBaseUrl('custom', 'https://llm.example.com/v1'), 'https://llm.example.com/v1')
  assert.throws(
    () => app.saveAIProviderConfig({
      provider: 'custom',
      model: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'sk-local',
      enabled: true
    }),
    /Base URL 不安全/
  )
  assert.throws(
    () => app.saveAIProviderConfig({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://evil.example.com/v1',
      apiKey: 'sk-test',
      enabled: true
    }),
    /Base URL 不安全/
  )
})

test('AI provider config keeps existing api key when editing model only', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = new Date().toISOString()
  repository.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-old-secret-9999',
    enabled: true,
    updatedAt: now
  })
  const updated = repository.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    updatedAt: now
  })

  assert.equal(updated.model, 'gpt-4.1')
  assert.equal(updated.apiKeyPreview, '...9999')
  assert.equal(repository.getAIProviderSecret('openai'), 'sk-old-secret-9999')
  repository.close()
})

test('AI provider config can reference api key from environment', () => {
  const envName = 'LEAD_MINER_TEST_OPENAI_KEY'
  process.env[envName] = 'sk-env-secret-2468'
  const app = createDefaultApplicationCore()

  const saved = app.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: `env:${envName}`,
    enabled: true
  })

  assert.equal(saved.apiKeySet, true)
  assert.equal(saved.apiKeyPreview, `env:${envName}`)
  assert.equal(saved.secretStorage, 'external_env')
  assert.equal(app.repository.getAIProviderSecret('openai'), 'sk-env-secret-2468')

  const updated = app.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true
  })
  assert.equal(updated.secretStorage, 'external_env')
  assert.equal(updated.apiKeyPreview, `env:${envName}`)
  assert.equal(app.repository.getAIProviderSecret('openai'), 'sk-env-secret-2468')

  delete process.env[envName]
  const missing = app.listAISecretHealth().find((item) => item.provider === 'openai')
  assert.equal(app.repository.getAIProviderSecret('openai'), undefined)
  assert.equal(missing?.severity, 'critical')
  assert.equal(missing?.recommendedAction, 'configure_key')
})

test('AI failure policy is persisted and normalized by application core', () => {
  const app = createDefaultApplicationCore()
  const saved = app.saveAIFailurePolicy({
    maxRetries: 2.8,
    retryDelayMs: 1200.3,
    minDelayMs: 50.9,
    circuitBreakerThreshold: 3.1
  })

  assert.equal(saved.maxRetries, 2)
  assert.equal(saved.retryDelayMs, 1200)
  assert.equal(app.getAIFailurePolicy().circuitBreakerThreshold, 3)
  assert.equal(app.listAuditLogs()[0].action, 'ai.failure_policy.save')
})

test('AI failure policy presets can be applied and recovery advice follows circuit state', async () => {
  const app = createDefaultApplicationCore()
  const preset = app.listAIFailurePolicyPresets().find((item) => item.key === 'offline_safe')
  assert.ok(preset)
  const saved = app.saveAIFailurePolicy(preset.policy)
  assert.equal(saved.circuitBreakerThreshold, 1)

  app.ai.commentToLeadWithMeta = async () => {
    throw new AIProviderError('server_error', 'server down')
  }
  const now = new Date().toISOString()
  await app.analyzeComments([
    { id: 'cb-advice-1', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/1', nickname: 'A', text: '多少钱', likes: 0, publishedAt: now, collectedAt: now },
    { id: 'cb-advice-2', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/2', nickname: 'B', text: '想买', likes: 0, publishedAt: now, collectedAt: now }
  ])

  const advice = app.getAIRecoveryAdvice()
  assert.equal(advice.severity, 'critical')
  assert.equal(advice.recommendedPolicyKey, 'offline_safe')
  assert.ok(advice.actions.some((action) => action.includes('API Key')))
})

test('AI recovery advice recommends conservative policy for rate limits', async () => {
  const app = createDefaultApplicationCore()
  app.saveAIFailurePolicy({
    maxRetries: 0,
    retryDelayMs: 0,
    minDelayMs: 0,
    circuitBreakerThreshold: 10
  })
  app.ai.commentToLeadWithMeta = async () => {
    throw new AIProviderError('rate_limited', 'too many requests')
  }
  const now = new Date().toISOString()
  await app.analyzeComments([
    { id: 'rate-advice-1', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/1', nickname: 'A', text: '多少钱', likes: 0, publishedAt: now, collectedAt: now }
  ])

  const advice = app.getAIRecoveryAdvice()

  assert.equal(advice.severity, 'warning')
  assert.equal(advice.recommendedPolicyKey, 'conservative')
})

test('AI provider secrets use pluggable codec and remain readable after model edits', () => {
  const codec: SecretCodec = {
    encode(value) {
      return `mock:${Buffer.from(value, 'utf8').toString('base64')}`
    },
    decode(value) {
      if (!value.startsWith('mock:')) return value
      return Buffer.from(value.slice(5), 'base64').toString('utf8')
    },
    describe() {
      return 'mock'
    },
    inspect(value) {
      return value.startsWith('mock:') ? 'encrypted' : 'legacy_plain'
    }
  }
  const repository = new LeadMinerRepository(':memory:', codec)
  const now = new Date().toISOString()
  repository.saveAIProviderConfig({
    provider: 'dashscope',
    model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-secret-0001',
    enabled: true,
    updatedAt: now
  })
  const updated = repository.saveAIProviderConfig({
    provider: 'dashscope',
    model: 'qwen-max',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    enabled: true,
    updatedAt: now
  })

  assert.equal(updated.apiKeyPreview, '...0001')
  assert.equal(updated.secretStorage, 'encrypted')
  assert.equal(repository.getAIProviderSecret('dashscope'), 'sk-secret-0001')
  repository.close()
})

test('application migrates AI provider secrets with the active codec', () => {
  const codec: SecretCodec = {
    encode(value) {
      return `secure:${Buffer.from(value).toString('base64')}`
    },
    decode(value) {
      if (!value.startsWith('secure:')) return value
      return Buffer.from(value.slice(7), 'base64').toString()
    },
    describe() {
      return 'secure'
    },
    inspect(value) {
      return value.startsWith('secure:') ? 'encrypted' : 'legacy_plain'
    }
  }
  const app = createDefaultApplicationCore({ secretCodec: codec })
  app.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-migrate-1234',
    enabled: true
  })
  const migrated = app.migrateAIProviderSecrets('openai')

  assert.equal(migrated[0].secretStorage, 'encrypted')
  assert.equal(app.repository.getAIProviderSecret('openai'), 'sk-migrate-1234')
  assert.equal(app.listAISecretBackups('openai').length, 1)
  assert.equal(app.listAISecretBackups('openai')[0].reason, 'migration')
  assert.ok(app.listAuditLogs().some((event) => event.action === 'ai.secret.backup'))
  assert.ok(app.listAuditLogs().some((event) => event.action === 'ai.secret.migrate'))
})

test('application can restore an AI secret backup after migration', () => {
  const codec = {
    encode(value: string) {
      return `secure:${value}`
    },
    decode(value: string) {
      return value.startsWith('secure:') ? value.slice(7) : value
    },
    describe() {
      return 'secure'
    },
    inspect(value: string) {
      return value.startsWith('secure:') ? 'encrypted' as const : 'legacy_plain' as const
    }
  }
  const app = createDefaultApplicationCore({ secretCodec: codec })
  app.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-restore-1234',
    enabled: true
  })
  const backup = app.listAISecretBackups('openai')[0] ?? app.repository.createAIProviderSecretBackup('openai', 'manual')
  app.migrateAIProviderSecrets('openai')
  const restored = app.restoreAISecretBackup((backup ?? app.listAISecretBackups('openai').at(-1))?.id ?? '')

  assert.equal(restored?.provider, 'openai')
  assert.equal(app.repository.getAIProviderSecret('openai'), 'sk-restore-1234')
  assert.ok(app.listAuditLogs().some((event) => event.action === 'ai.secret.restore'))
})

test('AI secret backups are pruned and legacy restores re-encode with active codec', () => {
  const repository = new LeadMinerRepository(':memory:', new PlainSecretCodec())
  const now = new Date().toISOString()
  repository.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-legacy-0001',
    enabled: true,
    updatedAt: now
  })
  const firstBackup = repository.createAIProviderSecretBackup('openai', 'manual')
  const secureCodec: SecretCodec = {
    encode(value) {
      return `secure:${Buffer.from(value, 'utf8').toString('base64')}`
    },
    decode(value) {
      return value.startsWith('secure:') ? Buffer.from(value.slice(7), 'base64').toString('utf8') : value
    },
    describe() {
      return 'secure'
    },
    inspect(value) {
      return value.startsWith('secure:') ? 'encrypted' : 'legacy_plain'
    }
  }
  ;(repository as unknown as { secretCodec: SecretCodec }).secretCodec = secureCodec
  repository.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-current-0002',
    enabled: true,
    updatedAt: now
  })

  const restored = repository.restoreAIProviderSecretBackup(firstBackup?.id ?? '')
  assert.equal(restored?.secretStorage, 'encrypted')
  assert.equal(repository.getAIProviderSecret('openai'), 'sk-legacy-0001')

  for (let index = 0; index < 7; index += 1) {
    repository.createAIProviderSecretBackup('openai', 'manual')
  }
  assert.equal(repository.listAISecretBackups('openai').length, 5)
  repository.close()
})

test('application reports AI secret health and rotation advice', () => {
  const now = new Date('2026-05-19T00:00:00.000Z')
  const app = createDefaultApplicationCore()
  app.saveAIProviderConfig({
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    enabled: true
  })
  app.repository.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-old-secret-1234',
    enabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z'
  })
  app.repository.saveAIProviderConfig({
    provider: 'dashscope',
    model: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-fresh-secret-5678',
    enabled: true,
    updatedAt: '2026-05-01T00:00:00.000Z'
  })

  const health = app.listAISecretHealth(now)
  const byProvider = new Map(health.map((item) => [item.provider, item]))

  assert.equal(byProvider.get('deepseek')?.recommendedAction, 'configure_key')
  assert.equal(byProvider.get('deepseek')?.severity, 'critical')
  assert.equal(byProvider.get('openai')?.recommendedAction, 'migrate_secret')
  assert.equal(byProvider.get('openai')?.severity, 'warning')
  assert.equal(byProvider.get('dashscope')?.recommendedAction, 'migrate_secret')

  const encryptedApp = createDefaultApplicationCore({
    secretCodec: {
      encode(value) {
        return `secure:${value}`
      },
      decode(value) {
        return value.startsWith('secure:') ? value.slice(7) : value
      },
      describe() {
        return 'secure'
      },
      inspect(value) {
        return value.startsWith('secure:') ? 'encrypted' : 'legacy_plain'
      }
    }
  })
  encryptedApp.repository.saveAIProviderConfig({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-old-encrypted-9999',
    enabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z'
  })
  const encryptedHealth = encryptedApp.listAISecretHealth(now)[0]

  assert.equal(encryptedHealth.recommendedAction, 'rotate_key')
  assert.equal(encryptedHealth.ageDays, 138)
})

test('plain secret codec keeps backward compatibility with existing plaintext secrets', () => {
  const codec = new PlainSecretCodec()

  assert.equal(codec.decode('legacy-secret'), 'legacy-secret')
  assert.equal(codec.encode('legacy-secret'), 'legacy-secret')
  assert.equal(codec.describe(), 'plain')
  assert.equal(codec.inspect('plain:secret'), 'plain')
  assert.equal(codec.inspect('legacy-secret'), 'legacy_plain')
})

test('AI prompt template and model output normalization are deterministic', () => {
  const prompt = buildIntentAnalysisPrompt({
    platformKey: 'youtube',
    contentUrl: 'https://example.test/video',
    nickname: 'Alice',
    text: '想买，怎么买',
    likes: 3
  })
  const normalized = normalizeIntentResult({
    level: 'high',
    confidence: 2,
    keywords: ['想买', '怎么买'],
    reason: '购买意图明确'
  })

  assert.ok(prompt.includes('请只输出 JSON'))
  assert.ok(prompt.includes('想买，怎么买'))
  assert.equal(normalized.confidence, 1)
  assert.deepEqual(normalized.keywords, ['想买', '怎么买'])
})

test('AI service uses configured LLM client before rule fallback', async () => {
  const ai = new AIService({
    async analyzeIntent() {
      return { level: 'medium', confidence: 0.77, keywords: ['模型关键词'], reason: '模型判断' }
    }
  } satisfies LLMClient)
  ai.configureProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    enabled: true,
    apiKeySet: true,
    apiKeyPreview: '...1234',
    secretStorage: 'encrypted',
    updatedAt: new Date().toISOString()
  }, 'sk-test')

  const lead = await ai.commentToLeadAsync({
    id: 'comment-model-1',
    platformKey: 'youtube',
    contentId: 'video-1',
    contentUrl: 'https://example.test/video',
    nickname: 'Alice',
    text: '普通评论',
    likes: 0,
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString()
  })

  assert.equal(lead?.intentLevel, 'medium')
  assert.deepEqual(lead?.keywords, ['模型关键词'])
})

test('AI service falls back to rules when LLM client fails', async () => {
  const ai = new AIService({
    async analyzeIntent() {
      throw new Error('network failed')
    }
  } satisfies LLMClient)
  ai.configureProvider({
    provider: 'openai',
    model: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    apiKeySet: true,
    apiKeyPreview: '...1234',
    secretStorage: 'encrypted',
    updatedAt: new Date().toISOString()
  }, 'sk-test')

  const lead = await ai.commentToLeadAsync({
    id: 'comment-model-2',
    platformKey: 'youtube',
    contentId: 'video-1',
    contentUrl: 'https://example.test/video',
    nickname: 'Alice',
    text: '多少钱，求链接',
    likes: 0,
    publishedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString()
  })

  assert.equal(lead?.intentLevel, 'high')
  assert.ok(lead?.keywords.includes('多少钱'))
})

test('AI provider errors classify http statuses', () => {
  assert.equal(codeFromHttpStatus(401), 'auth_failed')
  assert.equal(codeFromHttpStatus(429), 'rate_limited')
  assert.equal(codeFromHttpStatus(503), 'server_error')
  assert.equal(codeFromHttpStatus(400), 'unknown')
})

test('AI analysis queue tracks model usage, fallback and estimated cost', async () => {
  const ai = new AIService({
    async analyzeIntent(comment) {
      if (comment.text.includes('失败')) throw new Error('provider failed')
      return { level: 'high', confidence: 0.9, keywords: ['模型'], reason: '模型判断' }
    }
  } satisfies LLMClient)
  ai.configureProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    enabled: true,
    apiKeySet: true,
    apiKeyPreview: '...1234',
    secretStorage: 'encrypted',
    updatedAt: new Date().toISOString()
  }, 'sk-test')

  const now = new Date().toISOString()
  const queue = new AIAnalysisQueue(ai, { maxRetries: 0 })
  const result = await queue.analyze([
    { id: 'c1', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/1', nickname: 'A', text: '普通评论', likes: 0, publishedAt: now, collectedAt: now },
    { id: 'c2', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/2', nickname: 'B', text: '失败但多少钱', likes: 0, publishedAt: now, collectedAt: now }
  ])

  assert.equal(result.stats.total, 2)
  assert.equal(result.stats.modelUsed, 1)
  assert.equal(result.stats.ruleFallback, 1)
  assert.equal(result.leads.length, 2)
  assert.ok(result.stats.estimatedInputTokens > 0)
  assert.ok(result.stats.estimatedCostUsd > 0)
})

test('AI analysis queue retries retryable errors and records final failure code', async () => {
  let attempts = 0
  const ai = new AIService()
  ai.commentToLeadWithMeta = async () => {
    attempts += 1
    throw new AIProviderError('rate_limited', 'too many requests')
  }
  const now = new Date().toISOString()
  const result = await new AIAnalysisQueue(ai, { maxRetries: 2 }).analyze([
    { id: 'retry-1', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/1', nickname: 'A', text: '多少钱', likes: 0, publishedAt: now, collectedAt: now }
  ])

  assert.equal(attempts, 3)
  assert.equal(result.stats.failed, 1)
  assert.equal(result.stats.failuresByCode?.rate_limited, 1)
})

test('AI analysis queue does not retry non-retryable errors', async () => {
  let attempts = 0
  const ai = new AIService()
  ai.commentToLeadWithMeta = async () => {
    attempts += 1
    throw new AIProviderError('auth_failed', 'bad key', { retryable: false })
  }
  const now = new Date().toISOString()
  const result = await new AIAnalysisQueue(ai, { maxRetries: 3 }).analyze([
    { id: 'auth-1', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/1', nickname: 'A', text: '多少钱', likes: 0, publishedAt: now, collectedAt: now }
  ])

  assert.equal(attempts, 1)
  assert.equal(result.stats.failuresByCode?.auth_failed, 1)
})

test('AI analysis queue opens circuit after consecutive failures', async () => {
  let attempts = 0
  const ai = new AIService()
  ai.commentToLeadWithMeta = async () => {
    attempts += 1
    throw new AIProviderError('server_error', 'server down')
  }
  const now = new Date().toISOString()
  const result = await new AIAnalysisQueue(ai, { maxRetries: 0, circuitBreakerThreshold: 1 }).analyze([
    { id: 'cb-1', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/1', nickname: 'A', text: '多少钱', likes: 0, publishedAt: now, collectedAt: now },
    { id: 'cb-2', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://example.test/2', nickname: 'B', text: '多少钱', likes: 0, publishedAt: now, collectedAt: now }
  ])

  assert.equal(attempts, 1)
  assert.equal(result.stats.circuitOpen, true)
  assert.equal(result.stats.failed, 2)
})

test('application batch analysis records task, audit and last AI stats', async () => {
  const app = createDefaultApplicationCore()
  const now = new Date().toISOString()
  app.repository.saveComment({
    id: 'comment-batch-1',
    platformKey: 'bilibili',
    contentId: 'content-1',
    contentUrl: 'https://example.test/video',
    nickname: 'Alice',
    text: '多少钱，求链接',
    likes: 3,
    publishedAt: now,
    collectedAt: now
  })

  const leads = await app.analyzeComments()

  assert.equal(leads.length, 1)
  assert.equal(app.getAIAnalysisStats()?.total, 1)
  assert.equal(app.tasks.list()[0].type, 'analyze_leads')
  assert.equal(app.listAuditLogs()[0].action, 'ai.analysis.batch')
})

test('compliance policy removes private fields and blocks unsafe export fields', () => {
  const policy = new CompliancePolicy()
  const sanitized = policy.sanitizeRecord({
    nickname: 'Alice',
    password: 'secret',
    comment: '求链接',
    id_card: '123'
  })

  assert.deepEqual(sanitized, { nickname: 'Alice', comment: '求链接' })

  const decision = policy.validateExportFields(['nickname', 'password'])
  assert.equal(decision.allowed, false)
  assert.deepEqual(decision.violations, ['password'])
})

test('task orchestrator persists status transitions in memory baseline', () => {
  const tasks = new TaskOrchestrator()
  const created = tasks.create('search', { keyword: '咖啡机' }, 'google')
  const running = tasks.transition(created.id, 'running', { progress: 30 })
  const completed = tasks.transition(created.id, 'completed', { progress: 100 })

  assert.equal(running.status, 'running')
  assert.equal(completed.status, 'completed')
  assert.equal(tasks.list()[0].progress, 100)
})

test('application core creates search task and ranks placeholder results', async () => {
  const app = createDefaultApplicationCore()
  const plan = app.planSearch('咖啡机')
  const results = await app.searchAcrossPlatforms('咖啡机', ['google', 'bing'])

  assert.ok(plan.keywords.length > 3)
  assert.equal(results.length, 6)
  assert.equal(app.tasks.list()[0].status, 'completed')
  assert.ok(results[0].relevance >= results[1].relevance)
  assert.equal(app.listSearchResults().length, 6)
})

test('application core isolates platform status failures', async () => {
  class FailingStatusAdapter extends MetadataOnlyPlatformAdapter {
    override async checkStatus(): Promise<PlatformStatus> {
      throw new Error('status unavailable')
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new MetadataOnlyPlatformAdapter({
    key: 'ok',
    name: 'OK',
    category: 'search_engine',
    domains: ['ok.test'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }))
  registry.register(new FailingStatusAdapter({
    key: 'bad',
    name: 'Bad',
    category: 'search_engine',
    domains: ['bad.test'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }))
  const repository = new LeadMinerRepository(':memory:')
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())

  const statuses = await app.checkPlatformStatuses()

  assert.equal(statuses.length, 2)
  assert.equal(statuses.find((status) => status.platformKey === 'bad')?.available, false)
  assert.equal(repository.listPlatformStatuses().length, 2)
  repository.close()
})

test('application core returns readable platform network errors', async () => {
  class FailingStatusAdapter extends MetadataOnlyPlatformAdapter {
    override async checkStatus(): Promise<PlatformStatus> {
      throw new Error('page.goto: net::ERR_CONNECTION_CLOSED at https://www.douyin.com/ Call log: navigating')
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new FailingStatusAdapter({
    key: 'douyin',
    name: '抖音',
    category: 'video',
    domains: ['douyin.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }))
  const repository = new LeadMinerRepository(':memory:')
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())

  const [status] = await app.checkPlatformStatuses()

  assert.equal(status.errorCode, 'network_error')
  assert.match(status.message, /网络连接被平台关闭/)
  assert.doesNotMatch(status.message, /Call log|ERR_CONNECTION_CLOSED/)
  repository.close()
})

test('application core keeps partial search results when one platform fails', async () => {
  class FailingSearchAdapter extends MetadataOnlyPlatformAdapter {
    override async search(_input: SearchInput): Promise<SearchResult[]> {
      throw new Error('blocked')
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new MetadataOnlyPlatformAdapter({
    key: 'ok',
    name: 'OK',
    category: 'search_engine',
    domains: ['ok.test'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }))
  registry.register(new FailingSearchAdapter({
    key: 'bad',
    name: 'Bad',
    category: 'search_engine',
    domains: ['bad.test'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }))
  const repository = new LeadMinerRepository(':memory:')
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())

  const results = await app.searchAcrossPlatforms('咖啡机', ['ok', 'bad'])

  assert.equal(results.length, 1)
  assert.equal(app.tasks.list()[0].status, 'completed')
  assert.equal(app.listAuditLogs()[0].action, 'search.partial_failure')
  repository.close()
})

test('repository persists platform statuses, tasks and search results', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = new Date().toISOString()
  repository.savePlatformStatus({
    platformKey: 'google',
    available: true,
    loggedIn: true,
    latencyMs: 42,
    checkedAt: now,
    errorCode: 'ok',
    message: 'ok'
  })
  const session = repository.createSearchSession('咖啡机', ['google'])
  repository.saveSearchResults(session.id, [{
    id: 'result-1',
    platformKey: 'google',
    title: '咖啡机 推荐',
    url: 'https://www.google.com/search?q=coffee',
    snippet: 'snippet',
    relevance: 0.8,
    createdAt: now
  }])
  const task = new TaskOrchestrator(repository).create('search', { keyword: '咖啡机' }, 'google')
  repository.saveLead({
    id: 'lead-1',
    commentId: 'comment-1',
    platformKey: 'google',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '多少钱',
    intentLevel: 'high',
    confidence: 0.9,
    keywords: ['多少钱'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  })

  assert.equal(repository.listPlatformStatuses()[0].platformKey, 'google')
  assert.equal(repository.listSearchResults(session.id)[0].title, '咖啡机 推荐')
  assert.equal(repository.listTasks()[0].id, task.id)
  assert.equal(repository.listLeads()[0].score, 95)
  repository.close()
})

test('application privacy cleanup clears local data and selected platform profiles', async () => {
  const actualProfileRoot = path.join(tmpdir(), `lead-miner-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const actualLogRoot = path.join(tmpdir(), `lead-miner-logs-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await mkdir(path.join(actualProfileRoot, 'google'), { recursive: true })
  await mkdir(path.join(actualLogRoot, 'nested'), { recursive: true })
  await writeFile(path.join(actualProfileRoot, 'google', 'Cookies'), 'cookie')
  await writeFile(path.join(actualLogRoot, 'lead-miner.log'), 'token=secret')
  await writeFile(path.join(actualLogRoot, 'nested', 'debug.jsonl'), '{"cookie":"secret"}')
  await writeFile(path.join(actualLogRoot, 'ignore.sqlite3'), 'db')
  const app = createDefaultApplicationCore({ profileRoot: actualProfileRoot, logRoot: actualLogRoot })
  const now = new Date().toISOString()
  app.repository.savePlatformStatus({ platformKey: 'google', available: true, loggedIn: true, latencyMs: 1, checkedAt: now, errorCode: 'ok', message: 'ok' })
  app.repository.savePlatformProtection({ platformKey: 'google', pausedUntil: new Date(Date.now() + 86_400_000).toISOString(), reason: 'test', createdAt: now })
  const session = app.repository.createSearchSession('咖啡机', ['google'])
  app.repository.saveSearchResults(session.id, [{ id: 'cleanup-result', platformKey: 'google', title: 't', url: 'https://www.google.com/search?q=x', snippet: 's', relevance: 1, createdAt: now }])
  app.repository.saveContent({ platformKey: 'youtube', contentId: 'v1', contentType: 'video', url: 'https://www.youtube.com/watch?v=abc123XYZ00' })
  app.repository.saveComment({ id: 'cleanup-comment', platformKey: 'youtube', contentId: 'v1', contentUrl: 'https://www.youtube.com/watch?v=abc123XYZ00', nickname: 'Alice', text: '多少钱', likes: 1, publishedAt: now, collectedAt: now })
  app.repository.saveLead({ id: 'cleanup-lead', commentId: 'cleanup-comment', platformKey: 'youtube', contentId: 'v1', nickname: 'Alice', text: '多少钱', intentLevel: 'high', confidence: 1, keywords: ['多少钱'], score: 95, scoreReason: 'test', suggestedAction: '跟进', status: 'new', createdAt: now })
  app.tasks.create('search', { keyword: '咖啡机' }, 'google')
  app.saveAIProviderConfig({ provider: 'openai', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-cleanup-1234', enabled: true })
  app.repository.createAIProviderSecretBackup('openai', 'manual')

  const estimate = await app.previewPrivacyCleanup({
    platformProfiles: true,
    platformKeys: ['google'],
    platformState: true,
    searchData: true,
    commentsAndLeads: true,
    tasks: true,
    aiSecretBackups: true,
    localLogs: true
  })
  assert.equal(estimate.platformProfilesFound, 1)
  assert.equal(estimate.localLogFilesCleared, 2)
  assert.equal(estimate.searchRowsCleared, 2)
  assert.equal(estimate.leadRowsCleared, 1)

  const result = await app.cleanupPrivacyData({
    platformProfiles: true,
    platformKeys: ['google'],
    platformState: true,
    searchData: true,
    commentsAndLeads: true,
    tasks: true,
    aiSecretBackups: true,
    localLogs: true
  })

  assert.equal(result.platformProfilesCleared, 1)
  assert.equal(result.platformStateRowsCleared, 2)
  assert.equal(result.searchRowsCleared, 2)
  assert.equal(result.leadRowsCleared, 1)
  assert.equal(result.commentRowsCleared, 2)
  assert.equal(result.taskRowsCleared, 1)
  assert.equal(result.aiSecretBackupRowsCleared, 1)
  assert.equal(result.localLogFilesCleared, 2)
  assert.ok(result.localLogBytesCleared > 0)
  await assert.rejects(() => access(path.join(actualProfileRoot, 'google')))
  await assert.rejects(() => access(path.join(actualLogRoot, 'lead-miner.log')))
  await assert.rejects(() => access(path.join(actualLogRoot, 'nested', 'debug.jsonl')))
  await access(path.join(actualLogRoot, 'ignore.sqlite3'))
  assert.equal(app.repository.listSearchResults().length, 0)
  assert.equal(app.repository.listComments().length, 0)
  assert.equal(app.repository.listLeads().length, 0)
  assert.equal(app.repository.listTasks().length, 0)
  assert.equal(app.listAISecretBackups('openai').length, 0)
  assert.ok(app.listAuditLogs().some((event) => event.action === 'privacy.cleanup'))
})

test('repository filters leads, updates status and stores audit logs', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = new Date().toISOString()
  const baseLead: LeadRecord = {
    id: 'lead-1',
    commentId: 'comment-1',
    platformKey: 'youtube',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '多少钱，求链接',
    intentLevel: 'high',
    confidence: 0.9,
    keywords: ['多少钱'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  }

  repository.saveLead(baseLead)
  repository.saveLead({ ...baseLead, id: 'lead-2', commentId: 'comment-2', nickname: 'Bob', text: '看看测评', score: 55, status: 'ignored' })
  assert.equal(repository.listLeads({ status: 'new' }).length, 1)
  assert.equal(repository.listLeads({ minScore: 90 })[0].nickname, 'Alice')
  assert.equal(repository.listLeads({ keyword: '测评' })[0].nickname, 'Bob')

  const updated = repository.updateLeadStatus('lead-1', 'contacted')
  assert.equal(updated?.status, 'contacted')
  repository.saveAudit({
    id: 'audit-1',
    action: 'lead.status.update',
    targetType: 'lead',
    targetId: 'lead-1',
    message: '线索状态更新为 contacted',
    createdAt: now
  })
  assert.equal(repository.listAuditLogs()[0].action, 'lead.status.update')
  repository.close()
})

test('repository filters audit logs by action prefix and keyword', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = new Date().toISOString()
  repository.saveAudit({ id: 'audit-manual-1', action: 'manual_import.completed', targetType: 'content', targetId: 'content-1', message: '手动导入 微信公众号 评论 2 条', createdAt: now })
  repository.saveAudit({ id: 'audit-lead-1', action: 'lead.export', targetType: 'lead', message: '导出 1 条线索', createdAt: now })
  repository.saveAudit({ id: 'audit-manual-2', action: 'manual_import.analysis_failed', targetType: 'comment', targetId: 'comment-1', message: 'AI 分析失败', createdAt: now })

  const manualLogs = repository.listAuditLogs({ actionPrefix: 'manual_import', limit: 10 })
  const keywordLogs = repository.listAuditLogs({ actionPrefix: 'manual_import', keyword: '公众号', limit: 10 })

  assert.deepEqual(manualLogs.map((event) => event.action).sort(), ['manual_import.analysis_failed', 'manual_import.completed'])
  assert.equal(keywordLogs.length, 1)
  assert.equal(keywordLogs[0].id, 'audit-manual-1')
  repository.close()
})

test('repository updates lead notes, follow-up time and bulk statuses', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = new Date().toISOString()
  const baseLead: LeadRecord = {
    id: 'lead-note-1',
    commentId: 'comment-note-1',
    platformKey: 'bilibili',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '想买，求链接',
    intentLevel: 'high',
    confidence: 0.9,
    keywords: ['想买'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  }

  repository.saveLead(baseLead)
  repository.saveLead({ ...baseLead, id: 'lead-note-2', commentId: 'comment-note-2', nickname: 'Bob' })
  const nextFollowUpAt = '2026-06-01T08:00:00.000Z'
  const updated = repository.updateLead('lead-note-1', { note: '已加微信，等报价', nextFollowUpAt })
  const bulk = repository.updateLeadStatuses(['lead-note-1', 'lead-note-2'], 'contacted')

  assert.equal(updated?.note, '已加微信，等报价')
  assert.equal(updated?.nextFollowUpAt, nextFollowUpAt)
  assert.equal(bulk.length, 2)
  assert.equal(repository.listLeads({ status: 'contacted' }).length, 2)
  repository.close()
})

test('repository can clear lead follow-up time without losing notes', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = new Date().toISOString()
  repository.saveLead({
    id: 'lead-clear-follow-1',
    commentId: 'comment-clear-follow-1',
    platformKey: 'bilibili',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '求报价',
    intentLevel: 'high',
    confidence: 0.9,
    keywords: ['报价'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    note: '已预约',
    nextFollowUpAt: '2026-06-01T08:00:00.000Z',
    createdAt: now
  })

  const updated = repository.updateLead('lead-clear-follow-1', { nextFollowUpAt: null })

  assert.equal(updated?.note, '已预约')
  assert.equal(updated?.nextFollowUpAt, undefined)
  assert.equal(repository.listFollowUpReminders({ now: '2026-05-31T08:00:00.000Z' }).length, 0)
  repository.close()
})

test('repository lists follow-up reminders by overdue today and upcoming horizon', () => {
  const repository = new LeadMinerRepository(':memory:')
  const now = '2026-06-01T08:00:00.000Z'
  const baseLead: LeadRecord = {
    id: 'follow-1',
    commentId: 'follow-comment-1',
    platformKey: 'xiaohongshu',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '想买，求报价',
    intentLevel: 'high',
    confidence: 0.9,
    keywords: ['想买'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  }

  repository.saveLead({ ...baseLead, nextFollowUpAt: '2026-05-31T08:00:00.000Z' })
  repository.saveLead({ ...baseLead, id: 'follow-2', commentId: 'follow-comment-2', nickname: 'Bob', nextFollowUpAt: '2026-06-01T10:00:00.000Z' })
  repository.saveLead({ ...baseLead, id: 'follow-3', commentId: 'follow-comment-3', nickname: 'Carol', nextFollowUpAt: '2026-06-03T08:00:00.000Z' })
  repository.saveLead({ ...baseLead, id: 'follow-4', commentId: 'follow-comment-4', nickname: 'Dave', nextFollowUpAt: '2026-06-10T08:00:00.000Z' })
  repository.saveLead({ ...baseLead, id: 'follow-5', commentId: 'follow-comment-5', nickname: 'Eve', status: 'ignored', nextFollowUpAt: '2026-06-01T09:00:00.000Z' })

  const reminders = repository.listFollowUpReminders({ now, horizonDays: 3 })

  assert.deepEqual(reminders.map((item) => item.lead.id), ['follow-1', 'follow-2', 'follow-3'])
  assert.deepEqual(reminders.map((item) => item.status), ['overdue', 'today', 'upcoming'])
  assert.equal(reminders[0].daysUntilDue, -1)
  assert.equal(reminders[2].daysUntilDue, 2)
  repository.close()
})

test('application core updates lead status and exports sanitized csv', () => {
  const app = createDefaultApplicationCore()
  const now = new Date().toISOString()
  app.repository.saveLead({
    id: 'lead-1',
    commentId: 'comment-1',
    platformKey: 'bilibili',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '这个多少钱，求链接',
    intentLevel: 'high',
    confidence: 0.92,
    keywords: ['多少钱', '链接'],
    score: 96,
    scoreReason: '模型判断；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  })

  assert.equal(app.updateLeadStatus('lead-1', 'contacted').status, 'contacted')
  const exported = app.exportLeads({
    filters: { status: 'contacted' },
    fields: ['platformKey', 'nickname', 'text', 'score', 'scoreReason', 'status']
  })

  assert.equal(exported.count, 1)
  assert.ok(exported.content.includes('platformKey,nickname,text,score,scoreReason,status'))
  assert.ok(exported.content.includes('bilibili,Alice'))
  assert.equal(app.listAuditLogs().length, 2)
})

test('application core neutralizes spreadsheet formulas in csv exports', () => {
  const app = createDefaultApplicationCore()
  app.repository.saveLead({
    id: 'lead-formula-1',
    commentId: 'comment-formula-1',
    platformKey: 'youtube',
    contentId: 'content-formula-1',
    nickname: '=HYPERLINK("https://evil.test","click")',
    text: '+cmd|calc',
    intentLevel: 'high',
    confidence: 0.92,
    keywords: ['求链接'],
    score: 95,
    scoreReason: '@external',
    suggestedAction: '-call',
    status: 'new',
    note: '\tstealth',
    createdAt: new Date().toISOString()
  })

  const exported = app.exportLeads({
    fields: ['nickname', 'text', 'scoreReason', 'suggestedAction', 'note']
  })
  const preview = app.previewLeadExport({
    fields: ['nickname', 'text', 'scoreReason', 'suggestedAction', 'note']
  })

  assert.ok(exported.content.includes('"\'=HYPERLINK(""https://evil.test"",""click"")"'))
  assert.ok(exported.content.includes("'+cmd|calc"))
  assert.ok(exported.content.includes("'@external"))
  assert.ok(exported.content.includes("'-call"))
  assert.ok(exported.content.includes("'\tstealth"))
  assert.equal(preview.count, 1)
  assert.equal(preview.sampleRows[0].nickname, '=HYPERLINK("https://evil.test","click")')
  assert.equal('apiKey' in preview.sampleRows[0], false)
})

test('application core updates lead details, bulk statuses and exports follow-up fields', () => {
  const app = createDefaultApplicationCore()
  const now = new Date().toISOString()
  app.repository.saveLead({
    id: 'lead-detail-1',
    commentId: 'comment-detail-1',
    platformKey: 'youtube',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '怎么买',
    intentLevel: 'high',
    confidence: 0.88,
    keywords: ['怎么买'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  })

  app.updateLead('lead-detail-1', { note: '明天回访', nextFollowUpAt: '2026-06-02T09:00:00.000Z' })
  app.updateLeadStatuses(['lead-detail-1'], 'contacted')
  const exported = app.exportLeads({ fields: ['nickname', 'status', 'note', 'nextFollowUpAt'] })

  assert.equal(app.listLeads()[0].status, 'contacted')
  assert.ok(exported.content.includes('明天回访'))
  assert.ok(app.listAuditLogs().some((event) => event.action === 'lead.status.bulk_update'))
})

test('application core returns lead detail with original comment and content context', () => {
  const app = createDefaultApplicationCore()
  const now = new Date().toISOString()
  app.repository.saveContent({
    platformKey: 'youtube',
    contentId: 'content-detail-1',
    contentType: 'video',
    title: '咖啡机测评',
    url: 'https://www.youtube.com/watch?v=content-detail-1'
  })
  app.repository.saveComment({
    id: 'comment-detail-context-1',
    platformKey: 'youtube',
    contentId: 'content-detail-1',
    contentUrl: 'https://www.youtube.com/watch?v=content-detail-1',
    nickname: 'Alice',
    text: '这台怎么买，求链接',
    likes: 11,
    publishedAt: now,
    collectedAt: now
  })
  app.repository.saveLead({
    id: 'lead-detail-context-1',
    commentId: 'comment-detail-context-1',
    platformKey: 'youtube',
    contentId: 'content-detail-1',
    nickname: 'Alice',
    text: '这台怎么买，求链接',
    intentLevel: 'high',
    confidence: 0.88,
    keywords: ['怎么买', '求链接'],
    score: 96,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 6',
    suggestedAction: '优先跟进',
    status: 'new',
    createdAt: now
  })

  const detail = app.getLeadDetail('lead-detail-context-1')

  assert.equal(detail.lead.nickname, 'Alice')
  assert.equal(detail.comment?.text, '这台怎么买，求链接')
  assert.equal(detail.content?.title, '咖啡机测评')
  assert.throws(() => app.getLeadDetail('missing-lead'), /线索不存在/)
})

test('application core exposes follow-up reminders for desktop dashboard', () => {
  const app = createDefaultApplicationCore()
  const now = '2026-06-01T08:00:00.000Z'
  app.repository.saveLead({
    id: 'lead-follow-app-1',
    commentId: 'comment-follow-app-1',
    platformKey: 'youtube',
    contentId: 'content-1',
    nickname: 'Alice',
    text: '怎么买',
    intentLevel: 'high',
    confidence: 0.88,
    keywords: ['怎么买'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    nextFollowUpAt: '2026-06-01T09:00:00.000Z',
    createdAt: now
  })

  const reminders = app.listFollowUpReminders({ now, horizonDays: 1 })

  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].status, 'today')
  assert.equal(reminders[0].lead.nickname, 'Alice')
})

test('application core exports follow-up reminders as calendar events', () => {
  const app = createDefaultApplicationCore()
  const now = '2026-06-01T08:00:00.000Z'
  app.repository.saveLead({
    id: 'lead-calendar-1',
    commentId: 'comment-calendar-1',
    platformKey: 'youtube',
    contentId: 'content-1',
    nickname: 'Alice,VIP',
    text: '想买; 需要报价',
    intentLevel: 'high',
    confidence: 0.88,
    keywords: ['报价'],
    score: 95,
    scoreReason: '命中高意向关键词；基础分 90；关键词加分 5',
    suggestedAction: '优先跟进',
    status: 'new',
    note: '电话回访',
    nextFollowUpAt: '2026-06-01T09:00:00.000Z',
    createdAt: now
  })

  const calendar = app.exportFollowUpsCalendar({ now, horizonDays: 1 })

  assert.equal(calendar.mimeType, 'text/calendar')
  assert.equal(calendar.count, 1)
  assert.ok(calendar.content.includes('BEGIN:VCALENDAR'))
  assert.ok(calendar.content.includes('BEGIN:VEVENT'))
  assert.ok(calendar.content.includes('DTSTART:20260601T090000Z'))
  assert.ok(calendar.content.includes('SUMMARY:跟进 Alice\\,VIP (youtube)'))
  assert.ok(calendar.content.includes('DESCRIPTION:想买\\; 需要报价'))
  assert.ok(app.listAuditLogs().some((event) => event.action === 'followup.calendar.export'))
})

test('browser context manager isolates platform profile paths and login hints', () => {
  const manager = new BrowserContextManager('profiles-root')
  const profile = manager.profileFor('xiaohongshu')
  const hint = manager.createLoginHint({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com'],
    requiresLogin: true,
    capabilities: ['login', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 1000, maxRetries: 2 }
  })

  assert.ok(profile.userDataDir.includes('xiaohongshu'))
  assert.ok(hint.includes('独立浏览器窗口'))
  assert.ok(manager.createLoginHint({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    loginUrl: 'https://passport.bilibili.com/login',
    requiresLogin: false,
    capabilities: ['login', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 1000, maxRetries: 2 }
  }).includes('可选登录'))
})

test('bilibili adapter checks login state through nav api', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText() {
      return JSON.stringify({ code: 0, data: { isLogin: true } })
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    loginUrl: 'https://passport.bilibili.com/login',
    requiresLogin: false,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)

  const status = await adapter.checkStatus()

  assert.equal(status.available, true)
  assert.equal(status.loggedIn, true)
  assert.equal(status.errorCode, 'ok')
})

test('youtube adapter checks optional login state from homepage html', async () => {
  const loggedOutExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<a aria-label="Sign in" href="/signin">Sign in</a>'
    }
  }
  const loggedInExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<button id="avatar-btn">Account</button><ytd-topbar-menu-button-renderer></ytd-topbar-menu-button-renderer>'
    }
  }
  const loggedInWithResidualSignInTextExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<script>{"tooltip":"Sign in to switch account"}</script><button id="avatar-btn">Account</button>'
    }
  }
  const anonymousTopbarExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<ytd-topbar-menu-button-renderer></ytd-topbar-menu-button-renderer><a aria-label="Sign in">Sign in</a>'
    }
  }
  const spec: PlatformSpec = {
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube',
    requiresLogin: false,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }
  const loggedOut = new VideoPlatformAdapter(spec, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, loggedOutExecutor)
  const loggedIn = new VideoPlatformAdapter(spec, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, loggedInExecutor)
  const loggedInWithResidualSignInText = new VideoPlatformAdapter(spec, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, loggedInWithResidualSignInTextExecutor)
  const anonymousTopbar = new VideoPlatformAdapter(spec, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, anonymousTopbarExecutor)

  assert.equal((await loggedOut.checkStatus()).loggedIn, false)
  assert.equal((await loggedOut.checkStatus()).errorCode, 'login_required')
  assert.equal((await loggedIn.checkStatus()).loggedIn, true)
  assert.equal((await loggedIn.checkStatus()).errorCode, 'ok')
  assert.equal((await loggedInWithResidualSignInText.checkStatus()).loggedIn, true)
  assert.equal((await anonymousTopbar.checkStatus()).loggedIn, false)
})

test('search engine adapter checks generic login status with latency', async () => {
  const requested: string[] = []
  const loggedInExecutor: SearchPageExecutor = {
    async fetchHtml(url, platformKey) {
      requested.push(`${platformKey}:${url}`)
      return '<div class="user-menu">个人主页</div><button>退出登录</button>'
    }
  }
  const loggedOutExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<main><button>扫码登录</button><a>请登录后继续</a></main>'
    }
  }
  const failingExecutor: SearchPageExecutor = {
    async fetchHtml() {
      throw new Error('network down')
    }
  }
  const spec: PlatformSpec = {
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    loginUrl: 'https://www.xiaohongshu.com/explore',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }

  const loggedIn = await new SearchEngineAdapter(spec, (keyword) => `https://example.test?q=${keyword}`, undefined, loggedInExecutor).checkStatus()
  const loggedOut = await new SearchEngineAdapter(spec, (keyword) => `https://example.test?q=${keyword}`, undefined, loggedOutExecutor).checkStatus()
  const failed = await new SearchEngineAdapter(spec, (keyword) => `https://example.test?q=${keyword}`, undefined, failingExecutor).checkStatus()

  assert.deepEqual(requested, ['xiaohongshu:https://www.xiaohongshu.com/explore'])
  assert.equal(loggedIn.available, true)
  assert.equal(loggedIn.loggedIn, true)
  assert.equal(loggedIn.errorCode, 'ok')
  assert.equal(typeof loggedIn.latencyMs, 'number')
  assert.equal(loggedOut.available, true)
  assert.equal(loggedOut.loggedIn, false)
  assert.equal(loggedOut.errorCode, 'login_required')
  assert.equal(failed.available, false)
  assert.equal(failed.errorCode, 'network_error')
})

test('search engine adapter uses auth cookies as login state fallback', async () => {
  const checked: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return '<main><button>扫码登录</button><a>请登录后继续</a></main>'
    },
    async hasAuthCookies(platformKey, url) {
      checked.push(`${platformKey}:${url}`)
      return true
    }
  }
  const spec: PlatformSpec = {
    key: 'douyin',
    name: '抖音',
    category: 'video',
    domains: ['douyin.com'],
    loginUrl: 'https://www.douyin.com/',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }

  const status = await new SearchEngineAdapter(spec, (keyword) => `https://example.test?q=${keyword}`, undefined, executor).checkStatus()

  assert.deepEqual(checked, ['douyin:https://www.douyin.com/'])
  assert.equal(status.available, true)
  assert.equal(status.loggedIn, true)
  assert.equal(status.errorCode, 'ok')
  assert.equal(status.message, '抖音 登录态有效')
})

test('search engine adapter does not treat generic profile text as login state', async () => {
  const html = `
    <html>
      <script>window.routes = ["profile", "account", "settings", "login"]</script>
      <main><a href="/login">Log in</a><button>Sign in</button></main>
    </html>
  `
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return html
    },
    async hasAuthCookies() {
      return false
    }
  }
  const specs: PlatformSpec[] = [
    { key: 'tiktok', name: 'TikTok', category: 'video', domains: ['tiktok.com'], loginUrl: 'https://www.tiktok.com/login', requiresLogin: true, capabilities: ['search', 'login', 'status'], rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 } },
    { key: 'instagram', name: 'Instagram', category: 'social', domains: ['instagram.com'], loginUrl: 'https://www.instagram.com/', requiresLogin: true, capabilities: ['search', 'login', 'status'], rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 } },
    { key: 'facebook', name: 'Facebook', category: 'social', domains: ['facebook.com'], loginUrl: 'https://www.facebook.com/', requiresLogin: true, capabilities: ['search', 'login', 'status'], rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 } },
    { key: 'twitter', name: 'X/Twitter', category: 'social', domains: ['x.com'], loginUrl: 'https://x.com/i/flow/login', requiresLogin: true, capabilities: ['search', 'login', 'status'], rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 } }
  ]

  for (const spec of specs) {
    const status = await new SearchEngineAdapter(spec, (keyword) => `https://example.test?q=${keyword}`, undefined, executor).checkStatus()
    assert.equal(status.loggedIn, false, `${spec.key} should not be logged in`)
    assert.equal(status.errorCode, 'login_required')
  }
})

test('auth cookie detection uses platform-specific strong cookie names', () => {
  assert.equal(isAuthCookie('tiktok', 'ttwid'), false)
  assert.equal(isAuthCookie('tiktok', 'passport_csrf_token'), false)
  assert.equal(isAuthCookie('tiktok', 'sessionid'), true)
  assert.equal(isAuthCookie('douyin', 'passport_csrf_token'), false)
  assert.equal(isAuthCookie('douyin', 'sid_guard'), true)
  assert.equal(isAuthCookie('xiaohongshu', 'webId'), false)
  assert.equal(isAuthCookie('xiaohongshu', 'web_session'), true)
  assert.equal(isAuthCookie('instagram', 'csrftoken'), false)
  assert.equal(isAuthCookie('instagram', 'ds_user_id'), true)
  assert.equal(isAuthCookie('facebook', 'fr'), false)
  assert.equal(isAuthCookie('facebook', 'c_user'), true)
  assert.equal(isAuthCookie('unknown', 'sessionid'), false)
})

test('platform final url validation rejects redirects to private or off-domain hosts', () => {
  const domains = ['xiaohongshu.com', 'xhslink.com']

  assert.equal(isAllowedPlatformFinalUrl('https://www.xiaohongshu.com/explore/abc', domains), true)
  assert.equal(isAllowedPlatformFinalUrl('https://sub.xhslink.com/path', domains), true)
  assert.equal(isAllowedPlatformFinalUrl('http://www.xiaohongshu.com/explore/abc', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://evil.test/explore/abc', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://127.0.0.1/admin', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://localhost/admin', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://[::1]/admin', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://[fe80::1]/admin', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://[fc00::1]/admin', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://[::ffff:127.0.0.1]/admin', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://169.254.169.254/latest/meta-data', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('https://192.168.1.10/dashboard', domains), false)
  assert.equal(isAllowedPlatformFinalUrl('not a url', domains), false)
})

test('search html parser extracts generic external result anchors safely', () => {
  const html = `
    <html>
      <a href="https://example.com/a"><h3>咖啡机 真实测评</h3></a>
      <a href="/search?q=skip">skip internal</a>
      <a href="https://example.com/b">价格渠道 &amp; 推荐</a>
    </html>
  `
  const results = parseSearchResultHtml('generic', html, 10)

  assert.equal(results.length, 2)
  assert.equal(results[0].title, '咖啡机 真实测评')
  assert.equal(results[1].title, '价格渠道 & 推荐')
})

test('search html parser accepts platform relative urls and rejects off-domain urls', () => {
  const html = `
    <a href="/explore/abc">小红书咖啡机真实反馈</a>
    <a href="https://evil.example/post">伪造的小红书结果</a>
    <a href="/login">登录入口</a>
  `
  const results = parseSearchResultHtml('xiaohongshu', html, 10)

  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://www.xiaohongshu.com/explore/abc')
  assert.equal(results[0].title, '小红书咖啡机真实反馈')
})

test('built-in registry wires more platforms to search adapters with parsed results', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml(url, platformKey) {
      assert.equal(platformKey, 'reddit')
      assert.ok(url.includes('reddit.com/search'))
      return '<a href="https://www.reddit.com/r/coffee/comments/abc">Reddit 咖啡机讨论</a>'
    }
  }
  const registry = createBuiltinPlatformRegistry(new BrowserContextManager(), executor)

  const results = await registry.get('reddit').search({ keyword: '咖啡机', platformKeys: ['reddit'], limit: 5 })

  assert.equal(results.length, 1)
  assert.equal(results[0].platformKey, 'reddit')
  assert.equal(results[0].url, 'https://www.reddit.com/r/coffee/comments/abc')
})

test('search html parser handles google and bing result structures', () => {
  const google = `
    <div class="g">
      <a href="/url?q=https%3A%2F%2Fexample.com%2Fg&sa=U"><h3>Google 咖啡机推荐</h3></a>
      <div class="VwiC3b">真实用户测评摘要</div>
    </div>
  `
  const bing = `
    <li class="b_algo">
      <h2><a href="https://example.com/b">Bing 咖啡机价格</a></h2>
      <p>价格渠道摘要</p>
    </li>
  `

  assert.equal(parseSearchResultHtml('google', google, 5)[0].url, 'https://example.com/g')
  assert.equal(parseSearchResultHtml('bing', bing, 5)[0].snippet, '价格渠道摘要')
})

test('search html parser handles youtube and bilibili video links', () => {
  const youtube = '<a id="video-title" href="/watch?v=abc123" title="咖啡机开箱">ignored</a>'
  const bilibili = '<a href="//www.bilibili.com/video/BV1234567" title="咖啡机评测">ignored</a>'

  assert.equal(parseSearchResultHtml('youtube', youtube, 5)[0].url, 'https://www.youtube.com/watch?v=abc123')
  assert.equal(parseSearchResultHtml('bilibili', bilibili, 5)[0].title, '咖啡机评测')
})

test('search engine adapter uses parsed html results before deterministic fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return '<div class="g"><a href="https://example.com/result"><h3>咖啡机 怎么选</h3></a></div>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'google',
    name: 'Google',
    category: 'search_engine',
    domains: ['google.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://google.test/search?q=${encodeURIComponent(keyword)}`, undefined, executor)

  const results = await adapter.search({ keyword: '咖啡机', platformKeys: ['google'], limit: 5 })
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://example.com/result')
})

test('search engine adapter falls back when executor returns no parseable html', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'bing',
    name: 'Bing',
    category: 'search_engine',
    domains: ['bing.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://bing.test/search?q=${encodeURIComponent(keyword)}`, undefined, executor)

  const results = await adapter.search({ keyword: '咖啡机', platformKeys: ['bing'], limit: 5 })
  assert.equal(results.length, 3)
  assert.ok(results[0].title.includes('咖啡机'))
})

test('application core login returns immediately for no-login platforms', async () => {
  const app = createDefaultApplicationCore()
  const result = await app.loginPlatform('google')

  assert.equal(result.success, true)
  assert.ok(result.message.includes('无需登录'))
  assert.equal(result.status?.platformKey, 'google')
  assert.ok(app.listAuditLogs().some((event) => event.action === 'platform.login.completed'))
})

test('application core rechecks and persists platform status after login', async () => {
  const spec: PlatformSpec = {
    key: 'mock_login',
    name: 'MockLogin',
    category: 'social',
    domains: ['mock.test'],
    loginUrl: 'https://mock.test/login',
    requiresLogin: true,
    capabilities: ['login', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }
  class LoggedInAdapter extends MetadataOnlyPlatformAdapter {
    override async checkStatus(): Promise<PlatformStatus> {
      return {
        platformKey: spec.key,
        available: true,
        loggedIn: true,
        latencyMs: 7,
        checkedAt: new Date().toISOString(),
        errorCode: 'ok',
        message: 'MockLogin 登录态有效'
      }
    }
  }
  class LoginBrowser extends BrowserContextManager {
    override async openLoginWindow() {
      return { success: true, message: 'MockLogin 登录窗口已关闭', profile: this.profileFor(spec.key) }
    }
  }
  const registry = new PlatformRegistry()
  const repository = new LeadMinerRepository(':memory:')
  registry.register(new LoggedInAdapter(spec, new LoginBrowser()))
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new LoginBrowser())

  const result = await app.loginPlatform(spec.key)

  assert.equal(result.success, true)
  assert.equal(result.status?.loggedIn, true)
  assert.equal(repository.listPlatformStatuses()[0].platformKey, spec.key)
  assert.equal(repository.listPlatformStatuses()[0].loggedIn, true)
  assert.ok(app.listAuditLogs().some((event) => event.action === 'platform.login.completed' && event.targetId === spec.key))
  repository.close()
})

test('application core handles manually closed login windows gracefully', async () => {
  const spec: PlatformSpec = {
    key: 'mock_closed_login',
    name: 'MockClosedLogin',
    category: 'social',
    domains: ['mock.test'],
    loginUrl: 'https://mock.test/login',
    requiresLogin: true,
    capabilities: ['login', 'status'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 0 }
  }
  class LoggedOutAdapter extends MetadataOnlyPlatformAdapter {
    override async checkStatus(): Promise<PlatformStatus> {
      return {
        platformKey: spec.key,
        available: true,
        loggedIn: false,
        latencyMs: 5,
        checkedAt: new Date().toISOString(),
        errorCode: 'login_required',
        message: 'MockClosedLogin 未登录'
      }
    }
  }
  class ClosedLoginBrowser extends BrowserContextManager {
    override async openLoginWindow(): Promise<{ success: boolean; message: string; profile: { platformKey: string; userDataDir: string } }> {
      throw new Error('page.waitForTimeout: Target page, context or browser has been closed')
    }
  }
  const registry = new PlatformRegistry()
  const repository = new LeadMinerRepository(':memory:')
  registry.register(new LoggedOutAdapter(spec, new ClosedLoginBrowser()))
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new ClosedLoginBrowser())

  const result = await app.loginPlatform(spec.key)

  assert.equal(result.success, false)
  assert.equal(result.status?.errorCode, 'login_required')
  assert.match(result.message, /登录窗口已关闭或无法打开/)
  assert.doesNotMatch(result.message, /Target page|waitForTimeout/)
  assert.ok(app.listAuditLogs().some((event) => event.action === 'platform.login.failed' && event.targetId === spec.key))
  repository.close()
})

test('video adapters parse youtube and bilibili content refs', async () => {
  const app = createDefaultApplicationCore()
  const youtube = await app.parseContent('youtube', 'https://www.youtube.com/watch?v=abc123XYZ00')
  const bilibili = await app.parseContent('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/')

  assert.equal(youtube.contentId, 'abc123XYZ00')
  assert.equal(youtube.contentType, 'video')
  assert.equal(bilibili.contentId, 'BV1xx411c7mD')
})

test('video adapters reject spoofed platform domains in path or query', async () => {
  const app = createDefaultApplicationCore()

  await assert.rejects(
    () => app.parseContent('youtube', 'https://evil.test/watch?v=abc123XYZ00&next=youtube.com'),
    /链接域名不匹配/
  )
  await assert.rejects(
    () => app.parseContent('bilibili', 'https://evil.test/video/BV1xx411c7mD/?from=bilibili.com'),
    /链接域名不匹配/
  )
})

test('video adapters enrich content title from page metadata when available', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      if (url.includes('youtube.com')) return '<meta property="og:title" content="咖啡机测评 &amp; 真实体验 - YouTube">'
      return '<html><head><title>B站咖啡机购买建议</title></head></html>'
    }
  }
  const youtube = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const bilibili = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)

  const youtubeContent = await youtube.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const bilibiliContent = await bilibili.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')

  assert.equal(youtubeContent.title, '咖啡机测评 & 真实体验')
  assert.equal(bilibiliContent.title, 'B站咖啡机购买建议')
})

test('video adapters prefer structured page state titles when metadata is absent', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      if (url.includes('youtube.com')) {
        return '<script>ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc123XYZ00","title":"YouTube JSON 咖啡机 &amp; 真实体验 - YouTube"}};</script>'
      }
      return '<script>window.__INITIAL_STATE__ = {"videoData":{"bvid":"BV1xx411c7mD","title":"B站 JSON 咖啡机购买建议 &amp; 测评"}};</script>'
    }
  }
  const youtube = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const bilibili = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)

  const youtubeContent = await youtube.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const bilibiliContent = await bilibili.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')

  assert.equal(youtubeContent.title, 'YouTube JSON 咖啡机 & 真实体验')
  assert.equal(bilibiliContent.title, 'B站 JSON 咖啡机购买建议 & 测评')
})

test('video adapter reuses parsed page html for immediate comment collection', async () => {
  let pageFetches = 0
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      pageFetches += 1
      return `
        <meta property="og:title" content="缓存页面标题 - YouTube">
        <script>
          ytInitialData = {"contents":[{"commentRenderer":{
            "commentId":"cached-c1",
            "authorText":{"simpleText":"CacheUser"},
            "contentText":{"simpleText":"缓存复用后仍能解析评论"},
            "voteCount":{"simpleText":"5"}
          }}]};
        </script>
      `
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)

  const content = await adapter.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const comments: Array<{ nickname: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string })
  }

  assert.equal(content.title, '缓存页面标题')
  assert.equal(comments[0].nickname, 'CacheUser')
  assert.equal(pageFetches, 1)
})

test('search adapters parse platform content refs with host-only validation', async () => {
  const app = createDefaultApplicationCore()
  const xiaohongshu = await app.platforms.get('xiaohongshu').parseContent('https://www.xiaohongshu.com/explore/abc123')
  const reddit = await app.platforms.get('reddit').parseContent('https://www.reddit.com/r/coffee/comments/abc123/title/')
  const tiktok = await app.platforms.get('tiktok').parseContent('https://www.tiktok.com/@maker/video/987654')
  const zhihu = await app.platforms.get('zhihu').parseContent('https://www.zhihu.com/question/123/answer/456')
  const kuaishou = await app.platforms.get('kuaishou').parseContent('https://www.kuaishou.com/short-video/3xabc123')

  assert.equal(xiaohongshu.contentId, 'abc123')
  assert.equal(xiaohongshu.contentType, 'image_text')
  assert.equal(reddit.contentId, 'abc123')
  assert.equal(reddit.contentType, 'post')
  assert.equal(tiktok.contentId, '987654')
  assert.equal(tiktok.contentType, 'video')
  assert.equal(zhihu.contentId, '123-456')
  assert.equal(zhihu.contentType, 'post')
  assert.equal(kuaishou.contentId, '3xabc123')
  assert.equal(kuaishou.contentType, 'video')

  await assert.rejects(
    () => app.platforms.get('xiaohongshu').parseContent('https://evil.test/path?u=xiaohongshu.com'),
    /链接域名不匹配/
  )
})

test('search adapters enrich content refs with page metadata title when available', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml(url, platformKey) {
      assert.equal(platformKey, 'xiaohongshu')
      assert.ok(url.includes('/explore/abc123'))
      return '<html><head><meta property="og:title" content="咖啡机真实体验 &amp; 购买建议"></head></html>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, executor)

  const content = await adapter.parseContent('https://www.xiaohongshu.com/explore/abc123')

  assert.equal(content.contentId, 'abc123')
  assert.equal(content.title, '咖啡机真实体验 & 购买建议')
})

test('search adapters enrich content refs from structured page state titles', async () => {
  const xhsExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<script>window.__INITIAL_STATE__ = {"note":{"id":"abc123","title":"小红书 JSON 咖啡机体验 &amp; 避坑"}}</script>'
    }
  }
  const douyinExecutor: SearchPageExecutor = {
    async fetchHtml() {
      return '<script>window.__INITIAL_STATE__ = {"aweme_detail":{"aweme_id":"987654","desc":"抖音 JSON 咖啡机测评 &amp; 报价"}}</script>'
    }
  }
  const xiaohongshu = new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, xhsExecutor)
  const douyin = new SearchEngineAdapter({
    key: 'douyin',
    name: '抖音',
    category: 'video',
    domains: ['douyin.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`, undefined, douyinExecutor)

  const xhsContent = await xiaohongshu.parseContent('https://www.xiaohongshu.com/explore/abc123')
  const douyinContent = await douyin.parseContent('https://www.douyin.com/video/987654')

  assert.equal(xhsContent.title, '小红书 JSON 咖啡机体验 & 避坑')
  assert.equal(douyinContent.title, '抖音 JSON 咖啡机测评 & 报价')
})

test('search adapters cover structured titles for additional social platforms', async () => {
  const cases = [
    {
      key: 'tiktok',
      name: 'TikTok',
      category: 'video' as const,
      domains: ['tiktok.com'],
      url: 'https://www.tiktok.com/@maker/video/987654',
      html: '<script>window.__INITIAL_STATE__ = {"itemInfo":{"itemStruct":{"desc":"TikTok JSON 咖啡机体验 &amp; 价格"}}}</script>',
      expected: 'TikTok JSON 咖啡机体验 & 价格'
    },
    {
      key: 'instagram',
      name: 'Instagram',
      category: 'social' as const,
      domains: ['instagram.com'],
      url: 'https://www.instagram.com/p/abc123/',
      html: '<script type="application/json">{"media":{"caption":{"text":"Instagram JSON 咖啡机开箱 &amp; 咨询"}}}</script>',
      expected: 'Instagram JSON 咖啡机开箱 & 咨询'
    },
    {
      key: 'weibo',
      name: '微博',
      category: 'social' as const,
      domains: ['weibo.com'],
      url: 'https://weibo.com/123456/Nabc123',
      html: '<script>window.__INITIAL_STATE__ = {"status":{"text_raw":"微博 JSON 咖啡机购买建议 &amp; 讨论"}}</script>',
      expected: '微博 JSON 咖啡机购买建议 & 讨论'
    },
    {
      key: 'zhihu',
      name: '知乎',
      category: 'forum' as const,
      domains: ['zhihu.com'],
      url: 'https://www.zhihu.com/question/123/answer/456',
      html: '<script>window.__INITIAL_STATE__ = {"question":{"title":"知乎 JSON 咖啡机怎么选 &amp; 预算"}}</script>',
      expected: '知乎 JSON 咖啡机怎么选 & 预算'
    },
    {
      key: 'kuaishou',
      name: '快手',
      category: 'video' as const,
      domains: ['kuaishou.com'],
      url: 'https://www.kuaishou.com/short-video/3xabc123',
      html: '<script>window.__INITIAL_STATE__ = {"photo":{"caption":"快手 JSON 咖啡机测评 &amp; 报价"}}</script>',
      expected: '快手 JSON 咖啡机测评 & 报价'
    },
    {
      key: 'reddit',
      name: 'Reddit',
      category: 'forum' as const,
      domains: ['reddit.com'],
      url: 'https://www.reddit.com/r/coffee/comments/abc123/title/',
      html: '<script type="application/json">{"data":{"title":"Reddit JSON coffee machine buying advice"}}</script>',
      expected: 'Reddit JSON coffee machine buying advice'
    }
  ]

  for (const item of cases) {
    const adapter = new SearchEngineAdapter({
      key: item.key,
      name: item.name,
      category: item.category,
      domains: item.domains,
      requiresLogin: true,
      capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
      rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
    }, (keyword) => `https://${item.domains[0]}/search?q=${encodeURIComponent(keyword)}`, undefined, {
      async fetchHtml() {
        return item.html
      }
    })

    const content = await adapter.parseContent(item.url)
    assert.equal(content.title, item.expected)
  }
})

test('search adapters collect generic html comments without sample data', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return '<div data-comment-author="Alice" data-comment-text="这个咖啡机多少钱，求链接"></div>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.xiaohongshu.com/explore/abc123')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'Alice')
  assert.equal(comments[0].text, '这个咖啡机多少钱，求链接')
})

test('xiaohongshu parser extracts embedded comment data', () => {
  const content = {
    platformKey: 'xiaohongshu',
    contentId: 'abc123',
    contentType: 'image_text' as const,
    url: 'https://www.xiaohongshu.com/explore/abc123'
  }
  const html = `
    <script type="application/json">
      {"comment_list":[
        {"id":"c1","content":"这个多少钱，求链接","like_count":"1.2万","create_time":1710000000000,"user_info":{"nickname":"小红薯A"}},
        {"comment_id":"c2","commentContent":"想买，有官网吗","likeCount":8,"createTime":1710000060,"userInfo":{"nickName":"BuyerB"}}
      ]}
    </script>
  `

  const comments = parseXiaohongshuComments(content, html)

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, '小红薯A')
  assert.equal(comments[0].likes, 12000)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
  assert.equal(comments[1].text, '想买，有官网吗')
})

test('xiaohongshu adapter prefers embedded comment data over generic html fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comments":[{"id":"xhs-c1","content":"求购买链接","userInfo":{"nickname":"XhsUser"},"likeCount":3}]}</script>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.xiaohongshu.com/explore/abc123')
  const comments: Array<{ nickname: string; text: string; likes: number }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string; likes: number })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'XhsUser')
  assert.equal(comments[0].text, '求购买链接')
  assert.equal(comments[0].likes, 3)
})

test('xiaohongshu parser extracts pagination cursor hints', () => {
  const html = '<script type="application/json">{"comments":{"cursor":"cursor-2","hasMore":true}}</script>'

  assert.deepEqual(extractXiaohongshuPageCursor(html), { cursor: 'cursor-2', hasMore: true })
  assert.deepEqual(extractXiaohongshuPageCursor('not json'), { cursor: null, hasMore: false })
})

test('xiaohongshu adapter fetches one cursor page when available', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comments":[{"id":"c1","content":"第一页想买","userInfo":{"nickname":"FirstXhs"}},{"cursor":"cursor-2","hasMore":true}]}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push(url)
      assert.equal(platformKey, 'xiaohongshu')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.referer, 'https://www.xiaohongshu.com/explore/abc123?xsec_token=token-1&xsec_source=pc_feed')
      assert.equal(options?.headers?.['x-requested-with'], 'XMLHttpRequest')
      return JSON.stringify({ comments: [{ id: 'c2', content: '第二页求链接', userInfo: { nickname: 'SecondXhs' }, likeCount: 4 }] })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.xiaohongshu.com/explore/abc123?xsec_token=token-1&xsec_source=pc_feed')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requested[0].includes('/api/sns/web/v2/comment/page'))
  assert.ok(requested[0].includes('note_id=abc123'))
  assert.ok(requested[0].includes('cursor=cursor-2'))
  assert.ok(requested[0].includes('xsec_token=token-1'))
  assert.ok(requested[0].includes('xsec_source=pc_feed'))
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstXhs', 'SecondXhs'])
})

test('short video parser extracts douyin and tiktok embedded comments', () => {
  const content = {
    platformKey: 'douyin',
    contentId: '987654',
    contentType: 'video' as const,
    url: 'https://www.douyin.com/video/987654'
  }
  const html = `
    <script type="application/json">
      {"comments":[
        {"cid":"c1","text":"多少钱，怎么买","digg_count":23,"create_time":1710000000,"user":{"nickname":"DouyinUser"}},
        {"comment_id":"c2","commentText":"求购买链接","likeCount":"1.1k","createTime":1710000060000,"userInfo":{"uniqueId":"TikTokBuyer"}}
      ],"cursor":20,"hasMore":true}
    </script>
  `

  const comments = parseShortVideoComments(content, html)

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, 'DouyinUser')
  assert.equal(comments[0].likes, 23)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
  assert.equal(comments[1].nickname, 'TikTokBuyer')
  assert.equal(comments[1].likes, 1100)
  assert.deepEqual(extractShortVideoCursor(html), { cursor: '20', hasMore: true })
})

test('short video adapters prefer embedded comment data over generic html fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comment_list":[{"cid":"sv1","text":"想了解价格","user":{"nickname":"VideoUser"},"diggCount":9}]}</script>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'douyin',
    name: '抖音',
    category: 'video',
    domains: ['douyin.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.douyin.com/video/987654?msToken=token-1&X-Bogus=bogus-1&verifyFp=fp-1&webid=web-1')
  const comments: Array<{ nickname: string; text: string; likes: number }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string; likes: number })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'VideoUser')
  assert.equal(comments[0].text, '想了解价格')
  assert.equal(comments[0].likes, 9)
})

test('short video adapter fetches one cursor comment page when available', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comment_list":[{"cid":"sv1","text":"首屏想了解价格","user":{"nickname":"FirstVideo"}}],"cursor":20,"hasMore":true}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push(url)
      assert.equal(platformKey, 'douyin')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.referer, 'https://www.douyin.com/video/987654?msToken=token-1&X-Bogus=bogus-1&verifyFp=fp-1&webid=web-1')
      return JSON.stringify({ comments: [{ cid: 'sv2', text: '下一页求购买链接', user: { nickname: 'SecondVideo' }, digg_count: 4 }] })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'douyin',
    name: '抖音',
    category: 'video',
    domains: ['douyin.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.douyin.com/video/987654?msToken=token-1&X-Bogus=bogus-1&verifyFp=fp-1&webid=web-1')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requested[0].startsWith('https://www.douyin.com/aweme/v1/web/comment/list/?'))
  const requestedUrl = new URL(requested[0])
  assert.equal(requestedUrl.searchParams.get('aweme_id'), '987654')
  assert.equal(requestedUrl.searchParams.get('cursor'), '20')
  assert.equal(requestedUrl.searchParams.get('count'), '20')
  assert.equal(requestedUrl.searchParams.get('device_platform'), 'webapp')
  assert.equal(requestedUrl.searchParams.get('aid'), '6383')
  assert.equal(requestedUrl.searchParams.get('msToken'), 'token-1')
  assert.equal(requestedUrl.searchParams.get('X-Bogus'), 'bogus-1')
  assert.equal(requestedUrl.searchParams.get('verifyFp'), 'fp-1')
  assert.equal(requestedUrl.searchParams.get('webid'), 'web-1')
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstVideo', 'SecondVideo'])
})

test('tiktok adapter carries risk params into cursor comment page', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comments":[{"cid":"tt1","text":"First TikTok comment wants price","user":{"nickname":"FirstTikTok"}}],"cursor":30,"hasMore":true}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push(url)
      assert.equal(platformKey, 'tiktok')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.referer, 'https://www.tiktok.com/@maker/video/987654?msToken=tt-token&X-Bogus=tt-bogus&_signature=tt-sign&aid=1999')
      return JSON.stringify({ comments: [{ cid: 'tt2', text: 'Second TikTok comment needs link', user: { nickname: 'SecondTikTok' }, digg_count: 2 }] })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'tiktok',
    name: 'TikTok',
    category: 'video',
    domains: ['tiktok.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.tiktok.com/@maker/video/987654?msToken=tt-token&X-Bogus=tt-bogus&_signature=tt-sign&aid=1999')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requested[0].startsWith('https://www.tiktok.com/api/comment/list/?'))
  assert.ok(requested[0].includes('item_id=987654'))
  assert.ok(requested[0].includes('cursor=30'))
  assert.ok(requested[0].includes('count=20'))
  assert.ok(requested[0].includes('aid=1999'))
  assert.ok(requested[0].includes('msToken=tt-token'))
  assert.ok(requested[0].includes('X-Bogus=tt-bogus'))
  assert.ok(requested[0].includes('_signature=tt-sign'))
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstTikTok', 'SecondTikTok'])
})

test('application core classifies short video captcha pages when no comments are parsed', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<html><body>security check captcha verify</body></html>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'tiktok',
    name: 'TikTok',
    category: 'video',
    domains: ['tiktok.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('tiktok', 'https://www.tiktok.com/@maker/video/987654'),
    /风控校验/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'captcha_required')
})

test('kuaishou parser extracts embedded comments and cursor hints', () => {
  const content = {
    platformKey: 'kuaishou',
    contentId: '3xabc123',
    contentType: 'video' as const,
    url: 'https://www.kuaishou.com/short-video/3xabc123'
  }
  const html = `
    <script type="application/json">
      {"visionCommentList":{"rootComments":[
        {"commentId":"ks1","content":"这个多少钱，求链接","likedCount":"1.2w","timestamp":1710000000000,"author":{"name":"KsUser"}},
        {"comment_id":"ks2","commentContent":"想了解购买渠道","likeCount":8,"createTime":1710000060,"userInfo":{"nickname":"KsBuyer"}}
      ],"pcursor":"cursor-2","hasMore":true}}
    </script>
  `

  const comments = parseKuaishouComments(content, html)

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, 'KsUser')
  assert.equal(comments[0].likes, 12000)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
  assert.equal(comments[1].text, '想了解购买渠道')
  assert.deepEqual(extractKuaishouPageCursor(html), { cursor: 'cursor-2', hasMore: true })
})

test('kuaishou adapter fetches one cursor comment page when available', async () => {
  const requested: Array<{ url: string; body?: string; headers?: Record<string, string>; method?: string }> = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"visionCommentList":{"rootComments":[{"commentId":"ks1","content":"首屏想了解价格","author":{"name":"FirstKs"}}],"pcursor":"cursor-2","hasMore":true}}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push({ url, body: options?.body, headers: options?.headers, method: options?.method })
      assert.equal(platformKey, 'kuaishou')
      assert.equal(options?.method, 'POST')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.['content-type'], 'application/json')
      assert.equal(options?.headers?.origin, 'https://www.kuaishou.com')
      assert.equal(options?.headers?.referer, 'https://www.kuaishou.com/short-video/3xabc123')
      const body = JSON.parse(options?.body ?? '{}') as { operationName?: string; variables?: { photoId?: string; pcursor?: string } }
      assert.equal(body.operationName, 'visionCommentList')
      assert.equal(body.variables?.photoId, '3xabc123')
      assert.equal(body.variables?.pcursor, 'cursor-2')
      return JSON.stringify({ data: { visionCommentList: { rootComments: [{ commentId: 'ks2', content: '下一页求链接', author: { name: 'SecondKs' }, likedCount: 4 }], pcursor: 'no_more' } } })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'kuaishou',
    name: '快手',
    category: 'video',
    domains: ['kuaishou.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.kuaishou.com/short-video/3xabc123')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(requested.length, 1)
  assert.equal(requested[0].url, 'https://www.kuaishou.com/graphql')
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstKs', 'SecondKs'])
})

test('application core classifies kuaishou login pages when no comments are parsed', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<html><body>请登录后查看评论</body></html>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'kuaishou',
    name: '快手',
    category: 'video',
    domains: ['kuaishou.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('kuaishou', 'https://www.kuaishou.com/short-video/3xabc123'),
    /需要登录/
  )
  assert.equal(app.tasks.list()[0].errorCode, 'login_required')
})

test('instagram parser extracts embedded graphql comments', () => {
  const content = {
    platformKey: 'instagram',
    contentId: 'abc123',
    contentType: 'image_text' as const,
    url: 'https://www.instagram.com/p/abc123/'
  }
  const html = `
    <script type="application/json">
      {"edge_media_to_parent_comment":{"edges":[
        {"node":{"__typename":"GraphComment","id":"ig1","text":"How much is this? Need a link.","created_at":1710000000,"owner":{"username":"InstaBuyer"},"edge_liked_by":{"count":12}}},
        {"node":{"id":"ig2","text":"Interested in buying","createdAt":1710000060000,"user":{"username":"ShopperB"},"like_count":3}}
      ],"page_info":{"has_next_page":true,"end_cursor":"ig-cursor-2"}}}
    </script>
  `

  const comments = parseInstagramComments(content, html)

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, 'InstaBuyer')
  assert.equal(comments[0].likes, 12)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
  assert.equal(comments[1].nickname, 'ShopperB')
  assert.equal(comments[1].likes, 3)
  assert.deepEqual(extractInstagramPageCursor(html), { cursor: 'ig-cursor-2', hasMore: true })
})

test('instagram adapter prefers embedded comment data over generic html fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"edge_threaded_comments":{"edges":[{"node":{"__typename":"GraphComment","id":"ig1","text":"Can I buy this set?","owner":{"username":"InstaUser"},"edge_likes":{"count":7}}}]}}</script>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'instagram',
    name: 'Instagram',
    category: 'social',
    domains: ['instagram.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.instagram.com/p/abc123/')
  const comments: Array<{ nickname: string; text: string; likes: number }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string; likes: number })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'InstaUser')
  assert.equal(comments[0].text, 'Can I buy this set?')
  assert.equal(comments[0].likes, 7)
})

test('instagram adapter fetches one end cursor comment page when available', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"edge_media_to_parent_comment":{"edges":[{"node":{"__typename":"GraphComment","id":"ig1","text":"First page wants details","owner":{"username":"FirstInsta"}}}],"page_info":{"has_next_page":true,"end_cursor":"ig-cursor-2"}}}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push(url)
      assert.equal(platformKey, 'instagram')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.referer, 'https://www.instagram.com/p/abc123/')
      const parsed = new URL(url)
      assert.equal(parsed.pathname, '/graphql/query/')
      assert.equal(parsed.searchParams.get('query_hash'), '97b41c52301f77ce508f55e66d17620e')
      assert.deepEqual(JSON.parse(parsed.searchParams.get('variables') ?? '{}'), {
        shortcode: 'abc123',
        first: 24,
        after: 'ig-cursor-2'
      })
      return JSON.stringify({ edge_media_to_parent_comment: { edges: [{ node: { __typename: 'GraphComment', id: 'ig2', text: 'Second page needs a link', owner: { username: 'SecondInsta' }, edge_likes: { count: 5 } } }] } })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'instagram',
    name: 'Instagram',
    category: 'social',
    domains: ['instagram.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.instagram.com/p/abc123/')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(requested.length, 1)
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstInsta', 'SecondInsta'])
})

test('application core classifies instagram login pages when no comments are parsed', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<html><body>Please log in to view comments</body></html>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'instagram',
    name: 'Instagram',
    category: 'social',
    domains: ['instagram.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('instagram', 'https://www.instagram.com/p/abc123/'),
    /需要登录/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'login_required')
})

test('weibo parser extracts embedded comment data and cursor hints', () => {
  const content = {
    platformKey: 'weibo',
    contentId: 'Nabc123',
    contentType: 'post' as const,
    url: 'https://weibo.com/123456/Nabc123'
  }
  const html = `
    <script type="application/json">
      {"data":[
        {"id":"wb1","text_raw":"想买同款，求链接","created_at":1710000000,"like_counts":18,"user":{"screen_name":"微博买家A"}},
        {"idstr":"wb2","text":"价格多少，哪里买","createdAt":1710000060000,"likes":"2.3万","user":{"screenName":"微博买家B"}}
      ],"max_id":12345}
    </script>
  `

  const comments = parseWeiboComments(content, html)

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, '微博买家A')
  assert.equal(comments[0].likes, 18)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
  assert.equal(comments[1].nickname, '微博买家B')
  assert.equal(comments[1].likes, 23000)
  assert.deepEqual(extractWeiboPageCursor(html), { cursor: '12345', hasMore: true })
})

test('weibo adapter prefers embedded comment data over generic html fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comments":[{"id":"wb1","text_raw":"想了解价格","user":{"screen_name":"WeiboUser"},"like_counts":6}]}</script>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'weibo',
    name: '微博',
    category: 'social',
    domains: ['weibo.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://weibo.com/123456/Nabc123')
  const comments: Array<{ nickname: string; text: string; likes: number }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string; likes: number })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'WeiboUser')
  assert.equal(comments[0].text, '想了解价格')
  assert.equal(comments[0].likes, 6)
})

test('weibo adapter fetches one max_id comment page when available', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"data":[{"id":"wb1","text_raw":"首屏想买同款","user":{"screen_name":"FirstWeibo"}}],"max_id":12345}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push(url)
      assert.equal(platformKey, 'weibo')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.referer, 'https://weibo.com/123456/Nabc123')
      return JSON.stringify({ data: [{ id: 'wb2', text_raw: '下一页求购买链接', user: { screen_name: 'SecondWeibo' }, like_counts: 4 }] })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'weibo',
    name: '微博',
    category: 'social',
    domains: ['weibo.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://weibo.com/123456/Nabc123')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requested[0].startsWith('https://weibo.com/ajax/statuses/buildComments?'))
  assert.ok(requested[0].includes('id=Nabc123'))
  assert.ok(requested[0].includes('max_id=12345'))
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstWeibo', 'SecondWeibo'])
})

test('application core classifies weibo rate limited pages when no comments are parsed', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<html><body>操作频繁，请稍后再试</body></html>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'weibo',
    name: '微博',
    category: 'social',
    domains: ['weibo.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('weibo', 'https://weibo.com/123456/Nabc123'),
    /请求过于频繁/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'rate_limited')
})

test('zhihu parser extracts embedded comment data and paging hints', () => {
  const content = {
    platformKey: 'zhihu',
    contentId: '123-456',
    contentType: 'post' as const,
    url: 'https://www.zhihu.com/question/123/answer/456'
  }
  const html = `
    <script type="application/json">
      {"data":[
        {"type":"comment","id":"zh1","content":"这个方案多少钱，能给链接吗","created_time":1710000000,"vote_count":11,"author":{"member":{"name":"知乎用户A"}}},
        {"comment_id":"zh2","content":"想了解购买渠道","createdTime":1710000060000,"likeCount":"1.2k","author":{"name":"知乎用户B"}}
      ],"paging":{"is_end":false,"next":"https://www.zhihu.com/api/v4/comment_v5/answers/456/root_comment?offset=20"}}
    </script>
  `

  const comments = parseZhihuComments(content, html)

  assert.equal(comments.length, 2)
  assert.equal(comments[0].nickname, '知乎用户A')
  assert.equal(comments[0].likes, 11)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
  assert.equal(comments[1].nickname, '知乎用户B')
  assert.equal(comments[1].likes, 1200)
  assert.deepEqual(extractZhihuPageCursor(html), {
    cursor: 'https://www.zhihu.com/api/v4/comment_v5/answers/456/root_comment?offset=20',
    hasMore: true
  })
})

test('zhihu adapter prefers embedded comment data over generic html fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"data":[{"type":"comment","id":"zh1","content":"求详细参数和价格","author":{"name":"ZhihuUser"},"vote_count":5}]}</script>'
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'zhihu',
    name: '知乎',
    category: 'forum',
    domains: ['zhihu.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.zhihu.com/question/123/answer/456')
  const comments: Array<{ nickname: string; text: string; likes: number }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string; likes: number })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'ZhihuUser')
  assert.equal(comments[0].text, '求详细参数和价格')
  assert.equal(comments[0].likes, 5)
})

test('zhihu adapter fetches one paging.next comment page when available', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"data":[{"type":"comment","id":"zh1","content":"首屏想了解价格","author":{"name":"FirstZhihu"}}],"paging":{"is_end":false,"next":"/api/v4/comment_v5/answers/456/root_comment?offset=20"}}</script>'
    },
    async fetchText(url, platformKey, options) {
      requested.push(url)
      assert.equal(platformKey, 'zhihu')
      assert.equal(options?.headers?.accept, 'application/json')
      assert.equal(options?.headers?.referer, 'https://www.zhihu.com/question/123/answer/456')
      return JSON.stringify({ data: [{ type: 'comment', id: 'zh2', content: '下一页求购买渠道', author: { name: 'SecondZhihu' }, voteCount: 4 }] })
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'zhihu',
    name: '知乎',
    category: 'forum',
    domains: ['zhihu.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.zhihu.com/question/123/answer/456')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(requested[0], 'https://www.zhihu.com/api/v4/comment_v5/answers/456/root_comment?offset=20')
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstZhihu', 'SecondZhihu'])
})

test('application core classifies zhihu login pages when no comments are parsed', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      return '<html><body>请登录后继续查看评论</body></html>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'zhihu',
    name: '知乎',
    category: 'forum',
    domains: ['zhihu.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('zhihu', 'https://www.zhihu.com/question/123/answer/456'),
    /需要登录/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'login_required')
})

test('application core classifies xiaohongshu captcha pages when no comments are parsed', async () => {
  let renderedFetches = 0
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchRenderedHtml() {
      renderedFetches += 1
      return '<html><body>请完成滑块验证码验证后继续访问</body></html>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 },
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web'
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, executor))
  const repository = new LeadMinerRepository(':memory:')
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    repository,
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('xiaohongshu', 'https://www.xiaohongshu.com/explore/abc123'),
    /风控校验/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'captcha_required')
  assert.ok(app.listAuditLogs().some((event) => event.action === 'collect.failed'))
  assert.ok(app.listAuditLogs().some((event) => event.action === 'platform.protection.paused'))

  const fetchesAfterPause = renderedFetches
  await assert.rejects(
    () => app.collectComments('xiaohongshu', 'https://www.xiaohongshu.com/explore/abc123'),
    /账号安全保护暂停真实评论采集/
  )
  assert.equal(renderedFetches, fetchesAfterPause)

  const reloadedApp = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(repository),
    repository,
    new BrowserContextManager()
  )
  const [status] = await reloadedApp.checkPlatformStatuses()
  assert.equal(status.errorCode, 'rate_limited')
  assert.match(status.message, /账号保护暂停真实采集/)
  await assert.rejects(
    () => reloadedApp.searchAcrossPlatforms('咖啡机', ['xiaohongshu']),
    /账号安全保护暂停真实搜索/
  )
  await assert.rejects(
    () => reloadedApp.parseContent('xiaohongshu', 'https://www.xiaohongshu.com/explore/abc123'),
    /账号安全保护暂停真实内容解析/
  )
})

test('application account protection is derived from platform manifest risk metadata', async () => {
  class ManifestRiskAdapter extends MetadataOnlyPlatformAdapter {
    override async parseContent(url: string) {
      return {
        platformKey: this.spec.key,
        url,
        contentId: 'post-1',
        contentType: 'post' as const
      }
    }

    override async *collectComments() {
      yield { type: 'failed' as const, payload: { message: '验证码校验失败' } }
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new ManifestRiskAdapter({
    key: 'new-risk-platform',
    name: 'New Risk Platform',
    category: 'social',
    domains: ['risk.example'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 },
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web'
  }))
  const repository = new LeadMinerRepository(':memory:')
  const app = new ApplicationCore(registry, new AIService(), new CompliancePolicy(), new TaskOrchestrator(repository), repository, new BrowserContextManager())

  await assert.rejects(
    () => app.collectComments('new-risk-platform', 'https://risk.example/post/1'),
    /验证码校验失败/
  )

  assert.ok(app.listAuditLogs().some((event) => event.action === 'platform.protection.paused'))
  await assert.rejects(
    () => app.searchAcrossPlatforms('咖啡机', ['new-risk-platform']),
    /账号安全保护暂停真实搜索/
  )
})

test('reddit parser extracts public json comments', () => {
  const content = {
    platformKey: 'reddit',
    contentId: 'abc123',
    contentType: 'post' as const,
    url: 'https://www.reddit.com/r/coffee/comments/abc123/title/'
  }
  const payload = JSON.stringify([
    { kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'Post title' } }] } },
    {
      kind: 'Listing',
      data: {
        children: [{
          kind: 't1',
          data: {
            id: 'c1',
            author: 'CoffeeBuyer',
            body: 'How much is this machine? Need a link.',
            score: 17,
            created_utc: 1710000000
          }
        }]
      }
    }
  ])

  const comments = parseRedditComments(content, payload)

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'CoffeeBuyer')
  assert.equal(comments[0].likes, 17)
  assert.equal(comments[0].publishedAt, '2024-03-09T16:00:00.000Z')
})

test('reddit parser extracts more children ids for follow-up pagination', () => {
  const payload = JSON.stringify([{ data: { children: [{ kind: 'more', data: { children: ['c2', 'c3', 'c2'] } }] } }])

  assert.deepEqual(extractRedditMoreChildren(payload), ['c2', 'c3'])
  assert.deepEqual(extractRedditMoreChildren('not json'), [])
})

test('reddit adapter prefers json comments before html fallback', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText(url, platformKey) {
      requested.push(url)
      assert.equal(platformKey, 'reddit')
      return JSON.stringify([{}, { data: { children: [{ kind: 't1', data: { id: 'r1', author: 'RedditUser', body: 'Want to buy this, any coupon?', score: 5 } }] } }])
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.reddit.com/r/coffee/comments/abc123/title/')
  const comments: Array<{ nickname: string; text: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requested[0].includes('/comments/abc123/title.json'))
  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'RedditUser')
  assert.equal(comments[0].text, 'Want to buy this, any coupon?')
})

test('reddit adapter expands morechildren comments once', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText(url) {
      requested.push(url)
      if (url.includes('/api/morechildren.json')) {
        return JSON.stringify({ json: { data: { things: [{ kind: 't1', data: { id: 'c2', author: 'MoreUser', body: 'Second page wants details', score: 3 } }] } } })
      }
      return JSON.stringify([
        {},
        { data: { children: [
          { kind: 't1', data: { id: 'c1', author: 'FirstUser', body: 'First comment wants a link', score: 8 } },
          { kind: 'more', data: { children: ['c2'] } }
        ] } }
      ])
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.reddit.com/r/coffee/comments/abc123/title/')
  const comments: Array<{ nickname: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string })
  }

  assert.ok(requested.some((url) => url.includes('/api/morechildren.json') && url.includes('children=c2')))
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstUser', 'MoreUser'])
})

test('reddit adapter reports morechildren recovery while keeping first page comments', async () => {
  const requested: string[] = []
  const phases: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText(url) {
      requested.push(url)
      if (url.includes('/api/morechildren.json')) {
        throw Object.assign(new Error('Service Unavailable'), { status: 503 })
      }
      return JSON.stringify([
        {},
        { data: { children: [
          { kind: 't1', data: { id: 'c1', author: 'FirstUser', body: 'First page still useful', score: 3 } },
          { kind: 'more', data: { children: ['c2'] } }
        ] } }
      ])
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.reddit.com/r/coffee/comments/abc123/title/')
  const comments: Array<{ nickname: string }> = []

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'progress') phases.push((event.payload as { phase: string }).phase)
    if (event.type === 'comment') comments.push(event.payload as { nickname: string })
  }

  assert.ok(requested.some((url) => url.includes('/api/morechildren.json')))
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstUser'])
  assert.ok(phases.some((phase) => phase.includes('后续评论展开失败') && phase.includes('已保留首屏')))
})

test('reddit adapter carries requested comment sort into json endpoints', async () => {
  const requested: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText(url) {
      requested.push(url)
      if (url.includes('/api/morechildren.json')) {
        return JSON.stringify({ json: { data: { things: [{ kind: 't1', data: { id: 'c2', author: 'SortedMore', body: 'More sorted comment', score: 2 } }] } } })
      }
      return JSON.stringify([{ data: { children: [{ kind: 'more', data: { children: ['c2'] } }] } }])
    }
  }
  const adapter = new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor)
  const content = await adapter.parseContent('https://www.reddit.com/r/coffee/comments/abc123/title/?sort=top')

  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'failed') assert.fail('reddit sorted collection should not fail')
  }

  assert.ok(requested[0].includes('sort=top'))
  assert.ok(requested[1].includes('sort=top'))
})

test('application core classifies reddit rate limits when fallback has no comments', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText() {
      throw new Error('429 Too Many Requests')
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('reddit', 'https://www.reddit.com/r/coffee/comments/abc123/title/'),
    /请求过于频繁/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'rate_limited')
  assert.equal(app.listAuditLogs()[0].action, 'collect.failed')
})

test('application core classifies reddit permission failures from status-like errors', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText() {
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('reddit', 'https://www.reddit.com/r/private/comments/abc123/title/'),
    /权限受限/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'permission_denied')
})

test('application core classifies reddit deleted posts from json 404', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText() {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('reddit', 'https://www.reddit.com/r/coffee/comments/missing/title/'),
    /帖子不存在/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'content_not_found')
})

test('application core classifies reddit network failures from json api', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return ''
    },
    async fetchText() {
      throw new Error('fetch failed: network timeout')
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`, undefined, executor))
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(),
    new LeadMinerRepository(':memory:'),
    new BrowserContextManager()
  )

  await assert.rejects(
    () => app.collectComments('reddit', 'https://www.reddit.com/r/coffee/comments/abc123/title/'),
    /网络连接异常/
  )

  assert.equal(app.tasks.list()[0].errorCode, 'network_error')
})

test('application core collects comments through adapter event stream and persists them', async () => {
  const app = createDefaultApplicationCore()
  const comments = await app.collectComments('youtube', 'https://www.youtube.com/watch?v=abc123XYZ00')

  assert.equal(comments.length, 2)
  assert.equal(app.listComments('abc123XYZ00').length, 2)
  assert.equal(app.listLeads().length, 2)
  assert.equal(app.tasks.list()[0].status, 'completed')
})

test('application core keeps collected comments when per-comment AI analysis fails', async () => {
  const app = createDefaultApplicationCore()
  app.analyzeAndSaveComment = async () => {
    throw new Error('analysis failed')
  }

  const comments = await app.collectComments('youtube', 'https://www.youtube.com/watch?v=abc123XYZ00')

  assert.equal(comments.length, 2)
  assert.equal(app.listComments('abc123XYZ00').length, 2)
  assert.equal(app.listLeads().length, 0)
  assert.equal(app.tasks.list()[0].status, 'completed')
  assert.ok(app.listAuditLogs().some((event) => event.action === 'ai.analysis.comment_failed'))
})

test('application core coordinates adapter comments, persistence, AI leads and export fields', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return '<meta property="og:title" content="小红书咖啡机体验">'
    },
    async fetchRenderedHtml() {
      return '<script type="application/json">{"comments":[{"id":"xhs-e2e-1","content":"这个多少钱，求购买链接","userInfo":{"nickname":"E2EUser"},"likeCount":6}]}</script>'
    }
  }
  const registry = new PlatformRegistry()
  registry.register(new SearchEngineAdapter({
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`, undefined, executor))
  const repository = new LeadMinerRepository(':memory:')
  const app = new ApplicationCore(
    registry,
    new AIService(),
    new CompliancePolicy(),
    new TaskOrchestrator(repository),
    repository,
    new BrowserContextManager()
  )

  const comments = await app.collectComments('xiaohongshu', 'https://www.xiaohongshu.com/explore/abc123')
  const leads = app.listLeads()
  const exported = app.exportLeads({ fields: ['platformKey', 'nickname', 'score', 'status'] })

  assert.equal(comments.length, 1)
  assert.equal(repository.listContents()[0].title, '小红书咖啡机体验')
  assert.equal(app.listComments('abc123')[0].nickname, 'E2EUser')
  assert.equal(leads.length, 1)
  assert.equal(leads[0].commentId, comments[0].id)
  assert.equal(app.tasks.list().find((task) => task.type === 'collect_comments')?.status, 'completed')
  assert.deepEqual(exported.fields, ['platformKey', 'nickname', 'score', 'status'])
  assert.ok(exported.content.includes('xiaohongshu,E2EUser'))
  assert.ok(app.listAuditLogs().some((event) => event.action === 'lead.export'))
})

test('application core classifies collect risk control failures in tasks and audit logs', async () => {
  const app = createDefaultApplicationCore()
  const originalCollect = app.platforms.get('bilibili').collectComments.bind(app.platforms.get('bilibili'))
  app.platforms.get('bilibili').collectComments = async function* () {
    yield { type: 'failed', payload: { message: 'B站接口错误 -352: 风控校验失败。建议稍后重试，或先完成登录、降低采集频率。' } }
  }

  await assert.rejects(
    () => app.collectComments('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/'),
    /风控校验失败/
  )

  assert.equal(app.tasks.list()[0].status, 'failed')
  assert.equal(app.tasks.list()[0].errorCode, 'captcha_required')
  assert.equal(app.listAuditLogs()[0].action, 'collect.failed')
  app.platforms.get('bilibili').collectComments = originalCollect
})

test('application core classifies bilibili login and rate limit failures by api code', async () => {
  const app = createDefaultApplicationCore()
  app.platforms.get('bilibili').collectComments = async function* () {
    yield { type: 'failed', payload: { message: 'B站接口错误 -101: 账号未登录。建议先登录 B站账号，并确认登录状态可访问该视频后再重试。' } }
  }
  await assert.rejects(
    () => app.collectComments('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/'),
    /账号未登录/
  )
  assert.equal(app.tasks.list()[0].errorCode, 'login_required')

  app.platforms.get('bilibili').collectComments = async function* () {
    yield { type: 'failed', payload: { message: 'B站接口错误 -509: 请求过于频繁。系统会自动重试；如仍失败，建议降低采集频率后再试。' } }
  }
  await assert.rejects(
    () => app.collectComments('bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD/'),
    /请求过于频繁/
  )
  assert.equal(app.tasks.list().find((task) => task.errorMessage?.includes('请求过于频繁'))?.errorCode, 'rate_limited')
})

test('application core classifies unsupported comment-disabled failures', async () => {
  const app = createDefaultApplicationCore()
  app.platforms.get('youtube').collectComments = async function* () {
    yield { type: 'failed', payload: { message: 'YouTube 评论已关闭，无法采集该视频评论。' } }
  }

  await assert.rejects(
    () => app.collectComments('youtube', 'https://www.youtube.com/watch?v=abc123XYZ00'),
    /评论已关闭/
  )

  assert.equal(app.tasks.list()[0].status, 'failed')
  assert.equal(app.tasks.list()[0].errorCode, 'unsupported')
})

test('application core prioritizes comment-disabled over login hints', async () => {
  const app = createDefaultApplicationCore()
  app.platforms.get('youtube').collectComments = async function* () {
    yield { type: 'failed', payload: { message: 'YouTube comments disabled or login required, 无法采集该视频评论。' } }
  }

  await assert.rejects(
    () => app.collectComments('youtube', 'https://www.youtube.com/watch?v=abc123XYZ00'),
    /comments disabled/
  )

  assert.equal(app.tasks.list()[0].status, 'failed')
  assert.equal(app.tasks.list()[0].errorCode, 'unsupported')
})

test('comment parsers extract youtube and bilibili comment payloads', () => {
  const content = {
    platformKey: 'youtube',
    contentId: 'abc123',
    contentType: 'video' as const,
    url: 'https://www.youtube.com/watch?v=abc123'
  }
  const youtubeHtml = `
    <script>
      ytInitialData = {"contents":[{"commentRenderer":{
        "commentId":"c1",
        "authorText":{"simpleText":"Alice"},
        "contentText":{"simpleText":"多少钱，求链接"},
        "voteCount":{"simpleText":"9"}
      }}]};
    </script>
  `
  const biliJson = JSON.stringify({
    data: {
      replies: [{
        rpid: 100,
        member: { uname: 'Bob' },
        content: { message: '想买但不知道怎么买' },
        like: 7,
        ctime: 1710000000
      }]
    }
  })

  assert.equal(parseYoutubeComments(content, youtubeHtml)[0].nickname, 'Alice')
  assert.equal(parseBilibiliComments({ ...content, platformKey: 'bilibili' }, biliJson)[0].text, '想买但不知道怎么买')
})

test('comment parsers extract youtube run text and bilibili aid metadata', () => {
  const content = {
    platformKey: 'youtube',
    contentId: 'abc123',
    contentType: 'video' as const,
    url: 'https://www.youtube.com/watch?v=abc123'
  }
  const youtubeHtml = `
    <script>
      ytInitialData = {"contents":[{"commentRenderer":{
        "commentId":"c-runs",
        "authorText":{"runs":[{"text":"Alice"},{"text":" Chen"}]},
        "contentText":{"runs":[{"text":"想买，"},{"text":"求报价"}]},
        "voteCount":{"simpleText":"1.2K"}
      }}]};
    </script>
  `
  const bilibiliHtml = `
    <script>
      window.__INITIAL_STATE__ = {"aid":987654321,"videoData":{"bvid":"BV1xx411c7mD"}};
    </script>
  `

  const comments = parseYoutubeComments(content, youtubeHtml)

  assert.equal(comments[0].nickname, 'Alice Chen')
  assert.equal(comments[0].text, '想买，求报价')
  assert.equal(comments[0].likes, 1200)
  assert.equal(extractBilibiliAid(bilibiliHtml), '987654321')
})

test('comment parser extracts modern youtube comment view models', () => {
  const content = {
    platformKey: 'youtube',
    contentId: 'abc123',
    contentType: 'video' as const,
    url: 'https://www.youtube.com/watch?v=abc123'
  }
  const youtubeHtml = `
    <script>
      ytInitialData = {"contents":[
        {"commentViewModel":{
          "commentKey":"vm-1",
          "author":{"displayName":"ViewUser"},
          "content":{"content":"新版页面评论，想了解价格"},
          "toolbar":{"likeCount":"2.5K"}
        }},
        {"commentEntityPayload":{
          "id":"entity-1",
          "properties":{
            "author":"EntityUser",
            "content":{"runs":[{"text":"登录态可见评论，求链接"}]},
            "likeCount":"3"
          }
        }}
      ]};
    </script>
  `

  const comments = parseYoutubeComments(content, youtubeHtml)

  assert.deepEqual(comments.map((comment) => comment.nickname), ['ViewUser', 'EntityUser'])
  assert.deepEqual(comments.map((comment) => comment.text), ['新版页面评论，想了解价格', '登录态可见评论，求链接'])
  assert.equal(comments[0].likes, 2500)
  assert.equal(comments[1].likes, 3)
})

test('comment parser extracts nested youtube view model fields from logged-in pages', () => {
  const content = {
    platformKey: 'youtube',
    contentId: 'abc123',
    contentType: 'video' as const,
    url: 'https://www.youtube.com/watch?v=abc123'
  }
  const youtubeHtml = `
    <script>
      ytInitialData = {"frameworkUpdates":{"entityBatchUpdate":{"mutations":[
        {"payload":{"commentViewModel":{
          "commentKey":"vm-nested-1",
          "properties":{
            "authorDisplayName":{"simpleText":"NestedUser"},
            "content":{"content":"登录态新版嵌套评论，想了解购买渠道"}
          },
          "toolbar":{"voteCountContent":{"accessibility":{"label":"1.1K likes"}}}
        }}},
        {"payload":{"commentEntityPayload":{
          "key":"entity-nested-1",
          "author":{"displayNameText":{"runs":[{"text":"EntityNested"}]}},
          "attributedDescription":{"content":"实体嵌套评论，求报价"},
          "toolbar":{"likeButtonViewModel":{"accessibilityText":"42 likes"}}
        }}}
      ]}}};
    </script>
  `

  const comments = parseYoutubeComments(content, youtubeHtml)

  assert.deepEqual(comments.map((comment) => comment.nickname), ['NestedUser', 'EntityNested'])
  assert.deepEqual(comments.map((comment) => comment.text), ['登录态新版嵌套评论，想了解购买渠道', '实体嵌套评论，求报价'])
  assert.equal(comments[0].likes, 1100)
  assert.equal(comments[1].likes, 42)
})

test('comment parser bounds oversized and deeply nested platform json', () => {
  const content = {
    platformKey: 'youtube',
    contentId: 'abc123',
    contentType: 'video' as const,
    url: 'https://www.youtube.com/watch?v=abc123'
  }
  let nested: Record<string, unknown> = { commentRenderer: { commentId: 'too-deep', authorText: { simpleText: 'Deep' }, contentText: { simpleText: '不应解析到过深评论' } } }
  for (let index = 0; index < 140; index += 1) nested = { child: nested }
  const deepHtml = `<script>ytInitialData = ${JSON.stringify(nested)};</script>`
  const oversizedHtml = `<script type="application/json">${JSON.stringify({ pad: 'x'.repeat(1_600_000) })}</script>`

  assert.doesNotThrow(() => parseYoutubeComments(content, deepHtml))
  assert.deepEqual(parseYoutubeComments(content, deepHtml), [])
  assert.deepEqual(parseXiaohongshuComments({
    platformKey: 'xiaohongshu',
    contentId: 'xhs1',
    contentType: 'image_text' as const,
    url: 'https://www.xiaohongshu.com/explore/xhs1'
  }, oversizedHtml), [])
})

test('bilibili parser extracts wbi keys and signs reply api urls', () => {
  const html = `
    <script>
      window.__INITIAL_STATE__ = {"wbi_img":{
        "img_url":"https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz123456.png",
        "sub_url":"https://i0.hdslb.com/bfs/wbi/123456abcdefghijklmnopqrstuvwxyz.jpg"
      }};
    </script>
  `
  const keys = extractBilibiliWbiKeys(html)

  assert.deepEqual(keys, {
    imgKey: 'abcdefghijklmnopqrstuvwxyz123456',
    subKey: '123456abcdefghijklmnopqrstuvwxyz'
  })
  const signed = signBilibiliWbiParams({ oid: '123', type: '1', mode: '3' }, keys, 1710000000)
  const url = buildBilibiliReplyUrl('123', '', keys)

  assert.equal(signed.wts, '1710000000')
  assert.match(signed.w_rid, /^[a-f0-9]{32}$/)
  assert.ok(url.includes('w_rid='))
  assert.ok(url.includes('wts='))
  assert.ok(url.includes('web_location=1315875'))
})

test('bilibili retry delay adapts to rate limits and server errors', () => {
  assert.equal(calculateBilibiliRetryDelayMs(100, 0), 100)
  assert.equal(calculateBilibiliRetryDelayMs(100, 1), 200)
  assert.equal(calculateBilibiliRetryDelayMs(0, 0, -509), 0)
  assert.equal(calculateBilibiliRetryDelayMs(100, 0, -509), 3000)
  assert.equal(calculateBilibiliRetryDelayMs(2000, 1, 429), 12000)
  assert.equal(calculateBilibiliRetryDelayMs(100, 0, 500), 1500)
})

test('comment parser extracts youtube continuation request metadata', () => {
  const html = `
    <script>
      ytInitialData = {"contents":[
        {"continuationEndpoint":{"continuationCommand":{"token":"CONT_TOKEN_1"}}},
        {"nextContinuationData":{"continuation":"CONT_TOKEN_2"}},
        {"reloadContinuationData":{"continuation":"CONT_TOKEN_3"}}
      ]};
    </script>
    <script>
      ytcfg.set({"INNERTUBE_API_KEY":"AIza-test","INNERTUBE_CLIENT_NAME":"1","INNERTUBE_CLIENT_VERSION":"2.20260519.01.00","VISITOR_DATA":"visitor-1"});
    </script>
  `

  const requests = extractYoutubeContinuationRequests(html)

  assert.equal(requests.length, 3)
  assert.equal(requests[0].token, 'CONT_TOKEN_1')
  assert.equal(requests[1].token, 'CONT_TOKEN_2')
  assert.equal(requests[2].token, 'CONT_TOKEN_3')
  assert.equal(requests[0].apiKey, 'AIza-test')
  assert.equal(requests[0].clientVersion, '2.20260519.01.00')
  assert.equal(requests[0].visitorData, 'visitor-1')
})

test('comment parser extracts bilibili reply pagination offset', () => {
  const firstPage = JSON.stringify({
    data: {
      pagination_reply: {
        next_offset: '{"type":3,"direction":1,"data":{"cursor":2}}'
      }
    }
  })
  const lastPage = JSON.stringify({
    data: {
      cursor: {
        is_end: true
      }
    }
  })

  assert.equal(extractBilibiliNextOffset(firstPage), '{"type":3,"direction":1,"data":{"cursor":2}}')
  assert.equal(extractBilibiliNextOffset(lastPage), null)
  assert.equal(extractBilibiliNextOffset('not json'), null)
})

test('comment parser extracts bilibili roots that have child replies', () => {
  const payload = JSON.stringify({
    data: {
      replies: [
        { rpid: 1001, rcount: 2, content: { message: '主评论' }, member: { uname: 'A' } },
        { rpid: 1002, rcount: 0, content: { message: '无回复' }, member: { uname: 'B' } },
        { rpid: 1003, reply_count: 1, content: { message: '有回复' }, member: { uname: 'C' } }
      ]
    }
  })

  assert.deepEqual(extractBilibiliReplyRoots(payload), ['1001', '1003'])
})

test('comment parser surfaces bilibili api error messages', () => {
  assert.equal(extractBilibiliApiError(JSON.stringify({ code: -352, message: '风控校验失败' })), 'B站接口错误 -352: 风控校验失败。建议完成登录/验证，降低采集频率，稍后再重试。')
  assert.equal(extractBilibiliApiErrorInfo(JSON.stringify({ code: -352, message: '风控校验失败' }))?.retryable, false)
  assert.equal(extractBilibiliApiErrorInfo(JSON.stringify({ code: -509, message: '请求过于频繁' }))?.retryable, true)
  assert.match(extractBilibiliApiError(JSON.stringify({ code: -101, message: '账号未登录' })) ?? '', /先登录 B站账号/)
  assert.match(extractBilibiliApiError(JSON.stringify({ code: -412, message: '请求被拦截' })) ?? '', /完成登录\/验证/)
  assert.match(extractBilibiliApiError(JSON.stringify({ code: -403, message: '权限不足' })) ?? '', /账号权限/)
  assert.equal(extractBilibiliApiError(JSON.stringify({ code: 0, message: '0' })), null)
  assert.equal(extractBilibiliApiError('not json'), null)
})

test('video adapter uses parsed comments when executor returns comment payloads', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return `
        <script>
          ytInitialData = {"contents":[{"commentRenderer":{
            "commentId":"c2",
            "authorText":{"simpleText":"Carol"},
            "contentText":{"simpleText":"有优惠吗"},
            "voteCount":{"simpleText":"3"}
          }}]};
        </script>
      `
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const comments: Array<{ nickname: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string })
  }

  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'Carol')
})

test('youtube adapter prefers rendered scrolling html when executor supports it', async () => {
  let renderedCalls = 0
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      throw new Error('plain fetch should not be used')
    },
    async fetchRenderedHtml(_url, _platformKey, options) {
      renderedCalls += 1
      assert.equal(options?.scrollSteps, 8)
      assert.equal(options?.commentSort, 'newest')
      assert.ok(options?.expandText?.includes('Show more'))
      return `
        <script>
          ytInitialData = {"contents":[{"commentRenderer":{
            "commentId":"c-rendered",
            "authorText":{"simpleText":"RenderedUser"},
            "contentText":{"simpleText":"滚动后看到，求链接"},
            "voteCount":{"simpleText":"4"}
          }}]};
        </script>
      `
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const comments: Array<{ nickname: string; text: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(renderedCalls, 1)
  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'RenderedUser')
})

test('youtube adapter reports blocked comment pages instead of sample fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return '<html><body>Sign in to confirm you are not a bot captcha verify</body></html>'
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const events = []
  for await (const event of adapter.collectComments(content)) events.push(event)

  assert.equal(events.some((event) => event.type === 'comment'), false)
  assert.equal(events.at(-1)?.type, 'failed')
  assert.match(String((events.at(-1)?.payload as { message?: string }).message), /验证码|风控|captcha/)
})

test('youtube adapter fetches continuation pages when metadata is available', async () => {
  const requested: Array<{ url: string; body?: string; headers?: Record<string, string> }> = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return `
        <script>
          ytInitialData = {"contents":[
            {"commentRenderer":{
              "commentId":"c-page-1",
              "authorText":{"simpleText":"FirstUser"},
              "contentText":{"simpleText":"第一页想买"},
              "voteCount":{"simpleText":"1"}
            }},
            {"continuationEndpoint":{"continuationCommand":{"token":"CONT_TOKEN_1"}}}
          ]};
        </script>
        <script>
          ytcfg.set({"INNERTUBE_API_KEY":"AIza-test","INNERTUBE_CLIENT_NAME":"1","INNERTUBE_CLIENT_VERSION":"2.20260519.01.00","VISITOR_DATA":"visitor-e2e"});
        </script>
      `
    },
    async fetchText(url, _platformKey, options) {
      requested.push({ url, body: options?.body, headers: options?.headers })
      const body = JSON.parse(options?.body ?? '{}') as {
        continuation?: string
        context?: { client?: { visitorData?: string }; request?: { useSsl?: boolean } }
      }
      assert.equal(body.continuation, 'CONT_TOKEN_1')
      assert.equal(body.context?.client?.visitorData, 'visitor-e2e')
      assert.equal(body.context?.request?.useSsl, true)
      assert.equal(options?.headers?.['x-goog-visitor-id'], 'visitor-e2e')
      assert.equal(options?.headers?.origin, 'https://www.youtube.com')
      assert.equal(options?.headers?.referer, 'https://www.youtube.com/watch?v=abc123XYZ00')
      return JSON.stringify({
        onResponseReceivedEndpoints: [{
          appendContinuationItemsAction: {
            continuationItems: [{
              commentRenderer: {
                commentId: 'c-page-2',
                authorText: { simpleText: 'SecondUser' },
                contentText: { simpleText: '第二页求链接' },
                voteCount: { simpleText: '2' }
              }
            }]
          }
        }]
      })
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const comments: Array<{ nickname: string; text: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(requested.length, 1)
  assert.ok(requested[0].url.includes('/youtubei/v1/next'))
  assert.equal(requested[0].headers?.['x-youtube-client-version'], '2.20260519.01.00')
  assert.deepEqual(comments.map((comment) => comment.nickname), ['FirstUser', 'SecondUser'])
})

test('youtube adapter follows chained continuation pages up to collection limit', async () => {
  const requestedTokens: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml() {
      return `
        <script>
          ytInitialData = {"contents":[
            {"commentRenderer":{
              "commentId":"c-root",
              "authorText":{"simpleText":"RootUser"},
              "contentText":{"simpleText":"首屏评论"},
              "voteCount":{"simpleText":"1"}
            }},
            {"continuationEndpoint":{"continuationCommand":{"token":"PAGE_1"}}}
          ]};
        </script>
        <script>
          ytcfg.set({"INNERTUBE_API_KEY":"AIza-test","INNERTUBE_CLIENT_NAME":"1","INNERTUBE_CLIENT_VERSION":"2.20260519.01.00"});
        </script>
      `
    },
    async fetchText(_url, _platformKey, options) {
      const token = JSON.parse(options?.body ?? '{}').continuation as string
      requestedTokens.push(token)
      const page = Number(token.replace('PAGE_', ''))
      return JSON.stringify({
        onResponseReceivedEndpoints: [{
          appendContinuationItemsAction: {
            continuationItems: [
              {
                commentThreadRenderer: {
                  comment: {
                    commentRenderer: {
                      commentId: `c-page-${page}`,
                      authorText: { simpleText: `PageUser${page}` },
                      contentText: { simpleText: `第 ${page} 页求链接` },
                      voteCount: { simpleText: String(page) }
                    }
                  }
                }
              },
              {
                continuationEndpoint: {
                  continuationCommand: { token: `PAGE_${page + 1}` }
                }
              }
            ]
          }
        }]
      })
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 1 }
  }, 'youtube', (keyword) => `https://youtube.test/results?q=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.youtube.com/watch?v=abc123XYZ00')
  const comments: Array<{ nickname: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string })
  }

  assert.deepEqual(requestedTokens, ['PAGE_1', 'PAGE_2', 'PAGE_3', 'PAGE_4', 'PAGE_5'])
  assert.deepEqual(comments.map((comment) => comment.nickname), ['RootUser', 'PageUser1', 'PageUser2', 'PageUser3', 'PageUser4', 'PageUser5'])
})

test('bilibili adapter resolves aid before requesting reply api comments', async () => {
  const requestedUrls: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      requestedUrls.push(url)
      if (url.includes('/x/v2/reply/main')) {
        return JSON.stringify({
          data: {
            replies: [{
              rpid: 200,
              member: { uname: 'BiliUser' },
              content: { message: '多少钱，求链接' },
              like: 5,
              ctime: 1710000000
            }]
          }
        })
      }
      return `<script>window.__INITIAL_STATE__ = {
        "aid":123456789,
        "videoData":{"bvid":"BV1xx411c7mD"},
        "wbi_img":{
          "img_url":"https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz123456.png",
          "sub_url":"https://i0.hdslb.com/bfs/wbi/123456abcdefghijklmnopqrstuvwxyz.jpg"
        }
      };</script>`
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')
  const comments: Array<{ nickname: string; text: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requestedUrls.some((url) => url.includes('oid=123456789')))
  assert.ok(requestedUrls.some((url) => url.includes('w_rid=') && url.includes('wts=')))
  assert.equal(comments.length, 1)
  assert.equal(comments[0].nickname, 'BiliUser')
})

test('bilibili adapter follows reply pagination offsets', async () => {
  const requestedUrls: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      requestedUrls.push(url)
      if (!url.includes('/x/v2/reply/main')) {
        return '<script>window.__INITIAL_STATE__ = {"aid":24680,"videoData":{"bvid":"BV1xx411c7mD"}};</script>'
      }
      const decoded = decodeURIComponent(url)
      if (decoded.includes('cursor')) {
        return JSON.stringify({
          data: {
            replies: [{
              rpid: 302,
              member: { uname: 'PageTwo' },
              content: { message: '第二页也想买' },
              like: 2
            }],
            cursor: { is_end: true }
          }
        })
      }
      return JSON.stringify({
        data: {
          replies: [{
            rpid: 301,
            member: { uname: 'PageOne' },
            content: { message: '第一页求报价' },
            like: 1
          }],
          pagination_reply: {
            next_offset: '{"type":3,"direction":1,"data":{"cursor":2}}'
          }
        }
      })
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')
  const comments: Array<{ nickname: string; text: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.equal(requestedUrls.filter((url) => url.includes('/x/v2/reply/main')).length, 2)
  assert.deepEqual(comments.map((comment) => comment.nickname), ['PageOne', 'PageTwo'])
})

test('bilibili adapter fetches child replies for roots with reply counts', async () => {
  const requestedUrls: string[] = []
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      requestedUrls.push(url)
      if (!url.includes('/x/v2/reply/')) {
        return '<script>window.__INITIAL_STATE__ = {"aid":13579,"videoData":{"bvid":"BV1xx411c7mD"}};</script>'
      }
      if (url.includes('/x/v2/reply/reply')) {
        return JSON.stringify({
          data: {
            replies: [{
              rpid: 402,
              member: { uname: 'ChildUser' },
              content: { message: '楼中楼求链接' },
              like: 3
            }]
          }
        })
      }
      return JSON.stringify({
        data: {
          replies: [{
            rpid: 401,
            rcount: 1,
            member: { uname: 'RootUser' },
            content: { message: '主评论' },
            like: 1
          }],
          cursor: { is_end: true }
        }
      })
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')
  const comments: Array<{ nickname: string; text: string }> = []
  for await (const event of adapter.collectComments(content)) {
    if (event.type === 'comment') comments.push(event.payload as { nickname: string; text: string })
  }

  assert.ok(requestedUrls.some((url) => url.includes('/x/v2/reply/reply') && url.includes('root=401')))
  assert.deepEqual(comments.map((comment) => comment.nickname), ['RootUser', 'ChildUser'])
})

test('bilibili adapter reports api risk control errors instead of sample fallback', async () => {
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      if (url.includes('/x/v2/reply/main')) {
        return JSON.stringify({ code: -352, message: '风控校验失败' })
      }
      return '<script>window.__INITIAL_STATE__ = {"aid":86420,"videoData":{"bvid":"BV1xx411c7mD"}};</script>'
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 100, maxRetries: 1 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')
  const events = []
  for await (const event of adapter.collectComments(content)) events.push(event)

  assert.equal(events.some((event) => event.type === 'comment'), false)
  assert.equal(events.at(-1)?.type, 'failed')
  assert.match(String((events.at(-1)?.payload as { message?: string }).message), /风控校验失败/)
})

test('bilibili adapter retries retryable api errors before failing collection', async () => {
  const requestedUrls: string[] = []
  let mainAttempts = 0
  const executor: SearchPageExecutor = {
    async fetchHtml(url) {
      requestedUrls.push(url)
      if (url.includes('/x/v2/reply/main')) {
        mainAttempts += 1
        if (mainAttempts === 1) return JSON.stringify({ code: -509, message: '请求过于频繁' })
        return JSON.stringify({
          data: {
            replies: [{
              rpid: 501,
              member: { uname: 'RetryUser' },
              content: { message: '重试后成功，想买' },
              like: 6
            }],
            cursor: { is_end: true }
          }
        })
      }
      return '<script>window.__INITIAL_STATE__ = {"aid":97531,"videoData":{"bvid":"BV1xx411c7mD"}};</script>'
    }
  }
  const adapter = new VideoPlatformAdapter({
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 1, minDelayMs: 0, maxRetries: 2 }
  }, 'bilibili', (keyword) => `https://bilibili.test/search?keyword=${keyword}`, undefined, executor)
  const content = await adapter.parseContent('https://www.bilibili.com/video/BV1xx411c7mD/')
  const events = []
  for await (const event of adapter.collectComments(content)) events.push(event)

  assert.equal(requestedUrls.filter((url) => url.includes('/x/v2/reply/main')).length, 2)
  assert.equal(events.some((event) => event.type === 'failed'), false)
  assert.equal(events.filter((event) => event.type === 'comment').length, 1)
})
