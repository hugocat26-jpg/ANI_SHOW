import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

import { canBatchCollectPlatform, canLoginPlatform, canSearchPlatform, requiresSingleItemCollection } from '../../../../../packages/core/src/platform/capability-policy'
import type { AIAnalysisStats, AIFailurePolicy, AIFailurePolicyPreset, AIProviderKey, AIProviderPublicConfig, AIRecoveryAdvice, AISecretHealth, AuditEvent, AuditLogFilters, CommentRecord, FollowUpReminder, KeywordPlan, LeadDetail, LeadExportPreview, LeadRecord, ManualImportConflictStrategy, ManualImportPreview, ManualImportTemplateType, ModelPricingView, PlatformConnectorPublicConfig, PlatformSpec, PlatformStatus, PrivacyCleanupEstimate, PrivacyCleanupOptions, SearchResult, Task } from '../../../../../packages/core/src/index'
import { getLeadMinerApi } from './leadMinerApi'

const api = getLeadMinerApi()
type ViewKey = 'dashboard' | 'platforms' | 'searchResults' | 'tasks' | 'leads' | 'ai' | 'audit' | 'settings'
type ConnectorErrorFilter = 'all' | 'failed' | 'quota_exhausted' | 'auth_failed' | 'rate_limited' | 'retryable'
type AuditPreset = 'all' | 'manual_import' | 'platform' | 'lead' | 'ai' | 'privacy'

export function App() {
  const [keyword, setKeyword] = useState('咖啡机')
  const [selected, setSelected] = useState<ViewKey>('dashboard')
  const [appVersion, setAppVersion] = useState('')
  const [platforms, setPlatforms] = useState<PlatformSpec[]>([])
  const [platformTargets, setPlatformTargets] = useState<PlatformSpec[]>([])
  const [platformConnectorConfigs, setPlatformConnectorConfigs] = useState<PlatformConnectorPublicConfig[]>([])
  const [connectorErrorFilter, setConnectorErrorFilter] = useState<ConnectorErrorFilter>('all')
  const [statuses, setStatuses] = useState<PlatformStatus[]>([])
  const [keywordPlan, setKeywordPlan] = useState<KeywordPlan>({ seed: '', keywords: [], locales: [] })
  const [results, setResults] = useState<SearchResult[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [leads, setLeads] = useState<LeadRecord[]>([])
  const [auditLogs, setAuditLogs] = useState<AuditEvent[]>([])
  const [auditPreset, setAuditPreset] = useState<AuditPreset>('manual_import')
  const [auditKeyword, setAuditKeyword] = useState('')
  const [followUps, setFollowUps] = useState<FollowUpReminder[]>([])
  const [aiProviders, setAiProviders] = useState<AIProviderPublicConfig[]>([])
  const [aiSecretHealth, setAiSecretHealth] = useState<AISecretHealth[]>([])
  const [aiStats, setAiStats] = useState<AIAnalysisStats | undefined>()
  const [modelPricing, setModelPricing] = useState<ModelPricingView[]>([])
  const [currentPricing, setCurrentPricing] = useState<ModelPricingView | undefined>()
  const [pricingForm, setPricingForm] = useState({ provider: 'custom' as AIProviderKey, modelPattern: '', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })
  const [failurePolicy, setFailurePolicy] = useState<AIFailurePolicy>({ maxRetries: 1, retryDelayMs: 800, minDelayMs: 0, circuitBreakerThreshold: 5, updatedAt: '' })
  const [failurePresets, setFailurePresets] = useState<AIFailurePolicyPreset[]>([])
  const [recoveryAdvice, setRecoveryAdvice] = useState<AIRecoveryAdvice | undefined>()
  const [aiForm, setAiForm] = useState({ provider: 'deepseek' as AIProviderKey, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', enabled: true })
  const [platformConnectorForm, setPlatformConnectorForm] = useState({
    platformKey: '',
    enabled: false,
    apiBaseUrl: '',
    apiKey: '',
    quotaPerDay: 1000,
    minDelayMs: 1000,
    importFields: 'url,title,body,published_at',
    requiredFields: 'url,body'
  })
  const [manualImportForm, setManualImportForm] = useState({
    platformKey: 'wechat_official_account',
    templateType: 'wechat_article_csv' as ManualImportTemplateType,
    conflictStrategy: 'skip_duplicates' as ManualImportConflictStrategy,
    sourceUrl: '',
    title: '',
    body: '',
    csv: 'author,comment,likes,time,link\nAlice,公众号文章里提到的型号多少钱,8,2026-05-20T10:00:00.000Z,https://mp.weixin.qq.com/s/demo'
  })
  const [manualImportPreview, setManualImportPreview] = useState<ManualImportPreview | undefined>()
  const [cleanupOptions, setCleanupOptions] = useState<PrivacyCleanupOptions>({
    platformProfiles: false,
    platformState: true,
    searchData: true,
    commentsAndLeads: true,
    tasks: true,
    aiSecretBackups: false,
    auditLogs: false,
    localLogs: true
  })
  const [privacyEstimate, setPrivacyEstimate] = useState<PrivacyCleanupEstimate | undefined>()
  const [leadExportPreview, setLeadExportPreview] = useState<LeadExportPreview | undefined>()
  const [leadStatus, setLeadStatus] = useState<LeadRecord['status'] | 'all'>('all')
  const [leadKeyword, setLeadKeyword] = useState('')
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([])
  const [editingLead, setEditingLead] = useState<LeadRecord | undefined>()
  const [editingLeadDetail, setEditingLeadDetail] = useState<LeadDetail | undefined>()
  const [leadDraft, setLeadDraft] = useState({ note: '', nextFollowUpAt: '' })
  const [lastFollowUpNotificationKey, setLastFollowUpNotificationKey] = useState('')
  const [lastAIRecoveryNotificationKey, setLastAIRecoveryNotificationKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [platformDefaultsReady, setPlatformDefaultsReady] = useState(false)
  const [selectedResultIds, setSelectedResultIds] = useState<string[]>([])
  const [collectProgressByResultId, setCollectProgressByResultId] = useState<Record<string, ResultCollectProgress>>({})
  const [batchCollectProgress, setBatchCollectProgress] = useState<BatchCollectProgress | undefined>()
  const [selectionBox, setSelectionBox] = useState<SelectionBox | undefined>()
  const resultListRef = useRef<HTMLDivElement | null>(null)

  const statusByPlatform = useMemo(() => new Map(statuses.map((status) => [status.platformKey, status])), [statuses])
  const platformByKey = useMemo(() => new Map(platforms.map((platform) => [platform.key, platform])), [platforms])
  const searchableKeys = useMemo(() => selectedPlatforms, [selectedPlatforms])
  const visibleConnectorConfigs = useMemo(() => platformConnectorConfigs.filter((config) => {
    if (connectorErrorFilter === 'all') return true
    if (connectorErrorFilter === 'failed') return config.lastStatus === 'failed'
    if (connectorErrorFilter === 'retryable') return config.lastRetryable === true
    return config.lastErrorCode === connectorErrorFilter
  }), [connectorErrorFilter, platformConnectorConfigs])

  useEffect(() => {
    void refresh()
    void api.getAppVersion().then(setAppVersion).catch(() => setAppVersion(''))
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (platforms.length > 0 && !platformDefaultsReady) {
      setSelectedPlatforms(platforms.filter((platform) => canSearchPlatform(platform) && ['google', 'bing', 'youtube', 'bilibili'].includes(platform.key)).map((platform) => platform.key))
      setPlatformDefaultsReady(true)
    }
  }, [platforms, platformDefaultsReady])

  useEffect(() => {
    const searchablePlatformKeys = new Set(platforms.filter(canSearchPlatform).map((platform) => platform.key))
    setSelectedPlatforms((current) => current.filter((key) => searchablePlatformKeys.has(key)))
  }, [platforms])

  useEffect(() => {
    const resultIds = new Set(results.map((result) => result.id))
    setSelectedResultIds((current) => current.filter((id) => resultIds.has(id)))
    setCollectProgressByResultId((current) => Object.fromEntries(Object.entries(current).filter(([id]) => resultIds.has(id))))
  }, [results])

  useEffect(() => {
    if (!api.notifyFollowUps) return
    const overdue = followUps.filter((item) => item.status === 'overdue').length
    const today = followUps.filter((item) => item.status === 'today').length
    const key = `${new Date().toISOString().slice(0, 10)}:${overdue}:${today}`
    if (overdue + today === 0 || key === lastFollowUpNotificationKey) return
    setLastFollowUpNotificationKey(key)
    void api.notifyFollowUps({ overdue, today })
  }, [followUps, lastFollowUpNotificationKey])

  useEffect(() => {
    if (!api.notifyAIRecovery || !recoveryAdvice || recoveryAdvice.severity === 'info') return
    const key = `${recoveryAdvice.severity}:${recoveryAdvice.title}:${recoveryAdvice.recommendedPolicyKey ?? ''}`
    if (key === lastAIRecoveryNotificationKey) return
    setLastAIRecoveryNotificationKey(key)
    void api.notifyAIRecovery(recoveryAdvice)
  }, [recoveryAdvice, lastAIRecoveryNotificationKey])

  async function refresh() {
    try {
      const [nextPlatforms, nextPlatformTargets, nextConnectorConfigs, nextStatuses, nextTasks, nextResults, nextComments, nextLeads, nextAuditLogs, nextFollowUps, nextAIProviders, nextAISecretHealth, nextAIStats, nextModelPricing, nextCurrentPricing, nextFailurePolicy, nextFailurePresets, nextRecoveryAdvice] = await Promise.all([
        api.listPlatforms(),
        api.listPlatformExpansionTargets(),
        api.listPlatformConnectorConfigs(),
        api.checkPlatformStatuses(),
        api.listTasks(),
        api.listSearchResults(),
        api.listComments(),
        api.listLeads({ status: leadStatus }),
        api.listAuditLogs({ limit: 100, actionPrefix: auditPreset === 'all' ? undefined : auditPreset, keyword: auditKeyword || undefined }),
        api.listFollowUpReminders({ horizonDays: 7 }),
        api.listAIProviders(),
        api.listAISecretHealth(),
        api.getAIAnalysisStats(),
        api.listModelPricing(),
        api.currentModelPricing(),
        api.getAIFailurePolicy(),
        api.listAIFailurePolicyPresets(),
        api.getAIRecoveryAdvice()
      ])
      setPlatforms(nextPlatforms)
      setPlatformTargets(nextPlatformTargets)
      setPlatformConnectorConfigs(nextConnectorConfigs)
      setPlatformConnectorForm((current) => current.platformKey ? current : {
        ...current,
        platformKey: nextPlatformTargets[0]?.key ?? ''
      })
      setStatuses(nextStatuses)
      setTasks(nextTasks)
      setResults(nextResults)
      setComments(nextComments)
      setLeads(nextLeads)
      setAuditLogs(nextAuditLogs)
      setFollowUps(nextFollowUps)
      setAiProviders(nextAIProviders)
      setAiSecretHealth(nextAISecretHealth)
      setAiStats(nextAIStats)
      setModelPricing(nextModelPricing)
      setCurrentPricing(nextCurrentPricing)
      setFailurePolicy(nextFailurePolicy)
      setFailurePresets(nextFailurePresets)
      setRecoveryAdvice(nextRecoveryAdvice)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadAuditLogs(nextPreset = auditPreset, nextKeyword = auditKeyword) {
    const filters: AuditLogFilters = {
      limit: 100,
      actionPrefix: nextPreset === 'all' ? undefined : nextPreset,
      keyword: nextKeyword || undefined
    }
    setAuditLogs(await api.listAuditLogs(filters))
  }

  async function planKeyword() {
    try {
      setKeywordPlan(await api.planSearch(keyword))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function runSearch() {
    if (searchableKeys.length === 0) {
      setNotice('请至少选择一个搜索平台')
      return
    }
    const searchablePlatformKeys = new Set(platforms.filter(canSearchPlatform).map((platform) => platform.key))
    const safeSearchKeys = searchableKeys.filter((key) => searchablePlatformKeys.has(key))
    if (safeSearchKeys.length === 0) {
      setNotice('当前选择的平台未开放搜索能力')
      return
    }
    setBusy(true)
    try {
      const plan = await api.planSearch(keyword)
      const nextResults = await api.runSearch({ keyword, platformKeys: safeSearchKeys })
      setKeywordPlan(plan)
      setResults(nextResults)
      setSelectedResultIds([])
      setTasks(await api.listTasks())
      setNotice(`已入库 ${nextResults.length} 条搜索结果`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function login(platformKey: string) {
    setBusy(true)
    try {
      const result = await api.loginPlatform(platformKey)
      setNotice(result.message)
      if (result.status) {
        setStatuses((current) => [
          ...current.filter((status) => status.platformKey !== platformKey),
          result.status as PlatformStatus
        ])
      }
      setStatuses(await api.checkPlatformStatuses())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  function togglePlatform(platformKey: string) {
    setSelectedPlatforms((current) => (
      current.includes(platformKey)
        ? current.filter((key) => key !== platformKey)
        : [...current, platformKey]
    ))
  }

  async function collect(result: SearchResult) {
    setBusy(true)
    if (isSingleItemCollectionResult(result, platformByKey)) {
      setNotice(`${result.platformKey} 属于高风险登录平台，本次仅执行单条低频采集；如出现验证码/警告请立即停止。`)
    }
    setBatchCollectProgress({
      current: 1,
      total: 1,
      title: result.title,
      message: '准备采集评论'
    })
    setResultCollectProgress(result.id, {
      status: 'running',
      message: '正在打开内容并加载评论',
      comments: 0,
      updatedAt: new Date().toISOString()
    })
    try {
      const nextComments = await collectByUrl(result.platformKey, result.url)
      setResultCollectProgress(result.id, {
        status: 'completed',
        message: `采集完成，获得 ${nextComments.length} 条评论`,
        comments: nextComments.length,
        updatedAt: new Date().toISOString()
      })
      setBatchCollectProgress({
        current: 1,
        total: 1,
        title: result.title,
        message: `采集完成，获得 ${nextComments.length} 条评论`
      })
      setNotice(`已采集 ${nextComments.length} 条评论: ${result.title}`)
    } catch (error) {
      setResultCollectProgress(result.id, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        comments: 0,
        updatedAt: new Date().toISOString()
      })
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      window.setTimeout(() => setBatchCollectProgress(undefined), 1600)
    }
  }

  async function collectSelectedResults() {
    const selectedResults = results.filter((result) => selectedResultIds.includes(result.id))
    if (selectedResults.length === 0) {
      setNotice('请先框选或勾选要采集的搜索结果')
      return
    }
    const highRiskResults = selectedResults.filter((result) => {
      const platform = platformByKey.get(result.platformKey)
      return platform ? !canBatchCollectPlatform(platform) : false
    })
    if (highRiskResults.length > 0) {
      setNotice(`为保护账号，${[...new Set(highRiskResults.map((result) => result.platformKey))].join('、')} 不支持批量评论采集。请只选择单条内容低频采集，出现平台警告后停止。`)
      return
    }
    setBusy(true)
    const total = selectedResults.length
    setBatchCollectProgress({
      current: 0,
      total,
      title: '批量采集',
      message: `等待采集 ${total} 个搜索结果`
    })
    const now = new Date().toISOString()
    setCollectProgressByResultId((current) => ({
      ...current,
      ...Object.fromEntries(selectedResults.map((result) => [result.id, {
        status: 'pending',
        message: '等待批量采集',
        comments: 0,
        updatedAt: now
      } satisfies ResultCollectProgress]))
    }))
    let activeResultId = ''
    try {
      let totalComments = 0
      for (const [index, result] of selectedResults.entries()) {
        activeResultId = result.id
        setBatchCollectProgress({
          current: index + 1,
          total,
          title: result.title,
          message: `正在采集 ${index + 1}/${total}`
        })
        setResultCollectProgress(result.id, {
          status: 'running',
          message: `正在采集 ${index + 1}/${total}`,
          comments: 0,
          updatedAt: new Date().toISOString()
        })
        const nextComments = await collectByUrl(result.platformKey, result.url)
        totalComments += nextComments.length
        setResultCollectProgress(result.id, {
          status: 'completed',
          message: `采集完成，获得 ${nextComments.length} 条评论`,
          comments: nextComments.length,
          updatedAt: new Date().toISOString()
        })
      }
      setSelectedResultIds([])
      setBatchCollectProgress({
        current: total,
        total,
        title: '批量采集完成',
        message: `共采集 ${totalComments} 条评论`
      })
      setNotice(`已批量采集 ${selectedResults.length} 个内容，共 ${totalComments} 条评论`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (activeResultId) {
        setResultCollectProgress(activeResultId, {
          status: 'failed',
          message,
          comments: 0,
          updatedAt: new Date().toISOString()
        })
      }
      setBatchCollectProgress((current) => current ? {
        ...current,
        message
      } : current)
      setNotice(message)
    } finally {
      setBusy(false)
      window.setTimeout(() => setBatchCollectProgress(undefined), 2200)
    }
  }

  function setResultCollectProgress(resultId: string, progress: ResultCollectProgress) {
    setCollectProgressByResultId((current) => ({ ...current, [resultId]: progress }))
  }

  function toggleResultSelection(id: string) {
    setSelectedResultIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  function startResultSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('a,button,input,label,select,textarea')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectionBox({
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY
    })
  }

  function moveResultSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (!selectionBox?.active) return
    setSelectionBox((current) => current ? { ...current, currentX: event.clientX, currentY: event.clientY } : current)
  }

  function finishResultSelection() {
    if (!selectionBox?.active || !resultListRef.current) {
      setSelectionBox(undefined)
      return
    }
    const marquee = normalizedBox(selectionBox)
    const nextIds = [...resultListRef.current.querySelectorAll<HTMLElement>('[data-result-id]')]
      .filter((node) => intersects(marquee, node.getBoundingClientRect()))
      .map((node) => node.dataset.resultId)
      .filter((id): id is string => Boolean(id))
    if (nextIds.length > 0) {
      setSelectedResultIds((current) => [...new Set([...current, ...nextIds])])
    }
    setSelectionBox(undefined)
  }

  async function collectByUrl(platformKey: string, url: string) {
    const nextComments = await api.collectComments({ platformKey, url })
    setComments(nextComments)
    setTasks(await api.listTasks())
    setLeads(await api.listLeads({ status: leadStatus }))
    setFollowUps(await api.listFollowUpReminders({ horizonDays: 7 }))
    return nextComments
  }

  async function retryTask(task: Task) {
    if (task.type !== 'collect_comments' || !task.platformKey) return
    const url = taskInputUrl(task.input)
    if (!url) {
      setNotice('该任务缺少可重试的内容链接')
      return
    }
    setBusy(true)
    try {
      const nextComments = await collectByUrl(task.platformKey, url)
      setNotice(`已重试采集 ${nextComments.length} 条评论`)
    } catch (error) {
      setTasks(await api.listTasks())
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function analyzeLeads() {
    setBusy(true)
    try {
      const nextLeads = await api.analyzeLeads()
      setLeads(nextLeads)
      setFollowUps(await api.listFollowUpReminders({ horizonDays: 7 }))
      setAiStats(await api.getAIAnalysisStats())
      setRecoveryAdvice(await api.getAIRecoveryAdvice())
      setTasks(await api.listTasks())
      setNotice(`已生成 ${nextLeads.length} 条线索`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function refreshLeads(nextStatus = leadStatus) {
    const [nextLeads, nextFollowUps] = await Promise.all([
      api.listLeads({ status: nextStatus, keyword: leadKeyword }),
      api.listFollowUpReminders({ horizonDays: 7 })
    ])
    setLeads(nextLeads)
    setFollowUps(nextFollowUps)
  }

  async function updateLeadStatus(id: string, status: LeadRecord['status']) {
    setBusy(true)
    try {
      await api.updateLeadStatus({ id, status })
      await refreshLeads()
      setTasks(await api.listTasks())
      setNotice(`线索已标记为 ${status}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  function toggleLeadSelection(id: string) {
    setSelectedLeadIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  function openLeadDetail(lead: LeadRecord) {
    setEditingLead(lead)
    setEditingLeadDetail(undefined)
    setLeadDraft({
      note: lead.note ?? '',
      nextFollowUpAt: lead.nextFollowUpAt ? lead.nextFollowUpAt.slice(0, 16) : ''
    })
    void api.getLeadDetail(lead.id)
      .then((detail) => {
        setEditingLead(detail.lead)
        setEditingLeadDetail(detail)
        setLeadDraft({
          note: detail.lead.note ?? '',
          nextFollowUpAt: detail.lead.nextFollowUpAt ? detail.lead.nextFollowUpAt.slice(0, 16) : ''
        })
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
  }

  async function saveLeadDetail() {
    if (!editingLead) return
    setBusy(true)
    try {
      await api.updateLead({
        id: editingLead.id,
        patch: {
          note: leadDraft.note,
          nextFollowUpAt: leadDraft.nextFollowUpAt ? new Date(leadDraft.nextFollowUpAt).toISOString() : null
        }
      })
      setEditingLead(undefined)
      setEditingLeadDetail(undefined)
      await refreshLeads()
      setNotice('线索备注已保存')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function bulkUpdate(status: LeadRecord['status']) {
    if (selectedLeadIds.length === 0) return
    setBusy(true)
    try {
      const updated = await api.bulkUpdateLeadStatus({ ids: selectedLeadIds, status })
      setSelectedLeadIds([])
      await refreshLeads()
      setNotice(`已批量更新 ${updated.length} 条线索`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function exportLeads() {
    setBusy(true)
    try {
      const options = {
        filters: { status: leadStatus, keyword: leadKeyword },
        fields: ['platformKey', 'nickname', 'text', 'intentLevel', 'confidence', 'score', 'scoreReason', 'suggestedAction', 'status', 'note', 'lastContactedAt', 'nextFollowUpAt', 'createdAt']
      }
      if (api.exportLeadsToFile) {
        const saved = await api.exportLeadsToFile(options)
        setNotice(saved.canceled ? '已取消导出' : `已导出 ${saved.count} 条线索`)
        return
      }
      const result = await api.exportLeads(options)
      const blob = new Blob([result.content], { type: `${result.mimeType};charset=utf-8` })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename
      link.click()
      URL.revokeObjectURL(url)
      setNotice(`已导出 ${result.count} 条线索`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function previewLeadExport() {
    try {
      const preview = await api.previewLeadExport({
        filters: { status: leadStatus, keyword: leadKeyword },
        fields: ['platformKey', 'nickname', 'text', 'intentLevel', 'confidence', 'score', 'scoreReason', 'suggestedAction', 'status', 'note', 'lastContactedAt', 'nextFollowUpAt', 'createdAt']
      })
      setLeadExportPreview(preview)
      setNotice(`导出预览：${preview.count} 条，样例 ${preview.sampleRows.length} 条`)
    } catch (error) {
      setLeadExportPreview(undefined)
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function exportFollowUpCalendar() {
    setBusy(true)
    try {
      const options = { horizonDays: 30 }
      if (api.exportFollowUpsCalendarToFile) {
        const saved = await api.exportFollowUpsCalendarToFile(options)
        setNotice(saved.canceled ? '已取消日历导出' : `已导出 ${saved.count} 条跟进日历事件`)
        return
      }
      const result = await api.exportFollowUpsCalendar(options)
      const blob = new Blob([result.content], { type: `${result.mimeType};charset=utf-8` })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename
      link.click()
      URL.revokeObjectURL(url)
      setNotice(`已导出 ${result.count} 条跟进日历事件`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveAIProvider() {
    setBusy(true)
    try {
      const saved = await api.saveAIProvider(aiForm)
      setAiProviders(await api.listAIProviders())
      setAiSecretHealth(await api.listAISecretHealth())
      setCurrentPricing(await api.currentModelPricing())
      setAiForm((current) => ({ ...current, apiKey: '' }))
      setNotice(`${saved.provider} 已保存，密钥状态: ${saved.apiKeySet ? '已配置' : '未配置'}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function savePlatformConnectorConfig() {
    if (!platformConnectorForm.platformKey) {
      setNotice('请选择要配置的平台')
      return
    }
    setBusy(true)
    try {
      const importFields = parseCsvFields(platformConnectorForm.importFields)
      const requiredFields = parseCsvFields(platformConnectorForm.requiredFields)
      const saved = await api.savePlatformConnectorConfig({
        platformKey: platformConnectorForm.platformKey,
        enabled: platformConnectorForm.enabled,
        apiBaseUrl: platformConnectorForm.apiBaseUrl || undefined,
        apiKey: platformConnectorForm.apiKey || undefined,
        quotaPerDay: platformConnectorForm.quotaPerDay,
        minDelayMs: platformConnectorForm.minDelayMs,
        importTemplate: importFields.length > 0 ? { fields: importFields, requiredFields } : undefined
      })
      setPlatformConnectorConfigs((current) => [
        ...current.filter((item) => item.platformKey !== saved.platformKey),
        saved
      ].sort((a, b) => a.platformKey.localeCompare(b.platformKey)))
      setPlatformConnectorForm((current) => ({ ...current, apiKey: '' }))
      setNotice(`平台接入配置已保存：${saved.platformKey}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function importManualContent() {
    setBusy(true)
    try {
      const result = await api.importManualContent({
        platformKey: manualImportForm.platformKey,
        templateType: manualImportForm.templateType,
        conflictStrategy: manualImportForm.conflictStrategy,
        sourceUrl: manualImportForm.sourceUrl || undefined,
        title: manualImportForm.title || undefined,
        body: manualImportForm.body || undefined,
        csv: manualImportForm.csv || undefined
      })
      setComments(await api.listComments())
      setLeads(await api.listLeads())
      setTasks(await api.listTasks())
      await loadAuditLogs()
      setManualImportPreview(undefined)
      setNotice(`手动导入完成：新增 ${result.commentsImported} 条，跳过 ${result.duplicatesSkipped ?? 0} 条，更新 ${result.duplicatesUpdated ?? 0} 条，线索 ${result.leadsGenerated} 条`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function previewManualContent() {
    try {
      const preview = await api.previewManualContent({
        platformKey: manualImportForm.platformKey,
        templateType: manualImportForm.templateType,
        conflictStrategy: manualImportForm.conflictStrategy,
        sourceUrl: manualImportForm.sourceUrl || undefined,
        title: manualImportForm.title || undefined,
        body: manualImportForm.body || undefined,
        csv: manualImportForm.csv || undefined
      })
      setManualImportPreview(preview)
      setNotice(`导入预览：新评论 ${preview.newComments} 条，重复 ${preview.duplicates} 条，可更新 ${preview.updatableDuplicates} 条`)
    } catch (error) {
      setManualImportPreview(undefined)
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  async function loadManualImportFile(file?: File) {
    if (!file) return
    if (file.size > 1_000_000) {
      setNotice('CSV 文件不能超过 1MB')
      return
    }
    const text = await file.text()
    setManualImportForm((current) => ({ ...current, csv: text }))
    setManualImportPreview(undefined)
    setNotice(`已载入 CSV：${file.name}`)
  }

  function downloadManualImportTemplate() {
    const samples: Record<ManualImportTemplateType, string> = {
      comment_csv: 'nickname,text,likes,published_at,url\r\nAlice,这个多少钱 求链接,8,2026-05-20T10:00:00.000Z,https://example.com/post\r\n',
      wechat_article_csv: 'author,comment,likes,time,link\r\nAlice,公众号文章里提到的型号多少钱,8,2026-05-20T10:00:00.000Z,https://mp.weixin.qq.com/s/demo\r\n',
      social_comments_csv: 'username,content,like_count,date,link\r\nAlice,想了解购买渠道,12,2026-05-20T10:00:00.000Z,https://example.com/post\r\n',
      commerce_reviews_csv: 'buyer,review,likes,created_at,url\r\nAlice,评价不错 想回购,3,2026-05-20T10:00:00.000Z,https://shop.example.com/item/1\r\n'
    }
    const content = `\uFEFF${samples[manualImportForm.templateType]}`
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `manual-import-${manualImportForm.templateType}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function migrateAISecrets(provider?: AIProviderKey) {
    setBusy(true)
    try {
      const migrated = await api.migrateAISecrets(provider)
      setAiProviders(await api.listAIProviders())
      setAiSecretHealth(await api.listAISecretHealth())
      setNotice(`已迁移 ${migrated.length} 个 AI 密钥配置`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function saveFailurePolicy() {
    setBusy(true)
    try {
      const saved = await api.saveAIFailurePolicy(failurePolicy)
      setFailurePolicy(saved)
      setRecoveryAdvice(await api.getAIRecoveryAdvice())
      setNotice('AI 失败处理策略已保存')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function applyFailurePreset(preset: AIFailurePolicyPreset) {
    setBusy(true)
    try {
      const saved = await api.saveAIFailurePolicy(preset.policy)
      setFailurePolicy(saved)
      setRecoveryAdvice(await api.getAIRecoveryAdvice())
      setNotice(`已应用 AI 策略：${preset.name}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function applyRecommendedRecoveryPolicy() {
    const preset = failurePresets.find((item) => item.key === recoveryAdvice?.recommendedPolicyKey)
    if (!preset) {
      setNotice('暂无可应用的推荐策略')
      return
    }
    await applyFailurePreset(preset)
  }

  async function saveCustomPricing() {
    if (!pricingForm.modelPattern.trim()) {
      setNotice('请填写模型匹配规则')
      return
    }
    setBusy(true)
    try {
      const custom = modelPricing.filter((item) => item.source === 'custom')
      const nextCustom = await api.saveCustomModelPricing([...custom, { ...pricingForm, source: 'custom' }])
      setModelPricing(await api.listModelPricing())
      setCurrentPricing(await api.currentModelPricing())
      setPricingForm({ provider: 'custom', modelPattern: '', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 })
      setNotice(`已保存 ${nextCustom.length} 条自定义模型价格`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function cleanupPrivacyData() {
    if (!Object.entries(cleanupOptions).some(([key, value]) => key !== 'platformKeys' && value === true)) {
      setNotice('请至少选择一项要清理的数据')
      return
    }
    const confirmed = window.confirm('将按所选项清理本机隐私数据。该操作不可撤销，确认继续？')
    if (!confirmed) return
    setBusy(true)
    try {
      const result = await api.cleanupPrivacyData(cleanupOptions)
      await refresh()
      setSelectedResultIds([])
      setSelectedLeadIds([])
      setEditingLead(undefined)
      setEditingLeadDetail(undefined)
      setPrivacyEstimate(undefined)
      setNotice(`清理完成：Profile ${result.platformProfilesCleared}，搜索 ${result.searchRowsCleared}，评论/内容 ${result.commentRowsCleared}，线索 ${result.leadRowsCleared}，任务 ${result.taskRowsCleared}，密钥备份 ${result.aiSecretBackupRowsCleared}，日志 ${result.localLogFilesCleared}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function previewPrivacyCleanup() {
    try {
      const estimate = await api.previewPrivacyCleanup(cleanupOptions)
      setPrivacyEstimate(estimate)
      setNotice(`清理预估：数据库 ${estimate.searchRowsCleared + estimate.commentRowsCleared + estimate.leadRowsCleared + estimate.taskRowsCleared + estimate.auditRowsCleared + estimate.aiSecretBackupRowsCleared + estimate.platformStateRowsCleared} 行，日志 ${estimate.localLogFilesCleared} 个`)
    } catch (error) {
      setPrivacyEstimate(undefined)
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <main className="shell">
      {notice ? <div className="toastNotice" role="status">{notice}</div> : null}
      {selectionBox?.active ? <div className="selectionMarquee" style={selectionBoxStyle(selectionBox)} /> : null}
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">LM</span>
          <div>
            <strong>Lead Miner</strong>
            <small>AI 线索挖掘工作台</small>
          </div>
          {appVersion ? <span className="brandVersion">v{appVersion}</span> : null}
        </div>
        {[
          ['dashboard', '搜索工作台'] as const,
          ['platforms', '平台中心'] as const,
          ['searchResults', '搜索结果'] as const,
          ['tasks', '任务中心'] as const,
          ['leads', '线索中心'] as const,
          ['ai', 'AI 分析'] as const,
          ['audit', '审计日志'] as const,
          ['settings', '设置'] as const
        ].map(([key, label]) => (
          <button className={selected === key ? 'nav active' : 'nav'} key={key} onClick={() => setSelected(key)}>
            {label}
          </button>
        ))}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>客户线索挖掘平台</h1>
            <p>跨平台搜索、登录态管理、AI 评分、采集合规与导出的一体化工作台。</p>
          </div>
          <button className="primary" onClick={refresh}>检查平台状态</button>
        </header>

        <section className="searchBand">
          <label>
            <span>搜索关键词</span>
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} />
          </label>
          <button className="secondary" onClick={planKeyword}>AI 扩展</button>
          <button className="primary" disabled={busy} onClick={runSearch}>{busy ? '搜索中...' : '搜索并入库'}</button>
        </section>

        <section className="grid">
          {isVisible(selected, 'dashboard', 'platforms') ? <div className="panel wide">
            <div className="panelHead">
              <h2>平台状态</h2>
              <span>{platforms.length} 个首批平台</span>
            </div>
            <div className="platformGrid">
              {platforms.map((platform) => {
                const status = statusByPlatform.get(platform.key)
                const statusView = platformStatusView(platform, status)
                return (
                <article className="platform" key={platform.key}>
                  <div>
                    <strong>{platform.name}</strong>
                    <small>{platform.category}</small>
                  </div>
                  <span className={`badge ${statusView.tone}`}>
                    {statusView.label}
                  </span>
                  <p>{statusView.detail} · {platform.capabilities.join(' / ')}</p>
                  <div className="platformMeta">
                    <span className={`riskPill ${platform.riskLevel ?? 'medium'}`}>{platformRiskLabel(platform.riskLevel)}</span>
                    <span>{platformIntegrationStatusLabel(platform.integrationStatus)}</span>
                    <span>{platformAuthModeLabel(platform.authMode)}</span>
                    <span>{platformConnectorLabel(platform.connectorKind)}</span>
                    <span>间隔 {platform.rateLimit.minDelayMs}ms</span>
                  </div>
                  {platform.complianceNotes ? <p className="complianceNote">{platform.complianceNotes}</p> : null}
                  {canSearchPlatform(platform) ? (
                    <label className="platformSelect">
                      <input
                        checked={searchableKeys.includes(platform.key)}
                        type="checkbox"
                        onChange={() => togglePlatform(platform.key)}
                      />
                      参与搜索
                    </label>
                  ) : null}
                  {canLoginPlatform(platform) && !status?.loggedIn ? (
                    <button className="miniButton" disabled={busy} onClick={() => login(platform.key)}>
                      登录
                    </button>
                  ) : null}
                </article>
                )
              })}
            </div>
          </div> : null}

          {isVisible(selected, 'platforms') ? <div className="panel wide">
            <div className="panelHead">
              <h2>待接入路线图</h2>
              <span>{platformTargets.length} 个目标</span>
            </div>
            <div className="platformGrid">
              {platformTargets.map((platform) => (
                <article className="platform" key={platform.key}>
                  <div className="platformHeader">
                    <strong>{platform.name}</strong>
                    <small>{platform.category}</small>
                  </div>
                  <p>{platform.capabilities.join(' / ') || '能力待定义'} · {platform.domains.join(' / ')}</p>
                  <div className="platformMeta">
                    <span className={`riskPill ${platform.riskLevel ?? 'medium'}`}>{platformRiskLabel(platform.riskLevel)}</span>
                    <span>{platformIntegrationStatusLabel(platform.integrationStatus)}</span>
                    <span>{platformAuthModeLabel(platform.authMode)}</span>
                    <span>{platformConnectorLabel(platform.connectorKind)}</span>
                    <span>间隔 {platform.rateLimit.minDelayMs}ms</span>
                  </div>
                  {platform.complianceNotes ? <p className="complianceNote">{platform.complianceNotes}</p> : null}
                  {platform.roadmapNotes ? <p className="complianceNote">{platform.roadmapNotes}</p> : null}
                </article>
              ))}
            </div>
          </div> : null}

          {isVisible(selected, 'dashboard') ? <div className="panel">
            <div className="panelHead">
              <h2>AI 关键词计划</h2>
              <span>{keywordPlan.keywords.length}</span>
            </div>
            <ul className="keywordList">
              {keywordPlan.keywords.map((item) => <li key={item}>{item}</li>)}
              {keywordPlan.keywords.length === 0 ? <li>点击 AI 扩展生成关键词矩阵</li> : null}
            </ul>
          </div> : null}

          {isVisible(selected, 'dashboard', 'tasks') ? <div className="panel">
            <div className="panelHead">
              <h2>任务队列</h2>
              <span>{tasks.filter((task) => task.status === 'running').length} 运行中</span>
            </div>
            {recoveryAdvice && recoveryAdvice.severity !== 'info' ? (
              <div className={`recoveryBox taskRecovery ${recoveryAdvice.severity}`}>
                <strong>{recoveryAdvice.title}</strong>
                {recoveryAdvice.actions.slice(0, 2).map((action) => <span key={action}>{action}</span>)}
                {recoveryAdvice.recommendedPolicyKey ? (
                  <button className="miniButton inline" disabled={busy} onClick={applyRecommendedRecoveryPolicy}>应用推荐策略</button>
                ) : null}
              </div>
            ) : null}
            {tasks.length === 0 ? <div className="empty">等待搜索或采集任务</div> : (
              <div className="taskList">
                {tasks.slice(0, 8).map((task) => (
                  <article className={task.status === 'failed' ? 'taskItem failed' : 'taskItem'} key={task.id}>
                    <div>
                      <strong>{task.type}</strong>
                      <span>{task.status} · {task.progress}%{task.platformKey ? ` · ${task.platformKey}` : ''}</span>
                    </div>
                    {task.errorMessage ? <p>{task.errorMessage}</p> : null}
                    {task.errorCode ? <small>{taskRecoveryAdvice(task.errorCode)}</small> : null}
                    {task.status === 'failed' && task.platformKey ? (
                      <div className="taskActions">
                        {task.errorCode === 'login_required' || task.errorCode === 'captcha_required' || task.errorCode === 'permission_denied' ? (
                          <button className="miniButton" disabled={busy} onClick={() => login(task.platformKey as string)}>登录/验证</button>
                        ) : null}
                        {task.type === 'collect_comments' ? (
                          <button className="miniButton" disabled={busy} onClick={() => retryTask(task)}>重试采集</button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </div> : null}

          {isVisible(selected, 'dashboard', 'leads') ? <div className="panel">
            <div className="panelHead">
              <h2>跟进提醒</h2>
              <div className="panelActions">
                <span>{followUps.filter((item) => item.status === 'overdue').length} 逾期</span>
                <button className="miniButton inline" disabled={busy || followUps.length === 0} onClick={exportFollowUpCalendar}>导出日历</button>
              </div>
            </div>
            {followUps.length === 0 ? <div className="empty">未来 7 天暂无跟进提醒</div> : (
              <div className="reminderList">
                <div className="reminderSummary">
                  <span>今日 {followUps.filter((item) => item.status === 'today').length}</span>
                  <span>近期 {followUps.filter((item) => item.status === 'upcoming').length}</span>
                </div>
                {followUps.slice(0, 6).map((item) => (
                  <button className="reminderItem" key={item.lead.id} onClick={() => openLeadDetail(item.lead)}>
                    <span className={`reminderStatus ${item.status}`}>{followUpLabel(item.status, item.daysUntilDue)}</span>
                    <strong>{item.lead.nickname}</strong>
                    <small>{item.lead.platformKey} · {new Date(item.dueAt).toLocaleString()}</small>
                  </button>
                ))}
              </div>
            )}
          </div> : null}

          {isVisible(selected, 'dashboard', 'searchResults') ? <div className="panel wide">
            <div className="panelHead">
              <h2>搜索结果</h2>
              <div className="panelActions">
                <span>{results.length} 条</span>
                {results.length > 0 ? <span>已选 {selectedResultIds.length}</span> : null}
                {results.length > 0 ? (
                  <button className="miniButton inline" disabled={busy || selectedResultIds.length === 0} onClick={collectSelectedResults}>
                    采集已选
                  </button>
                ) : null}
              </div>
            </div>
            {batchCollectProgress ? (
              <div className="collectProgress">
                <div className="collectProgressMeta">
                  <strong>{batchCollectProgress.message}</strong>
                  <span>{batchCollectProgress.current}/{batchCollectProgress.total} · {batchCollectProgress.title}</span>
                </div>
                <div className="progressTrack">
                  <span style={{ width: `${Math.min(100, Math.round((batchCollectProgress.current / Math.max(1, batchCollectProgress.total)) * 100))}%` }} />
                </div>
              </div>
            ) : null}
            {results.length === 0 ? (
              <div className="funnel">
              <div><strong>搜索结果</strong><b>{results.length}</b></div>
              <div><strong>采集评论</strong><b>0</b></div>
              <div><strong>AI 高意向</strong><b>0</b></div>
              <div><strong>待跟进</strong><b>0</b></div>
              </div>
            ) : (
              <div
                className="resultList selectableResults"
                ref={resultListRef}
                onPointerDown={startResultSelection}
                onPointerMove={moveResultSelection}
                onPointerUp={finishResultSelection}
                onPointerCancel={finishResultSelection}
              >
                {results.map((result) => (
                  <article className={selectedResultIds.includes(result.id) ? 'resultItem selected' : 'resultItem'} data-result-id={result.id} key={result.id}>
                    <a href={result.url} target="_blank" rel="noreferrer">
                      <strong>{result.title}</strong>
                      <span>{result.platformKey} · relevance {result.relevance.toFixed(2)}</span>
                      <p>{result.snippet}</p>
                    </a>
                    {collectProgressByResultId[result.id] ? (
                      <div className={`resultCollectState ${collectProgressByResultId[result.id].status}`}>
                        <span>{resultCollectStatusLabel(collectProgressByResultId[result.id].status)}</span>
                        <small>{collectProgressByResultId[result.id].message}</small>
                      </div>
                    ) : null}
                    {isSingleItemCollectionResult(result, platformByKey) ? (
                      <div className="riskHint">
                        账号保护：该平台仅支持单条低频采集，触发验证码或官方警告后请停止。
                      </div>
                    ) : null}
                    <label className="resultSelect">
                      <input checked={selectedResultIds.includes(result.id)} type="checkbox" onChange={() => toggleResultSelection(result.id)} />
                      选择
                    </label>
                    <button className="miniButton" disabled={busy} onClick={() => collect(result)}>
                      {isSingleItemCollectionResult(result, platformByKey) ? '单条低频采集' : '采集评论'}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div> : null}

          {isVisible(selected, 'dashboard', 'leads') ? <div className="panel wide">
            <div className="panelHead">
              <h2>最新评论</h2>
              <span>{comments.length} 条</span>
            </div>
            {comments.length === 0 ? <div className="empty">尚未采集评论</div> : (
              <div className="resultList">
                {comments.map((comment) => (
                  <article className="commentItem" key={comment.id}>
                    <strong>{comment.nickname}</strong>
                    <span>{comment.platformKey} · {comment.likes} likes</span>
                    <p>{comment.text}</p>
                  </article>
                ))}
              </div>
            )}
          </div> : null}

          {isVisible(selected, 'dashboard', 'leads') ? <div className="panel wide">
            <div className="panelHead">
              <h2>线索中心</h2>
              <span>{leads.length} 条</span>
            </div>
            <div className="leadTools">
              <select
                value={leadStatus}
                onChange={(event) => {
                  const value = event.target.value as LeadRecord['status'] | 'all'
                  setLeadStatus(value)
                  void refreshLeads(value)
                }}
              >
                <option value="all">全部状态</option>
                <option value="new">待跟进</option>
                <option value="contacted">已联系</option>
                <option value="ignored">已忽略</option>
              </select>
              <input
                placeholder="筛选昵称、文本、关键词"
                value={leadKeyword}
                onChange={(event) => setLeadKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void refreshLeads()
                }}
              />
              <button className="secondary" disabled={busy} onClick={() => refreshLeads()}>筛选</button>
              <button className="secondary" disabled={busy} onClick={analyzeLeads}>重新分析评论</button>
              <button className="secondary" disabled={busy} onClick={previewLeadExport}>导出预览</button>
              <button className="primary" disabled={busy} onClick={exportLeads}>导出 CSV</button>
            </div>
            {leadExportPreview ? (
              <div className="manualImportPreview">
                <div><strong>{leadExportPreview.count}</strong><span>可导出线索</span></div>
                <div><strong>{leadExportPreview.fields.length}</strong><span>脱敏字段</span></div>
                {leadExportPreview.sampleRows.map((row, index) => (
                  <p key={index}>{leadExportPreview.fields.slice(0, 4).map((field) => `${field}: ${String(row[field] ?? '')}`).join(' / ')}</p>
                ))}
              </div>
            ) : null}
            <div className="bulkBar">
              <span>已选 {selectedLeadIds.length} 条</span>
              <button className="miniButton" disabled={busy || selectedLeadIds.length === 0} onClick={() => bulkUpdate('new')}>批量待跟进</button>
              <button className="miniButton" disabled={busy || selectedLeadIds.length === 0} onClick={() => bulkUpdate('contacted')}>批量已联系</button>
              <button className="miniButton" disabled={busy || selectedLeadIds.length === 0} onClick={() => bulkUpdate('ignored')}>批量忽略</button>
            </div>
            {leads.length === 0 ? <div className="empty">尚未生成线索</div> : (
              <div className="resultList">
                {leads.map((lead) => (
                  <article className="commentItem" key={lead.id}>
                    <div className="leadTitle">
                      <label>
                        <input checked={selectedLeadIds.includes(lead.id)} type="checkbox" onChange={() => toggleLeadSelection(lead.id)} />
                        <strong>{lead.nickname} · {lead.score}</strong>
                      </label>
                      <button className="miniButton" disabled={busy} onClick={() => openLeadDetail(lead)}>详情</button>
                    </div>
                    <span>{lead.platformKey} · {lead.intentLevel} · {lead.status} · {lead.suggestedAction}</span>
                    <span>{lead.scoreReason}</span>
                    {lead.nextFollowUpAt ? <span>下次跟进：{new Date(lead.nextFollowUpAt).toLocaleString()}</span> : null}
                    {lead.note ? <p className="leadNote">{lead.note}</p> : null}
                    <p>{lead.text}</p>
                    <div className="leadActions">
                      <button className="miniButton" disabled={busy} onClick={() => updateLeadStatus(lead.id, 'new')}>待跟进</button>
                      <button className="miniButton" disabled={busy} onClick={() => updateLeadStatus(lead.id, 'contacted')}>已联系</button>
                      <button className="miniButton" disabled={busy} onClick={() => updateLeadStatus(lead.id, 'ignored')}>忽略</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div> : null}

          {editingLead && isVisible(selected, 'dashboard', 'leads') ? (
            <div className="panel wide">
              <div className="panelHead">
                <h2>线索详情</h2>
                <button className="miniButton" onClick={() => {
                  setEditingLead(undefined)
                  setEditingLeadDetail(undefined)
                }}>关闭</button>
              </div>
              <div className="leadDetail">
                <div>
                  <strong>{editingLead.nickname}</strong>
                  <span>{editingLead.platformKey} · {editingLead.intentLevel} · {editingLead.score}</span>
                  <span>{editingLead.scoreReason}</span>
                  <p>{editingLead.text}</p>
                </div>
                <div className="contextBlock">
                  <strong>原评论上下文</strong>
                  {editingLeadDetail?.comment ? (
                    <>
                      <span>{editingLeadDetail.comment.nickname} · {editingLeadDetail.comment.likes} likes · {new Date(editingLeadDetail.comment.collectedAt).toLocaleString()}</span>
                      <p>{editingLeadDetail.comment.text}</p>
                      <a href={editingLeadDetail.comment.contentUrl} target="_blank" rel="noreferrer">打开原评论来源</a>
                    </>
                  ) : <span>暂未找到原评论记录</span>}
                </div>
                <div className="contextBlock">
                  <strong>内容来源</strong>
                  {editingLeadDetail?.content ? (
                    <>
                      <span>{editingLeadDetail.content.platformKey} · {editingLeadDetail.content.contentType} · {editingLeadDetail.content.contentId}</span>
                      {editingLeadDetail.content.title ? <p>{editingLeadDetail.content.title}</p> : null}
                      <a href={editingLeadDetail.content.url} target="_blank" rel="noreferrer">打开原内容</a>
                    </>
                  ) : <span>暂未找到内容记录</span>}
                </div>
                <label>
                  <span>跟进备注</span>
                  <textarea value={leadDraft.note} onChange={(event) => setLeadDraft((current) => ({ ...current, note: event.target.value }))} />
                </label>
                <label>
                  <span>下次跟进时间</span>
                  <input type="datetime-local" value={leadDraft.nextFollowUpAt} onChange={(event) => setLeadDraft((current) => ({ ...current, nextFollowUpAt: event.target.value }))} />
                </label>
                <button className="primary" disabled={busy} onClick={saveLeadDetail}>保存详情</button>
              </div>
            </div>
          ) : null}

          {isVisible(selected, 'ai', 'settings') ? <div className="panel wide">
            <div className="panelHead">
              <h2>AI 模型配置</h2>
              <span>{aiProviders.filter((provider) => provider.enabled).length} 启用</span>
            </div>
            <div className="aiConfig">
              <select
                value={aiForm.provider}
                onChange={(event) => setAiForm((current) => ({ ...current, provider: event.target.value as AIProviderKey }))}
              >
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="dashscope">通义千问</option>
                <option value="custom">自定义兼容接口</option>
                <option value="rule">本地规则回退</option>
              </select>
              <input
                value={aiForm.model}
                onChange={(event) => setAiForm((current) => ({ ...current, model: event.target.value }))}
                placeholder="模型名称"
              />
              <input
                value={aiForm.baseUrl}
                onChange={(event) => setAiForm((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="Base URL"
              />
              <input
                value={aiForm.apiKey}
                onChange={(event) => setAiForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="API Key（保存后不回显）"
                type="password"
              />
              <label className="switchLine">
                <input
                  checked={aiForm.enabled}
                  type="checkbox"
                  onChange={(event) => setAiForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                启用
              </label>
              <button className="primary" disabled={busy || !aiForm.model.trim()} onClick={saveAIProvider}>保存模型配置</button>
            </div>
            {aiProviders.length === 0 ? <div className="empty">尚未保存模型配置，当前使用本地规则回退</div> : (
              <div className="providerList">
                {aiProviders.map((provider) => (
                  <div className="providerRow" key={provider.provider}>
                    <strong>{provider.provider}</strong>
                    <span>{provider.model}</span>
                    <span>{provider.enabled ? '启用' : '停用'}</span>
                    <span>{provider.apiKeySet ? `Key ${provider.apiKeyPreview ?? '已配置'}` : '未配置 Key'}</span>
                    <span>{secretStorageLabel(provider.secretStorage)}</span>
                    <button className="miniButton" disabled={busy || !provider.apiKeySet || provider.secretStorage === 'encrypted'} onClick={() => migrateAISecrets(provider.provider)}>
                      迁移
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="bulkBar">
              <button className="secondary" disabled={busy || aiProviders.length === 0} onClick={() => migrateAISecrets()}>迁移全部密钥</button>
            </div>
            {aiSecretHealth.length > 0 ? (
              <div className="secretHealthList">
                {aiSecretHealth.map((item) => (
                  <div className={`secretHealth ${item.severity}`} key={item.provider}>
                    <strong>{item.provider}</strong>
                    <span>{item.title}</span>
                    <small>{item.message}{item.ageDays !== null ? ` · ${item.ageDays} 天` : ''}</small>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="pricingBox">
              <div className="panelHead compact">
                <h2>模型价格表</h2>
                <span>{currentPricing ? `当前匹配 ${currentPricing.provider}/${currentPricing.modelPattern}` : '当前模型未匹配价格表'}</span>
              </div>
              <div className="pricingList">
                {modelPricing.map((item) => (
                  <div className="pricingRow" key={`${item.provider}-${item.modelPattern}`}>
                    <strong>{item.provider}</strong>
                    <span>{item.modelPattern}</span>
                    <span>{item.source === 'custom' ? '自定义' : '内置'}</span>
                    <span>输入 ${item.inputUsdPerMillionTokens}/M</span>
                    <span>输出 ${item.outputUsdPerMillionTokens}/M</span>
                  </div>
                ))}
              </div>
              <div className="policyGrid pricingEditor">
                <label>
                  <span>Provider</span>
                  <select value={pricingForm.provider} onChange={(event) => setPricingForm((current) => ({ ...current, provider: event.target.value as AIProviderKey }))}>
                    {(['custom', 'deepseek', 'openai', 'dashscope'] as AIProviderKey[]).map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                  </select>
                </label>
                <label>
                  <span>模型匹配</span>
                  <input value={pricingForm.modelPattern} onChange={(event) => setPricingForm((current) => ({ ...current, modelPattern: event.target.value }))} placeholder="例如 gpt-4\\.1-mini" />
                </label>
                <label>
                  <span>输入 $/M</span>
                  <input type="number" min="0" step="0.0001" value={pricingForm.inputUsdPerMillionTokens} onChange={(event) => setPricingForm((current) => ({ ...current, inputUsdPerMillionTokens: Number(event.target.value) }))} />
                </label>
                <label>
                  <span>输出 $/M</span>
                  <input type="number" min="0" step="0.0001" value={pricingForm.outputUsdPerMillionTokens} onChange={(event) => setPricingForm((current) => ({ ...current, outputUsdPerMillionTokens: Number(event.target.value) }))} />
                </label>
                <button className="secondary" disabled={busy || !pricingForm.modelPattern.trim()} onClick={saveCustomPricing}>保存价格</button>
              </div>
            </div>
            <div className="failurePolicy">
              <div className="panelHead compact">
                <h2>失败处理策略</h2>
                <span>{failurePolicy.circuitBreakerThreshold > 0 ? `连续失败 ${failurePolicy.circuitBreakerThreshold} 次熔断` : '未启用熔断'}</span>
              </div>
              <div className="presetList">
                {failurePresets.map((preset) => (
                  <button className="miniButton" disabled={busy} key={preset.key} onClick={() => applyFailurePreset(preset)} title={preset.description}>
                    {preset.name}
                  </button>
                ))}
              </div>
              <div className="policyGrid">
                <label>
                  <span>最大重试</span>
                  <input type="number" min="0" value={failurePolicy.maxRetries} onChange={(event) => setFailurePolicy((current) => ({ ...current, maxRetries: Number(event.target.value) }))} />
                </label>
                <label>
                  <span>重试延迟 ms</span>
                  <input type="number" min="0" value={failurePolicy.retryDelayMs} onChange={(event) => setFailurePolicy((current) => ({ ...current, retryDelayMs: Number(event.target.value) }))} />
                </label>
                <label>
                  <span>请求间隔 ms</span>
                  <input type="number" min="0" value={failurePolicy.minDelayMs} onChange={(event) => setFailurePolicy((current) => ({ ...current, minDelayMs: Number(event.target.value) }))} />
                </label>
                <label>
                  <span>熔断阈值</span>
                  <input type="number" min="0" value={failurePolicy.circuitBreakerThreshold} onChange={(event) => setFailurePolicy((current) => ({ ...current, circuitBreakerThreshold: Number(event.target.value) }))} />
                </label>
                <button className="secondary" disabled={busy} onClick={saveFailurePolicy}>保存策略</button>
              </div>
            </div>
            {recoveryAdvice ? (
              <div className={`recoveryBox ${recoveryAdvice.severity}`}>
                <strong>{recoveryAdvice.title}</strong>
                {recoveryAdvice.actions.map((action) => <span key={action}>{action}</span>)}
                {recoveryAdvice.recommendedPolicyKey ? (
                  <button className="miniButton inline" disabled={busy} onClick={applyRecommendedRecoveryPolicy}>应用推荐策略</button>
                ) : null}
              </div>
            ) : null}
            {aiStats ? (
              <div className="aiStats">
                <div><strong>{aiStats.total}</strong><span>分析评论</span></div>
                <div><strong>{aiStats.modelUsed}</strong><span>模型调用</span></div>
                <div><strong>{aiStats.ruleFallback}</strong><span>规则回退</span></div>
                <div><strong>{Object.entries(aiStats.failuresByCode ?? {}).map(([code, count]) => `${code}:${count}`).join(' / ') || '0'}</strong><span>失败分类</span></div>
                <div><strong>{aiStats.circuitOpen ? '已熔断' : '正常'}</strong><span>熔断状态</span></div>
                <div><strong>{aiStats.estimatedInputTokens + aiStats.estimatedOutputTokens}</strong><span>估算 tokens</span></div>
                <div><strong>${aiStats.estimatedCostUsd.toFixed(6)}</strong><span>估算成本</span></div>
              </div>
            ) : null}
          </div> : null}

          {isVisible(selected, 'audit') ? <div className="panel wide">
            <div className="panelHead">
              <h2>审计日志</h2>
              <span>{auditLogs.length} 条</span>
            </div>
            <div className="filterBar">
              {[
                ['manual_import', '手动导入'],
                ['platform', '平台'],
                ['lead', '线索'],
                ['ai', 'AI'],
                ['privacy', '隐私'],
                ['all', '全部']
              ].map(([key, label]) => (
                <button
                  className={auditPreset === key ? 'miniButton active' : 'miniButton'}
                  key={key}
                  onClick={() => {
                    const next = key as AuditPreset
                    setAuditPreset(next)
                    void loadAuditLogs(next)
                  }}
                >
                  {label}
                </button>
              ))}
              <input
                value={auditKeyword}
                onChange={(event) => setAuditKeyword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadAuditLogs()
                }}
                placeholder="筛选关键词"
              />
              <button className="miniButton" onClick={() => void loadAuditLogs()}>筛选</button>
            </div>
            <div className="auditList">
              {auditLogs.map((event) => (
                <article className="auditRow" key={event.id}>
                  <strong>{auditActionLabel(event.action)}</strong>
                  <span>{formatDateTime(event.createdAt)}</span>
                  <small>{event.targetType}{event.targetId ? ` · ${event.targetId}` : ''}</small>
                  <p>{event.message}</p>
                </article>
              ))}
              {auditLogs.length === 0 ? <div className="emptyState">没有匹配的审计记录</div> : null}
            </div>
          </div> : null}

          {isVisible(selected, 'settings') ? <div className="panel wide">
            <div className="panelHead">
              <h2>平台接入配置</h2>
              <span>{platformConnectorConfigs.length} 已配置</span>
            </div>
            <div className="aiConfig">
              <select
                value={platformConnectorForm.platformKey}
                onChange={(event) => {
                  const platformKey = event.target.value
                  const existing = platformConnectorConfigs.find((item) => item.platformKey === platformKey)
                  setPlatformConnectorForm((current) => ({
                    ...current,
                    platformKey,
                    enabled: existing?.enabled ?? false,
                    apiBaseUrl: existing?.apiBaseUrl ?? '',
                    apiKey: '',
                    quotaPerDay: existing?.quotaPerDay ?? 1000,
                    minDelayMs: existing?.minDelayMs ?? 1000,
                    importFields: existing?.importTemplate?.fields.join(',') ?? current.importFields,
                    requiredFields: existing?.importTemplate?.requiredFields?.join(',') ?? current.requiredFields
                  }))
                }}
              >
                {platformTargets.map((platform) => <option key={platform.key} value={platform.key}>{platform.name}</option>)}
              </select>
              <input
                value={platformConnectorForm.apiBaseUrl}
                onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, apiBaseUrl: event.target.value }))}
                placeholder="API Base URL（可选）"
              />
              <input
                value={platformConnectorForm.apiKey}
                onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="API Key 或 env:VAR_NAME（保存后不回显）"
                type="password"
              />
              <input
                min="1"
                type="number"
                value={platformConnectorForm.quotaPerDay}
                onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, quotaPerDay: Number(event.target.value) }))}
                placeholder="每日配额"
              />
              <input
                min="0"
                type="number"
                value={platformConnectorForm.minDelayMs}
                onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, minDelayMs: Number(event.target.value) }))}
                placeholder="请求间隔 ms"
              />
              <input
                value={platformConnectorForm.importFields}
                onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, importFields: event.target.value }))}
                placeholder="手动导入字段，逗号分隔"
              />
              <input
                value={platformConnectorForm.requiredFields}
                onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, requiredFields: event.target.value }))}
                placeholder="必填字段，逗号分隔"
              />
              <label className="switchLine">
                <input
                  checked={platformConnectorForm.enabled}
                  type="checkbox"
                  onChange={(event) => setPlatformConnectorForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                启用
              </label>
              <button className="primary" disabled={busy || !platformConnectorForm.platformKey} onClick={savePlatformConnectorConfig}>保存平台接入配置</button>
            </div>
            {platformConnectorConfigs.length > 0 ? (
              <div className="filterBar">
                {[
                  ['all', '全部'],
                  ['failed', '失败'],
                  ['quota_exhausted', '配额耗尽'],
                  ['auth_failed', '认证失败'],
                  ['rate_limited', '限流'],
                  ['retryable', '可重试']
                ].map(([key, label]) => (
                  <button
                    className={connectorErrorFilter === key ? 'miniButton active' : 'miniButton'}
                    key={key}
                    onClick={() => setConnectorErrorFilter(key as ConnectorErrorFilter)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {visibleConnectorConfigs.length > 0 ? (
              <div className="providerList">
                {visibleConnectorConfigs.map((config) => (
                  <div className="providerRow" key={config.platformKey}>
                    <strong>{platformTargets.find((platform) => platform.key === config.platformKey)?.name ?? config.platformKey}</strong>
                    <span>{config.enabled ? '启用' : '停用'}</span>
                    <span>{config.apiKeySet ? `Key ${config.apiKeyPreview ?? '已配置'}` : '未配置 Key'}</span>
                    <span>{secretStorageLabel(config.secretStorage)}</span>
                    <span>{config.quotaPerDay ? `配额 ${config.quotaPerDay}/日` : '未设配额'}</span>
                    <span>{config.quotaPerDay ? `今日 ${config.usedToday ?? 0}/${config.quotaPerDay}` : `今日 ${config.usedToday ?? 0}`}</span>
                    <span>{platformConnectorStatusText(config)}</span>
                    {config.quotaResetAt ? <span>预计重置 {formatDateTime(config.quotaResetAt)}</span> : null}
                    <span>{config.minDelayMs ?? 0}ms</span>
                  </div>
                ))}
              </div>
            ) : platformConnectorConfigs.length > 0 ? <div className="emptyState">当前筛选条件下没有平台接入记录</div> : null}
          </div> : null}

          {isVisible(selected, 'settings') ? <div className="panel wide">
            <div className="panelHead">
              <h2>手动内容导入</h2>
              <span>本地解析</span>
            </div>
            <div className="aiConfig">
              <select
                value={manualImportForm.platformKey}
                onChange={(event) => setManualImportForm((current) => ({ ...current, platformKey: event.target.value }))}
              >
                {platformTargets
                  .filter((platform) => platform.connectorKind === 'manual_import' || platform.authMode === 'manual_import')
                  .map((platform) => <option key={platform.key} value={platform.key}>{platform.name}</option>)}
              </select>
              <select
                value={manualImportForm.templateType}
                onChange={(event) => setManualImportForm((current) => ({ ...current, templateType: event.target.value as ManualImportTemplateType }))}
              >
                <option value="wechat_article_csv">微信公众号文章评论</option>
                <option value="comment_csv">通用评论 CSV</option>
                <option value="social_comments_csv">社媒评论 CSV</option>
                <option value="commerce_reviews_csv">电商评价 CSV</option>
              </select>
              <select
                value={manualImportForm.conflictStrategy}
                onChange={(event) => setManualImportForm((current) => ({ ...current, conflictStrategy: event.target.value as ManualImportConflictStrategy }))}
              >
                <option value="skip_duplicates">重复评论跳过</option>
                <option value="replace_existing">重复评论更新元数据</option>
              </select>
              <div className="manualImportGuide">
                <span>字段：{manualTemplateMeta(manualImportForm.templateType).fields.join(' / ')}</span>
                <span>必填：{manualTemplateMeta(manualImportForm.templateType).required.join(' / ')}</span>
                <span>{manualConflictLabel(manualImportForm.conflictStrategy)}</span>
              </div>
              <input
                value={manualImportForm.sourceUrl}
                onChange={(event) => setManualImportForm((current) => ({ ...current, sourceUrl: event.target.value }))}
                placeholder="文章/商品/帖子链接（可选）"
              />
              <input
                value={manualImportForm.title}
                onChange={(event) => setManualImportForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="标题（可选）"
              />
              <textarea
                value={manualImportForm.body}
                onChange={(event) => setManualImportForm((current) => ({ ...current, body: event.target.value }))}
                placeholder="正文摘要（可选，不联网抓取）"
                rows={4}
              />
              <textarea
                value={manualImportForm.csv}
                onChange={(event) => setManualImportForm((current) => ({ ...current, csv: event.target.value }))}
                placeholder="评论 CSV：nickname,text,likes,published_at,url"
                rows={6}
              />
              <label className="filePickButton">
                选择 CSV
                <input accept=".csv,text/csv" type="file" onChange={(event) => void loadManualImportFile(event.target.files?.[0])} />
              </label>
              <button className="miniButton inline" disabled={busy} onClick={downloadManualImportTemplate}>下载模板</button>
              <button className="miniButton inline" disabled={busy || !manualImportForm.platformKey} onClick={previewManualContent}>导入预览</button>
              <button className="primary" disabled={busy || !manualImportForm.platformKey} onClick={importManualContent}>导入并分析</button>
            </div>
            {manualImportPreview ? (
              <div className="manualImportPreview">
                <div><strong>{manualImportPreview.parsedComments}</strong><span>解析评论</span></div>
                <div><strong>{manualImportPreview.newComments}</strong><span>新评论</span></div>
                <div><strong>{manualImportPreview.duplicates}</strong><span>重复跳过</span></div>
                <div><strong>{manualImportPreview.updatableDuplicates}</strong><span>可更新</span></div>
                <div><strong>{manualImportPreview.content.title || manualImportPreview.content.contentId}</strong><span>内容标识</span></div>
                {manualImportPreview.sampleComments.map((comment, index) => (
                  <p key={`${comment.nickname}-${index}`}>{comment.nickname ?? '手动导入用户'}：{comment.text}</p>
                ))}
              </div>
            ) : null}
          </div> : null}

          {isVisible(selected, 'settings') ? <div className="panel wide">
            <div className="panelHead">
              <h2>隐私与本机数据</h2>
              <span>本机清理</span>
            </div>
            <div className="privacyGrid">
              {[
                ['platformProfiles', '平台登录态/Profile'] as const,
                ['platformState', '平台状态与账号保护'] as const,
                ['searchData', '搜索会话与结果'] as const,
                ['commentsAndLeads', '内容、评论与线索'] as const,
                ['tasks', '任务记录'] as const,
                ['aiSecretBackups', 'AI 密钥备份'] as const,
                ['auditLogs', '审计日志'] as const,
                ['localLogs', '本地日志文件'] as const
              ].map(([key, label]) => (
                <label className="cleanupOption" key={key}>
                  <input
                    checked={cleanupOptions[key] === true}
                    type="checkbox"
                    onChange={(event) => setCleanupOptions((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="cleanupPlatforms">
              <strong>限定平台 Profile</strong>
              <div className="platformChipList">
                {platforms.map((platform) => {
                  const selectedProfiles = cleanupOptions.platformKeys ?? []
                  return (
                    <label className="platformChip" key={platform.key}>
                      <input
                        checked={selectedProfiles.includes(platform.key)}
                        type="checkbox"
                        onChange={(event) => setCleanupOptions((current) => {
                          const currentKeys = current.platformKeys ?? []
                          const nextKeys = event.target.checked
                            ? [...new Set([...currentKeys, platform.key])]
                            : currentKeys.filter((key) => key !== platform.key)
                          return { ...current, platformKeys: nextKeys.length ? nextKeys : undefined }
                        })}
                      />
                      <span>{platform.name}</span>
                    </label>
                  )
                })}
              </div>
            </div>
            <div className="dangerZone">
              <strong>危险操作</strong>
              <span>清理后无法恢复。若选择平台登录态，后续需要重新扫码或密码登录对应平台。</span>
              {privacyEstimate ? (
                <span>预估：Profile {privacyEstimate.platformProfilesFound} 个，搜索 {privacyEstimate.searchRowsCleared} 行，评论/内容 {privacyEstimate.commentRowsCleared} 行，线索 {privacyEstimate.leadRowsCleared} 行，日志 {privacyEstimate.localLogFilesCleared} 个 / {Math.round(privacyEstimate.localLogBytesCleared / 1024)}KB。</span>
              ) : null}
              <button className="secondary" disabled={busy} onClick={previewPrivacyCleanup}>清理预估</button>
              <button className="dangerButton" disabled={busy} onClick={cleanupPrivacyData}>清理所选数据</button>
            </div>
          </div> : null}
        </section>
      </section>
    </main>
  )
}

interface SelectionBox {
  active: boolean
  startX: number
  startY: number
  currentX: number
  currentY: number
}

interface ResultCollectProgress {
  status: 'pending' | 'running' | 'completed' | 'failed'
  message: string
  comments: number
  updatedAt: string
}

interface BatchCollectProgress {
  current: number
  total: number
  title: string
  message: string
}

interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

function normalizedBox(box: SelectionBox): RectLike {
  const left = Math.min(box.startX, box.currentX)
  const top = Math.min(box.startY, box.currentY)
  const right = Math.max(box.startX, box.currentX)
  const bottom = Math.max(box.startY, box.currentY)
  return { left, top, right, bottom }
}

function selectionBoxStyle(box: SelectionBox): CSSProperties {
  const rect = normalizedBox(box)
  return {
    left: rect.left,
    top: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  }
}

function intersects(a: RectLike, b: RectLike): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

function resultCollectStatusLabel(status: ResultCollectProgress['status']): string {
  if (status === 'pending') return '等待中'
  if (status === 'running') return '采集中'
  if (status === 'completed') return '已完成'
  return '失败'
}

function isSingleItemCollectionResult(result: SearchResult, platformByKey: Map<string, PlatformSpec>): boolean {
  const platform = platformByKey.get(result.platformKey)
  return platform ? requiresSingleItemCollection(platform) : false
}

function followUpLabel(status: FollowUpReminder['status'], daysUntilDue: number): string {
  if (status === 'overdue') return daysUntilDue <= -1 ? `逾期 ${Math.abs(daysUntilDue)} 天` : '已逾期'
  if (status === 'today') return '今日跟进'
  return daysUntilDue <= 1 ? '明日跟进' : `${daysUntilDue} 天后`
}

function isVisible(selected: ViewKey, ...views: ViewKey[]): boolean {
  return views.includes(selected)
}

function platformStatusView(platform: PlatformSpec, status?: PlatformStatus): { label: string; tone: 'ok' | 'warn' | 'danger'; detail: string } {
  if (!status) {
    return {
      label: platform.requiresLogin ? '待检查' : '可直搜',
      tone: platform.requiresLogin || platform.capabilities.includes('login') ? 'warn' : 'ok',
      detail: '等待状态检查'
    }
  }
  const latency = typeof status.latencyMs === 'number' ? `${status.latencyMs}ms` : '未测速'
  if (!status.available || status.errorCode === 'network_error') {
    return { label: '不可用', tone: 'danger', detail: `${latency} · ${status.message}` }
  }
  if (status.loggedIn) {
    return { label: '已登录', tone: 'ok', detail: `${latency} · ${status.message}` }
  }
  if (status.errorCode === 'login_required') {
    return {
      label: platform.requiresLogin ? '需登录' : '可登录',
      tone: 'warn',
      detail: `${latency} · ${status.message}`
    }
  }
  return { label: '可直搜', tone: 'ok', detail: `${latency} · ${status.message}` }
}

function platformRiskLabel(risk?: PlatformSpec['riskLevel']): string {
  if (risk === 'low') return '低风险'
  if (risk === 'high') return '高风险'
  return '中风险'
}

function platformIntegrationStatusLabel(status?: PlatformSpec['integrationStatus']): string {
  if (status === 'active') return '已接入'
  if (status === 'planned') return '计划接入'
  if (status === 'manual_import') return '手动导入'
  if (status === 'official_api_preferred') return 'API 优先'
  return '未标注接入状态'
}

function platformAuthModeLabel(authMode?: PlatformSpec['authMode']): string {
  if (authMode === 'none') return '无需登录'
  if (authMode === 'optional_login') return '可选登录'
  if (authMode === 'required_login') return '需登录'
  if (authMode === 'api_key') return 'API Key'
  if (authMode === 'manual_import') return '手动导入'
  return '未标注登录方式'
}

function platformConnectorLabel(kind?: PlatformSpec['connectorKind']): string {
  if (kind === 'official_api') return '官方 API'
  if (kind === 'public_web') return '公开网页'
  if (kind === 'logged_in_web') return '登录网页'
  if (kind === 'manual_import') return '手动导入'
  if (kind === 'hybrid') return '混合接入'
  return '未标注接入'
}

function parseCsvFields(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

function taskInputUrl(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('url' in input)) return undefined
  const value = (input as { url?: unknown }).url
  return typeof value === 'string' && value.trim() ? value : undefined
}

function taskRecoveryAdvice(errorCode: Task['errorCode']): string {
  if (errorCode === 'captcha_required') return '建议完成登录/验证后降低频率再重试。'
  if (errorCode === 'rate_limited') return '建议稍后重试并降低采集频率。'
  if (errorCode === 'login_required') return '建议先登录该平台再继续。'
  if (errorCode === 'permission_denied') return '建议检查账号权限或内容可见范围。'
  if (errorCode === 'content_not_found') return '建议确认链接是否仍可访问。'
  if (errorCode === 'unsupported') return '该内容暂不支持采集，建议更换内容或确认评论区可访问。'
  return '建议稍后重试，或检查网络和平台状态。'
}

function platformConnectorStatusText(config: PlatformConnectorPublicConfig): string {
  if (config.lastStatus === 'ok') return '最近成功'
  if (config.lastStatus !== 'failed') return '暂无调用'
  const code = connectorErrorCodeLabel(config.lastErrorCode)
  const retry = config.lastRetryable === true ? '可重试' : '需处理'
  const message = config.lastError ? `：${config.lastError}` : ''
  return `${code} · ${retry}${message}`
}

function connectorErrorCodeLabel(code?: string): string {
  if (code === 'invalid_request') return '参数无效'
  if (code === 'auth_failed') return '认证失败'
  if (code === 'permission_denied') return '权限不足'
  if (code === 'quota_exhausted') return '配额耗尽'
  if (code === 'rate_limited') return '请求限流'
  if (code === 'server_error') return '服务异常'
  if (code === 'network_error') return '网络异常'
  return '失败'
}

function auditActionLabel(action: string): string {
  if (action === 'manual_import.completed') return '手动导入完成'
  if (action === 'manual_import.analysis_failed') return '导入分析失败'
  if (action === 'platform.login.completed') return '平台登录完成'
  if (action === 'platform.login.failed') return '平台登录失败'
  if (action === 'platform.protection.paused') return '账号保护暂停'
  if (action === 'lead.export') return '线索导出'
  if (action === 'privacy.cleanup') return '隐私清理'
  if (action.startsWith('ai.')) return `AI · ${action.slice(3)}`
  return action
}

function manualTemplateMeta(type: ManualImportTemplateType): { fields: string[]; required: string[] } {
  if (type === 'wechat_article_csv') return { fields: ['author', 'comment', 'likes', 'time', 'link'], required: ['comment'] }
  if (type === 'social_comments_csv') return { fields: ['username', 'content', 'like_count', 'date', 'link'], required: ['content'] }
  if (type === 'commerce_reviews_csv') return { fields: ['buyer', 'review', 'likes', 'created_at', 'url'], required: ['review'] }
  return { fields: ['nickname', 'text', 'likes', 'published_at', 'url'], required: ['text'] }
}

function manualConflictLabel(strategy: ManualImportConflictStrategy): string {
  if (strategy === 'replace_existing') return '重复项更新点赞、时间和链接'
  return '重复项跳过，不重复分析'
}

function formatDateTime(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return value
  return parsed.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function secretStorageLabel(storage: AIProviderPublicConfig['secretStorage']): string {
  if (storage === 'encrypted') return '系统加密'
  if (storage === 'plain') return '明文降级'
  if (storage === 'legacy_plain') return '旧明文，建议重存'
  if (storage === 'external_env') return '环境变量引用'
  if (storage === 'none') return '无密钥'
  return '未知存储'
}
