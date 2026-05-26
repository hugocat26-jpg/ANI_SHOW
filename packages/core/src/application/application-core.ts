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
  AuditLogFilters,
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
  LeadExportPreview,
  LeadExportResult,
  LeadFilters,
  LeadRecord,
  LeadUpdateInput,
  ManualImportInput,
  ManualImportPreview,
  ManualImportResult,
  PlatformConnectorConfig,
  PlatformConnectorPublicConfig,
  PlatformErrorCode,
  PlatformStatus,
  PrivacyCleanupEstimate,
  PrivacyCleanupOptions,
  PrivacyCleanupResult,
  SearchResult
} from '../domain/types.ts'
import { contentRefFromManualImport, manualCommentFingerprint, manualCommentId, normalizeManualImportInput } from '../import/manual-import.ts'
import type { ModelPricingView } from '../ai/model-pricing.ts'
import { createBuiltinPlatformRegistry, platformExpansionTargetSpecs } from '../platform/builtin.ts'
import { canSearchPlatform, requiresSingleItemCollection } from '../platform/capability-policy.ts'
import { OfficialApiError, OfficialApiPlatformAdapter } from '../platform/official-api-adapter.ts'
import type { PlatformRegistry } from '../platform/registry.ts'
import { CompliancePolicy } from '../policy/compliance-policy.ts'
import { PrivacyFileManager } from '../security/privacy-files.ts'
import type { SecretCodec } from '../security/secret-codec.ts'
import { TaskOrchestrator } from '../task/task-orchestrator.ts'

export interface ApplicationCoreOptions {
  dataPath?: string
  profileRoot?: string
  logRoot?: string
  secretCodec?: SecretCodec
}

export interface PlatformLoginResult {
  success: boolean
  message: string
  status?: PlatformStatus
}

const ACCOUNT_PROTECTION_COOLDOWN_MS = 24 * 60 * 60 * 1000
const ACCOUNT_PROTECTION_ERROR_CODES = new Set<PlatformErrorCode>(['captcha_required', 'rate_limited', 'permission_denied'])
const LEAD_STATUSES = new Set<LeadRecord['status']>(['new', 'contacted', 'ignored'])

interface PlatformProtectionState {
  pausedUntil: number
  reason: string
}

export class ApplicationCore {
  platforms: PlatformRegistry
  ai: AIService
  policy: CompliancePolicy
  tasks: TaskOrchestrator
  repository: LeadMinerRepository
  browser: BrowserContextManager
  privacyFiles: PrivacyFileManager
  private lastAIStats?: AIAnalysisStats
  private readonly platformProtection = new Map<string, PlatformProtectionState>()

  constructor(
    platforms: PlatformRegistry,
    ai: AIService,
    policy: CompliancePolicy,
    tasks: TaskOrchestrator,
    repository: LeadMinerRepository,
    browser: BrowserContextManager,
    privacyFiles = new PrivacyFileManager()
  ) {
    this.platforms = platforms
    this.ai = ai
    this.policy = policy
    this.tasks = tasks
    this.repository = repository
    this.browser = browser
    this.privacyFiles = privacyFiles
    this.loadPlatformProtections()
    this.registerConfiguredPlatformConnectors()
  }

  listAIProviders(): AIProviderPublicConfig[] {
    const configs = this.repository.listAIProviderConfigs()
    const enabled = configs.find((config) => config.enabled)
    this.ai.configureProvider(enabled, enabled ? this.repository.getAIProviderSecret(enabled.provider) : undefined)
    return configs
  }

  listPlatformConnectorConfigs(): PlatformConnectorPublicConfig[] {
    return this.repository.listPlatformConnectorConfigs()
  }

  savePlatformConnectorConfig(input: Omit<PlatformConnectorConfig, 'updatedAt'>): PlatformConnectorPublicConfig {
    validatePlatformConnectorConfig(input, [...this.platforms.keys(), ...platformExpansionTargetSpecs.map((spec) => spec.key)])
    const config = this.repository.savePlatformConnectorConfig({
      ...input,
      updatedAt: new Date().toISOString()
    })
    this.registerConfiguredPlatformConnectors()
    this.audit('platform.connector.save', 'platform', config.platformKey, `平台接入配置已更新: ${config.platformKey}`)
    return config
  }

  listAISecretHealth(now = new Date()): AISecretHealth[] {
    return this.repository.listAIProviderConfigs().map((config) => aiSecretHealth(config, now))
  }

  saveAIProviderConfig(input: Omit<AIProviderConfig, 'updatedAt'>): AIProviderPublicConfig {
    if (!input || typeof input !== 'object') throw new Error('AI Provider 配置必须是对象')
    if (!input.model?.trim()) throw new Error('AI Provider 模型名称不能为空')
    if (input.model.length > 160) throw new Error('AI Provider 模型名称过长')
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

  async cleanupPrivacyData(input: PrivacyCleanupOptions): Promise<PrivacyCleanupResult> {
    const options = validatePrivacyCleanupOptions(input, this.platforms.keys())
    const result: PrivacyCleanupResult = {
      platformProfilesCleared: 0,
      platformStateRowsCleared: 0,
      searchRowsCleared: 0,
      commentRowsCleared: 0,
      leadRowsCleared: 0,
      taskRowsCleared: 0,
      auditRowsCleared: 0,
      aiSecretBackupRowsCleared: 0,
      localLogFilesCleared: 0,
      localLogBytesCleared: 0
    }

    if (options.platformProfiles) {
      result.platformProfilesCleared = await this.browser.clearProfiles(options.platformKeys)
    }
    if (options.platformState) {
      result.platformStateRowsCleared = this.repository.clearPlatformState()
      this.platformProtection.clear()
    }
    if (options.searchData) result.searchRowsCleared = this.repository.clearSearchData()
    if (options.commentsAndLeads) {
      const cleared = this.repository.clearCommentsAndLeads()
      result.commentRowsCleared = cleared.comments + cleared.contents
      result.leadRowsCleared = cleared.leads
    }
    if (options.tasks) result.taskRowsCleared = this.repository.clearTasks()
    if (options.aiSecretBackups) result.aiSecretBackupRowsCleared = this.repository.clearAISecretBackups()
    if (options.localLogs) {
      const cleared = await this.privacyFiles.clearLogFiles()
      result.localLogFilesCleared = cleared.files
      result.localLogBytesCleared = cleared.bytes
    }
    if (options.auditLogs) {
      result.auditRowsCleared = this.repository.clearAuditLogs()
    } else {
      this.audit('privacy.cleanup', 'privacy', undefined, privacyCleanupSummary(result))
    }

    return result
  }

  async previewPrivacyCleanup(input: PrivacyCleanupOptions): Promise<PrivacyCleanupEstimate> {
    const options = validatePrivacyCleanupOptions(input, this.platforms.keys())
    const commentsAndLeads = options.commentsAndLeads ? this.repository.countCommentsAndLeads() : { comments: 0, leads: 0, contents: 0 }
    const logs = options.localLogs ? await this.privacyFiles.listLogFiles() : []
    return {
      platformProfilesFound: options.platformProfiles ? await this.browser.countProfiles(options.platformKeys) : 0,
      platformProfilesCleared: 0,
      platformStateRowsCleared: options.platformState ? this.repository.countPlatformState() : 0,
      searchRowsCleared: options.searchData ? this.repository.countSearchData() : 0,
      commentRowsCleared: commentsAndLeads.comments + commentsAndLeads.contents,
      leadRowsCleared: commentsAndLeads.leads,
      taskRowsCleared: options.tasks ? this.repository.countTasks() : 0,
      auditRowsCleared: options.auditLogs ? this.repository.countAuditLogs() : 0,
      aiSecretBackupRowsCleared: options.aiSecretBackups ? this.repository.countAISecretBackups() : 0,
      localLogFilesCleared: logs.length,
      localLogBytesCleared: logs.reduce((sum, file) => sum + file.sizeBytes, 0)
    }
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
        return this.applyPlatformProtectionStatus(key, await adapter.checkStatus())
      } catch (error) {
        return this.applyPlatformProtectionStatus(key, {
          platformKey: key,
          available: false,
          loggedIn: false,
          latencyMs: null,
          checkedAt: new Date().toISOString(),
          errorCode: 'network_error' as const,
          message: platformErrorMessage(error, '平台状态检查失败')
        })
      }
    })
    for (const status of statuses) this.repository.savePlatformStatus(status)
    return statuses
  }

  planSearch(keyword: string): KeywordPlan {
    return this.ai.expandKeywords(keyword, ['zh-CN', 'en-US'])
  }

  async searchAcrossPlatforms(keyword: string, platformKeys: string[]): Promise<SearchResult[]> {
    const safeKeyword = assertStringLength(keyword, '搜索关键词', 1, 200)
    const safePlatformKeys = validatePlatformKeys(platformKeys, this.platforms.keys())
    const task = this.tasks.create('search', { keyword: safeKeyword, platformKeys: safePlatformKeys })
    this.tasks.transition(task.id, 'running', { progress: 10 })
    const session = this.repository.createSearchSession(safeKeyword, safePlatformKeys)
    const results: SearchResult[] = []
    const failures: string[] = []
    for (const key of safePlatformKeys) {
      try {
        this.assertRealtimePlatformAllowed(key, 'search')
        const adapter = this.platforms.get(key)
        if (!canSearchPlatform(adapter.spec)) throw new Error(`${adapter.spec.name} 当前 manifest 未开放搜索能力`)
        results.push(...await adapter.search({ keyword: safeKeyword, platformKeys: [key], limit: 20 }))
        if (adapter.spec.connectorKind === 'official_api') this.repository.recordPlatformConnectorUsage(key, 'ok')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          if (this.platforms.get(key).spec.connectorKind === 'official_api') {
            this.repository.recordPlatformConnectorUsage(key, 'failed', message, new Date(), officialApiUsageDetails(error))
          }
        } catch {
          // Ignore usage bookkeeping errors; the user-facing search failure is more important.
        }
        failures.push(`${key}: ${message}`)
      }
    }
    const ranked = this.ai.rankSearchResults(safeKeyword, results)
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

  previewManualContent(input: ManualImportInput): ManualImportPreview {
    const normalized = normalizeManualImportInput(input)
    const knownSpec = this.findKnownPlatformSpec(normalized.platformKey)
    if (!knownSpec) throw new Error(`平台不存在: ${normalized.platformKey}`)
    if (!knownSpec.capabilities.includes('parse_content') && knownSpec.connectorKind !== 'manual_import') {
      throw new Error(`${knownSpec.name} 不支持手动内容导入`)
    }
    const content = contentRefFromManualImport(normalized, knownSpec)
    const existingFingerprints = new Set(this.repository.listComments(content.contentId).map((comment) => manualCommentFingerprint(comment)))
    const seen = new Set<string>()
    let duplicates = 0
    for (const comment of normalized.comments ?? []) {
      const fingerprint = manualCommentFingerprint(comment)
      if (seen.has(fingerprint) || existingFingerprints.has(fingerprint)) duplicates += 1
      seen.add(fingerprint)
    }
    const parsedComments = normalized.comments?.length ?? 0
    return {
      content,
      templateType: normalized.templateType ?? 'comment_csv',
      conflictStrategy: normalized.conflictStrategy ?? 'skip_duplicates',
      parsedComments,
      newComments: parsedComments - duplicates,
      duplicates,
      updatableDuplicates: normalized.conflictStrategy === 'replace_existing' ? duplicates : 0,
      sampleComments: (normalized.comments ?? []).slice(0, 5)
    }
  }

  async importManualContent(input: ManualImportInput): Promise<ManualImportResult> {
    const normalized = normalizeManualImportInput(input)
    const knownSpec = this.findKnownPlatformSpec(normalized.platformKey)
    if (!knownSpec) throw new Error(`平台不存在: ${normalized.platformKey}`)
    if (!knownSpec.capabilities.includes('parse_content') && knownSpec.connectorKind !== 'manual_import') {
      throw new Error(`${knownSpec.name} 不支持手动内容导入`)
    }
    const task = this.tasks.create('manual_import', {
      platformKey: normalized.platformKey,
      sourceUrl: normalized.sourceUrl,
      title: normalized.title,
      commentCount: normalized.comments?.length ?? 0
    }, normalized.platformKey)
    this.tasks.transition(task.id, 'running', { progress: 10 })
    try {
      const content = contentRefFromManualImport(normalized, knownSpec)
      this.repository.saveContent(content)
      const now = new Date().toISOString()
      const existingByFingerprint = new Map(this.repository.listComments(content.contentId).map((comment) => [manualCommentFingerprint(comment), comment]))
      const seenFingerprints = new Set<string>()
      let commentsImported = 0
      let duplicatesSkipped = 0
      let duplicatesUpdated = 0
      let leadsGenerated = 0
      for (const [index, commentInput] of (normalized.comments ?? []).entries()) {
        const fingerprint = manualCommentFingerprint(commentInput)
        const existingComment = existingByFingerprint.get(fingerprint)
        if (seenFingerprints.has(fingerprint)) {
          duplicatesSkipped += 1
          continue
        }
        seenFingerprints.add(fingerprint)
        if (existingComment) {
          if (normalized.conflictStrategy !== 'replace_existing') {
            duplicatesSkipped += 1
            continue
          }
          this.repository.saveComment({
            ...existingComment,
            contentUrl: commentInput.contentUrl ?? existingComment.contentUrl,
            likes: commentInput.likes ?? existingComment.likes,
            publishedAt: commentInput.publishedAt ?? existingComment.publishedAt,
            collectedAt: now
          })
          duplicatesUpdated += 1
          continue
        }
        const comment: CommentRecord = {
          id: manualCommentId(content.contentId, commentInput, index),
          platformKey: normalized.platformKey,
          contentId: content.contentId,
          contentUrl: commentInput.contentUrl ?? content.url,
          nickname: commentInput.nickname ?? '手动导入用户',
          text: commentInput.text,
          likes: commentInput.likes ?? 0,
          publishedAt: commentInput.publishedAt ?? now,
          collectedAt: now
        }
        this.repository.saveComment(comment)
        commentsImported += 1
        try {
          const lead = await this.analyzeAndSaveComment(comment)
          if (lead) leadsGenerated += 1
        } catch (error) {
          this.audit('manual_import.analysis_failed', 'comment', comment.id, error instanceof Error ? error.message : String(error))
        }
        const progress = 10 + Math.round((commentsImported / Math.max(1, normalized.comments?.length ?? 1)) * 85)
        this.tasks.transition(task.id, 'running', { progress: Math.min(95, progress) })
      }
      this.tasks.transition(task.id, 'completed', { progress: 100 })
      this.audit('manual_import.completed', 'content', content.contentId, `手动导入 ${knownSpec.name} 内容，评论 ${commentsImported} 条，跳过重复 ${duplicatesSkipped} 条，更新重复 ${duplicatesUpdated} 条，线索 ${leadsGenerated} 条`)
      return { content, commentsImported, duplicatesSkipped, duplicatesUpdated, leadsGenerated }
    } catch (error) {
      this.tasks.transition(task.id, 'failed', {
        progress: 100,
        errorCode: 'unsupported',
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
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

  listAuditLogs(input: number | AuditLogFilters = 100): AuditEvent[] {
    const filters = normalizeAuditLogFilters(input)
    return this.repository.listAuditLogs(filters)
  }

  updateLeadStatus(id: string, status: LeadRecord['status']): LeadRecord {
    assertStringLength(id, '线索 ID', 1, 160)
    if (!LEAD_STATUSES.has(status)) throw new Error('线索状态无效')
    const lead = this.repository.updateLeadStatus(id, status)
    if (!lead) throw new Error(`线索不存在: ${id}`)
    this.audit('lead.status.update', 'lead', id, `线索状态更新为 ${status}`)
    return lead
  }

  updateLead(id: string, input: LeadUpdateInput): LeadRecord {
    assertStringLength(id, '线索 ID', 1, 160)
    validateLeadUpdateInput(input)
    const lead = this.repository.updateLead(id, input)
    if (!lead) throw new Error(`线索不存在: ${id}`)
    this.audit('lead.update', 'lead', id, '线索详情已更新')
    return lead
  }

  updateLeadStatuses(ids: string[], status: LeadRecord['status']): LeadRecord[] {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new Error('批量线索 ID 数量必须在 1 到 500 之间')
    for (const id of ids) assertStringLength(id, '线索 ID', 1, 160)
    if (!LEAD_STATUSES.has(status)) throw new Error('线索状态无效')
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

  previewLeadExport(options: LeadExportOptions = {}): LeadExportPreview {
    const defaultFields = ['platformKey', 'nickname', 'text', 'intentLevel', 'confidence', 'score', 'scoreReason', 'suggestedAction', 'status', 'note', 'lastContactedAt', 'nextFollowUpAt', 'createdAt']
    const fields = options.fields?.length ? options.fields : defaultFields
    const decision = this.policy.validateExportFields(fields)
    if (!decision.allowed) throw new Error(`导出字段包含敏感字段: ${decision.violations.join(', ')}`)
    const leads = this.repository.listLeads(options.filters)
    return {
      count: leads.length,
      fields,
      sampleRows: leads.slice(0, 5).map((lead) => this.policy.sanitizeRecord(lead as unknown as Record<string, unknown>))
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
    const safePlatformKey = validatePlatformKeys([platformKey], this.platforms.keys())[0]
    const safeUrl = assertHttpUrl(url, '内容链接', 2048)
    const task = this.tasks.create('parse_content', { url: safeUrl }, safePlatformKey)
    this.tasks.transition(task.id, 'running', { progress: 20 })
    try {
      this.assertRealtimePlatformAllowed(safePlatformKey, 'parse_content')
      const content = await this.platforms.get(safePlatformKey).parseContent(safeUrl)
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
    const safePlatformKey = validatePlatformKeys([platformKey], this.platforms.keys())[0]
    const safeUrl = assertHttpUrl(url, '内容链接', 2048)
    const task = this.tasks.create('collect_comments', { url: safeUrl }, safePlatformKey)
    this.tasks.transition(task.id, 'running', { progress: 5 })
    try {
      this.assertRealtimePlatformAllowed(safePlatformKey, 'collect_comments')
      const adapter = this.platforms.get(safePlatformKey)
      const content = await adapter.parseContent(safeUrl)
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
      const errorCode = classifyPlatformFailure(message, 'network_error')
      this.pausePlatformAfterRiskSignal(safePlatformKey, errorCode, message)
      this.tasks.transition(task.id, 'failed', {
        progress: 100,
        errorCode,
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

  private assertRealtimePlatformAllowed(platformKey: string, operation: 'search' | 'parse_content' | 'collect_comments'): void {
    const state = this.platformProtection.get(platformKey)
    if (!state) return
    if (state.pausedUntil <= Date.now()) {
      this.platformProtection.delete(platformKey)
      this.repository.deletePlatformProtection(platformKey)
      return
    }
    const until = new Date(state.pausedUntil).toLocaleString('zh-CN', { hour12: false })
    const operationText = operation === 'search' ? '搜索' : operation === 'parse_content' ? '内容解析' : '评论采集'
    throw new Error(`${this.platforms.get(platformKey).spec.name} 已因账号安全保护暂停真实${operationText}，预计 ${until} 后再试。原因：${state.reason}`)
  }

  private pausePlatformAfterRiskSignal(platformKey: string, errorCode: PlatformErrorCode, message: string): void {
    const adapter = this.platforms.get(platformKey)
    if (!requiresSingleItemCollection(adapter.spec) || !ACCOUNT_PROTECTION_ERROR_CODES.has(errorCode)) return
    const pausedUntil = Date.now() + ACCOUNT_PROTECTION_COOLDOWN_MS
    const reason = platformErrorMessage(message, '平台触发验证码、频率限制或权限风控')
    this.platformProtection.set(platformKey, { pausedUntil, reason })
    this.repository.savePlatformProtection({
      platformKey,
      pausedUntil: new Date(pausedUntil).toISOString(),
      reason,
      createdAt: new Date().toISOString()
    })
    this.audit(
      'platform.protection.paused',
      'platform',
      platformKey,
      `${adapter.spec.name} 已自动暂停真实评论采集 24 小时，保护账号安全：${reason}`
    )
  }

  private applyPlatformProtectionStatus(platformKey: string, status: PlatformStatus): PlatformStatus {
    const state = this.platformProtection.get(platformKey)
    if (!state) return status
    if (state.pausedUntil <= Date.now()) {
      this.platformProtection.delete(platformKey)
      this.repository.deletePlatformProtection(platformKey)
      return status
    }
    const until = new Date(state.pausedUntil).toLocaleString('zh-CN', { hour12: false })
    return {
      ...status,
      available: false,
      loggedIn: false,
      errorCode: 'rate_limited',
      message: `账号保护暂停真实采集至 ${until}。${state.reason}`
    }
  }

  private loadPlatformProtections(): void {
    for (const protection of this.repository.listPlatformProtections()) {
      const pausedUntil = Date.parse(protection.pausedUntil)
      if (Number.isFinite(pausedUntil)) {
        this.platformProtection.set(protection.platformKey, {
          pausedUntil,
          reason: protection.reason
        })
      }
    }
  }

  private registerConfiguredPlatformConnectors(): void {
    const configs = this.repository.listPlatformConnectorConfigs()
    for (const config of configs) {
      if (!config.enabled) continue
      const target = platformExpansionTargetSpecs.find((spec) => spec.key === config.platformKey)
      if (!target || target.connectorKind !== 'official_api') continue
      this.platforms.register(new OfficialApiPlatformAdapter(
        { ...target, integrationStatus: 'active' },
        (platformKey) => ({
          publicConfig: this.repository.listPlatformConnectorConfigs().find((item) => item.platformKey === platformKey),
          apiKey: this.repository.getPlatformConnectorSecret(platformKey)
        })
      ))
    }
  }

  private findKnownPlatformSpec(platformKey: string) {
    try {
      return this.platforms.get(platformKey).spec
    } catch {
      return platformExpansionTargetSpecs.find((spec) => spec.key === platformKey)
    }
  }
}

function assertStringLength(value: unknown, label: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length < minLength) throw new Error(`${label} 不能为空`)
  if (trimmed.length > maxLength) throw new Error(`${label} 长度不能超过 ${maxLength}`)
  return trimmed
}

function officialApiUsageDetails(error: unknown): { errorCode?: string; retryable?: boolean; quotaResetAt?: string } {
  if (!(error instanceof OfficialApiError)) return {}
  return {
    errorCode: error.code,
    retryable: error.retryable,
    quotaResetAt: error.code === 'quota_exhausted' ? nextLocalMidnightIso() : undefined
  }
}

function nextLocalMidnightIso(now = new Date()): string {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.toISOString()
}

function normalizeAuditLogFilters(input: number | AuditLogFilters): AuditLogFilters {
  if (typeof input === 'number') return { limit: clampInteger(input, 1, 1000, 100) }
  return {
    limit: clampInteger(input.limit ?? 100, 1, 1000, 100),
    actionPrefix: input.actionPrefix === undefined || input.actionPrefix.trim() === '' ? undefined : assertStringLength(input.actionPrefix, '审计动作前缀', 1, 120),
    targetType: input.targetType === undefined || input.targetType.trim() === '' ? undefined : assertStringLength(input.targetType, '审计目标类型', 1, 80),
    keyword: input.keyword === undefined || input.keyword.trim() === '' ? undefined : assertStringLength(input.keyword, '审计关键词', 1, 200)
  }
}

function assertHttpUrl(value: unknown, label: string, maxLength: number): string {
  const text = assertStringLength(value, label, 1, maxLength)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${label} 必须是有效链接`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${label} 仅支持 HTTP/HTTPS`)
  return parsed.toString()
}

function validatePlatformKeys(value: unknown, allowedKeys: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new Error('平台数量必须在 1 到 20 之间')
  const allowed = new Set(allowedKeys)
  const keys = [...new Set(value.map((item) => assertStringLength(item, '平台 key', 1, 80)))]
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`平台不存在: ${key}`)
  }
  return keys
}

function validateLeadUpdateInput(input: LeadUpdateInput): void {
  if (!input || typeof input !== 'object') throw new Error('线索更新内容必须是对象')
  if (input.status !== undefined && !LEAD_STATUSES.has(input.status)) throw new Error('线索状态无效')
  if (input.note !== undefined && input.note !== null && String(input.note).length > 5000) throw new Error('线索备注长度不能超过 5000')
  if (input.lastContactedAt !== undefined && input.lastContactedAt !== null) assertIsoDate(input.lastContactedAt, '上次联系时间')
  if (input.nextFollowUpAt !== undefined && input.nextFollowUpAt !== null) assertIsoDate(input.nextFollowUpAt, '下次跟进时间')
}

function validatePrivacyCleanupOptions(input: PrivacyCleanupOptions, allowedPlatformKeys: string[]): PrivacyCleanupOptions {
  if (!input || typeof input !== 'object') throw new Error('隐私清理参数必须是对象')
  return {
    platformProfiles: input.platformProfiles === true,
    platformKeys: input.platformKeys === undefined ? undefined : validatePlatformKeys(input.platformKeys, allowedPlatformKeys),
    platformState: input.platformState === true,
    searchData: input.searchData === true,
    commentsAndLeads: input.commentsAndLeads === true,
    tasks: input.tasks === true,
    auditLogs: input.auditLogs === true,
    aiSecretBackups: input.aiSecretBackups === true,
    localLogs: input.localLogs === true
  }
}

function validatePlatformConnectorConfig(input: Omit<PlatformConnectorConfig, 'updatedAt'>, allowedPlatformKeys: string[]): void {
  if (!input || typeof input !== 'object') throw new Error('平台接入配置必须是对象')
  validatePlatformKeys([input.platformKey], allowedPlatformKeys)
  if (input.apiBaseUrl !== undefined) assertHttpUrl(input.apiBaseUrl, '平台 API Base URL', 2048)
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('平台 API Key 必须是字符串')
  if (input.apiKey && input.apiKey.length > 5000) throw new Error('平台 API Key 长度不能超过 5000')
  if (input.quotaPerDay !== undefined && (!Number.isFinite(input.quotaPerDay) || input.quotaPerDay < 1 || input.quotaPerDay > 1_000_000)) {
    throw new Error('平台每日配额必须在 1 到 1000000 之间')
  }
  if (input.minDelayMs !== undefined && (!Number.isFinite(input.minDelayMs) || input.minDelayMs < 0 || input.minDelayMs > 86_400_000)) {
    throw new Error('平台请求间隔必须在 0 到 86400000 毫秒之间')
  }
  if (input.importTemplate !== undefined) {
    if (!Array.isArray(input.importTemplate.fields) || input.importTemplate.fields.length === 0) throw new Error('手动导入模板至少需要一个字段')
    for (const field of input.importTemplate.fields) assertStringLength(field, '导入字段名', 1, 80)
    for (const field of input.importTemplate.requiredFields ?? []) assertStringLength(field, '必填导入字段名', 1, 80)
    if (input.importTemplate.sample !== undefined && input.importTemplate.sample.length > 2000) throw new Error('导入模板示例长度不能超过 2000')
  }
}

function privacyCleanupSummary(result: PrivacyCleanupResult): string {
  return [
    `平台 Profile ${result.platformProfilesCleared}`,
    `平台状态 ${result.platformStateRowsCleared}`,
    `搜索 ${result.searchRowsCleared}`,
    `评论/内容 ${result.commentRowsCleared}`,
    `线索 ${result.leadRowsCleared}`,
    `任务 ${result.taskRowsCleared}`,
    `AI 密钥备份 ${result.aiSecretBackupRowsCleared}`,
    `本地日志 ${result.localLogFilesCleared}`
  ].join('；')
}

function assertIsoDate(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) throw new Error(`${label} 必须是有效时间`)
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function csvCell(value: unknown): string {
  if (Array.isArray(value)) return csvCell(value.join('|'))
  if (value === null || value === undefined) return ''
  const text = neutralizeSpreadsheetFormula(String(value))
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
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
  const privacyFiles = new PrivacyFileManager(options.logRoot)
  return new ApplicationCore(
    createBuiltinPlatformRegistry(browser),
    new AIService(new OpenAICompatibleLLMClient()),
    new CompliancePolicy(),
    new TaskOrchestrator(repository),
    repository,
    browser,
    privacyFiles
  )
}
