import type { AIAnalysisStats, AIFailurePolicy } from '../domain/types.ts'

export interface AIFailurePolicyPreset {
  key: 'conservative' | 'balanced' | 'aggressive' | 'offline_safe'
  name: string
  description: string
  policy: Omit<AIFailurePolicy, 'updatedAt'>
}

export interface AIRecoveryAdvice {
  severity: 'info' | 'warning' | 'critical'
  title: string
  actions: string[]
  recommendedPolicyKey?: AIFailurePolicyPreset['key']
}

export const aiFailurePolicyPresets: AIFailurePolicyPreset[] = [
  {
    key: 'balanced',
    name: '均衡',
    description: '适合日常批量分析，兼顾速度和稳定性。',
    policy: { maxRetries: 1, retryDelayMs: 800, minDelayMs: 0, circuitBreakerThreshold: 5 }
  },
  {
    key: 'conservative',
    name: '保守',
    description: '适合平台或模型接口不稳定时使用，降低请求频率。',
    policy: { maxRetries: 2, retryDelayMs: 1500, minDelayMs: 500, circuitBreakerThreshold: 3 }
  },
  {
    key: 'aggressive',
    name: '快速',
    description: '适合少量评论快速分析，失败时尽快返回。',
    policy: { maxRetries: 0, retryDelayMs: 0, minDelayMs: 0, circuitBreakerThreshold: 8 }
  },
  {
    key: 'offline_safe',
    name: '离线优先',
    description: '适合未配置模型或密钥异常时，尽快切换到规则回退。',
    policy: { maxRetries: 0, retryDelayMs: 0, minDelayMs: 0, circuitBreakerThreshold: 1 }
  }
]

export function listAIFailurePolicyPresets(): AIFailurePolicyPreset[] {
  return aiFailurePolicyPresets.map((preset) => ({ ...preset, policy: { ...preset.policy } }))
}

export function buildAIRecoveryAdvice(stats?: AIAnalysisStats): AIRecoveryAdvice {
  if (!stats) {
    return {
      severity: 'info',
      title: '暂无 AI 分析统计',
      actions: ['完成一次批量分析后查看模型调用、失败分类和熔断状态。']
    }
  }
  if (stats.circuitOpen) {
    return {
      severity: 'critical',
      title: 'AI 分析已触发熔断',
      recommendedPolicyKey: 'offline_safe',
      actions: [
        '检查当前 Provider 的 API Key、余额和模型名称。',
        '切换到保守或离线优先策略后重试。',
        '若失败集中在 rate_limited 或 server_error，增加重试延迟和请求间隔。'
      ]
    }
  }
  if (stats.failed > 0) {
    return {
      severity: 'warning',
      title: 'AI 分析存在失败项',
      recommendedPolicyKey: stats.failuresByCode?.rate_limited || stats.failuresByCode?.server_error ? 'conservative' : 'balanced',
      actions: [
        '查看失败分类，优先处理 auth_failed、missing_api_key、rate_limited。',
        '保留规则回退结果，并对高价值评论稍后重试模型分析。'
      ]
    }
  }
  return {
    severity: 'info',
    title: 'AI 分析状态正常',
    actions: ['当前策略运行正常，可继续观察模型成本和规则回退比例。']
  }
}
