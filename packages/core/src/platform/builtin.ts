import type { PlatformAuthMode, PlatformConnectorKind, PlatformIntegrationStatus, PlatformRiskLevel, PlatformSpec } from '../domain/types.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'
import { MetadataOnlyPlatformAdapter } from './adapter.ts'
import { PlatformRegistry } from './registry.ts'
import { SearchEngineAdapter } from './search-engine-adapter.ts'
import { PlaywrightSearchPageExecutor, type SearchPageExecutor } from './search-page-executor.ts'
import { VideoPlatformAdapter } from './video-platform-adapter.ts'

const baseRate = { concurrency: 1, minDelayMs: 1500, maxRetries: 2 }

interface PlatformGovernance {
  authMode: PlatformAuthMode
  riskLevel: PlatformRiskLevel
  connectorKind: PlatformConnectorKind
  integrationStatus: PlatformIntegrationStatus
  complianceNotes: string
}

const governanceByPlatform: Record<string, PlatformGovernance> = {
  google: {
    authMode: 'none',
    riskLevel: 'low',
    connectorKind: 'public_web',
    integrationStatus: 'active',
    complianceNotes: '优先使用公开搜索结果；后续可接入官方 Custom Search API 降低页面抓取不确定性。'
  },
  bing: {
    authMode: 'none',
    riskLevel: 'low',
    connectorKind: 'public_web',
    integrationStatus: 'active',
    complianceNotes: '优先使用公开搜索结果；后续可接入 Bing Web Search API。'
  },
  youtube: {
    authMode: 'optional_login',
    riskLevel: 'medium',
    connectorKind: 'hybrid',
    integrationStatus: 'active',
    complianceNotes: '公开搜索优先，评论采集建议优先使用 YouTube Data API 或低频用户授权访问。'
  },
  bilibili: {
    authMode: 'optional_login',
    riskLevel: 'medium',
    connectorKind: 'hybrid',
    integrationStatus: 'active',
    complianceNotes: '公开内容可低频访问；登录态仅用于用户授权场景，遇到风控需自动暂停。'
  },
  reddit: {
    authMode: 'none',
    riskLevel: 'low',
    connectorKind: 'public_web',
    integrationStatus: 'active',
    complianceNotes: '优先使用公开 JSON 端点；私密、隔离或权限受限社区不得绕过访问。'
  },
  xiaohongshu: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，不建议用个人账号批量采集；优先用户导入、低频单条验证或官方/授权数据源。'
  },
  douyin: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，禁止批量评论采集；遇到验证码、限流或账号警告必须暂停。'
  },
  tiktok: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，建议使用官方 Research/API 能力或用户导入，避免个人账号自动化高频访问。'
  },
  instagram: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，优先官方 Graph API/用户授权数据；不绕过登录、挑战或权限限制。'
  },
  facebook: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，优先官方 Graph API/用户授权数据；不采集非公开或权限受限内容。'
  },
  twitter: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，优先官方 API 或用户导入；登录态访问需低频且尊重平台限制。'
  },
  weibo: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，登录态采集需低频并在风控/验证码后自动暂停。'
  },
  zhihu: {
    authMode: 'required_login',
    riskLevel: 'medium',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '登录态内容需遵守可见范围；优先公开内容和用户授权导入。'
  },
  kuaishou: {
    authMode: 'required_login',
    riskLevel: 'high',
    connectorKind: 'logged_in_web',
    integrationStatus: 'active',
    complianceNotes: '高风险平台，禁止批量评论采集；遇到验证或限流后应进入保护期。'
  }
}

const rawBuiltinPlatformSpecs: PlatformSpec[] = [
  {
    key: 'google',
    name: 'Google',
    category: 'search_engine',
    domains: ['google.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { ...baseRate, minDelayMs: 600 }
  },
  {
    key: 'bing',
    name: 'Bing',
    category: 'search_engine',
    domains: ['bing.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { ...baseRate, minDelayMs: 600 }
  },
  {
    key: 'youtube',
    name: 'YouTube',
    category: 'video',
    domains: ['youtube.com', 'youtu.be'],
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube',
    requiresLogin: false,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    category: 'video',
    domains: ['tiktok.com'],
    loginUrl: 'https://www.tiktok.com/login',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'douyin',
    name: '抖音',
    category: 'video',
    domains: ['douyin.com', 'iesdouyin.com'],
    loginUrl: 'https://www.douyin.com/',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'bilibili',
    name: 'B站',
    category: 'video',
    domains: ['bilibili.com', 'b23.tv'],
    loginUrl: 'https://passport.bilibili.com/login',
    requiresLogin: false,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'xiaohongshu',
    name: '小红书',
    category: 'social',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    loginUrl: 'https://www.xiaohongshu.com/explore',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'instagram',
    name: 'Instagram',
    category: 'social',
    domains: ['instagram.com'],
    loginUrl: 'https://www.instagram.com/',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'facebook',
    name: 'Facebook',
    category: 'social',
    domains: ['facebook.com', 'fb.com', 'fb.watch'],
    loginUrl: 'https://www.facebook.com/',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'twitter',
    name: 'X/Twitter',
    category: 'social',
    domains: ['x.com', 'twitter.com'],
    loginUrl: 'https://x.com/i/flow/login',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content'],
    rateLimit: baseRate
  },
  {
    key: 'reddit',
    name: 'Reddit',
    category: 'forum',
    domains: ['reddit.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'weibo',
    name: '微博',
    category: 'social',
    domains: ['weibo.com'],
    loginUrl: 'https://weibo.com/login.php',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'zhihu',
    name: '知乎',
    category: 'forum',
    domains: ['zhihu.com'],
    loginUrl: 'https://www.zhihu.com/signin',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  },
  {
    key: 'kuaishou',
    name: '快手',
    category: 'video',
    domains: ['kuaishou.com'],
    loginUrl: 'https://www.kuaishou.com/',
    requiresLogin: true,
    capabilities: ['search', 'login', 'status', 'parse_content', 'comments'],
    rateLimit: baseRate
  }
]

export const builtinPlatformSpecs: PlatformSpec[] = rawBuiltinPlatformSpecs.map((spec) => ({
  ...spec,
  ...governanceByPlatform[spec.key]
}))

export const platformExpansionTargetSpecs: PlatformSpec[] = [
  {
    key: 'google_custom_search_api',
    name: 'Google Custom Search API',
    category: 'search_engine',
    domains: ['googleapis.com'],
    requiresLogin: false,
    capabilities: ['search', 'status'],
    rateLimit: { concurrency: 2, minDelayMs: 300, maxRetries: 2 },
    authMode: 'api_key',
    riskLevel: 'low',
    connectorKind: 'official_api',
    integrationStatus: 'official_api_preferred',
    complianceNotes: '用于替代公开 Google 搜索页抓取，需用户配置官方 API Key 和搜索引擎 ID。',
    roadmapNotes: '优先级高；适合作为跨平台补充搜索的稳定入口。'
  },
  {
    key: 'youtube_data_api',
    name: 'YouTube Data API',
    category: 'video',
    domains: ['googleapis.com', 'youtube.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content', 'comments'],
    rateLimit: { concurrency: 2, minDelayMs: 300, maxRetries: 2 },
    authMode: 'api_key',
    riskLevel: 'low',
    connectorKind: 'official_api',
    integrationStatus: 'official_api_preferred',
    complianceNotes: '优先走官方配额和授权边界，减少网页自动化和登录态账号风险。',
    roadmapNotes: '可先接搜索和视频详情，再评估评论接口配额与排序策略。'
  },
  {
    key: 'wechat_official_account',
    name: '微信公众号/文章',
    category: 'social',
    domains: ['mp.weixin.qq.com'],
    requiresLogin: false,
    capabilities: ['parse_content'],
    rateLimit: { concurrency: 1, minDelayMs: 2000, maxRetries: 1 },
    authMode: 'manual_import',
    riskLevel: 'medium',
    connectorKind: 'manual_import',
    integrationStatus: 'manual_import',
    complianceNotes: '优先由用户粘贴公开文章链接或导入授权数据，不做登录态批量抓取。',
    roadmapNotes: '适合作为内容解析和线索文本抽取入口，不作为评论采集主平台。'
  },
  {
    key: 'linkedin',
    name: 'LinkedIn',
    category: 'social',
    domains: ['linkedin.com'],
    requiresLogin: true,
    capabilities: ['search', 'status', 'parse_content'],
    rateLimit: { concurrency: 1, minDelayMs: 3000, maxRetries: 1 },
    authMode: 'api_key',
    riskLevel: 'high',
    connectorKind: 'official_api',
    integrationStatus: 'official_api_preferred',
    complianceNotes: '职业社交平台权限边界强，优先官方 API、合作数据或用户授权导入。',
    roadmapNotes: '不建议个人账号网页登录自动化。'
  },
  {
    key: 'pinterest',
    name: 'Pinterest',
    category: 'social',
    domains: ['pinterest.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content'],
    rateLimit: { concurrency: 1, minDelayMs: 2000, maxRetries: 1 },
    authMode: 'optional_login',
    riskLevel: 'medium',
    connectorKind: 'hybrid',
    integrationStatus: 'planned',
    complianceNotes: '公开内容可低频检索；登录态和图片详情采集需遵守平台限制。',
    roadmapNotes: '适合消费品、家居、视觉趋势线索。'
  },
  {
    key: 'amazon',
    name: 'Amazon',
    category: 'ecommerce',
    domains: ['amazon.com'],
    requiresLogin: false,
    capabilities: ['search', 'status', 'parse_content'],
    rateLimit: { concurrency: 1, minDelayMs: 2500, maxRetries: 1 },
    authMode: 'api_key',
    riskLevel: 'medium',
    connectorKind: 'official_api',
    integrationStatus: 'official_api_preferred',
    complianceNotes: '优先 Product Advertising API 或用户导入，避免抓取账号、订单或非公开数据。',
    roadmapNotes: '可作为商品评论与需求词研究的合规数据源。'
  },
  {
    key: 'taobao_tmall',
    name: '淘宝/天猫',
    category: 'ecommerce',
    domains: ['taobao.com', 'tmall.com'],
    requiresLogin: true,
    capabilities: ['parse_content'],
    rateLimit: { concurrency: 1, minDelayMs: 3000, maxRetries: 1 },
    authMode: 'manual_import',
    riskLevel: 'high',
    connectorKind: 'manual_import',
    integrationStatus: 'manual_import',
    complianceNotes: '高风险电商平台，优先用户导出/授权数据或官方开放平台，不做个人账号批量自动化。',
    roadmapNotes: '先支持表格/链接导入和本地 AI 分析。'
  },
  {
    key: 'jd',
    name: '京东',
    category: 'ecommerce',
    domains: ['jd.com'],
    requiresLogin: true,
    capabilities: ['parse_content'],
    rateLimit: { concurrency: 1, minDelayMs: 3000, maxRetries: 1 },
    authMode: 'manual_import',
    riskLevel: 'high',
    connectorKind: 'manual_import',
    integrationStatus: 'manual_import',
    complianceNotes: '高风险电商平台，优先用户导出/授权数据或官方开放平台，不做个人账号批量自动化。',
    roadmapNotes: '先支持手动导入评论/商品链接，再评估官方接口。'
  }
]

export function createBuiltinPlatformRegistry(
  browser = new BrowserContextManager(),
  searchExecutor: SearchPageExecutor = new PlaywrightSearchPageExecutor(browser)
): PlatformRegistry {
  const registry = new PlatformRegistry()
  const searchUrlBuilders: Record<string, (keyword: string) => string> = {
    google: (keyword) => `https://www.google.com/search?q=${encodeURIComponent(keyword)}`,
    bing: (keyword) => `https://www.bing.com/search?q=${encodeURIComponent(keyword)}`,
    youtube: (keyword) => `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`,
    bilibili: (keyword) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
    tiktok: (keyword) => `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`,
    douyin: (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}`,
    xiaohongshu: (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
    instagram: (keyword) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(keyword)}`,
    facebook: (keyword) => `https://www.facebook.com/search/top?q=${encodeURIComponent(keyword)}`,
    twitter: (keyword) => `https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query`,
    reddit: (keyword) => `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`,
    weibo: (keyword) => `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}`,
    zhihu: (keyword) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`,
    kuaishou: (keyword) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`
  }
  for (const spec of builtinPlatformSpecs) {
    if (spec.key === 'google') {
      registry.register(new SearchEngineAdapter(spec, searchUrlBuilders.google, browser, searchExecutor))
    } else if (spec.key === 'bing') {
      registry.register(new SearchEngineAdapter(spec, searchUrlBuilders.bing, browser, searchExecutor))
    } else if (spec.key === 'youtube') {
      registry.register(new VideoPlatformAdapter(spec, 'youtube', searchUrlBuilders.youtube, browser, searchExecutor))
    } else if (spec.key === 'bilibili') {
      registry.register(new VideoPlatformAdapter(spec, 'bilibili', searchUrlBuilders.bilibili, browser, searchExecutor))
    } else if (searchUrlBuilders[spec.key]) {
      registry.register(new SearchEngineAdapter(spec, searchUrlBuilders[spec.key], browser, searchExecutor))
    } else {
      registry.register(new MetadataOnlyPlatformAdapter(spec, browser))
    }
  }
  return registry
}
