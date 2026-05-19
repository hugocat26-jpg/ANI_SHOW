import type { AIAnalysisStats, AIFailurePolicy, AIFailurePolicyPreset, AIProviderConfig, AIProviderPublicConfig, AIRecoveryAdvice, AISecretBackup, AISecretHealth, AuditEvent, CalendarExportResult, CommentRecord, FollowUpReminder, FollowUpReminderOptions, KeywordPlan, LeadDetail, LeadExportOptions, LeadExportResult, LeadFilters, LeadRecord, LeadUpdateInput, ModelPricingView, PlatformLoginResult, PlatformSpec, PlatformStatus, SearchResult, Task } from '../../../../../packages/core/src/index'

export interface LeadMinerApi {
  listPlatforms(): Promise<PlatformSpec[]>
  checkPlatformStatuses(): Promise<PlatformStatus[]>
  loginPlatform(platformKey: string): Promise<PlatformLoginResult>
  planSearch(keyword: string): Promise<KeywordPlan>
  runSearch(input: { keyword: string; platformKeys: string[] }): Promise<SearchResult[]>
  listSearchResults(): Promise<SearchResult[]>
  collectComments(input: { platformKey: string; url: string }): Promise<CommentRecord[]>
  listComments(contentId?: string): Promise<CommentRecord[]>
  listLeads(filters?: LeadFilters): Promise<LeadRecord[]>
  getLeadDetail(id: string): Promise<LeadDetail>
  listFollowUpReminders(options?: FollowUpReminderOptions): Promise<FollowUpReminder[]>
  exportFollowUpsCalendar(options?: FollowUpReminderOptions): Promise<CalendarExportResult>
  exportFollowUpsCalendarToFile?(options?: FollowUpReminderOptions): Promise<{ canceled: boolean; filePath?: string; count: number }>
  analyzeLeads(): Promise<LeadRecord[]>
  updateLeadStatus(input: { id: string; status: LeadRecord['status'] }): Promise<LeadRecord>
  updateLead(input: { id: string; patch: LeadUpdateInput }): Promise<LeadRecord>
  bulkUpdateLeadStatus(input: { ids: string[]; status: LeadRecord['status'] }): Promise<LeadRecord[]>
  exportLeads(input?: LeadExportOptions): Promise<LeadExportResult>
  exportLeadsToFile?(input?: LeadExportOptions): Promise<{ canceled: boolean; filePath?: string; count: number }>
  listAuditLogs(limit?: number): Promise<AuditEvent[]>
  listAIProviders(): Promise<AIProviderPublicConfig[]>
  listAISecretHealth(): Promise<AISecretHealth[]>
  saveAIProvider(input: Omit<AIProviderConfig, 'updatedAt'>): Promise<AIProviderPublicConfig>
  migrateAISecrets(provider?: AIProviderConfig['provider']): Promise<AIProviderPublicConfig[]>
  listAISecretBackups(provider?: AIProviderConfig['provider']): Promise<AISecretBackup[]>
  restoreAISecretBackup(id: string): Promise<AIProviderPublicConfig | null>
  getAIAnalysisStats(): Promise<AIAnalysisStats | undefined>
  listModelPricing(): Promise<ModelPricingView[]>
  currentModelPricing(): Promise<ModelPricingView | undefined>
  saveCustomModelPricing(input: ModelPricingView[]): Promise<ModelPricingView[]>
  getAIFailurePolicy(): Promise<AIFailurePolicy>
  saveAIFailurePolicy(input: Omit<AIFailurePolicy, 'updatedAt'>): Promise<AIFailurePolicy>
  listAIFailurePolicyPresets(): Promise<AIFailurePolicyPreset[]>
  getAIRecoveryAdvice(): Promise<AIRecoveryAdvice>
  notifyFollowUps?(input: { overdue: number; today: number }): Promise<{ shown: boolean }>
  notifyAIRecovery?(input: AIRecoveryAdvice): Promise<{ shown: boolean }>
  listTasks(): Promise<Task[]>
}

declare global {
  interface Window {
    leadMiner?: LeadMinerApi
  }
}

export const fallbackApi: LeadMinerApi = {
  async listPlatforms() {
    return [
      { key: 'google', name: 'Google', category: 'search_engine', domains: ['google.com'], requiresLogin: false, capabilities: ['search', 'status'], rateLimit: { concurrency: 1, minDelayMs: 600, maxRetries: 2 } },
      { key: 'bing', name: 'Bing', category: 'search_engine', domains: ['bing.com'], requiresLogin: false, capabilities: ['search', 'status'], rateLimit: { concurrency: 1, minDelayMs: 600, maxRetries: 2 } },
      { key: 'douyin', name: '抖音', category: 'video', domains: ['douyin.com'], loginUrl: 'https://www.douyin.com/', requiresLogin: true, capabilities: ['search', 'login', 'status', 'comments'], rateLimit: { concurrency: 1, minDelayMs: 1500, maxRetries: 2 } },
      { key: 'xiaohongshu', name: '小红书', category: 'social', domains: ['xiaohongshu.com'], loginUrl: 'https://www.xiaohongshu.com/explore', requiresLogin: true, capabilities: ['search', 'login', 'status', 'comments'], rateLimit: { concurrency: 1, minDelayMs: 1500, maxRetries: 2 } }
    ]
  },
  async checkPlatformStatuses() {
    const platforms = await fallbackApi.listPlatforms()
    return platforms.map((platform) => ({
      platformKey: platform.key,
      available: true,
      loggedIn: !platform.requiresLogin,
      latencyMs: platform.requiresLogin ? 86 : 32,
      checkedAt: new Date().toISOString(),
      errorCode: platform.requiresLogin ? 'login_required' : 'ok',
      message: platform.requiresLogin ? '未确认登录态；如搜索或评论受限，请先登录/验证' : '可访问'
    }))
  },
  async loginPlatform(platformKey: string) {
    return {
      success: false,
      message: `${platformKey} 登录仅在 Electron 桌面环境可用`,
      status: {
        platformKey,
        available: true,
        loggedIn: false,
        latencyMs: 0,
        checkedAt: new Date().toISOString(),
        errorCode: 'login_required',
        message: '浏览器预览环境无法打开平台登录窗口'
      }
    }
  },
  async planSearch(keyword: string) {
    const seed = keyword.trim()
    return { seed, keywords: [seed, `${seed} 推荐`, `${seed} 怎么选`, `${seed} 价格`, `${seed} review`], locales: ['zh-CN', 'en-US'] }
  },
  async runSearch(input) {
    return input.platformKeys.flatMap((platformKey, index) => ({
      id: `${platformKey}-${index}`,
      platformKey,
      title: `${input.keyword} 搜索结果`,
      url: `https://example.test/${platformKey}?q=${encodeURIComponent(input.keyword)}`,
      snippet: '浏览器预览 fallback 数据；Electron 环境会调用主进程核心服务。',
      relevance: 0.5,
      createdAt: new Date().toISOString()
    }))
  },
  async listSearchResults() {
    return []
  },
  async collectComments(input) {
    const now = new Date().toISOString()
    return [{
      id: `${input.platformKey}-fallback-comment`,
      platformKey: input.platformKey,
      contentId: input.url,
      contentUrl: input.url,
      nickname: '预览用户',
      text: '这个多少钱，求链接',
      likes: 8,
      publishedAt: now,
      collectedAt: now
    }]
  },
  async listComments() {
    return []
  },
  async listLeads() {
    return []
  },
  async getLeadDetail(id) {
    throw new Error(`线索不存在: ${id}`)
  },
  async listFollowUpReminders() {
    return []
  },
  async exportFollowUpsCalendar() {
    return {
      filename: 'lead-followups-preview.ics',
      mimeType: 'text/calendar',
      content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR',
      count: 0
    }
  },
  async analyzeLeads() {
    return []
  },
  async updateLeadStatus() {
    throw new Error('线索状态更新仅在 Electron 桌面环境可用')
  },
  async updateLead() {
    throw new Error('线索详情更新仅在 Electron 桌面环境可用')
  },
  async bulkUpdateLeadStatus() {
    return []
  },
  async exportLeads() {
    return {
      filename: 'leads-preview.csv',
      mimeType: 'text/csv',
      content: '\uFEFFplatformKey,nickname,text,score,status\r\n',
      count: 0,
      fields: ['platformKey', 'nickname', 'text', 'score', 'status']
    }
  },
  async listAuditLogs() {
    return []
  },
  async listAIProviders() {
    return [{
      provider: 'rule',
      model: 'rule-fallback',
      enabled: true,
      apiKeySet: false,
      secretStorage: 'none',
      updatedAt: new Date().toISOString()
    }]
  },
  async saveAIProvider(input) {
    return {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      enabled: input.enabled,
      apiKeySet: Boolean(input.apiKey),
      apiKeyPreview: input.apiKey && input.apiKey.length > 4 ? `...${input.apiKey.slice(-4)}` : undefined,
      secretStorage: input.apiKey ? 'plain' : 'none',
      updatedAt: new Date().toISOString()
    }
  },
  async migrateAISecrets() {
    return fallbackApi.listAIProviders()
  },
  async listAISecretBackups() {
    return []
  },
  async restoreAISecretBackup() {
    return null
  },
  async listAISecretHealth() {
    const providers = await fallbackApi.listAIProviders()
    return providers.map((provider) => ({
      provider: provider.provider,
      severity: provider.apiKeySet ? 'ok' as const : 'warning' as const,
      title: provider.apiKeySet ? '密钥状态正常' : '未配置 API Key',
      message: provider.apiKeySet ? '浏览器预览环境使用模拟密钥状态。' : '保存 API Key 后可使用模型分析。',
      ageDays: provider.apiKeySet ? 0 : null,
      recommendedAction: provider.apiKeySet ? 'none' as const : 'configure_key' as const
    }))
  },
  async getAIAnalysisStats() {
    return undefined
  },
  async listModelPricing() {
    return [
      { provider: 'deepseek', modelPattern: 'deepseek-chat', inputUsdPerMillionTokens: 0.14, outputUsdPerMillionTokens: 0.28 },
      { provider: 'openai', modelPattern: 'gpt-4.1-mini', inputUsdPerMillionTokens: 0.4, outputUsdPerMillionTokens: 1.6 }
    ]
  },
  async currentModelPricing() {
    return undefined
  },
  async saveCustomModelPricing(input) {
    return input.map((item) => ({ ...item, source: 'custom' as const }))
  },
  async getAIFailurePolicy() {
    return { maxRetries: 1, retryDelayMs: 800, minDelayMs: 0, circuitBreakerThreshold: 5, updatedAt: new Date().toISOString() }
  },
  async saveAIFailurePolicy(input) {
    return { ...input, updatedAt: new Date().toISOString() }
  },
  async listAIFailurePolicyPresets() {
    return [{
      key: 'balanced',
      name: '均衡',
      description: '适合日常批量分析',
      policy: { maxRetries: 1, retryDelayMs: 800, minDelayMs: 0, circuitBreakerThreshold: 5 }
    }]
  },
  async getAIRecoveryAdvice() {
    return { severity: 'info', title: '暂无 AI 分析统计', actions: ['完成一次批量分析后查看恢复建议。'] }
  },
  async listTasks() {
    return []
  }
}

export function getLeadMinerApi(): LeadMinerApi {
  return window.leadMiner ?? fallbackApi
}
