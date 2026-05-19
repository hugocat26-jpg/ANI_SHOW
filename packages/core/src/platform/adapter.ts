import type {
  PlatformSpec,
  PlatformStatus,
  SearchInput,
  SearchResult,
  ContentRef,
  CommentRecord
} from '../domain/types.ts'
import { BrowserContextManager } from '../browser/browser-context-manager.ts'

export interface LoginResult {
  success: boolean
  message: string
}

export interface CollectEvent {
  type: 'progress' | 'comment' | 'completed' | 'failed'
  payload: unknown | CommentRecord
}

export interface PlatformAdapter {
  spec: PlatformSpec
  checkStatus(): Promise<PlatformStatus>
  login(): Promise<LoginResult>
  search(input: SearchInput): Promise<SearchResult[]>
  parseContent(url: string): Promise<ContentRef>
  collectComments(input: ContentRef): AsyncIterable<CollectEvent>
}

export class MetadataOnlyPlatformAdapter implements PlatformAdapter {
  spec: PlatformSpec
  protected browser: BrowserContextManager

  constructor(spec: PlatformSpec, browser = new BrowserContextManager()) {
    this.spec = spec
    this.browser = browser
  }

  async checkStatus(): Promise<PlatformStatus> {
    return this.browser.inferStatusFromSpec(this.spec)
  }

  async login(): Promise<LoginResult> {
    return {
      success: !this.spec.requiresLogin,
      message: this.spec.requiresLogin ? '登录流程尚未实现' : '该平台无需登录'
    }
  }

  async search(input: SearchInput): Promise<SearchResult[]> {
    if (!this.spec.capabilities.includes('search')) return []
    return [{
      id: `${this.spec.key}-${Date.now()}`,
      platformKey: this.spec.key,
      title: `${input.keyword} - ${this.spec.name} 搜索占位结果`,
      url: `https://${this.spec.domains[0]}/search?q=${encodeURIComponent(input.keyword)}`,
      snippet: '平台 Adapter 已注册，真实搜索实现将在后续迭代接入。',
      relevance: 0.1,
      createdAt: new Date().toISOString()
    }]
  }

  async parseContent(url: string): Promise<ContentRef> {
    return {
      platformKey: this.spec.key,
      url,
      contentId: url,
      contentType: 'unknown'
    }
  }

  async *collectComments(_input: ContentRef): AsyncIterable<CollectEvent> {
    yield { type: 'failed', payload: { message: '评论采集尚未实现' } }
  }
}
