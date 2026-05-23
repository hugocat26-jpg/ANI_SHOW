import type { AIAnalysisContext, CommentInput, IntentResult } from '../domain/types.ts'
import { AIProviderError, codeFromHttpStatus } from './ai-errors.ts'
import { buildIntentAnalysisPrompt } from './prompt-templates.ts'
import { effectiveAIProviderBaseUrl } from './provider-url.ts'

export interface LLMClient {
  analyzeIntent(comment: CommentInput, context: AIAnalysisContext): Promise<IntentResult>
}

export class OpenAICompatibleLLMClient implements LLMClient {
  async analyzeIntent(comment: CommentInput, context: AIAnalysisContext): Promise<IntentResult> {
    if (!context.apiKey) throw new AIProviderError('missing_api_key', 'AI Provider 未配置 API Key', { retryable: false })
    const baseUrl = effectiveAIProviderBaseUrl(context.provider.provider, context.provider.baseUrl)
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${context.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: context.provider.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你只输出严格 JSON，用于客户购买意向识别。' },
          { role: 'user', content: buildIntentAnalysisPrompt(comment) }
        ]
      })
    })
    if (!response.ok) {
      const code = codeFromHttpStatus(response.status)
      throw new AIProviderError(code, `AI Provider 请求失败: ${response.status}`, { status: response.status })
    }
    const payload = await response.json() as Record<string, unknown>
    const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined
    const content = choices?.[0]?.message?.content
    if (!content) throw new AIProviderError('invalid_response', 'AI Provider 返回为空', { retryable: false })
    try {
      return normalizeIntentResult(JSON.parse(content) as Partial<IntentResult>)
    } catch (error) {
      throw new AIProviderError('invalid_response', 'AI Provider 返回不是合法 JSON', { retryable: false, cause: error })
    }
  }
}

export function normalizeIntentResult(value: Partial<IntentResult>): IntentResult {
  const level = ['high', 'medium', 'low', 'none'].includes(String(value.level)) ? value.level as IntentResult['level'] : 'none'
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : 0.3
  const keywords = Array.isArray(value.keywords) ? value.keywords.map(String).slice(0, 12) : []
  return {
    level,
    confidence,
    keywords,
    reason: value.reason ? String(value.reason) : '模型未提供原因'
  }
}
