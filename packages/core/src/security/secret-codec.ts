export interface SecretCodec {
  encode(value: string): string
  decode(value: string): string
  describe(): string
  inspect?(value: string): 'encrypted' | 'plain' | 'legacy_plain' | 'external_env' | 'unknown'
}

export class PlainSecretCodec implements SecretCodec {
  encode(value: string): string {
    return value
  }

  decode(value: string): string {
    return value
  }

  describe(): string {
    return 'plain'
  }

  inspect(value: string): 'plain' | 'legacy_plain' {
    return value.startsWith('plain:') ? 'plain' : 'legacy_plain'
  }
}
