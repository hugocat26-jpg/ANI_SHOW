import { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDefaultApplicationCore, type SecretCodec } from '../../../../packages/core/src/index.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const core = createDefaultApplicationCore({
  dataPath: path.join(app.getPath('userData'), 'lead-miner.sqlite3'),
  profileRoot: path.join(app.getPath('userData'), 'profiles'),
  secretCodec: createElectronSecretCodec()
})

function createElectronSecretCodec(): SecretCodec {
  return {
    encode(value: string) {
      if (!safeStorage.isEncryptionAvailable()) return `plain:${value}`
      return `safe:${safeStorage.encryptString(value).toString('base64')}`
    },
    decode(value: string) {
      if (value.startsWith('safe:')) {
        return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
      }
      if (value.startsWith('plain:')) return value.slice(6)
      return value
    },
    describe() {
      return safeStorage.isEncryptionAvailable() ? 'electron-safeStorage' : 'plain-fallback'
    },
    inspect(value: string) {
      if (value.startsWith('safe:')) return 'encrypted'
      if (value.startsWith('plain:')) return 'plain'
      return 'legacy_plain'
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: '客户线索挖掘平台',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('platform:list', () => core.platforms.list())
ipcMain.handle('platform:status', () => core.checkPlatformStatuses())
ipcMain.handle('platform:login', (_event, platformKey: string) => core.loginPlatform(platformKey))
ipcMain.handle('search:plan', (_event, keyword: string) => core.planSearch(keyword))
ipcMain.handle('search:run', (_event, input: { keyword: string; platformKeys: string[] }) =>
  core.searchAcrossPlatforms(input.keyword, input.platformKeys)
)
ipcMain.handle('search:results', () => core.listSearchResults())
ipcMain.handle('collect:comments', (_event, input: { platformKey: string; url: string }) =>
  core.collectComments(input.platformKey, input.url)
)
ipcMain.handle('comments:list', (_event, contentId?: string) => core.listComments(contentId))
ipcMain.handle('leads:list', (_event, filters) => core.listLeads(filters))
ipcMain.handle('leads:detail', (_event, id: string) => core.getLeadDetail(id))
ipcMain.handle('followups:list', (_event, options) => core.listFollowUpReminders(options))
ipcMain.handle('followups:exportCalendar', (_event, options) => core.exportFollowUpsCalendar(options))
ipcMain.handle('followups:exportCalendarToFile', async (_event, options) => {
  const result = core.exportFollowUpsCalendar(options)
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出跟进日历',
    defaultPath: result.filename,
    filters: [{ name: '日历文件', extensions: ['ics'] }]
  })
  if (canceled || !filePath) return { canceled: true, count: result.count }
  await writeFile(filePath, result.content, 'utf8')
  return { canceled: false, filePath, count: result.count }
})
ipcMain.handle('leads:analyze', () => core.analyzeComments())
ipcMain.handle('leads:updateStatus', (_event, input: { id: string; status: 'new' | 'contacted' | 'ignored' }) =>
  core.updateLeadStatus(input.id, input.status)
)
ipcMain.handle('leads:update', (_event, input) => core.updateLead(input.id, input.patch))
ipcMain.handle('leads:bulkUpdateStatus', (_event, input: { ids: string[]; status: 'new' | 'contacted' | 'ignored' }) =>
  core.updateLeadStatuses(input.ids, input.status)
)
ipcMain.handle('leads:export', (_event, input) => core.exportLeads(input))
ipcMain.handle('leads:exportToFile', async (_event, input) => {
  const result = core.exportLeads(input)
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出线索 CSV',
    defaultPath: result.filename,
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
  })
  if (canceled || !filePath) return { canceled: true, count: result.count }
  await writeFile(filePath, result.content, 'utf8')
  return { canceled: false, filePath, count: result.count }
})
ipcMain.handle('audit:list', (_event, limit?: number) => core.listAuditLogs(limit))
ipcMain.handle('ai:listProviders', () => core.listAIProviders())
ipcMain.handle('ai:secretHealth', () => core.listAISecretHealth())
ipcMain.handle('ai:saveProvider', (_event, input) => core.saveAIProviderConfig(input))
ipcMain.handle('ai:migrateSecrets', (_event, provider?: 'rule' | 'openai' | 'deepseek' | 'dashscope' | 'custom') =>
  core.migrateAIProviderSecrets(provider)
)
ipcMain.handle('ai:listSecretBackups', (_event, provider?: 'rule' | 'openai' | 'deepseek' | 'dashscope' | 'custom') =>
  core.listAISecretBackups(provider)
)
ipcMain.handle('ai:restoreSecretBackup', (_event, id: string) => core.restoreAISecretBackup(id))
ipcMain.handle('ai:analysisStats', () => core.getAIAnalysisStats())
ipcMain.handle('ai:modelPricing', () => core.listModelPricing())
ipcMain.handle('ai:currentModelPricing', () => core.currentModelPricing())
ipcMain.handle('ai:saveCustomModelPricing', (_event, input) => core.saveCustomModelPricing(input))
ipcMain.handle('ai:failurePolicy', () => core.getAIFailurePolicy())
ipcMain.handle('ai:saveFailurePolicy', (_event, input) => core.saveAIFailurePolicy(input))
ipcMain.handle('ai:failurePolicyPresets', () => core.listAIFailurePolicyPresets())
ipcMain.handle('ai:recoveryAdvice', () => core.getAIRecoveryAdvice())
ipcMain.handle('notify:followups', (_event, input: { overdue: number; today: number }) => {
  const overdue = Math.max(0, Number(input?.overdue ?? 0))
  const today = Math.max(0, Number(input?.today ?? 0))
  if (overdue + today === 0 || !Notification.isSupported()) return { shown: false }
  new Notification({
    title: '线索跟进提醒',
    body: overdue > 0 ? `${overdue} 条线索已逾期，${today} 条线索今日需跟进。` : `${today} 条线索今日需跟进。`
  }).show()
  return { shown: true }
})
ipcMain.handle('notify:aiRecovery', (_event, input: { severity?: string; title?: string; actions?: string[] }) => {
  const severity = input?.severity === 'critical' ? 'critical' : input?.severity === 'warning' ? 'warning' : 'info'
  const title = typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : 'AI 分析提醒'
  const actions = Array.isArray(input?.actions) ? input.actions.filter((action) => typeof action === 'string' && action.trim()) : []
  if (severity === 'info' || !Notification.isSupported()) return { shown: false }
  new Notification({
    title: severity === 'critical' ? 'AI 分析已触发熔断' : 'AI 分析需要关注',
    body: actions.length > 0 ? `${title}：${actions[0]}` : title
  }).show()
  return { shown: true }
})
ipcMain.handle('task:list', () => core.tasks.list())

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
