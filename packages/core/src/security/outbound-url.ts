export interface OutboundUrlPolicy {
  allowedDomains?: string[]
  requireHttps?: boolean
}

export function validateOutboundUrl(rawUrl: string, policy: OutboundUrlPolicy = {}): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('出站请求被拦截: URL 无效')
  }
  if ((policy.requireHttps ?? true) && parsed.protocol !== 'https:') {
    throw new Error(`出站请求被拦截: URL 必须使用 HTTPS (${parsed.protocol})`)
  }
  const host = parsed.hostname.toLowerCase()
  if (isLocalOrPrivateHost(host)) {
    throw new Error(`出站请求被拦截: 不允许访问本机或内网地址 (${host})`)
  }
  if (policy.allowedDomains?.length && !isAllowedHost(host, policy.allowedDomains)) {
    throw new Error(`出站请求被拦截: 域名不在允许范围内 (${host})`)
  }
  return parsed
}

export function isAllowedOutboundUrl(rawUrl: string, policy: OutboundUrlPolicy = {}): boolean {
  try {
    validateOutboundUrl(rawUrl, policy)
    return true
  } catch {
    return false
  }
}

export function isAllowedHost(host: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => isSameOrSubdomain(host, domain))
}

export function isSameOrSubdomain(host: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, '')
  const normalizedHost = host.toLowerCase().replace(/^www\./, '')
  return normalizedHost === normalized || normalizedHost.endsWith(`.${normalized}`)
}

export function isLocalOrPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mappedIpv4) return isLocalOrPrivateHost(mappedIpv4)
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^169\.254\./.test(normalized)) return true
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(normalized)
  if (!match) return false
  const first = Number(match[1])
  const second = Number(match[2])
  return (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}
