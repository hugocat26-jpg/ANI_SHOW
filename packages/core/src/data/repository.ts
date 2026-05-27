import { DatabaseSync } from 'node:sqlite'

import type {
  AIProviderConfig,
  AIProviderPublicConfig,
  AISecretBackup,
  AIFailurePolicy,
  AuditEvent,
  AuditLogFilters,
  CommentRecord,
  ContentRef,
  FollowUpReminder,
  FollowUpReminderOptions,
  LeadFilters,
  LeadDetail,
  LeadRecord,
  LeadUpdateInput,
  PlatformConnectorConfig,
  PlatformConnectorPublicConfig,
  PlatformConnectorUsageDay,
  PlatformConnectorUsageHistory,
  PlatformProtection,
  PlatformStatus,
  SearchResult,
  Task
} from '../domain/types.ts'
import type { ModelPricingView } from '../ai/model-pricing.ts'
import { normalizeCustomPricing } from '../ai/model-pricing.ts'
import { normalizeAIProviderBaseUrl } from '../ai/provider-url.ts'
import { PlainSecretCodec, type SecretCodec } from '../security/secret-codec.ts'

const MAX_AI_SECRET_BACKUPS_PER_PROVIDER = 5
const PLATFORM_CONNECTOR_CONFIGS_KEY = 'platform.connector_configs'
const PLATFORM_CONNECTOR_USAGE_KEY = 'platform.connector_usage'

export interface SearchSessionRecord {
  id: string
  keyword: string
  platformKeys: string[]
  createdAt: string
}

interface StoredPlatformConnectorConfig {
  platformKey: string
  enabled: boolean
  apiBaseUrl?: string
  apiKey?: string
  quotaPerDay?: number
  minDelayMs?: number
  importTemplate?: PlatformConnectorConfig['importTemplate']
  updatedAt: string
}

interface StoredPlatformConnectorUsage {
  platformKey: string
  date: string
  usedToday: number
  successCount?: number
  failureCount?: number
  quotaExhaustedCount?: number
  retryableFailureCount?: number
  lastStatus: 'ok' | 'failed'
  lastError?: string
  lastErrorCode?: string
  lastRetryable?: boolean
  quotaResetAt?: string
  lastRequestAt: string
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function defaultAIFailurePolicy(): AIFailurePolicy {
  return {
    maxRetries: 1,
    retryDelayMs: 800,
    minDelayMs: 0,
    circuitBreakerThreshold: 5,
    updatedAt: new Date().toISOString()
  }
}

function normalizeEnvSecretRef(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('env:')) return null
  const name = trimmed.slice(4).trim()
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `env:${name}` : null
}

function envSecretName(value: string): string | null {
  return normalizeEnvSecretRef(value)?.slice(4) ?? null
}

export class LeadMinerRepository {
  private db: DatabaseSync
  private secretCodec: SecretCodec

  constructor(path = ':memory:', secretCodec: SecretCodec = new PlainSecretCodec()) {
    this.db = new DatabaseSync(path)
    this.secretCodec = secretCodec
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_statuses (
        platform_key TEXT PRIMARY KEY,
        available INTEGER NOT NULL,
        logged_in INTEGER NOT NULL,
        latency_ms INTEGER,
        checked_at TEXT NOT NULL,
        error_code TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_sessions (
        id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        platform_keys TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        platform_key TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        snippet TEXT NOT NULL,
        relevance REAL NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, url)
      );

      CREATE TABLE IF NOT EXISTS contents (
        platform_key TEXT NOT NULL,
        content_id TEXT NOT NULL,
        url TEXT NOT NULL,
        content_type TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(platform_key, content_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        platform_key TEXT NOT NULL,
        content_id TEXT NOT NULL,
        content_url TEXT NOT NULL,
        nickname TEXT NOT NULL,
        text TEXT NOT NULL,
        likes INTEGER NOT NULL,
        published_at TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL UNIQUE,
        platform_key TEXT NOT NULL,
        content_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        text TEXT NOT NULL,
        intent_level TEXT NOT NULL,
        confidence REAL NOT NULL,
        keywords TEXT NOT NULL,
        score INTEGER NOT NULL,
        suggested_action TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        platform_key TEXT,
        progress INTEGER NOT NULL,
        input TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_provider_configs (
        provider TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_secret_backups (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        base_url TEXT,
        api_key TEXT,
        enabled INTEGER NOT NULL,
        reason TEXT NOT NULL,
        secret_storage TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_protections (
        platform_key TEXT PRIMARY KEY,
        paused_until TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    this.addColumnIfMissing('leads', 'note', 'TEXT')
    this.addColumnIfMissing('leads', 'last_contacted_at', 'TEXT')
    this.addColumnIfMissing('leads', 'next_follow_up_at', 'TEXT')
    this.addColumnIfMissing('leads', 'score_reason', 'TEXT')
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>
    if (!rows.some((row) => String(row.name) === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  savePlatformStatus(status: PlatformStatus): void {
    this.db.prepare(`
      INSERT INTO platform_statuses (
        platform_key, available, logged_in, latency_ms, checked_at, error_code, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_key) DO UPDATE SET
        available = excluded.available,
        logged_in = excluded.logged_in,
        latency_ms = excluded.latency_ms,
        checked_at = excluded.checked_at,
        error_code = excluded.error_code,
        message = excluded.message
    `).run(
      status.platformKey,
      status.available ? 1 : 0,
      status.loggedIn ? 1 : 0,
      status.latencyMs,
      status.checkedAt,
      status.errorCode,
      status.message
    )
  }

  listPlatformStatuses(): PlatformStatus[] {
    const rows = this.db.prepare('SELECT * FROM platform_statuses ORDER BY platform_key').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      platformKey: String(row.platform_key),
      available: Number(row.available) === 1,
      loggedIn: Number(row.logged_in) === 1,
      latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
      checkedAt: String(row.checked_at),
      errorCode: String(row.error_code) as PlatformStatus['errorCode'],
      message: String(row.message)
    }))
  }

  savePlatformProtection(protection: PlatformProtection): void {
    this.db.prepare(`
      INSERT INTO platform_protections (
        platform_key, paused_until, reason, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform_key) DO UPDATE SET
        paused_until = excluded.paused_until,
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(
      protection.platformKey,
      protection.pausedUntil,
      protection.reason,
      protection.createdAt
    )
  }

  deletePlatformProtection(platformKey: string): void {
    this.db.prepare('DELETE FROM platform_protections WHERE platform_key = ?').run(platformKey)
  }

  listPlatformProtections(now = new Date()): PlatformProtection[] {
    const rows = this.db.prepare('SELECT * FROM platform_protections ORDER BY platform_key').all() as Array<Record<string, unknown>>
    const active: PlatformProtection[] = []
    for (const row of rows) {
      const protection = {
        platformKey: String(row.platform_key),
        pausedUntil: String(row.paused_until),
        reason: String(row.reason),
        createdAt: String(row.created_at)
      }
      if (Date.parse(protection.pausedUntil) <= now.getTime()) {
        this.deletePlatformProtection(protection.platformKey)
      } else {
        active.push(protection)
      }
    }
    return active
  }

  clearPlatformState(): number {
    const statuses = runChanges(this.db.prepare('DELETE FROM platform_statuses').run())
    const protections = runChanges(this.db.prepare('DELETE FROM platform_protections').run())
    return statuses + protections
  }

  createSearchSession(keyword: string, platformKeys: string[]): SearchSessionRecord {
    const session = {
      id: `search-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      keyword,
      platformKeys,
      createdAt: new Date().toISOString()
    }
    this.db.prepare('INSERT INTO search_sessions (id, keyword, platform_keys, created_at) VALUES (?, ?, ?, ?)').run(
      session.id,
      session.keyword,
      json(session.platformKeys),
      session.createdAt
    )
    return session
  }

  saveSearchResults(sessionId: string, results: SearchResult[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO search_results (
        id, session_id, platform_key, title, url, snippet, relevance, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.db.exec('BEGIN')
    try {
      for (const item of results) {
        insert.run(item.id, sessionId, item.platformKey, item.title, item.url, item.snippet, item.relevance, item.createdAt)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listSearchResults(sessionId?: string): SearchResult[] {
    const query = sessionId
      ? this.db.prepare('SELECT * FROM search_results WHERE session_id = ? ORDER BY relevance DESC, created_at DESC').all(sessionId)
      : this.db.prepare('SELECT * FROM search_results ORDER BY created_at DESC').all()
    return (query as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      platformKey: String(row.platform_key),
      title: String(row.title),
      url: String(row.url),
      snippet: String(row.snippet),
      relevance: Number(row.relevance),
      createdAt: String(row.created_at)
    }))
  }

  clearSearchData(): number {
    this.db.exec('BEGIN')
    try {
      const results = runChanges(this.db.prepare('DELETE FROM search_results').run())
      const sessions = runChanges(this.db.prepare('DELETE FROM search_sessions').run())
      this.db.exec('COMMIT')
      return results + sessions
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  countSearchData(): number {
    return this.countRows('search_results') + this.countRows('search_sessions')
  }

  saveContent(content: ContentRef): void {
    this.db.prepare(`
      INSERT INTO contents (
        platform_key, content_id, url, content_type, title, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_key, content_id) DO UPDATE SET
        url = excluded.url,
        content_type = excluded.content_type,
        title = excluded.title
    `).run(
      content.platformKey,
      content.contentId,
      content.url,
      content.contentType,
      content.title ?? null,
      new Date().toISOString()
    )
  }

  listContents(): ContentRef[] {
    const rows = this.db.prepare('SELECT * FROM contents ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((row) => this.mapContent(row))
  }

  saveComment(comment: CommentRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO comments (
        id, platform_key, content_id, content_url, nickname, text, likes, published_at, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      comment.id,
      comment.platformKey,
      comment.contentId,
      comment.contentUrl,
      comment.nickname,
      comment.text,
      comment.likes,
      comment.publishedAt,
      comment.collectedAt
    )
  }

  listComments(contentId?: string): CommentRecord[] {
    const rows = contentId
      ? this.db.prepare('SELECT * FROM comments WHERE content_id = ? ORDER BY collected_at DESC').all(contentId)
      : this.db.prepare('SELECT * FROM comments ORDER BY collected_at DESC').all()
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapComment(row))
  }

  clearCommentsAndLeads(): { comments: number; leads: number; contents: number } {
    this.db.exec('BEGIN')
    try {
      const leads = runChanges(this.db.prepare('DELETE FROM leads').run())
      const comments = runChanges(this.db.prepare('DELETE FROM comments').run())
      const contents = runChanges(this.db.prepare('DELETE FROM contents').run())
      this.db.exec('COMMIT')
      return { comments, leads, contents }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  countCommentsAndLeads(): { comments: number; leads: number; contents: number } {
    return {
      comments: this.countRows('comments'),
      leads: this.countRows('leads'),
      contents: this.countRows('contents')
    }
  }

  saveLead(lead: LeadRecord): void {
    this.db.prepare(`
      INSERT INTO leads (
        id, comment_id, platform_key, content_id, nickname, text, intent_level, confidence,
        keywords, score, score_reason, suggested_action, status, note, last_contacted_at, next_follow_up_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(comment_id) DO UPDATE SET
        intent_level = excluded.intent_level,
        confidence = excluded.confidence,
        keywords = excluded.keywords,
        score = excluded.score,
        score_reason = excluded.score_reason,
        suggested_action = excluded.suggested_action,
        status = excluded.status,
        note = COALESCE(leads.note, excluded.note),
        last_contacted_at = COALESCE(leads.last_contacted_at, excluded.last_contacted_at),
        next_follow_up_at = COALESCE(leads.next_follow_up_at, excluded.next_follow_up_at)
    `).run(
      lead.id,
      lead.commentId,
      lead.platformKey,
      lead.contentId,
      lead.nickname,
      lead.text,
      lead.intentLevel,
      lead.confidence,
      json(lead.keywords),
      lead.score,
      lead.scoreReason,
      lead.suggestedAction,
      lead.status,
      lead.note ?? null,
      lead.lastContactedAt ?? null,
      lead.nextFollowUpAt ?? null,
      lead.createdAt
    )
  }

  listLeads(filters: LeadFilters = {}): LeadRecord[] {
    const where: string[] = []
    const params: Array<number | string> = []
    if (filters.status && filters.status !== 'all') {
      where.push('status = ?')
      params.push(filters.status)
    }
    if (filters.platformKey) {
      where.push('platform_key = ?')
      params.push(filters.platformKey)
    }
    if (typeof filters.minScore === 'number') {
      where.push('score >= ?')
      params.push(filters.minScore)
    }
    if (filters.keyword?.trim()) {
      where.push('(nickname LIKE ? OR text LIKE ? OR keywords LIKE ?)')
      const like = `%${filters.keyword.trim()}%`
      params.push(like, like, like)
    }
    const sql = `SELECT * FROM leads${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY score DESC, created_at DESC`
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((row) => this.mapLead(row))
  }

  getLeadDetail(id: string): LeadDetail | null {
    const leadRow = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!leadRow) return null
    const lead = this.mapLead(leadRow)
    const commentRow = this.db.prepare('SELECT * FROM comments WHERE id = ?').get(lead.commentId) as Record<string, unknown> | undefined
    const contentRow = this.db.prepare('SELECT * FROM contents WHERE platform_key = ? AND content_id = ?').get(lead.platformKey, lead.contentId) as Record<string, unknown> | undefined
    return {
      lead,
      comment: commentRow ? this.mapComment(commentRow) : undefined,
      content: contentRow ? this.mapContent(contentRow) : undefined
    }
  }

  listFollowUpReminders(options: FollowUpReminderOptions = {}): FollowUpReminder[] {
    const now = options.now ? new Date(options.now) : new Date()
    const horizonDays = Math.max(0, Math.floor(options.horizonDays ?? 7))
    const horizonAt = new Date(now.getTime() + horizonDays * 86_400_000)
    const rows = this.db.prepare(`
      SELECT * FROM leads
      WHERE next_follow_up_at IS NOT NULL
        AND next_follow_up_at != ''
        AND status != 'ignored'
      ORDER BY next_follow_up_at ASC, score DESC
    `).all() as Array<Record<string, unknown>>

    return rows
      .map((row) => {
        const lead = this.mapLead(row)
        const dueAt = new Date(lead.nextFollowUpAt as string)
        const status = classifyFollowUp(now, dueAt)
        const daysUntilDue = dueAt.getTime() < now.getTime()
          ? Math.floor((dueAt.getTime() - now.getTime()) / 86_400_000)
          : Math.ceil((dueAt.getTime() - now.getTime()) / 86_400_000)
        return { lead, status, dueAt: lead.nextFollowUpAt as string, daysUntilDue }
      })
      .filter((reminder) => reminder.status !== 'upcoming' || new Date(reminder.dueAt).getTime() <= horizonAt.getTime())
  }

  updateLeadStatus(id: string, status: LeadRecord['status']): LeadRecord | null {
    this.db.prepare('UPDATE leads SET status = ?, last_contacted_at = CASE WHEN ? = ? THEN ? ELSE last_contacted_at END WHERE id = ?').run(
      status,
      status,
      'contacted',
      new Date().toISOString(),
      id
    )
    const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapLead(row) : null
  }

  updateLead(id: string, input: LeadUpdateInput): LeadRecord | null {
    const current = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!current) return null
    const nextStatus = input.status ?? String(current.status) as LeadRecord['status']
    const hasNote = Object.hasOwn(input, 'note')
    const hasLastContactedAt = Object.hasOwn(input, 'lastContactedAt')
    const hasNextFollowUpAt = Object.hasOwn(input, 'nextFollowUpAt')
    const lastContactedAt = hasLastContactedAt
      ? input.lastContactedAt
      : nextStatus === 'contacted'
        ? new Date().toISOString()
        : current.last_contacted_at ? String(current.last_contacted_at) : null
    this.db.prepare(`
      UPDATE leads SET
        status = ?,
        note = ?,
        last_contacted_at = ?,
        next_follow_up_at = ?
      WHERE id = ?
    `).run(
      nextStatus,
      (hasNote ? input.note : (current.note ? String(current.note) : null)) ?? null,
      lastContactedAt ?? null,
      (hasNextFollowUpAt ? input.nextFollowUpAt : (current.next_follow_up_at ? String(current.next_follow_up_at) : null)) ?? null,
      id
    )
    const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapLead(row) : null
  }

  updateLeadStatuses(ids: string[], status: LeadRecord['status']): LeadRecord[] {
    const updated: LeadRecord[] = []
    this.db.exec('BEGIN')
    try {
      for (const id of ids) {
        const lead = this.updateLeadStatus(id, status)
        if (lead) updated.push(lead)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return updated
  }

  saveAudit(event: AuditEvent): void {
    this.db.prepare(`
      INSERT INTO audit_logs (
        id, action, target_type, target_id, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.action,
      event.targetType,
      event.targetId ?? null,
      event.message,
      event.createdAt
    )
  }

  listAuditLogs(input: number | AuditLogFilters = 100): AuditEvent[] {
    const filters = typeof input === 'number' ? { limit: input } : input
    const where: string[] = []
    const params: Array<string | number> = []
    if (filters.actionPrefix) {
      where.push('action LIKE ? ESCAPE \'\\\'')
      params.push(`${escapeSqlLike(filters.actionPrefix)}%`)
    }
    if (filters.targetType) {
      where.push('target_type = ?')
      params.push(filters.targetType)
    }
    if (filters.keyword) {
      where.push('(action LIKE ? ESCAPE \'\\\' OR target_type LIKE ? ESCAPE \'\\\' OR target_id LIKE ? ESCAPE \'\\\' OR message LIKE ? ESCAPE \'\\\')')
      const keyword = `%${escapeSqlLike(filters.keyword)}%`
      params.push(keyword, keyword, keyword, keyword)
    }
    const sql = `
      SELECT * FROM audit_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `
    params.push(Math.max(1, Math.min(1000, Math.floor(filters.limit ?? 100))))
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : undefined,
      message: String(row.message),
      createdAt: String(row.created_at)
    }))
  }

  clearAuditLogs(): number {
    return runChanges(this.db.prepare('DELETE FROM audit_logs').run())
  }

  countAuditLogs(): number {
    return this.countRows('audit_logs')
  }

  saveAIProviderConfig(config: AIProviderConfig): AIProviderPublicConfig {
    const existingStoredApiKey = this.getStoredAIProviderSecret(config.provider)
    const apiKey = config.apiKey === undefined ? undefined : config.apiKey.trim()
    const envRef = apiKey === undefined ? null : normalizeEnvSecretRef(apiKey)
    const storedApiKey = apiKey === undefined
      ? existingStoredApiKey
      : envRef ?? (apiKey ? this.secretCodec.encode(apiKey) : null)
    this.db.prepare(`
      INSERT INTO ai_provider_configs (
        provider, model, base_url, api_key, enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        model = excluded.model,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      config.provider,
      config.model.trim(),
      normalizeAIProviderBaseUrl(config.provider, config.baseUrl) ?? null,
      storedApiKey,
      config.enabled ? 1 : 0,
      config.updatedAt
    )
    return this.getAIProviderConfig(config.provider) as AIProviderPublicConfig
  }

  listAIProviderConfigs(): AIProviderPublicConfig[] {
    const rows = this.db.prepare('SELECT * FROM ai_provider_configs ORDER BY provider').all() as Array<Record<string, unknown>>
    return rows.map((row) => this.mapAIProviderConfig(row))
  }

  saveAIFailurePolicy(policy: AIFailurePolicy): AIFailurePolicy {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run('ai.failure_policy', json(policy), policy.updatedAt)
    return policy
  }

  getAIFailurePolicy(): AIFailurePolicy {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('ai.failure_policy') as Record<string, unknown> | undefined
    if (!row) return defaultAIFailurePolicy()
    return { ...defaultAIFailurePolicy(), ...parseJson<Partial<AIFailurePolicy>>(String(row.value)) }
  }

  saveCustomModelPricing(items: ModelPricingView[]): ModelPricingView[] {
    const normalized = normalizeCustomPricing(items)
    const updatedAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run('ai.custom_model_pricing', json(normalized), updatedAt)
    return normalized
  }

  listCustomModelPricing(): ModelPricingView[] {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('ai.custom_model_pricing') as Record<string, unknown> | undefined
    if (!row) return []
    return normalizeCustomPricing(parseJson<ModelPricingView[]>(String(row.value)))
  }

  savePlatformConnectorConfig(config: PlatformConnectorConfig): PlatformConnectorPublicConfig {
    const configs = this.readStoredPlatformConnectorConfigs()
    const existing = configs.find((item) => item.platformKey === config.platformKey)
    const next: StoredPlatformConnectorConfig = {
      platformKey: config.platformKey,
      enabled: config.enabled === true,
      apiBaseUrl: config.apiBaseUrl?.trim() || undefined,
      apiKey: normalizeStoredSecret(config.apiKey, existing?.apiKey, this.secretCodec),
      quotaPerDay: normalizeOptionalInteger(config.quotaPerDay, 1, 1_000_000),
      minDelayMs: normalizeOptionalInteger(config.minDelayMs, 0, 86_400_000),
      importTemplate: normalizeImportTemplate(config.importTemplate),
      updatedAt: config.updatedAt
    }
    const merged = [
      ...configs.filter((item) => item.platformKey !== config.platformKey),
      next
    ].sort((a, b) => a.platformKey.localeCompare(b.platformKey))
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(PLATFORM_CONNECTOR_CONFIGS_KEY, json(merged), new Date().toISOString())
    return this.mapPlatformConnectorConfig(next)
  }

  listPlatformConnectorConfigs(): PlatformConnectorPublicConfig[] {
    return this.readStoredPlatformConnectorConfigs().map((config) => this.mapPlatformConnectorConfig(config))
  }

  listPlatformConnectorUsageHistory(days = 7, now = new Date()): PlatformConnectorUsageHistory {
    const safeDays = Math.max(1, Math.min(30, Math.floor(days)))
    const end = dateOnly(now)
    const start = dateOnly(addUtcDays(now, -(safeDays - 1)))
    const rows = this.readStoredPlatformConnectorUsage()
      .filter((usage) => usage.date >= start && usage.date <= end)
      .sort((a, b) => b.date.localeCompare(a.date) || a.platformKey.localeCompare(b.platformKey))
      .map((usage): PlatformConnectorUsageDay => ({
        platformKey: usage.platformKey,
        date: usage.date,
        totalRequests: usage.usedToday,
        successCount: usage.successCount ?? (usage.lastStatus === 'ok' ? usage.usedToday : 0),
        failureCount: usage.failureCount ?? (usage.lastStatus === 'failed' ? usage.usedToday : 0),
        quotaExhaustedCount: usage.quotaExhaustedCount ?? (usage.lastErrorCode === 'quota_exhausted' ? 1 : 0),
        retryableFailureCount: usage.retryableFailureCount ?? (usage.lastRetryable ? 1 : 0),
        lastStatus: usage.lastStatus,
        lastError: usage.lastError,
        lastErrorCode: usage.lastErrorCode,
        lastRetryable: usage.lastRetryable,
        quotaResetAt: usage.quotaResetAt,
        lastRequestAt: usage.lastRequestAt
      }))
    const totals = rows.reduce((sum, row) => ({
      totalRequests: sum.totalRequests + row.totalRequests,
      successCount: sum.successCount + row.successCount,
      failureCount: sum.failureCount + row.failureCount,
      quotaExhaustedCount: sum.quotaExhaustedCount + row.quotaExhaustedCount,
      retryableFailureCount: sum.retryableFailureCount + row.retryableFailureCount
    }), { totalRequests: 0, successCount: 0, failureCount: 0, quotaExhaustedCount: 0, retryableFailureCount: 0 })
    return { days: safeDays, generatedAt: now.toISOString(), rows, totals }
  }

  recordPlatformConnectorUsage(platformKey: string, status: 'ok' | 'failed', message?: string, now = new Date(), details: { errorCode?: string; retryable?: boolean; quotaResetAt?: string } = {}): PlatformConnectorPublicConfig | null {
    const configs = this.readStoredPlatformConnectorConfigs()
    const config = configs.find((item) => item.platformKey === platformKey)
    if (!config) return null
    const date = now.toISOString().slice(0, 10)
    const usages = this.readStoredPlatformConnectorUsage()
    const existing = usages.find((item) => item.platformKey === platformKey && item.date === date)
    const successCount = (existing?.successCount ?? (existing?.lastStatus === 'ok' ? existing.usedToday : 0)) + (status === 'ok' ? 1 : 0)
    const failureCount = (existing?.failureCount ?? (existing?.lastStatus === 'failed' ? existing.usedToday : 0)) + (status === 'failed' ? 1 : 0)
    const quotaExhaustedCount = (existing?.quotaExhaustedCount ?? 0) + (details.errorCode === 'quota_exhausted' ? 1 : 0)
    const retryableFailureCount = (existing?.retryableFailureCount ?? 0) + (status === 'failed' && details.retryable ? 1 : 0)
    const next: StoredPlatformConnectorUsage = {
      platformKey,
      date,
      usedToday: (existing?.usedToday ?? 0) + 1,
      successCount,
      failureCount,
      quotaExhaustedCount,
      retryableFailureCount,
      lastStatus: status,
      lastError: status === 'failed' ? message?.slice(0, 500) : undefined,
      lastErrorCode: status === 'failed' ? details.errorCode?.slice(0, 80) : undefined,
      lastRetryable: status === 'failed' ? details.retryable : undefined,
      quotaResetAt: status === 'failed' ? details.quotaResetAt : undefined,
      lastRequestAt: now.toISOString()
    }
    const merged = [
      ...usages.filter((item) => !(item.platformKey === platformKey && item.date === date)),
      next
    ].filter((item) => item.date >= dateOnly(addUtcDays(now, -89)))
      .sort((a, b) => `${a.platformKey}:${a.date}`.localeCompare(`${b.platformKey}:${b.date}`))
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(PLATFORM_CONNECTOR_USAGE_KEY, json(merged), now.toISOString())
    return this.mapPlatformConnectorConfig(config)
  }

  getPlatformConnectorSecret(platformKey: string): string | undefined {
    const stored = this.readStoredPlatformConnectorConfigs().find((config) => config.platformKey === platformKey)?.apiKey
    if (!stored) return undefined
    const envName = envSecretName(stored)
    if (envName) return process.env[envName] || undefined
    return this.decodeSecret(stored) || undefined
  }

  getAIProviderConfig(provider: AIProviderConfig['provider']): AIProviderPublicConfig | null {
    const row = this.db.prepare('SELECT * FROM ai_provider_configs WHERE provider = ?').get(provider) as Record<string, unknown> | undefined
    return row ? this.mapAIProviderConfig(row) : null
  }

  getAIProviderSecret(provider: AIProviderConfig['provider']): string | undefined {
    const value = this.getStoredAIProviderSecret(provider)
    const envName = value ? envSecretName(value) : null
    if (envName) return process.env[envName] || undefined
    return value ? this.decodeSecret(value) : undefined
  }

  private getStoredAIProviderSecret(provider: AIProviderConfig['provider']): string | null {
    const row = this.db.prepare('SELECT api_key FROM ai_provider_configs WHERE provider = ?').get(provider) as Record<string, unknown> | undefined
    const value = row?.api_key
    return value ? String(value) : null
  }

  createAIProviderSecretBackup(provider: AIProviderConfig['provider'], reason: AISecretBackup['reason'] = 'manual'): AISecretBackup | null {
    const row = this.db.prepare('SELECT * FROM ai_provider_configs WHERE provider = ?').get(provider) as Record<string, unknown> | undefined
    if (!row) return null
    const id = `secret-backup-${provider}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const createdAt = new Date().toISOString()
    const apiKey = row.api_key ? String(row.api_key) : ''
    const secretStorage = apiKey ? this.inspectSecret(apiKey) : 'none'
    this.db.prepare(`
      INSERT INTO ai_secret_backups (
        id, provider, model, base_url, api_key, enabled, reason, secret_storage, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(row.provider),
      String(row.model),
      row.base_url ? String(row.base_url) : null,
      row.api_key ? String(row.api_key) : null,
      Number(row.enabled) === 1 ? 1 : 0,
      reason,
      secretStorage,
      createdAt
    )
    this.pruneAIProviderSecretBackups(String(row.provider) as AIProviderConfig['provider'])
    return {
      id,
      provider,
      reason,
      secretStorage,
      apiKeySet: Boolean(apiKey),
      createdAt
    }
  }

  listAISecretBackups(provider?: AIProviderConfig['provider']): AISecretBackup[] {
    const rows = provider
      ? this.db.prepare('SELECT * FROM ai_secret_backups WHERE provider = ? ORDER BY created_at DESC').all(provider) as Array<Record<string, unknown>>
      : this.db.prepare('SELECT * FROM ai_secret_backups ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((row) => this.mapAISecretBackup(row))
  }

  clearAISecretBackups(provider?: AIProviderConfig['provider']): number {
    return provider
      ? runChanges(this.db.prepare('DELETE FROM ai_secret_backups WHERE provider = ?').run(provider))
      : runChanges(this.db.prepare('DELETE FROM ai_secret_backups').run())
  }

  restoreAIProviderSecretBackup(id: string): AIProviderPublicConfig | null {
    const row = this.db.prepare('SELECT * FROM ai_secret_backups WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    const restoredApiKey = row.api_key ? this.reencodeRestoredSecret(String(row.api_key)) : null
    this.db.prepare(`
      INSERT INTO ai_provider_configs (
        provider, model, base_url, api_key, enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        model = excluded.model,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      String(row.provider),
      String(row.model),
      row.base_url ? String(row.base_url) : null,
      restoredApiKey,
      Number(row.enabled) === 1 ? 1 : 0,
      new Date().toISOString()
    )
    return this.getAIProviderConfig(String(row.provider) as AIProviderConfig['provider'])
  }

  private reencodeRestoredSecret(storedApiKey: string): string {
    const envName = envSecretName(storedApiKey)
    if (envName) return storedApiKey
    const decoded = this.decodeSecret(storedApiKey)
    return decoded ? this.secretCodec.encode(decoded) : storedApiKey
  }

  private pruneAIProviderSecretBackups(provider: AIProviderConfig['provider']): void {
    const staleRows = this.db.prepare(`
      SELECT id FROM ai_secret_backups
      WHERE provider = ?
      ORDER BY created_at DESC, id DESC
      LIMIT -1 OFFSET ?
    `).all(provider, MAX_AI_SECRET_BACKUPS_PER_PROVIDER) as Array<Record<string, unknown>>
    for (const row of staleRows) {
      this.db.prepare('DELETE FROM ai_secret_backups WHERE id = ?').run(String(row.id))
    }
  }

  migrateAIProviderSecret(provider: AIProviderConfig['provider']): AIProviderPublicConfig | null {
    const row = this.db.prepare('SELECT * FROM ai_provider_configs WHERE provider = ?').get(provider) as Record<string, unknown> | undefined
    if (!row) return null
    const storedApiKey = row.api_key ? String(row.api_key) : ''
    if (storedApiKey && envSecretName(storedApiKey)) return this.mapAIProviderConfig(row)
    const decoded = storedApiKey ? this.decodeSecret(storedApiKey) : ''
    if (!decoded) return this.mapAIProviderConfig(row)
    this.db.prepare('UPDATE ai_provider_configs SET api_key = ?, updated_at = ? WHERE provider = ?').run(
      this.secretCodec.encode(decoded),
      new Date().toISOString(),
      provider
    )
    return this.getAIProviderConfig(provider)
  }

  migrateAllAIProviderSecrets(): AIProviderPublicConfig[] {
    const rows = this.db.prepare('SELECT provider FROM ai_provider_configs').all() as Array<Record<string, unknown>>
    return rows
      .map((row) => this.migrateAIProviderSecret(String(row.provider) as AIProviderConfig['provider']))
      .filter((config): config is AIProviderPublicConfig => Boolean(config))
  }

  private mapAIProviderConfig(row: Record<string, unknown>): AIProviderPublicConfig {
    const storedApiKey = row.api_key ? String(row.api_key) : ''
    const envName = storedApiKey ? envSecretName(storedApiKey) : null
    const apiKey = envName ? (process.env[envName] ?? '') : storedApiKey ? this.decodeSecret(storedApiKey) : ''
    return {
      provider: String(row.provider) as AIProviderConfig['provider'],
      model: String(row.model),
      baseUrl: row.base_url ? String(row.base_url) : undefined,
      enabled: Number(row.enabled) === 1,
      apiKeySet: apiKey.length > 0,
      apiKeyPreview: envName ? `env:${envName}` : apiKey.length > 4 ? `...${apiKey.slice(-4)}` : undefined,
      secretStorage: storedApiKey ? this.inspectSecret(storedApiKey) : 'none',
      updatedAt: String(row.updated_at)
    }
  }

  private mapAISecretBackup(row: Record<string, unknown>): AISecretBackup {
    return {
      id: String(row.id),
      provider: String(row.provider) as AIProviderConfig['provider'],
      reason: String(row.reason) as AISecretBackup['reason'],
      secretStorage: String(row.secret_storage) as AIProviderPublicConfig['secretStorage'],
      apiKeySet: Boolean(row.api_key),
      createdAt: String(row.created_at)
    }
  }

  private readStoredPlatformConnectorConfigs(): StoredPlatformConnectorConfig[] {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PLATFORM_CONNECTOR_CONFIGS_KEY) as Record<string, unknown> | undefined
    if (!row) return []
    const parsed = parseJson<unknown>(String(row.value))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        platformKey: String(item.platformKey ?? ''),
        enabled: item.enabled === true,
        apiBaseUrl: typeof item.apiBaseUrl === 'string' ? item.apiBaseUrl : undefined,
        apiKey: typeof item.apiKey === 'string' ? item.apiKey : undefined,
        quotaPerDay: normalizeOptionalInteger(item.quotaPerDay, 1, 1_000_000),
        minDelayMs: normalizeOptionalInteger(item.minDelayMs, 0, 86_400_000),
        importTemplate: normalizeImportTemplate(item.importTemplate),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString()
      }))
      .filter((item) => /^[A-Za-z0-9_-]{1,80}$/.test(item.platformKey))
  }

  private readStoredPlatformConnectorUsage(): StoredPlatformConnectorUsage[] {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(PLATFORM_CONNECTOR_USAGE_KEY) as Record<string, unknown> | undefined
    if (!row) return []
    const parsed = parseJson<unknown>(String(row.value))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        platformKey: String(item.platformKey ?? ''),
        date: typeof item.date === 'string' ? item.date : '',
        usedToday: normalizeOptionalInteger(item.usedToday, 0, 1_000_000) ?? 0,
        successCount: normalizeOptionalInteger(item.successCount, 0, 1_000_000),
        failureCount: normalizeOptionalInteger(item.failureCount, 0, 1_000_000),
        quotaExhaustedCount: normalizeOptionalInteger(item.quotaExhaustedCount, 0, 1_000_000),
        retryableFailureCount: normalizeOptionalInteger(item.retryableFailureCount, 0, 1_000_000),
        lastStatus: item.lastStatus === 'failed' ? 'failed' as const : 'ok' as const,
        lastError: typeof item.lastError === 'string' ? item.lastError.slice(0, 500) : undefined,
        lastErrorCode: typeof item.lastErrorCode === 'string' ? item.lastErrorCode.slice(0, 80) : undefined,
        lastRetryable: typeof item.lastRetryable === 'boolean' ? item.lastRetryable : undefined,
        quotaResetAt: typeof item.quotaResetAt === 'string' && Number.isFinite(Date.parse(item.quotaResetAt)) ? new Date(item.quotaResetAt).toISOString() : undefined,
        lastRequestAt: typeof item.lastRequestAt === 'string' ? item.lastRequestAt : new Date().toISOString()
      }))
      .filter((item) => /^[A-Za-z0-9_-]{1,80}$/.test(item.platformKey) && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
  }

  private mapPlatformConnectorConfig(config: StoredPlatformConnectorConfig): PlatformConnectorPublicConfig {
    const storedApiKey = config.apiKey ?? ''
    const envName = storedApiKey ? envSecretName(storedApiKey) : null
    const apiKey = envName ? (process.env[envName] ?? '') : storedApiKey ? this.decodeSecret(storedApiKey) : ''
    const today = new Date().toISOString().slice(0, 10)
    const usage = this.readStoredPlatformConnectorUsage().find((item) => item.platformKey === config.platformKey && item.date === today)
    const remainingToday = config.quotaPerDay === undefined ? undefined : Math.max(0, config.quotaPerDay - (usage?.usedToday ?? 0))
    return {
      platformKey: config.platformKey,
      enabled: config.enabled,
      apiBaseUrl: config.apiBaseUrl,
      apiKeySet: apiKey.length > 0,
      apiKeyPreview: envName ? `env:${envName}` : apiKey.length > 4 ? `...${apiKey.slice(-4)}` : undefined,
      secretStorage: storedApiKey ? this.inspectSecret(storedApiKey) : 'none',
      quotaPerDay: config.quotaPerDay,
      minDelayMs: config.minDelayMs,
      importTemplate: config.importTemplate,
      usageDate: usage?.date,
      usedToday: usage?.usedToday ?? 0,
      remainingToday,
      lastStatus: usage?.lastStatus,
      lastError: usage?.lastError,
      lastErrorCode: usage?.lastErrorCode,
      lastRetryable: usage?.lastRetryable,
      quotaResetAt: usage?.quotaResetAt,
      lastRequestAt: usage?.lastRequestAt,
      updatedAt: config.updatedAt
    }
  }

  private mapComment(row: Record<string, unknown>): CommentRecord {
    return {
      id: String(row.id),
      platformKey: String(row.platform_key),
      contentId: String(row.content_id),
      contentUrl: String(row.content_url),
      nickname: String(row.nickname),
      text: String(row.text),
      likes: Number(row.likes),
      publishedAt: String(row.published_at),
      collectedAt: String(row.collected_at)
    }
  }

  private mapContent(row: Record<string, unknown>): ContentRef {
    return {
      platformKey: String(row.platform_key),
      contentId: String(row.content_id),
      url: String(row.url),
      contentType: String(row.content_type) as ContentRef['contentType'],
      title: row.title ? String(row.title) : undefined
    }
  }

  private decodeSecret(value: string): string {
    try {
      return this.secretCodec.decode(value)
    } catch {
      return ''
    }
  }

  private inspectSecret(value: string): AIProviderPublicConfig['secretStorage'] {
    if (envSecretName(value)) return 'external_env'
    return this.secretCodec.inspect?.(value) ?? 'unknown'
  }

  private mapLead(row: Record<string, unknown>): LeadRecord {
    return {
      id: String(row.id),
      commentId: String(row.comment_id),
      platformKey: String(row.platform_key),
      contentId: String(row.content_id),
      nickname: String(row.nickname),
      text: String(row.text),
      intentLevel: String(row.intent_level) as LeadRecord['intentLevel'],
      confidence: Number(row.confidence),
      keywords: parseJson<string[]>(String(row.keywords)),
      score: Number(row.score),
      scoreReason: row.score_reason ? String(row.score_reason) : String(row.suggested_action),
      suggestedAction: String(row.suggested_action),
      status: String(row.status) as LeadRecord['status'],
      note: row.note ? String(row.note) : undefined,
      lastContactedAt: row.last_contacted_at ? String(row.last_contacted_at) : undefined,
      nextFollowUpAt: row.next_follow_up_at ? String(row.next_follow_up_at) : undefined,
      createdAt: String(row.created_at)
    }
  }

  saveTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (
        id, type, status, platform_key, progress, input, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        platform_key = excluded.platform_key,
        progress = excluded.progress,
        input = excluded.input,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      task.type,
      task.status,
      task.platformKey ?? null,
      task.progress,
      json(task.input),
      task.errorCode ?? null,
      task.errorMessage ?? null,
      task.createdAt,
      task.updatedAt
    )
  }

  listTasks(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type) as Task['type'],
      status: String(row.status) as Task['status'],
      platformKey: row.platform_key ? String(row.platform_key) : undefined,
      progress: Number(row.progress),
      input: parseJson(String(row.input)),
      errorCode: row.error_code ? String(row.error_code) as Task['errorCode'] : undefined,
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }))
  }

  clearTasks(): number {
    return runChanges(this.db.prepare('DELETE FROM tasks').run())
  }

  countTasks(): number {
    return this.countRows('tasks')
  }

  countAISecretBackups(): number {
    return this.countRows('ai_secret_backups')
  }

  countPlatformState(): number {
    return this.countRows('platform_statuses') + this.countRows('platform_protections')
  }

  private countRows(table: string): number {
    const allowed = new Set([
      'search_results',
      'search_sessions',
      'comments',
      'leads',
      'contents',
      'tasks',
      'ai_secret_backups',
      'platform_statuses',
      'platform_protections',
      'audit_logs'
    ])
    if (!allowed.has(table)) throw new Error('统计表名不安全')
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown> | undefined
    return Number(row?.count ?? 0)
  }
}

function runChanges(result: unknown): number {
  if (result && typeof result === 'object' && 'changes' in result) {
    const changes = Number((result as { changes?: unknown }).changes)
    return Number.isFinite(changes) ? changes : 0
  }
  return 0
}

function normalizeStoredSecret(nextSecret: string | undefined, existingSecret: string | undefined, codec: SecretCodec): string | undefined {
  if (nextSecret === undefined) return existingSecret
  const trimmed = nextSecret.trim()
  if (!trimmed) return undefined
  const envRef = normalizeEnvSecretRef(trimmed)
  return envRef ?? codec.encode(trimmed)
}

function normalizeOptionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function normalizeImportTemplate(value: unknown): PlatformConnectorConfig['importTemplate'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { fields?: unknown; requiredFields?: unknown; sample?: unknown }
  const fields = normalizeFieldList(raw.fields)
  if (fields.length === 0) return undefined
  const requiredFields = normalizeFieldList(raw.requiredFields).filter((field) => fields.includes(field))
  const sample = typeof raw.sample === 'string' && raw.sample.length <= 2000 ? raw.sample : undefined
  return {
    fields,
    requiredFields: requiredFields.length ? requiredFields : undefined,
    sample
  }
}

function normalizeFieldList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_\-.]{1,80}$/.test(item)))]
    .slice(0, 80)
}

function classifyFollowUp(now: Date, dueAt: Date): FollowUpReminder['status'] {
  if (dueAt.getTime() < now.getTime()) return 'overdue'
  if (dueAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return 'today'
  return 'upcoming'
}
