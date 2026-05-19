import type { PlatformCapability, PlatformSpec } from '../domain/types.ts'
import type { PlatformAdapter } from './adapter.ts'

export class PlatformRegistry {
  private adapters = new Map<string, PlatformAdapter>()

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.spec.key, adapter)
  }

  get(key: string): PlatformAdapter {
    const adapter = this.adapters.get(key)
    if (!adapter) throw new Error(`Platform adapter not registered: ${key}`)
    return adapter
  }

  list(): PlatformSpec[] {
    return [...this.adapters.values()].map((adapter) => adapter.spec).sort((a, b) => a.key.localeCompare(b.key))
  }

  byCapability(capability: PlatformCapability): PlatformSpec[] {
    return this.list().filter((spec) => spec.capabilities.includes(capability))
  }

  keys(): string[] {
    return [...this.adapters.keys()].sort()
  }
}
