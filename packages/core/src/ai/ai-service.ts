import type { AIProviderPublicConfig, CommentInput, CommentRecord, IntentResult, KeywordPlan, LeadRecord, LeadScore, SearchResult } from '../domain/types.ts'
import type { LLMClient } from './llm-client.ts'

const intentKeywords = {
  high: ['想买', '多少钱', '哪里买', '求链接', '怎么买', 'price', 'buy', 'link'],
  medium: ['好用吗', '值得买吗', '推荐吗', '对比', '想了解', '了解一下', '有优惠', 'review', 'worth', 'best'],
  low: ['收藏', '看看', '喜欢', '种草', '不错', 'mark', 'interesting']
}

export class AIService {
  private provider?: AIProviderPublicConfig
  private apiKey?: string
  private llmClient?: LLMClient

  constructor(llmClient?: LLMClient) {
    this.llmClient = llmClient
  }

  configureProvider(config?: AIProviderPublicConfig, apiKey?: string): void {
    this.provider = config
    this.apiKey = apiKey
  }

  setLLMClient(client?: LLMClient): void {
    this.llmClient = client
  }

  currentProvider(): AIProviderPublicConfig | undefined {
    return this.provider
  }

  expandKeywords(seed: string, locales = ['zh-CN']): KeywordPlan {
    const base = seed.trim()
    if (!base) return { seed, keywords: [], locales }
    const keywords = [
      base,
      `${base} 推荐`,
      `${base} 怎么选`,
      `${base} 避坑`,
      `${base} 价格`,
      `${base} 测评`,
      `${base} 求链接`
    ]
    if (locales.some((locale) => locale.toLowerCase().startsWith('en'))) {
      keywords.push(`${base} review`, `best ${base}`, `${base} price`, `where to buy ${base}`)
    }
    return { seed: base, keywords: [...new Set(keywords)], locales }
  }

  rankSearchResults(keyword: string, results: SearchResult[]): SearchResult[] {
    const key = keyword.trim().toLowerCase()
    return results
      .map((result) => {
        const haystack = `${result.title} ${result.snippet}`.toLowerCase()
        let relevance = result.relevance
        if (key && haystack.includes(key)) relevance += 0.5
        if (/(推荐|测评|怎么买|价格|review|best|buy)/i.test(haystack)) relevance += 0.2
        return { ...result, relevance: Math.min(1, relevance) }
      })
      .sort((a, b) => b.relevance - a.relevance)
  }

  analyzeIntent(comment: CommentInput): IntentResult {
    const text = comment.text.toLowerCase()
    for (const level of ['high', 'medium', 'low'] as const) {
      const matched = intentKeywords[level].filter((keyword) => text.includes(keyword.toLowerCase()))
      if (matched.length > 0) {
        return {
          level,
          confidence: level === 'high' ? 0.86 : level === 'medium' ? 0.72 : 0.55,
          keywords: matched,
          reason: `命中${level}意向关键词`
        }
      }
    }
    return { level: 'none', confidence: 0.3, keywords: [], reason: '未发现明确购买信号' }
  }

  async analyzeIntentWithModel(comment: CommentInput): Promise<IntentResult> {
    return (await this.analyzeIntentWithSource(comment)).intent
  }

  async analyzeIntentWithSource(comment: CommentInput): Promise<{ intent: IntentResult; source: 'model' | 'rule' }> {
    if (!this.provider?.enabled || this.provider.provider === 'rule' || !this.apiKey || !this.llmClient) {
      return { intent: this.analyzeIntent(comment), source: 'rule' }
    }
    try {
      return { intent: await this.llmClient.analyzeIntent(comment, { provider: this.provider, apiKey: this.apiKey }), source: 'model' }
    } catch {
      return { intent: this.analyzeIntent(comment), source: 'rule' }
    }
  }

  scoreLead(intent: IntentResult, likes = 0): LeadScore {
    const base = { high: 90, medium: 65, low: 35, none: 0 }[intent.level]
    const likeBoost = likes >= 10 ? 5 : 0
    const keywordBoost = intent.keywords.length > 0 ? 5 : 0
    const score = Math.min(100, base + likeBoost + keywordBoost)
    return {
      score,
      level: intent.level,
      reason: [
        intent.reason,
        `基础分 ${base}`,
        keywordBoost ? `关键词加分 ${keywordBoost}` : '',
        likeBoost ? `互动加分 ${likeBoost}` : ''
      ].filter(Boolean).join('；'),
      suggestedAction: score >= 80 ? '优先跟进' : score >= 50 ? '加入跟进池' : '低优先级观察'
    }
  }

  commentToLead(comment: CommentRecord): LeadRecord | null {
    const intent = this.analyzeIntent({
      platformKey: comment.platformKey,
      contentUrl: comment.contentUrl,
      nickname: comment.nickname,
      text: comment.text,
      likes: comment.likes
    })
    if (intent.level === 'none') return null
    const score = this.scoreLead(intent, comment.likes)
    return {
      id: `lead-${comment.id}`,
      commentId: comment.id,
      platformKey: comment.platformKey,
      contentId: comment.contentId,
      nickname: comment.nickname,
      text: comment.text,
      intentLevel: intent.level,
      confidence: intent.confidence,
      keywords: intent.keywords,
      score: score.score,
      scoreReason: score.reason,
      suggestedAction: score.suggestedAction,
      status: 'new',
      createdAt: new Date().toISOString()
    }
  }

  async commentToLeadAsync(comment: CommentRecord): Promise<LeadRecord | null> {
    return (await this.commentToLeadWithMeta(comment)).lead
  }

  async commentToLeadWithMeta(comment: CommentRecord): Promise<{ lead: LeadRecord | null; source: 'model' | 'rule' }> {
    const result = await this.analyzeIntentWithSource({
      platformKey: comment.platformKey,
      contentUrl: comment.contentUrl,
      nickname: comment.nickname,
      text: comment.text,
      likes: comment.likes
    })
    const intent = result.intent
    const source = result.source
    if (intent.level === 'none') return { lead: null, source }
    const score = this.scoreLead(intent, comment.likes)
    return { lead: {
      id: `lead-${comment.id}`,
      commentId: comment.id,
      platformKey: comment.platformKey,
      contentId: comment.contentId,
      nickname: comment.nickname,
      text: comment.text,
      intentLevel: intent.level,
      confidence: intent.confidence,
      keywords: intent.keywords,
      score: score.score,
      scoreReason: score.reason,
      suggestedAction: score.suggestedAction,
      status: 'new',
      createdAt: new Date().toISOString()
    }, source }
  }
}
