export type AIProviderErrorCode =
  | 'missing_api_key'
  | 'auth_failed'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'invalid_response'
  | 'unknown'

export class AIProviderError extends Error {
  code: AIProviderErrorCode
  retryable: boolean
  status?: number

  constructor(code: AIProviderErrorCode, message: string, options: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message)
    this.name = 'AIProviderError'
    this.code = code
    this.retryable = options.retryable ?? isRetryableCode(code)
    this.status = options.status
    this.cause = options.cause
  }
}

export function classifyAIError(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error
  if (error instanceof SyntaxError) return new AIProviderError('invalid_response', error.message, { retryable: false, cause: error })
  if (error instanceof TypeError) return new AIProviderError('network_error', error.message, { retryable: true, cause: error })
  if (error instanceof Error) return new AIProviderError('unknown', error.message, { retryable: true, cause: error })
  return new AIProviderError('unknown', String(error), { retryable: true, cause: error })
}

export function codeFromHttpStatus(status: number): AIProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 408 || status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'unknown'
}

function isRetryableCode(code: AIProviderErrorCode): boolean {
  return code === 'rate_limited' || code === 'server_error' || code === 'network_error' || code === 'unknown'
}
