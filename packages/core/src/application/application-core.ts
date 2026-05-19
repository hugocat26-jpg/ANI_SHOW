import { AIAnalysisQueue } from '../ai/analysis-queue.ts'
import { AIService } from '../ai/ai-service.ts'
import { buildAIRecoveryAdvice, listAIFailurePolicyPresets } from '../ai/failure-policy.ts'
import type { AIRecoveryAdvice, AIFailurePolicyPreset } from '../ai/failure-policy.ts'
import { OpenAICompatibleLLMClient } from '../ai/llm-client.ts'
import { findModelPricing, listMergedModelPricing } from '../ai/model-pricing.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'
import { LeadMinerRepository } from '../data/repository.ts'
import type {
  AuditEvent,
  AIAnalysisStats,
  AIFailurePolicy,
  AIProviderConfig,
  AIProviderPublicConfig,
  AISecretBackup,
  AISecretHealth,
  CalendarExportResult,
  CommentRecord,
  ContentRef,
  FollowUpReminder,
  FollowUpReminderOptions,
  KeywordPlan,
  LeadDetail,
  LeadExportOptions,
  LeadExportResult,
  LeadFilters,
  LeadRecord,
  LeadUpdateInput,
  PlatformErrorCode,
  PlatformStatus,
  SearchResult
} from '../domain/types.ts'
import type { ModelPricingView } from '../ai/model-pricing.ts'
import { createBuiltinPlatformRegistry } from '../platform/builtin.ts'
import type { PlatformRegistry } from '../platform/registry.ts'
import { CompliancePolicy } from '../policy/compliance-policy.ts'
import type { SecretCodec } from '../security/secret-codec.ts'
import { TaskOrchestrator } from '../task/task-orchestrator.ts'

export interface ApplicationCoreOptions {
  dataPath?: string
  profileRoot?: string
  secretCodec?: SecretCodec
}

export interface PlatformLoginResult {
  success: boolean
  message: string
  status?: PlatformStatus
}

export class ApplicationCore {
  platforms: PlatformRegistry
  ai: AIService
  policy: CompliancePolicy
  tasks: TaskOrchestrator
  repository: LeadMinerRepository
  browser: BrowserContextManager
  private lastAIStats?: AIAnalysisStats

  constructor(
    platforms: PlatformRegistry,
    ai: AIService,
    policy: CompliancePolicy,
    tasks: TaskOrchestrator,
    repository: LeadMinerRepository,
    browser: BrowserContextManager
  ) {
    this.platforms = platforms
    this.ai = ai
    this.policy = policy
    this.tasks = tasks
    this.repository = repository
    this.browser = browser
  }

  listAIProviders(): AIProviderPublicConfig[] {
    const configs = this.repository.listAIProviderConfigs()
    const enabled = configs.find((config) => config.enabled)
    this.ai.configureProvider(enabled, enabled ? this.repository.getAIProviderSecret(enabled.provider) : undefined)
    return configs
  }

  listAISecretHealth(now = new Date()): AISecretHealth[] {
    return this.repository.listAIProviderConfigs().map((config) => aiSecretHealth(config, now))
  }

  saveAIProviderConfig(input: Omit<AIProviderConfig, 'updatedAt'>): AIProviderPublicConfig {
    const config = this.repository.saveAIProviderConfig({
      ...input,
      updatedAt: new Date().toISOString()
    })
    if (config.enabled) this.ai.configureProvider(config, this.repository.getAIProviderSecret(config.provider))
    this.audit('ai.provider.save', 'ai_provider', config.provider, `AI Provider 配置已更新: ${config.provider}`)
    return config
  }

  migrateAIProviderSecrets(provider?: AIProviderConfig['provider']): AIProviderPublicConfig[] {
    const backups = provider
      ? [this.repository.createAIProviderSecretBackup(provider, 'migration')].filter((backup): backup is AISecretBackup => Boolean(backup))
      : this.repository.listAIProviderConfigs()
        .map((config) => this.repository.createAIProviderSecretBackup(config.provider, 'migration'))
        .filter((backup): backup is AISecretBackup => Boolean(backup))
    const configs = provider
      ? [this.repository.migrateAIProviderSecret(provider)].filter((config): config is AIProviderPublicConfig => Boolean(config))
      : this.repository.migrateAllAIProviderSecrets()
    const enabled = configs.find((config) => config.enabled)
    if (enabled) this.ai.configureProvider(enabled, this.repository.getAIProviderSecret(enabled.provider))
    this.audit('ai.secret.backup', 'ai_provider', provider, `AI 密钥迁移前备份完成: ${backups.length} 个配置`)
    this.audit('ai.secret.migrate', 'ai_provider', provider, `AI 密钥迁移完成: ${configs.length} 个配置`)
    return configs
  }

  listAISecretBackups(provider?: AIProviderConfig['provider']): AISecretBackup[] {
    return this.repository.listAISecretBackups(provider)
  }

  restoreAISecretBackup(id: string): AIProviderPublicConfig | null {
    const restored = this.repository.restoreAIProviderSecretBackup(id)
    if (restored?.enabled) this.ai.configureProvider(restored, this.repository.getAIProviderSecret(restored.provider))
    this.audit('ai.secret.restore', 'ai_secret_backup', id, restored ? `AI 密钥备份已恢复: ${restored.provider}` : 'AI 密钥备份不存在')
    return restored
  }

  listModelPricing(): ModelPricingView[] {
    return listMergedModelPricing(this.repository.listCustomModelPricing())
  }

  currentModelPricing(): ModelPricingView | undefined {
    const provider = this.ai.currentProvider()
    return findModelPricing(provider?.provider, provider?.model, this.repository.listCustomModelPricing())
  }

  saveCustomModelPricing(items: ModelPricingView[]): ModelPricingView[] {
    const pricing = this.repository.saveCustomModelPricing(items)
    this.audit('ai.model_pricing.save', 'ai_model_pricing', undefined, `自定义模型价格表已更新: ${pricing.length} 条`)
    return pricing
  }

  getAIFailurePolicy(): AIFailurePolicy {
    return this.repository.getAIFailurePolicy()
  }

  saveAIFailurePolicy(input: Omit<AIFailurePolicy, 'updatedAt'>): AIFailurePolicy {
    const policy = this.repository.saveAIFailurePolicy({
      maxRetries: Math.max(0, Math.floor(input.maxRetries)),
      retryDelayMs: Math.max(0, Math.floor(input.retryDelayMs)),
      minDelayMs: Math.max(0, Math.floor(input.minDelayMs)),
      circuitBreakerThreshold: Math.max(0, Math.floor(input.circuitBreakerThreshold)),
      updatedAt: new Date().toISOString()
    })
    this.audit('ai.failure_policy.save', 'ai_failure_policy', undefined, 'AI 失败处理策略已更新')
    return policy
  }

  listAIFailurePolicyPresets(): AIFailurePolicyPreset[] {
    return listAIFailurePolicyPresets()
  }

  getAIRecoveryAdvice(): AIRecoveryAdvice {
    return buildAIRecoveryAdvice(this.lastAIStats)
  }

  async checkPlatformStatuses(): Promise<PlatformStatus[]> {
    const statuses = await mapWithConcurrency(this.platforms.keys(), 2, async (key) => {
      const adapter = this.platforms.get(key)
      try {
        return await adapter.checkStatus()
      } catch (error) {
        return {
          platformKey: key,
          available: false,
          loggedIn: false,
          latencyMs: null,
          checkedAt: new Date().toISOString(),
          errorCode: 'network_error' as const,
          message: platformErrorMessage(error, '平台状态检查失败')
        }
      }
    })
    for (const status of statuses) this.repository.savePlatformStatus(status)
    return statuses
  }

  planSearch(keyword: string): KeywordPlan {
    return this.ai.expandKeywords(keyword, ['zh-CN', 'en-US'])
  }

  async searchAcrossPlatforms(keyword: string, platformKeys: string[]): Promise<SearchResult[]> {
    const task = this.tasks.create('search', { keyword, platformKeys })
    this.tasks.transition(task.id, 'running', { progress: 10 })
    const session = this.repository.createSearchSession(keyword, platformKeys)
    const results: SearchResult[] = []
    const failures: string[] = []
    for (const key of platformKeys) {
      try {
        const adapter = this.platforms.get(key)
        results.push(...await adapter.search({ keyword, platformKeys: [key], limit: 20 }))
      } catch (error) {
        failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const ranked = this.ai.rankSearchResults(keyword, results)
    this.repository.saveSearchResults(session.id, ranked)
    if (ranked.length === 0 && failures.length > 0) {
      this.tasks.transition(task.id, 'failed', { progress: 100, errorCode: 'network_error', errorMessage: failures.join('; ') })
      throw new Error(`搜索失败: ${failures.join('; ')}`)
    }
    if (failures.length > 0) this.audit('search.partial_failure', 'search_session', session.id, failures.join('; '))
    this.tasks.transition(task.id, 'completed', { progress: 100 })
    return ranked
  }

  listSearchResults(): SearchResult[] {
    return this.repository.listSearchResults()
  }

  listComments(contentId?: string): CommentRecord[] {
    return this.repository.listComments(contentId)
  }

  listLeads(filters: LeadFilters = {}): LeadRecord[] {
    return this.repository.listLeads(filters)
  }

  getLeadDetail(id: string): LeadDetail {
    const detail = this.repository.getLeadDetail(id)
    if (!detail) throw new Error(`线索不存在: ${id}`)
    return detail
  }

  listFollowUpReminders(options: FollowUpReminderOptions = {}): FollowUpReminder[] {
    return this.repository.listFollowUpReminders(options)
  }

  exportFollowUpsCalendar(options: FollowUpReminderOptions = {}): CalendarExportResult {
    const reminders = this.repository.listFollowUpReminders(options)
    const now = new Date().toISOString()
    const content = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Lead Miner Workbench//Follow Ups//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      ...reminders.flatMap((reminder) => followUpReminderToIcsEvent(reminder, now)),
      'END:VCALENDAR'
    ].join('\r\n')
    this.audit('followup.calendar.export', 'follow_up', undefined, `导出 ${reminders.length} 条跟进日历事件`)
    return {
      filename: `lead-followups-${new Date().toISOString().slice(0, 10)}.ics`,
      mimeType: 'text/calendar',
      content,
      count: reminders.length
    }
  }

  listAuditLogs(limit = 100): AuditEvent[] {
    return this.repository.listAuditLogs(limit)
  }

  updateLeadStatus(id: string, status: LeadRecord['status']): LeadRecord {
    const lead = this.repository.updateLeadStatus(id, status)
    if (!lead) throw new Error(`线索不存在: ${id}`)
    this.audit('lead.status.update', 'lead', id, `线索状态更新为 ${status}`)
    return lead
  }

  updateLead(id: string, input: LeadUpdateInput): LeadRecord {
    const lead = this.repository.updateLead(id, input)
    if (!lead) throw new Error(`线索不存在: ${id}`)
    this.audit('lead.update', 'lead', id, '线索详情已更新')
    return lead
  }

  updateLeadStatuses(ids: string[], status: LeadRecord['status']): LeadRecord[] {
    const leads = this.repository.updateLeadStatuses(ids, status)
    this.audit('lead.status.bulk_update', 'lead', undefined, `批量更新 ${leads.length} 条线索为 ${status}`)
    return leads
  }

  exportLeads(options: LeadExportOptions = {}): LeadExportResult {
    const defaultFields = ['platformKey', 'nickname', 'text', 'intentLevel', 'confidence', 'score', 'scoreReason', 'suggestedAction', 'status', 'note', 'lastContactedAt', 'nextFollowUpAt', 'createdAt']
    const fields = options.fields?.length ? options.fields : defaultFields
    const decision = this.policy.validateExportFields(fields)
    if (!decision.allowed) throw new Error(`导出字段包含敏感字段: ${decision.violations.join(', ')}`)
    const leads = this.repository.listLeads(options.filters)
    const rows = leads.map((lead) => this.policy.sanitizeRecord(lead as unknown as Record<string, unknown>))
    const csv = [
      fields.map(csvCell).join(','),
      ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))
    ].join('\r\n')
    this.audit('lead.export', 'lead', undefined, `导出 ${leads.length} 条线索，字段: ${fields.join(', ')}`)
    return {
      filename: `leads-${new Date().toISOString().slice(0, 10)}.csv`,
      mimeType: 'text/csv',
      content: `\uFEFF${csv}`,
      count: leads.length,
      fields
    }
  }

  async analyzeComments(comments = this.repository.listComments()): Promise<LeadRecord[]> {
    const task = this.tasks.create('analyze_leads', { commentCount: comments.length })
    this.tasks.transition(task.id, 'running', { progress: 5 })
    const policy = this.repository.getAIFailurePolicy()
    const queue = new AIAnalysisQueue(this.ai, {
      minDelayMs: policy.minDelayMs,
      maxRetries: policy.maxRetries,
      retryDelayMs: policy.retryDelayMs,
      circuitBreakerThreshold: policy.circuitBreakerThreshold,
      modelPricing: this.repository.listCustomModelPricing()
    })
    try {
      const result = await queue.analyze(comments)
      for (const lead of result.leads) this.repository.saveLead(lead)
      this.lastAIStats = result.stats
      this.audit('ai.analysis.batch', 'ai_analysis', task.id, `分析 ${result.stats.total} 条评论，生成 ${result.leads.length} 条线索`)
      this.tasks.transition(task.id, 'completed', { progress: 100 })
      return result.leads
    } catch (error) {
      this.tasks.transition(task.id, 'failed', {
        progress: 100,
        errorCode: 'network_error',
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  getAIAnalysisStats(): AIAnalysisStats | undefined {
    return this.lastAIStats
  }

  async analyzeAndSaveComment(comment: CommentRecord): Promise<LeadRecord | null> {
    const result = await this.ai.commentToLeadWithMeta(comment)
    if (!result.lead) return null
    this.repository.saveLead(result.lead)
    return result.lead
  }

  async parseContent(platformKey: string, url: string): Promise<ContentRef> {
    const task = this.tasks.create('parse_content', { url }, platformKey)
    this.tasks.transition(task.id, 'running', { progress: 20 })
    try {
      const content = await this.platforms.get(platformKey).parseContent(url)
      this.repository.saveContent(content)
      this.tasks.transition(task.id, 'completed', { progress: 100 })
      return content
    } catch (error) {
      this.tasks.transition(task.id, 'failed', {
        progress: 100,
        errorCode: 'content_not_found',
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async collectComments(platformKey: string, url: string): Promise<CommentRecord[]> {
    const task = this.tasks.create('collect_comments', { url }, platformKey)
    this.tasks.transition(task.id, 'running', { progress: 5 })
    try {
      const adapter = this.platforms.get(platformKey)
      const content = await adapter.parseContent(url)
      this.repository.saveContent(content)
      const comments: CommentRecord[] = []
      for await (const event of adapter.collectComments(content)) {
        if (event.type === 'progress') {
          const progress = typeof event.payload === 'object' && event.payload && 'current' in event.payload && 'total' in event.payload
            ? Math.min(95, Math.round((Number(event.payload.current) / Math.max(1, Number(event.payload.total))) * 90))
            : task.progress
          this.tasks.transition(task.id, 'running', { progress })
        }
        if (event.type === 'comment') {
          const comment = event.payload as CommentRecord
          this.repository.saveComment(comment)
          comments.push(comment)
          try {
            await this.analyzeAndSaveComment(comment)
          } catch (error) {
            this.audit('ai.analysis.comment_failed', 'comment', comment.id, error instanceof Error ? error.message : String(error))
          }
        }
        if (event.type === 'failed') {
          throw new Error(typeof event.payload === 'object' && event.payload && 'message' in event.payload ? String(event.payload.message) : '评论采集失败')
        }
      }
      this.tasks.transition(task.id, 'completed', { progress: 100 })
      return comments
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.tasks.transition(task.id, 'failed', {
        progress: 100,
        errorCode: classifyPlatformFailure(message, 'network_error'),
        errorMessage: message
      })
      this.audit('collect.failed', 'content', url, message)
      throw error
    }
  }

  async loginPlatform(platformKey: string): Promise<PlatformLoginResult> {
    const adapter = this.platforms.get(platformKey)
    let result: PlatformLoginResult
    try {
      result = await this.browser.openLoginWindow(adapter.spec, adapter.spec.loginUrl)
    } catch (error) {
      result = {
        success: false,
        message: `${adapter.spec.name} 登录窗口已关闭或无法打开：${platformErrorMessage(error, '登录窗口异常关闭')}`
      }
    }
    let status: PlatformStatus | undefined
    try {
      status = await adapter.checkStatus()
      this.repository.savePlatformStatus(status)
    } catch (error) {
      status = {
        platformKey,
        available: false,
        loggedIn: false,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        errorCode: 'network_error',
        message: platformErrorMessage(error, '登录后状态复查失败')
      }
      this.repository.savePlatformStatus(status)
    }
    this.audit(
      result.success ? 'platform.login.completed' : 'platform.login.failed',
      'platform',
      platformKey,
      `${result.message}; 状态: ${status.message}`
    )
    return { success: result.success, message: result.message, status }
  }

  private audit(action: string, targetType: string, targetId: string | undefined, message: string): void {
    this.repository.saveAudit({
      id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action,
      targetType,
      targetId,
      message,
      createdAt: new Date().toISOString()
    })
  }
}

function csvCell(value: unknown): string {
  if (Array.isArray(value)) return csvCell(value.join('|'))
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return results
}

function platformErrorMessage(error: unknown, fallback: string): string {
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
  if (/Timeout|timed out|Navigation timeout/i.test(text)) {
    return '平台页面加载超时，可能是网络较慢或平台限制自动访问；请稍后重试。'
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(text)) {
    return '域名解析失败，请检查网络、DNS 或代理设置。'
  }
  return text || fallback
}

function classifyPlatformFailure(message: string, fallback: PlatformErrorCode): PlatformErrorCode {
  const text = message.toLowerCase()
  const codeMatch = /接口错误\s+(-?\d+)/.exec(message)
  if (codeMatch?.[1] === '-101') return 'login_required'
  if (codeMatch?.[1] === '-352') return 'captcha_required'
  if (codeMatch?.[1] === '-412') return 'captcha_required'
  if (codeMatch?.[1] === '-509') return 'rate_limited'
  if (codeMatch?.[1] === '-403' || codeMatch?.[1] === '403') return 'permission_denied'
  if (/风控|验证码|校验|captcha/.test(message)) return 'captcha_required'
  if (/限流|频率|rate|too many/.test(message)) return 'rate_limited'
  if (/权限|permission|forbidden|unauthorized/.test(message)) return 'permission_denied'
  if (/评论已关闭|关闭了评论|无法采集该视频评论/.test(message) || /comments are turned off|comments disabled/i.test(message)) return 'unsupported'
  if (/登录|login/.test(message) || text.includes('auth')) return 'login_required'
  if (/not found|不存在|无法识别/.test(text)) return 'content_not_found'
  return fallback
}

function aiSecretHealth(config: AIProviderPublicConfig, now: Date): AISecretHealth {
  if (config.provider === 'rule') {
    return {
      provider: config.provider,
      severity: 'ok',
      title: '本地规则无需密钥',
      message: '本地规则回退不需要 API Key。',
      ageDays: null,
      recommendedAction: 'none'
    }
  }
  const ageDays = daysSince(config.updatedAt, now)
  if (!config.apiKeySet) {
    return {
      provider: config.provider,
      severity: config.enabled ? 'critical' : 'warning',
      title: '未配置 API Key',
      message: config.secretStorage === 'external_env'
        ? `该 Provider 引用了环境变量 ${config.apiKeyPreview ?? ''}，但当前进程未读取到值。`
        : config.enabled ? '该 Provider 已启用但缺少 API Key，模型调用会回退或失败。' : '该 Provider 未配置 API Key。',
      ageDays,
      recommendedAction: 'configure_key'
    }
  }
  if (config.secretStorage === 'external_env') {
    return {
      provider: config.provider,
      severity: 'ok',
      title: '外部密钥可用',
      message: `当前使用环境变量引用 ${config.apiKeyPreview ?? ''}，仓库不保存真实 API Key。`,
      ageDays,
      recommendedAction: 'none'
    }
  }
  if (config.secretStorage !== 'encrypted') {
    return {
      provider: config.provider,
      severity: 'warning',
      title: '建议迁移密钥存储',
      message: `当前密钥存储状态为 ${config.secretStorage}，建议迁移到系统加密存储。`,
      ageDays,
      recommendedAction: 'migrate_secret'
    }
  }
  if (ageDays !== null && ageDays >= 90) {
    return {
      provider: config.provider,
      severity: 'warning',
      title: '建议轮换 API Key',
      message: `该 API Key 已保存 ${ageDays} 天，建议轮换并重新保存。`,
      ageDays,
      recommendedAction: 'rotate_key'
    }
  }
  return {
    provider: config.provider,
    severity: 'ok',
    title: '密钥状态正常',
    message: 'API Key 已配置且使用当前加密策略保存。',
    ageDays,
    recommendedAction: 'none'
  }
}

function daysSince(isoDate: string, now: Date): number | null {
  const timestamp = Date.parse(isoDate)
  if (!Number.isFinite(timestamp)) return null
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000))
}

function followUpReminderToIcsEvent(reminder: FollowUpReminder, createdAt: string): string[] {
  const start = new Date(reminder.dueAt)
  const end = new Date(start.getTime() + 30 * 60_000)
  const lead = reminder.lead
  return [
    'BEGIN:VEVENT',
    `UID:${icsText(`${lead.id}@lead-miner-workbench`)}`,
    `DTSTAMP:${icsDate(createdAt)}`,
    `DTSTART:${icsDate(start.toISOString())}`,
    `DTEND:${icsDate(end.toISOString())}`,
    `SUMMARY:${icsText(`跟进 ${lead.nickname} (${lead.platformKey})`)}`,
    `DESCRIPTION:${icsText(`${lead.text}\n建议动作: ${lead.suggestedAction}\n评分: ${lead.score}\n备注: ${lead.note ?? ''}`)}`,
    'END:VEVENT'
  ]
}

function icsDate(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

export function createDefaultApplicationCore(options: ApplicationCoreOptions = {}): ApplicationCore {
  const repository = new LeadMinerRepository(options.dataPath, options.secretCodec)
  const browser = new BrowserContextManager(options.profileRoot)
  return new ApplicationCore(
    createBuiltinPlatformRegistry(browser),
    new AIService(new OpenAICompatibleLLMClient()),
    new CompliancePolicy(),
    new TaskOrchestrator(repository),
    repository,
    browser
  )
}
