import type { AIProviderKey } from '../domain/types.ts'

export interface ModelPricing {
  provider: AIProviderKey
  modelPattern: RegExp
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
}

export interface ModelPricingView {
  provider: AIProviderKey
  modelPattern: string
  inputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  source?: 'built_in' | 'custom'
}

export const modelPricingTable: ModelPricing[] = [
  { provider: 'deepseek', modelPattern: /deepseek-chat/i, inputUsdPerMillionTokens: 0.14, outputUsdPerMillionTokens: 0.28 },
  { provider: 'deepseek', modelPattern: /deepseek-reasoner/i, inputUsdPerMillionTokens: 0.55, outputUsdPerMillionTokens: 2.19 },
  { provider: 'openai', modelPattern: /gpt-4\.1-mini/i, inputUsdPerMillionTokens: 0.4, outputUsdPerMillionTokens: 1.6 },
  { provider: 'openai', modelPattern: /gpt-4\.1(?!-mini)/i, inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8 },
  { provider: 'openai', modelPattern: /gpt-4o-mini/i, inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
  { provider: 'dashscope', modelPattern: /qwen-plus/i, inputUsdPerMillionTokens: 0.11, outputUsdPerMillionTokens: 0.28 },
  { provider: 'dashscope', modelPattern: /qwen-max/i, inputUsdPerMillionTokens: 1.6, outputUsdPerMillionTokens: 6.4 }
]

export function listModelPricing(): ModelPricingView[] {
  return modelPricingTable.map((item) => ({
    provider: item.provider,
    modelPattern: item.modelPattern.source,
    inputUsdPerMillionTokens: item.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: item.outputUsdPerMillionTokens,
    source: 'built_in'
  }))
}

export function listMergedModelPricing(customPricing: ModelPricingView[] = []): ModelPricingView[] {
  return [...normalizeCustomPricing(customPricing), ...listModelPricing()]
}

export function findModelPricing(provider: AIProviderKey | undefined, model: string | undefined, customPricing: ModelPricingView[] = []): ModelPricingView | undefined {
  const custom = normalizeCustomPricing(customPricing).find((entry) => entry.provider === provider && safePatternTest(entry.modelPattern, model ?? ''))
  if (custom) return custom
  const item = modelPricingTable.find((entry) => entry.provider === provider && entry.modelPattern.test(model ?? ''))
  return item ? {
    provider: item.provider,
    modelPattern: item.modelPattern.source,
    inputUsdPerMillionTokens: item.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: item.outputUsdPerMillionTokens,
    source: 'built_in'
  } : undefined
}

export function estimateModelCostUsd(
  provider: AIProviderKey | undefined,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  modelCalls: number,
  customPricing: ModelPricingView[] = []
): number {
  if (modelCalls === 0) return 0
  const pricing = findModelPricing(provider, model, customPricing)
    ?? { inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: 1.5 }
  const inputCost = (inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens
  const outputCost = (outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
  return Number((inputCost + outputCost).toFixed(6))
}

export function normalizeCustomPricing(items: ModelPricingView[]): ModelPricingView[] {
  const normalized: ModelPricingView[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const provider = item.provider
    const modelPattern = item.modelPattern.trim()
    const inputUsdPerMillionTokens = Math.max(0, Number(item.inputUsdPerMillionTokens) || 0)
    const outputUsdPerMillionTokens = Math.max(0, Number(item.outputUsdPerMillionTokens) || 0)
    if (!provider || !modelPattern) continue
    new RegExp(modelPattern, 'i')
    const key = `${provider}:${modelPattern}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ provider, modelPattern, inputUsdPerMillionTokens, outputUsdPerMillionTokens, source: 'custom' })
  }
  return normalized
}

function safePatternTest(pattern: string, model: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(model)
  } catch {
    return false
  }
}
