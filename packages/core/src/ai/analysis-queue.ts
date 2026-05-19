import type { AIAnalysisStats, CommentRecord, LeadRecord } from '../domain/types.ts'
import type { AIService } from './ai-service.ts'
import { classifyAIError, type AIProviderErrorCode } from './ai-errors.ts'
import { estimateModelCostUsd } from './model-pricing.ts'
import type { ModelPricingView } from './model-pricing.ts'

export interface AIAnalysisQueueOptions {
  minDelayMs?: number
  maxRetries?: number
  retryDelayMs?: number
  circuitBreakerThreshold?: number
  modelPricing?: ModelPricingView[]
}

export interface AIAnalysisQueueResult {
  leads: LeadRecord[]
  stats: AIAnalysisStats
}

export class AIAnalysisQueue {
  private ai: AIService
  private options: AIAnalysisQueueOptions

  constructor(ai: AIService, options: AIAnalysisQueueOptions = {}) {
    this.ai = ai
    this.options = options
  }

  async analyze(comments: CommentRecord[]): Promise<AIAnalysisQueueResult> {
    const stats: AIAnalysisStats = {
      total: comments.length,
      succeeded: 0,
      failed: 0,
      failuresByCode: {},
      modelUsed: 0,
      ruleFallback: 0,
      circuitOpen: false,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      startedAt: new Date().toISOString()
    }
    const leads: LeadRecord[] = []
    let consecutiveFailures = 0
    for (const comment of comments) {
      const threshold = this.options.circuitBreakerThreshold ?? 0
      if (threshold > 0 && consecutiveFailures >= threshold) {
        stats.circuitOpen = true
        stats.failed += 1
        increment(stats.failuresByCode, 'unknown')
        continue
      }
      stats.estimatedInputTokens += estimateTokens(comment.text) + estimateTokens(comment.contentUrl)
      const result = await this.analyzeOne(comment)
      if (result?.analysis) {
        consecutiveFailures = 0
        stats.succeeded += 1
        stats.estimatedOutputTokens += 120
        if (result.analysis.source === 'model') stats.modelUsed += 1
        if (result.analysis.source === 'rule') stats.ruleFallback += 1
        if (result.analysis.lead) leads.push(result.analysis.lead)
      } else {
        consecutiveFailures += 1
        stats.failed += 1
        increment(stats.failuresByCode, result?.errorCode ?? 'unknown')
      }
      if (this.options.minDelayMs && this.options.minDelayMs > 0) await sleep(this.options.minDelayMs)
    }
    stats.finishedAt = new Date().toISOString()
    const provider = this.ai.currentProvider()
    stats.estimatedCostUsd = estimateModelCostUsd(
      provider?.provider,
      provider?.model,
      stats.estimatedInputTokens,
      stats.estimatedOutputTokens,
      stats.modelUsed,
      this.options.modelPricing
    )
    return { leads, stats }
  }

  private async analyzeOne(comment: CommentRecord): Promise<{ analysis?: { lead: LeadRecord | null; source: 'model' | 'rule' }; errorCode?: AIProviderErrorCode }> {
    const maxRetries = this.options.maxRetries ?? 1
    let lastErrorCode: AIProviderErrorCode = 'unknown'
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return { analysis: await this.ai.commentToLeadWithMeta(comment) }
      } catch (error) {
        const classified = classifyAIError(error)
        lastErrorCode = classified.code
        if (!classified.retryable || attempt >= maxRetries) return { errorCode: classified.code }
        if (this.options.retryDelayMs && this.options.retryDelayMs > 0) await sleep(this.options.retryDelayMs * (attempt + 1))
      }
    }
    return { errorCode: lastErrorCode }
  }
}

function increment(record: Record<string, number> | undefined, code: AIProviderErrorCode): void {
  if (!record) return
  record[code] = (record[code] ?? 0) + 1
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
