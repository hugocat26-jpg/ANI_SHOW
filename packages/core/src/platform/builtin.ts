import type { PlatformSpec } from '../domain/types.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'
import { MetadataOnlyPlatformAdapter } from './adapter.ts'
import { PlatformRegistry } from './registry.ts'
import { SearchEngineAdapter } from './search-engine-adapter.ts'
import { PlaywrightSearchPageExecutor, type SearchPageExecutor } from './search-page-executor.ts'
import { VideoPlatformAdapter } from './video-platform-adapter.ts'

const baseRate = { concurrency: 1, minDelayMs: 1500, maxRetries: 2 }

export const builtinPlatformSpecs: PlatformSpec[] = [
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
