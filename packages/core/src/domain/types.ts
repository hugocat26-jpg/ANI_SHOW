export type PlatformCategory = 'search_engine' | 'video' | 'social' | 'forum' | 'ecommerce'

export type PlatformCapability =
  | 'search'
  | 'login'
  | 'status'
  | 'parse_content'
  | 'comments'
  | 'author'
  | 'hashtag_search'

export type PlatformErrorCode =
  | 'ok'
  | 'login_required'
  | 'captcha_required'
  | 'rate_limited'
  | 'network_error'
  | 'selector_changed'
  | 'no_results'
  | 'content_not_found'
  | 'permission_denied'
  | 'unsupported'

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

export type TaskType =
  | 'check_platform_status'
  | 'login_platform'
  | 'search'
  | 'parse_content'
  | 'collect_comments'
  | 'analyze_leads'
  | 'manual_import'
  | 'export'

export type IntentLevel = 'high' | 'medium' | 'low' | 'none'

export interface RateLimitPolicy {
  concurrency: number
  minDelayMs: number
  maxRetries: number
}

export type PlatformAuthMode = 'none' | 'optional_login' | 'required_login' | 'api_key' | 'manual_import'
export type PlatformRiskLevel = 'low' | 'medium' | 'high'
export type PlatformConnectorKind = 'official_api' | 'public_web' | 'logged_in_web' | 'manual_import' | 'hybrid'
export type PlatformIntegrationStatus = 'active' | 'planned' | 'manual_import' | 'official_api_preferred'

export interface PlatformSpec {
  key: string
  name: string
  category: PlatformCategory
  domains: string[]
  loginUrl?: string
  requiresLogin: boolean
  capabilities: PlatformCapability[]
  rateLimit: RateLimitPolicy
  authMode?: PlatformAuthMode
  riskLevel?: PlatformRiskLevel
  connectorKind?: PlatformConnectorKind
  integrationStatus?: PlatformIntegrationStatus
  complianceNotes?: string
  roadmapNotes?: string
}

export interface PlatformStatus {
  platformKey: string
  available: boolean
  loggedIn: boolean
  latencyMs: number | null
  checkedAt: string
  errorCode: PlatformErrorCode
  message: string
}

export interface PlatformProtection {
  platformKey: string
  pausedUntil: string
  reason: string
  createdAt: string
}

export interface SearchInput {
  keyword: string
  platformKeys: string[]
  limit: number
}

export interface SearchResult {
  id: string
  platformKey: string
  title: string
  url: string
  snippet: string
  relevance: number
  createdAt: string
}

export interface ContentRef {
  platformKey: string
  url: string
  contentId: string
  contentType: 'video' | 'image_text' | 'post' | 'unknown'
  title?: string
}

export interface CommentRecord {
  id: string
  platformKey: string
  contentId: string
  contentUrl: string
  nickname: string
  text: string
  likes: number
  publishedAt: string
  collectedAt: string
}

export interface ManualImportCommentInput {
  nickname?: string
  text: string
  likes?: number
  publishedAt?: string
  contentUrl?: string
}

export type ManualImportTemplateType = 'comment_csv' | 'wechat_article_csv' | 'social_comments_csv' | 'commerce_reviews_csv'
export type ManualImportConflictStrategy = 'skip_duplicates' | 'replace_existing'

export interface ManualImportInput {
  platformKey: string
  sourceUrl?: string
  title?: string
  body?: string
  templateType?: ManualImportTemplateType
  conflictStrategy?: ManualImportConflictStrategy
  comments?: ManualImportCommentInput[]
  csv?: string
}

export interface ManualImportResult {
  content: ContentRef
  commentsImported: number
  duplicatesSkipped?: number
  duplicatesUpdated?: number
  leadsGenerated: number
}

export interface ManualImportPreview {
  content: ContentRef
  templateType: ManualImportTemplateType
  conflictStrategy: ManualImportConflictStrategy
  parsedComments: number
  newComments: number
  duplicates: number
  updatableDuplicates: number
  sampleComments: ManualImportCommentInput[]
}

export interface KeywordPlan {
  seed: string
  keywords: string[]
  locales: string[]
}

export interface CommentInput {
  platformKey: string
  contentUrl: string
  nickname: string
  text: string
  likes: number
}

export interface IntentResult {
  level: IntentLevel
  confidence: number
  keywords: string[]
  reason: string
}

export interface LeadScore {
  score: number
  level: IntentLevel
  reason: string
  suggestedAction: string
}

export interface AIAnalysisContext {
  provider: AIProviderPublicConfig
  apiKey?: string
}

export interface AIAnalysisStats {
  total: number
  succeeded: number
  failed: number
  failuresByCode?: Record<string, number>
  modelUsed: number
  ruleFallback: number
  circuitOpen: boolean
  estimatedInputTokens: number
  estimatedOutputTokens: number
  estimatedCostUsd: number
  startedAt: string
  finishedAt?: string
}

export interface AIFailurePolicy {
  maxRetries: number
  retryDelayMs: number
  minDelayMs: number
  circuitBreakerThreshold: number
  updatedAt: string
}

export interface LeadRecord {
  id: string
  commentId: string
  platformKey: string
  contentId: string
  nickname: string
  text: string
  intentLevel: IntentLevel
  confidence: number
  keywords: string[]
  score: number
  scoreReason: string
  suggestedAction: string
  status: 'new' | 'contacted' | 'ignored'
  note?: string
  lastContactedAt?: string
  nextFollowUpAt?: string
  createdAt: string
}

export interface LeadDetail {
  lead: LeadRecord
  comment?: CommentRecord
  content?: ContentRef
}

export interface LeadUpdateInput {
  status?: LeadRecord['status']
  note?: string | null
  lastContactedAt?: string | null
  nextFollowUpAt?: string | null
}

export interface LeadFilters {
  status?: LeadRecord['status'] | 'all'
  platformKey?: string
  minScore?: number
  keyword?: string
}

export interface LeadExportOptions {
  fields?: string[]
  filters?: LeadFilters
}

export interface LeadExportResult {
  filename: string
  mimeType: 'text/csv'
  content: string
  count: number
  fields: string[]
}

export interface LeadExportPreview {
  count: number
  fields: string[]
  sampleRows: Array<Record<string, unknown>>
}

export type FollowUpReminderStatus = 'overdue' | 'today' | 'upcoming'

export interface FollowUpReminder {
  lead: LeadRecord
  status: FollowUpReminderStatus
  dueAt: string
  daysUntilDue: number
}

export interface FollowUpReminderOptions {
  horizonDays?: number
  now?: string
}

export interface CalendarExportResult {
  filename: string
  mimeType: 'text/calendar'
  content: string
  count: number
}

export type AIProviderKey = 'rule' | 'openai' | 'deepseek' | 'dashscope' | 'custom'

export interface AIProviderConfig {
  provider: AIProviderKey
  model: string
  baseUrl?: string
  apiKey?: string
  enabled: boolean
  updatedAt: string
}

export interface AIProviderPublicConfig {
  provider: AIProviderKey
  model: string
  baseUrl?: string
  enabled: boolean
  apiKeySet: boolean
  apiKeyPreview?: string
  secretStorage: 'none' | 'encrypted' | 'plain' | 'legacy_plain' | 'external_env' | 'unknown'
  updatedAt: string
}

export type AISecretHealthSeverity = 'ok' | 'warning' | 'critical'

export interface AISecretHealth {
  provider: AIProviderKey
  severity: AISecretHealthSeverity
  title: string
  message: string
  ageDays: number | null
  recommendedAction: 'none' | 'configure_key' | 'rotate_key' | 'migrate_secret'
}

export interface AISecretBackup {
  id: string
  provider: AIProviderKey
  reason: 'migration' | 'manual'
  secretStorage: AIProviderPublicConfig['secretStorage']
  apiKeySet: boolean
  createdAt: string
}

export interface ManualImportTemplate {
  fields: string[]
  requiredFields?: string[]
  sample?: string
}

export interface PlatformConnectorConfig {
  platformKey: string
  enabled: boolean
  apiBaseUrl?: string
  apiKey?: string
  quotaPerDay?: number
  minDelayMs?: number
  importTemplate?: ManualImportTemplate
  updatedAt: string
}

export interface PlatformConnectorPublicConfig {
  platformKey: string
  enabled: boolean
  apiBaseUrl?: string
  apiKeySet: boolean
  apiKeyPreview?: string
  secretStorage: AIProviderPublicConfig['secretStorage']
  quotaPerDay?: number
  minDelayMs?: number
  importTemplate?: ManualImportTemplate
  usageDate?: string
  usedToday?: number
  remainingToday?: number
  lastStatus?: 'ok' | 'failed'
  lastError?: string
  lastErrorCode?: string
  lastRetryable?: boolean
  quotaResetAt?: string
  lastRequestAt?: string
  updatedAt: string
}

export interface PrivacyCleanupOptions {
  platformProfiles?: boolean
  platformKeys?: string[]
  platformState?: boolean
  searchData?: boolean
  commentsAndLeads?: boolean
  tasks?: boolean
  auditLogs?: boolean
  aiSecretBackups?: boolean
  localLogs?: boolean
}

export interface PrivacyCleanupResult {
  platformProfilesCleared: number
  platformStateRowsCleared: number
  searchRowsCleared: number
  commentRowsCleared: number
  leadRowsCleared: number
  taskRowsCleared: number
  auditRowsCleared: number
  aiSecretBackupRowsCleared: number
  localLogFilesCleared: number
  localLogBytesCleared: number
}

export interface PrivacyCleanupEstimate extends PrivacyCleanupResult {
  platformProfilesFound: number
}

export interface Task {
  id: string
  type: TaskType
  status: TaskStatus
  platformKey?: string
  progress: number
  input: unknown
  errorCode?: PlatformErrorCode
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export interface AuditEvent {
  id: string
  action: string
  targetType: string
  targetId?: string
  message: string
  createdAt: string
}
