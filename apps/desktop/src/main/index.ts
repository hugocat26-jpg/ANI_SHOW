import { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDefaultApplicationCore, platformExpansionTargetSpecs, type ModelPricingView, type SecretCodec } from '../../../../packages/core/src/index.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

if (app.isPackaged && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0'
}

const core = createDefaultApplicationCore({
  dataPath: path.join(app.getPath('userData'), 'lead-miner.sqlite3'),
  profileRoot: path.join(app.getPath('userData'), 'profiles'),
  logRoot: app.getPath('logs'),
  secretCodec: createElectronSecretCodec()
})

const LEAD_STATUSES = new Set(['new', 'contacted', 'ignored'])
const AI_PROVIDERS = new Set(['rule', 'openai', 'deepseek', 'dashscope', 'custom'])
const SECRET_BACKUP_PROVIDERS = new Set(['openai', 'deepseek', 'dashscope', 'custom'])

function createElectronSecretCodec(): SecretCodec {
  return {
    encode(value: string) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统加密存储不可用，请改用 env:VAR_NAME 引用密钥或启用操作系统凭据保护')
      }
      return `safe:${safeStorage.encryptString(value).toString('base64')}`
    },
    decode(value: string) {
      if (value.startsWith('safe:')) {
        return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
      }
      if (value.startsWith('plain:')) return value.slice(6)
      return value
    },
    describe() {
      return safeStorage.isEncryptionAvailable() ? 'electron-safeStorage' : 'unavailable'
    },
    inspect(value: string) {
      if (value.startsWith('safe:')) return 'encrypted'
      if (value.startsWith('plain:')) return 'plain'
      return 'legacy_plain'
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: '客户线索挖掘平台',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  const devServerUrl = app.isPackaged ? undefined : trustedDevServerUrl(process.env.VITE_DEV_SERVER_URL)
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function handleTrusted(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event)
    return listener(event, ...args)
  })
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error(`Blocked IPC from untrusted renderer: ${senderUrl}`)
  }
}

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'file:') return url.pathname.replace(/\\/g, '/').endsWith('/renderer/index.html')
    if (!app.isPackaged && (url.protocol === 'http:' || url.protocol === 'https:')) {
      return isLoopbackHost(url.hostname)
    }
  } catch {
    return false
  }
  return false
}

function trustedDevServerUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return isLoopbackHost(url.hostname) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

handleTrusted('platform:list', () => core.platforms.list())
handleTrusted('platform:targets', () => platformExpansionTargetSpecs)
handleTrusted('platform:listConnectorConfigs', () => core.listPlatformConnectorConfigs())
handleTrusted('platform:connectorUsageHistory', (_event, input) => core.listPlatformConnectorUsageHistory(assertUsageHistoryDays(input)))
handleTrusted('platform:saveConnectorConfig', (_event, input) => core.savePlatformConnectorConfig(assertPlatformConnectorInput(input)))
handleTrusted('platform:status', () => core.checkPlatformStatuses())
handleTrusted('platform:login', (_event, platformKey) => core.loginPlatform(assertString(platformKey, '平台 key', 1, 80)))
handleTrusted('search:plan', (_event, keyword) => core.planSearch(assertString(keyword, '搜索关键词', 1, 200)))
handleTrusted('search:run', (_event, input) => {
  const value = assertSearchRunInput(input)
  return core.searchAcrossPlatforms(value.keyword, value.platformKeys)
})
handleTrusted('search:results', () => core.listSearchResults())
handleTrusted('collect:comments', (_event, input) => {
  const value = assertCollectCommentsInput(input)
  return core.collectComments(value.platformKey, value.url)
})
handleTrusted('import:previewManualContent', (_event, input) => core.previewManualContent(assertManualContentInput(input)))
handleTrusted('import:manualContent', (_event, input) => core.importManualContent(assertManualContentInput(input)))
handleTrusted('comments:list', (_event, contentId) => core.listComments(contentId === undefined ? undefined : assertString(contentId, '内容 ID', 1, 240)))
handleTrusted('leads:list', (_event, filters) => core.listLeads(assertLeadFilters(filters)))
handleTrusted('leads:detail', (_event, id) => core.getLeadDetail(assertString(id, '线索 ID', 1, 160)))
handleTrusted('followups:list', (_event, options) => core.listFollowUpReminders(assertFollowUpOptions(options)))
handleTrusted('followups:exportCalendar', (_event, options) => core.exportFollowUpsCalendar(assertFollowUpOptions(options)))
handleTrusted('followups:exportCalendarToFile', async (_event, options) => {
  const result = core.exportFollowUpsCalendar(assertFollowUpOptions(options))
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出跟进日历',
    defaultPath: result.filename,
    filters: [{ name: '日历文件', extensions: ['ics'] }]
  })
  if (canceled || !filePath) return { canceled: true, count: result.count }
  await writeFile(filePath, result.content, 'utf8')
  return { canceled: false, filePath, count: result.count }
})
handleTrusted('leads:analyze', () => core.analyzeComments())
handleTrusted('leads:updateStatus', (_event, input) =>
  core.updateLeadStatus(assertObjectFieldString(input, 'id', '线索 ID', 1, 160), assertLeadStatus(assertObject(input, '线索状态更新').status))
)
handleTrusted('leads:update', (_event, input) => {
  const value = assertObject(input, '线索更新')
  return core.updateLead(assertString(value.id, '线索 ID', 1, 160), assertLeadUpdatePatch(value.patch))
})
handleTrusted('leads:bulkUpdateStatus', (_event, input) => {
  const value = assertBulkLeadStatusInput(input)
  return core.updateLeadStatuses(value.ids, value.status)
})
handleTrusted('leads:export', (_event, input) => core.exportLeads(assertLeadExportOptions(input)))
handleTrusted('leads:previewExport', (_event, input) => core.previewLeadExport(assertLeadExportOptions(input)))
handleTrusted('leads:exportToFile', async (_event, input) => {
  const result = core.exportLeads(assertLeadExportOptions(input))
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出线索 CSV',
    defaultPath: result.filename,
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
  })
  if (canceled || !filePath) return { canceled: true, count: result.count }
  await writeFile(filePath, result.content, 'utf8')
  return { canceled: false, filePath, count: result.count }
})
handleTrusted('audit:list', (_event, input) => core.listAuditLogs(assertAuditLogInput(input)))
handleTrusted('app:version', () => app.getVersion())
handleTrusted('ai:listProviders', () => core.listAIProviders())
handleTrusted('ai:secretHealth', () => core.listAISecretHealth())
handleTrusted('ai:saveProvider', (_event, input) => core.saveAIProviderConfig(assertAIProviderInput(input)))
handleTrusted('ai:migrateSecrets', (_event, provider) =>
  core.migrateAIProviderSecrets(provider === undefined ? undefined : assertAIProvider(provider, true))
)
handleTrusted('ai:listSecretBackups', (_event, provider) =>
  core.listAISecretBackups(provider === undefined ? undefined : assertAIProvider(provider, true))
)
handleTrusted('ai:restoreSecretBackup', (_event, id) => core.restoreAISecretBackup(assertString(id, '密钥备份 ID', 1, 180)))
handleTrusted('ai:analysisStats', () => core.getAIAnalysisStats())
handleTrusted('ai:modelPricing', () => core.listModelPricing())
handleTrusted('ai:currentModelPricing', () => core.currentModelPricing())
handleTrusted('ai:saveCustomModelPricing', (_event, input) => core.saveCustomModelPricing(assertCustomModelPricing(input)))
handleTrusted('ai:failurePolicy', () => core.getAIFailurePolicy())
handleTrusted('ai:saveFailurePolicy', (_event, input) => core.saveAIFailurePolicy(assertAIFailurePolicy(input)))
handleTrusted('ai:failurePolicyPresets', () => core.listAIFailurePolicyPresets())
handleTrusted('ai:recoveryAdvice', () => core.getAIRecoveryAdvice())
handleTrusted('notify:followups', (_event, input) => {
  const value = assertOptionalObject(input, '跟进提醒') ?? {}
  const overdue = Math.max(0, clampInteger(value.overdue ?? 0, '逾期数量', 0, 10000))
  const today = Math.max(0, clampInteger(value.today ?? 0, '今日数量', 0, 10000))
  if (overdue + today === 0 || !Notification.isSupported()) return { shown: false }
  new Notification({
    title: '线索跟进提醒',
    body: overdue > 0 ? `${overdue} 条线索已逾期，${today} 条线索今日需跟进。` : `${today} 条线索今日需跟进。`
  }).show()
  return { shown: true }
})
handleTrusted('notify:aiRecovery', (_event, input) => {
  const value = assertOptionalObject(input, 'AI 恢复提醒') ?? {}
  const severity = value.severity === 'critical' ? 'critical' : value.severity === 'warning' ? 'warning' : 'info'
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 120) : 'AI 分析提醒'
  const actions = Array.isArray(value.actions) ? value.actions.filter((action: unknown) => typeof action === 'string' && action.trim()).slice(0, 10) : []
  if (severity === 'info' || !Notification.isSupported()) return { shown: false }
  new Notification({
    title: severity === 'critical' ? 'AI 分析已触发熔断' : 'AI 分析需要关注',
    body: actions.length > 0 ? `${title}：${actions[0]}` : title
  }).show()
  return { shown: true }
})
handleTrusted('privacy:previewCleanup', (_event, input) => core.previewPrivacyCleanup(assertPrivacyCleanupOptions(input)))
handleTrusted('privacy:cleanup', (_event, input) => core.cleanupPrivacyData(assertPrivacyCleanupOptions(input)))
handleTrusted('task:list', () => core.tasks.list())

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function assertOptionalObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return assertObject(value, label)
}

function assertString(value: unknown, label: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed.length < minLength) throw new Error(`${label} 不能为空`)
  if (trimmed.length > maxLength) throw new Error(`${label} 长度不能超过 ${maxLength}`)
  return trimmed
}

function assertOptionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return assertString(value, label, 1, maxLength)
}

function assertObjectFieldString(value: unknown, key: string, label: string, minLength: number, maxLength: number): string {
  return assertString(assertObject(value, label)[key], label, minLength, maxLength)
}

function assertStringArray(value: unknown, label: string, minItems: number, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new Error(`${label} 数量必须在 ${minItems} 到 ${maxItems} 之间`)
  }
  return [...new Set(value.map((item) => assertString(item, label, 1, maxItemLength)))]
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

function clampInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是数字`)
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function assertOptionalIsoDate(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const text = assertString(value, label, 1, 80)
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} 必须是有效时间`)
  return text
}

function assertSearchRunInput(input: unknown): { keyword: string; platformKeys: string[] } {
  const value = assertObject(input, '搜索参数')
  return {
    keyword: assertString(value.keyword, '搜索关键词', 1, 200),
    platformKeys: assertStringArray(value.platformKeys, '平台 key', 1, 20, 80)
  }
}

function assertCollectCommentsInput(input: unknown): { platformKey: string; url: string } {
  const value = assertObject(input, '评论采集参数')
  return {
    platformKey: assertString(value.platformKey, '平台 key', 1, 80),
    url: assertHttpUrl(value.url, '内容链接', 2048)
  }
}

function assertLeadStatus(value: unknown): 'new' | 'contacted' | 'ignored' {
  const status = assertString(value, '线索状态', 1, 32)
  if (!LEAD_STATUSES.has(status)) throw new Error('线索状态无效')
  return status as 'new' | 'contacted' | 'ignored'
}

function assertLeadFilters(input: unknown): { status?: 'new' | 'contacted' | 'ignored' | 'all'; platformKey?: string; minScore?: number; keyword?: string } {
  const value = assertOptionalObject(input, '线索筛选') ?? {}
  const status = value.status === undefined ? undefined : assertString(value.status, '线索状态', 1, 32)
  if (status !== undefined && status !== 'all' && !LEAD_STATUSES.has(status)) throw new Error('线索状态无效')
  const minScore = value.minScore === undefined ? undefined : clampInteger(value.minScore, '最低评分', 0, 100)
  return {
    status: status as 'new' | 'contacted' | 'ignored' | 'all' | undefined,
    platformKey: assertOptionalString(value.platformKey, '平台 key', 80),
    minScore,
    keyword: assertOptionalString(value.keyword, '筛选关键词', 200)
  }
}

function assertLeadUpdatePatch(input: unknown): { status?: 'new' | 'contacted' | 'ignored'; note?: string | null; lastContactedAt?: string | null; nextFollowUpAt?: string | null } {
  const value = assertObject(input, '线索更新内容')
  const allowed = new Set(['status', 'note', 'lastContactedAt', 'nextFollowUpAt'])
  if (!Object.keys(value).some((key) => allowed.has(key))) throw new Error('线索更新内容没有有效字段')
  return {
    status: value.status === undefined ? undefined : assertLeadStatus(value.status),
    note: value.note === undefined ? undefined : value.note === null ? null : assertString(value.note, '线索备注', 0, 5000),
    lastContactedAt: assertOptionalIsoDate(value.lastContactedAt, '上次联系时间'),
    nextFollowUpAt: assertOptionalIsoDate(value.nextFollowUpAt, '下次跟进时间')
  }
}

function assertBulkLeadStatusInput(input: unknown): { ids: string[]; status: 'new' | 'contacted' | 'ignored' } {
  const value = assertObject(input, '批量线索状态更新')
  return {
    ids: assertStringArray(value.ids, '线索 ID', 1, 500, 160),
    status: assertLeadStatus(value.status)
  }
}

function assertLeadExportOptions(input: unknown): { fields?: string[]; filters?: ReturnType<typeof assertLeadFilters> } {
  const value = assertOptionalObject(input, '线索导出参数') ?? {}
  return {
    fields: value.fields === undefined ? undefined : assertStringArray(value.fields, '导出字段', 1, 80, 80),
    filters: value.filters === undefined ? undefined : assertLeadFilters(value.filters)
  }
}

function assertFollowUpOptions(input: unknown): { horizonDays?: number; now?: string } {
  const value = assertOptionalObject(input, '跟进提醒参数') ?? {}
  return {
    horizonDays: value.horizonDays === undefined ? undefined : clampInteger(value.horizonDays, '提醒天数', 0, 365),
    now: value.now === undefined ? undefined : assertOptionalIsoDate(value.now, '当前时间') ?? undefined
  }
}

function assertAIProvider(value: unknown, allowUndefined = false): 'openai' | 'deepseek' | 'dashscope' | 'custom' {
  if (value === undefined && allowUndefined) return value as never
  const provider = assertString(value, 'AI Provider', 1, 32)
  if (!SECRET_BACKUP_PROVIDERS.has(provider)) throw new Error('AI Provider 无效')
  return provider as 'openai' | 'deepseek' | 'dashscope' | 'custom'
}

function assertAIProviderInput(input: unknown): { provider: 'rule' | 'openai' | 'deepseek' | 'dashscope' | 'custom'; model: string; baseUrl?: string; apiKey?: string; enabled: boolean } {
  const value = assertObject(input, 'AI Provider 配置')
  const provider = assertString(value.provider, 'AI Provider', 1, 32)
  if (!AI_PROVIDERS.has(provider)) throw new Error('AI Provider 无效')
  return {
    provider: provider as 'rule' | 'openai' | 'deepseek' | 'dashscope' | 'custom',
    model: assertString(value.model, '模型名称', 1, 160),
    baseUrl: assertOptionalString(value.baseUrl, 'Base URL', 2048),
    apiKey: assertOptionalString(value.apiKey, 'API Key', 4096),
    enabled: value.enabled === true
  }
}

function assertPlatformConnectorInput(input: unknown): { platformKey: string; enabled: boolean; apiBaseUrl?: string; apiKey?: string; quotaPerDay?: number; minDelayMs?: number; importTemplate?: { fields: string[]; requiredFields?: string[]; sample?: string } } {
  const value = assertObject(input, '平台接入配置')
  const importTemplate = value.importTemplate === undefined ? undefined : assertManualImportTemplate(value.importTemplate)
  return {
    platformKey: assertString(value.platformKey, '平台 key', 1, 80),
    enabled: value.enabled === true,
    apiBaseUrl: assertOptionalString(value.apiBaseUrl, '平台 API Base URL', 2048),
    apiKey: assertOptionalString(value.apiKey, '平台 API Key', 5000),
    quotaPerDay: value.quotaPerDay === undefined ? undefined : clampInteger(value.quotaPerDay, '平台每日配额', 1, 1_000_000),
    minDelayMs: value.minDelayMs === undefined ? undefined : clampInteger(value.minDelayMs, '平台请求间隔', 0, 86_400_000),
    importTemplate
  }
}

function assertUsageHistoryDays(input: unknown): number {
  if (input === undefined) return 7
  if (typeof input === 'number') return clampInteger(input, '用量历史天数', 1, 30)
  const value = assertObject(input, '用量历史筛选')
  return value.days === undefined ? 7 : clampInteger(value.days, '用量历史天数', 1, 30)
}

function assertManualImportTemplate(input: unknown): { fields: string[]; requiredFields?: string[]; sample?: string } {
  const value = assertObject(input, '手动导入模板')
  return {
    fields: assertStringArray(value.fields, '导入字段', 1, 80, 80),
    requiredFields: value.requiredFields === undefined ? undefined : assertStringArray(value.requiredFields, '必填导入字段', 0, 80, 80),
    sample: assertOptionalString(value.sample, '导入示例', 2000)
  }
}

function assertManualContentInput(input: unknown): { platformKey: string; sourceUrl?: string; title?: string; body?: string; templateType?: 'comment_csv' | 'wechat_article_csv' | 'social_comments_csv' | 'commerce_reviews_csv'; conflictStrategy?: 'skip_duplicates' | 'replace_existing'; comments?: Array<{ nickname?: string; text: string; likes?: number; publishedAt?: string; contentUrl?: string }>; csv?: string } {
  const value = assertObject(input, '手动内容导入')
  return {
    platformKey: assertString(value.platformKey, '平台 key', 1, 80),
    sourceUrl: assertOptionalString(value.sourceUrl, '来源链接', 2048),
    title: assertOptionalString(value.title, '标题', 300),
    body: assertOptionalString(value.body, '正文', 200000),
    templateType: value.templateType === undefined ? undefined : assertManualTemplateType(value.templateType),
    conflictStrategy: value.conflictStrategy === undefined ? undefined : assertManualConflictStrategy(value.conflictStrategy),
    comments: value.comments === undefined ? undefined : assertManualComments(value.comments),
    csv: assertOptionalString(value.csv, '评论 CSV', 1000000)
  }
}

function assertManualTemplateType(input: unknown): 'comment_csv' | 'wechat_article_csv' | 'social_comments_csv' | 'commerce_reviews_csv' {
  if (input === 'comment_csv' || input === 'wechat_article_csv' || input === 'social_comments_csv' || input === 'commerce_reviews_csv') return input
  throw new Error('手动导入模板类型无效')
}

function assertManualConflictStrategy(input: unknown): 'skip_duplicates' | 'replace_existing' {
  if (input === 'skip_duplicates' || input === 'replace_existing') return input
  throw new Error('手动导入冲突策略无效')
}

function assertManualComments(input: unknown): Array<{ nickname?: string; text: string; likes?: number; publishedAt?: string; contentUrl?: string }> {
  if (!Array.isArray(input) || input.length > 1000) throw new Error('手动评论数量必须在 0 到 1000 之间')
  return input.map((item) => {
    const value = assertObject(item, '手动评论')
    return {
      nickname: assertOptionalString(value.nickname, '评论昵称', 160),
      text: assertString(value.text, '评论内容', 1, 5000),
      likes: value.likes === undefined ? undefined : clampInteger(value.likes, '点赞数', 0, 1_000_000_000),
      publishedAt: value.publishedAt === undefined ? undefined : assertOptionalIsoDate(value.publishedAt, '发布时间') ?? undefined,
      contentUrl: assertOptionalString(value.contentUrl, '评论链接', 2048)
    }
  })
}

function assertAuditLogInput(input: unknown): number | { limit?: number; actionPrefix?: string; targetType?: string; keyword?: string } {
  if (input === undefined) return 100
  if (typeof input === 'number') return clampInteger(input, '审计日志数量', 1, 1000)
  const value = assertObject(input, '审计日志筛选')
  return {
    limit: value.limit === undefined ? undefined : clampInteger(value.limit, '审计日志数量', 1, 1000),
    actionPrefix: assertOptionalString(value.actionPrefix, '审计动作前缀', 120),
    targetType: assertOptionalString(value.targetType, '审计目标类型', 80),
    keyword: assertOptionalString(value.keyword, '审计关键词', 200)
  }
}

function assertCustomModelPricing(input: unknown): ModelPricingView[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error('自定义模型价格数量不能超过 100')
  return input.map((item) => {
    const value = assertObject(item, '自定义模型价格')
    const provider = assertString(value.provider, 'AI Provider', 1, 32)
    const inputPrice = Number(value.inputUsdPerMillionTokens)
    const outputPrice = Number(value.outputUsdPerMillionTokens)
    if (!AI_PROVIDERS.has(provider)) throw new Error('AI Provider 无效')
    if (!Number.isFinite(inputPrice) || inputPrice < 0 || inputPrice > 10000) throw new Error('输入价格无效')
    if (!Number.isFinite(outputPrice) || outputPrice < 0 || outputPrice > 10000) throw new Error('输出价格无效')
    return {
      provider: provider as ModelPricingView['provider'],
      modelPattern: assertString(value.modelPattern, '模型匹配规则', 1, 240),
      inputUsdPerMillionTokens: inputPrice,
      outputUsdPerMillionTokens: outputPrice
    }
  })
}

function assertAIFailurePolicy(input: unknown): { maxRetries: number; retryDelayMs: number; minDelayMs: number; circuitBreakerThreshold: number } {
  const value = assertObject(input, 'AI 失败策略')
  return {
    maxRetries: clampInteger(value.maxRetries, '最大重试次数', 0, 10),
    retryDelayMs: clampInteger(value.retryDelayMs, '重试延迟', 0, 3_600_000),
    minDelayMs: clampInteger(value.minDelayMs, '最小间隔', 0, 3_600_000),
    circuitBreakerThreshold: clampInteger(value.circuitBreakerThreshold, '熔断阈值', 0, 1000)
  }
}

function assertPrivacyCleanupOptions(input: unknown): { platformProfiles?: boolean; platformKeys?: string[]; platformState?: boolean; searchData?: boolean; commentsAndLeads?: boolean; tasks?: boolean; auditLogs?: boolean; aiSecretBackups?: boolean; localLogs?: boolean } {
  const value = assertObject(input, '隐私清理参数')
  return {
    platformProfiles: value.platformProfiles === true,
    platformKeys: value.platformKeys === undefined ? undefined : assertStringArray(value.platformKeys, '平台 key', 1, 20, 80),
    platformState: value.platformState === true,
    searchData: value.searchData === true,
    commentsAndLeads: value.commentsAndLeads === true,
    tasks: value.tasks === true,
    auditLogs: value.auditLogs === true,
    aiSecretBackups: value.aiSecretBackups === true,
    localLogs: value.localLogs === true
  }
}
