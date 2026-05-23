import type { AIProviderKey } from '../domain/types.ts'
import { validateOutboundUrl } from '../security/outbound-url.ts'

const BUILTIN_PROVIDER_DOMAINS: Record<Exclude<AIProviderKey, 'rule' | 'custom'>, string[]> = {
  openai: ['api.openai.com'],
  deepseek: ['api.deepseek.com'],
  dashscope: ['dashscope.aliyuncs.com']
}

export function defaultBaseUrl(provider: AIProviderKey): string {
  if (provider === 'openai') return 'https://api.openai.com/v1'
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1'
  if (provider === 'dashscope') return 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  return 'https://api.openai.com/v1'
}

export function normalizeAIProviderBaseUrl(provider: AIProviderKey, rawBaseUrl?: string): string | undefined {
  const trimmed = rawBaseUrl?.trim()
  if (!trimmed) return undefined
  if (provider === 'rule') return undefined
  const allowedDomains = provider === 'custom' ? undefined : BUILTIN_PROVIDER_DOMAINS[provider]
  try {
    return validateOutboundUrl(trimmed, { allowedDomains, requireHttps: true }).toString().replace(/\/$/, '')
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^出站请求被拦截:?\s*/, '') : '地址不安全'
    throw new Error(`AI Provider Base URL 不安全：${reason}`)
  }
}

export function effectiveAIProviderBaseUrl(provider: AIProviderKey, rawBaseUrl?: string): string {
  return normalizeAIProviderBaseUrl(provider, rawBaseUrl) ?? defaultBaseUrl(provider)
}
