import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

import type { AIAnalysisStats, AIFailurePolicy, AIFailurePolicyPreset, AIProviderKey, AIProviderPublicConfig, AIRecoveryAdvice, AISecretHealth, CommentRecord, FollowUpReminder, KeywordPlan, LeadDetail, LeadRecord, ModelPricingView, PlatformSpec, PlatformStatus, SearchResult, Task } from '../../../../../packages/core/src/index'
import { getLeadMinerApi } from './leadMinerApi'

const api = getLeadMinerApi()
type ViewKey = 'dashboard' | 'platforms' | 'tasks' | 'leads' | 'ai' | 'settings'

export function App() {
  const [keyword, setKeyword] = useState('咖啡机')
  const [selected, setSelected] = useState<ViewKey>('dashboard')
  const [platforms, setPlatforms] = useState<PlatformSpec[]>([])
  const [statuses, setStatuses] = useState<PlatformStatus[]>([])
  const [keywordPlan, setKeywordPlan] = useState<KeywordPlan>({ seed: '', keywords: [], locales: [] })
  const [results, setResults] = useState<SearchResult[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [leads, setLeads] = useState<LeadRecord[]>([])
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
  const [selectionBox, setSelectionBox] = useState<SelectionBox | undefined>()
  const resultListRef = useRef<HTMLDivElement | null>(null)

  const statusByPlatform = useMemo(() => new Map(statuses.map((status) => [status.platformKey, status])), [statuses])
  const searchableKeys = useMemo(() => selectedPlatforms, [selectedPlatforms])

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (platforms.length > 0 && !platformDefaultsReady) {
      setSelectedPlatforms(platforms.filter((platform) => ['google', 'bing', 'youtube', 'bilibili'].includes(platform.key)).map((platform) => platform.key))
      setPlatformDefaultsReady(true)
    }
  }, [platforms, platformDefaultsReady])

  useEffect(() => {
    const resultIds = new Set(results.map((result) => result.id))
    setSelectedResultIds((current) => current.filter((id) => resultIds.has(id)))
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
      const [nextPlatforms, nextStatuses, nextTasks, nextResults, nextComments, nextLeads, nextFollowUps, nextAIProviders, nextAISecretHealth, nextAIStats, nextModelPricing, nextCurrentPricing, nextFailurePolicy, nextFailurePresets, nextRecoveryAdvice] = await Promise.all([
        api.listPlatforms(),
        api.checkPlatformStatuses(),
        api.listTasks(),
        api.listSearchResults(),
        api.listComments(),
        api.listLeads({ status: leadStatus }),
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
      setStatuses(nextStatuses)
      setTasks(nextTasks)
      setResults(nextResults)
      setComments(nextComments)
      setLeads(nextLeads)
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
    setBusy(true)
    try {
      const plan = await api.planSearch(keyword)
      const nextResults = await api.runSearch({ keyword, platformKeys: searchableKeys })
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
    try {
      const nextComments = await collectByUrl(result.platformKey, result.url)
      setNotice(`已采集 ${nextComments.length} 条评论: ${result.title}`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function collectSelectedResults() {
    const selectedResults = results.filter((result) => selectedResultIds.includes(result.id))
    if (selectedResults.length === 0) {
      setNotice('请先框选或勾选要采集的搜索结果')
      return
    }
    setBusy(true)
    try {
      let totalComments = 0
      for (const result of selectedResults) {
        const nextComments = await collectByUrl(result.platformKey, result.url)
        totalComments += nextComments.length
      }
      setSelectedResultIds([])
      setNotice(`已批量采集 ${selectedResults.length} 个内容，共 ${totalComments} 条评论`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
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
        </div>
        {[
          ['dashboard', '搜索工作台'] as const,
          ['platforms', '平台中心'] as const,
          ['tasks', '任务中心'] as const,
          ['leads', '线索中心'] as const,
          ['ai', 'AI 分析'] as const,
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
                  {platform.capabilities.includes('search') ? (
                    <label className="platformSelect">
                      <input
                        checked={searchableKeys.includes(platform.key)}
                        type="checkbox"
                        onChange={() => togglePlatform(platform.key)}
                      />
                      参与搜索
                    </label>
                  ) : null}
                  {platform.capabilities.includes('login') && !status?.loggedIn ? (
                    <button className="miniButton" disabled={busy} onClick={() => login(platform.key)}>
                      登录
                    </button>
                  ) : null}
                </article>
                )
              })}
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

          {isVisible(selected, 'dashboard') ? <div className="panel wide">
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
                    <label className="resultSelect">
                      <input checked={selectedResultIds.includes(result.id)} type="checkbox" onChange={() => toggleResultSelection(result.id)} />
                      选择
                    </label>
                    <button className="miniButton" disabled={busy} onClick={() => collect(result)}>采集评论</button>
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
              <button className="primary" disabled={busy} onClick={exportLeads}>导出 CSV</button>
            </div>
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

function secretStorageLabel(storage: AIProviderPublicConfig['secretStorage']): string {
  if (storage === 'encrypted') return '系统加密'
  if (storage === 'plain') return '明文降级'
  if (storage === 'legacy_plain') return '旧明文，建议重存'
  if (storage === 'external_env') return '环境变量引用'
  if (storage === 'none') return '无密钥'
  return '未知存储'
}
