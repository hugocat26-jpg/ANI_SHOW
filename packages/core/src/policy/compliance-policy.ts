const privateFields = new Set([
  'password',
  'id_card',
  'passport',
  'bank_account',
  'credit_card',
  'ip',
  'precise_address',
  'real_name'
])

export class CompliancePolicy {
  private dailyLimit: number

  constructor(dailyLimit = 10000) {
    this.dailyLimit = dailyLimit
  }

  canRunBatch(dailyCount: number): { allowed: boolean; reason: string } {
    if (dailyCount >= this.dailyLimit) return { allowed: false, reason: '已达到单日合规处理上限' }
    return { allowed: true, reason: '' }
  }

  sanitizeRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
    return Object.fromEntries(
      Object.entries(record).filter(([key]) => !privateFields.has(key.toLowerCase()))
    ) as Partial<T>
  }

  validateExportFields(fields: string[]): { allowed: boolean; violations: string[] } {
    const violations = fields.filter((field) => privateFields.has(field.toLowerCase()))
    return { allowed: violations.length === 0, violations }
  }
}
