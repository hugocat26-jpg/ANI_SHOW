import type { PlatformCapability, PlatformSpec } from '../domain/types.ts'

export function isActivePlatform(spec: PlatformSpec): boolean {
  return (spec.integrationStatus ?? 'active') === 'active'
}

export function hasPlatformCapability(spec: PlatformSpec, capability: PlatformCapability): boolean {
  return spec.capabilities.includes(capability)
}

export function canSearchPlatform(spec: PlatformSpec): boolean {
  return isActivePlatform(spec) && hasPlatformCapability(spec, 'search')
}

export function canLoginPlatform(spec: PlatformSpec): boolean {
  return isActivePlatform(spec) && hasPlatformCapability(spec, 'login') && spec.authMode !== 'manual_import'
}

export function requiresSingleItemCollection(spec: PlatformSpec): boolean {
  if (!isActivePlatform(spec) || spec.riskLevel !== 'high') return false
  return spec.connectorKind === 'logged_in_web' || spec.connectorKind === 'hybrid' || spec.authMode === 'required_login'
}

export function canBatchCollectPlatform(spec: PlatformSpec): boolean {
  return isActivePlatform(spec) && !requiresSingleItemCollection(spec)
}
