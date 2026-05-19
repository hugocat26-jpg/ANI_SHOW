import type { CommentInput } from '../domain/types.ts'

export function buildIntentAnalysisPrompt(comment: CommentInput): string {
  return [
    '你是客户线索挖掘软件中的意向分析模型。',
    '请只输出 JSON，不要输出 Markdown。',
    '字段要求：level 只能是 high、medium、low、none；confidence 为 0 到 1；keywords 为命中的关键词数组；reason 为简短中文原因。',
    '',
    `平台：${comment.platformKey}`,
    `内容链接：${comment.contentUrl}`,
    `昵称：${comment.nickname}`,
    `点赞数：${comment.likes}`,
    `评论：${comment.text}`
  ].join('\n')
}
