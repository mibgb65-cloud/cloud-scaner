<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Trash2, XCircle, Terminal } from 'lucide-vue-next'
import AppLayout from '@/components/layout/AppLayout.vue'
import MetricCard from '@/components/ui/MetricCard.vue'
import SeverityBadge from '@/components/ui/SeverityBadge.vue'
import StatusIndicator from '@/components/ui/StatusIndicator.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import { useConfirm } from '@/composables/useConfirm'
import { scansApi } from '@/services/scans.api'
import { findingsApi } from '@/services/findings.api'
import { formatDate } from '@/utils/date'
import { severityLabel, validationLabel, validationColor } from '@/utils/severity'
import type { Scan, ScanProgress, Finding } from '@/types/domain'

type LogEntry = { ts: string; level: string; msg: string }

const route = useRoute()
const router = useRouter()
const { confirm } = useConfirm()

const scanId = route.params.scanId as string
const scan = ref<Scan | null>(null)
const progress = ref<ScanProgress | null>(null)
const findings = ref<Finding[]>([])
const findingsTotal = ref(0)
const findingsError = ref('')
const logEntries = ref<LogEntry[]>([])
const deleting = ref(false)
const showLog = ref(true)
const progressError = ref('')
const logContainer = ref<HTMLElement | null>(null)
const PROGRESS_POLL_MS = 3000
const FINDINGS_POLL_MS = 8000
let pollTimer: number | undefined
let pollingProgress = false

function findingBalance(f: Finding): string {
  if (!f.validation_json) return ''
  try { const v = JSON.parse(f.validation_json); return v.balance > 0 ? `${v.balance} ${v.currency}` : '' } catch { return '' }
}

const displayedFindingCount = computed(() => Math.max(
  progress.value?.findings ?? 0,
  scan.value?.progress_findings ?? 0,
  findingsTotal.value
))

const findingColumns: Column<Finding>[] = [
  { key: 'severity', label: '级别', render: (r) => severityLabel(r.severity) },
  { key: 'rule_name', label: '规则' },
  { key: 'repo', label: '仓库' },
  { key: 'matched_text', label: '匹配', class: 'font-mono' },
  { key: 'validation_status', label: '验证', render: (r) => r.validation_status === 'valid' && findingBalance(r) ? `${validationLabel(r.validation_status)} ${findingBalance(r)}` : validationLabel(r.validation_status) }
]

function levelColor(level: string): string {
  return level === 'found' ? 'var(--income)' : level === 'error' ? 'var(--expense)' : level === 'skip' ? 'var(--muted)' : 'var(--app-muted)'
}
function levelPrefix(level: string): string {
  return level === 'found' ? '✓' : level === 'error' ? '✗' : level === 'skip' ? '›' : '·'
}

async function load() { try { scan.value = await scansApi.get(scanId) } catch { /* */ } }
async function loadFindings() {
  findingsError.value = ''
  try {
    const r = await findingsApi.list({ scanId, pageSize: 100 })
    findings.value = r.items
    findingsTotal.value = r.total ?? r.items.length
  } catch (e: unknown) {
    findings.value = []
    findingsTotal.value = 0
    findingsError.value = e instanceof Error ? e.message : '发现列表加载失败'
  }
}

async function appendLogs(entries: LogEntry[] = []) {
  if (entries.length === 0) return
  logEntries.value = [...logEntries.value, ...entries].slice(-1000)
  await scrollToBottom()
}

async function pollProgress() {
  if (document.hidden) return
  if (pollingProgress) return
  pollingProgress = true
  try {
    const currentStatus = progress.value?.status ?? scan.value?.status
    const result = currentStatus === 'running' || !currentStatus
      ? await scansApi.advance(scanId)
      : await scansApi.progress(scanId)
    progress.value = result
    await appendLogs(result.logs)
    progressError.value = ''
    if (progress.value?.status !== 'running') {
      clearPolling()
      await load()
      await loadFindings()
    }
  } catch (e: unknown) {
    progressError.value = e instanceof Error ? e.message : '扫描推进失败'
  } finally {
    pollingProgress = false
  }
}

let findingsTimer: number | undefined

function startPolling() {
  if (document.hidden || pollTimer) return
  pollProgress()
  pollTimer = window.setInterval(pollProgress, PROGRESS_POLL_MS)
  // Also refresh findings during scan
  loadFindings()
  findingsTimer = window.setInterval(loadFindings, FINDINGS_POLL_MS)
}

function clearPolling() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined }
  if (findingsTimer) { window.clearInterval(findingsTimer); findingsTimer = undefined }
}

async function scrollToBottom() {
  await nextTick()
  if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight
}

function handleVisibilityChange() {
  if (document.hidden) {
    clearPolling()
    return
  }
  if ((progress.value?.status ?? scan.value?.status) === 'running') startPolling()
  else loadFindings()
}

onMounted(async () => {
  document.addEventListener('visibilitychange', handleVisibilityChange)
  await load(); await loadFindings()
  if (scan.value?.status === 'running') startPolling()
})
watch(() => scan.value?.status, (s) => { if (s === 'running' && !pollTimer) startPolling() })
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  clearPolling()
})

async function cancelScan() {
  const accepted = await confirm({
    title: '终止扫描',
    message: '确认终止此扫描？当前未完成的扫描进度会停止。',
    confirmText: '终止',
    tone: 'warning'
  })
  if (!accepted) return
  try { await scansApi.cancel(scanId); clearPolling(); await load() } catch { /* */ }
}
async function deleteScan() {
  const accepted = await confirm({
    title: '删除扫描',
    message: '确认删除此扫描及其所有发现结果？此操作无法恢复。',
    confirmText: '删除',
    tone: 'danger'
  })
  if (!accepted) return
  deleting.value = true
  try { await scansApi.delete(scanId); router.push('/') } catch { deleting.value = false }
}
function goFinding(f: Finding) { router.push(`/findings/${f.id}`) }
</script>

<template>
  <AppLayout>
    <div class="space-y-6">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <button class="text-[var(--app-muted)] hover:text-[var(--app-text)] shrink-0" @click="router.push('/')"><ArrowLeft class="h-5 w-5" /></button>
          <div class="min-w-0">
            <h1 class="truncate font-mono text-sm font-extrabold">{{ scan?.query || '扫描详情' }}</h1>
            <p class="text-xs text-[var(--app-muted)]">{{ scan?.created_at ? formatDate(scan.created_at) : '' }}</p>
          </div>
        </div>
        <div class="flex shrink-0 gap-2">
          <StatusIndicator v-if="scan" :status="scan.status"
            :label-map="{ pending: '待开始', running: '扫描中', completed: '已完成', failed: '失败', cancelled: '已取消' }"
            :color-map="{ running: 'var(--transfer)', completed: 'var(--valid)', failed: 'var(--invalid)', cancelled: 'var(--muted)' }" />
          <BaseButton v-if="scan?.status === 'running'" variant="danger" size="sm" @click="cancelScan"><XCircle class="h-4 w-4" /> 终止</BaseButton>
          <BaseButton v-if="scan?.status !== 'running'" variant="danger" size="sm" :disabled="deleting" @click="deleteScan"><Trash2 class="h-4 w-4" /> 删除</BaseButton>
        </div>
      </div>

      <div v-if="scan?.error_message" class="border border-[var(--app-border)] bg-[var(--app-surface)] p-4">
        <p class="text-xs font-bold text-[var(--app-muted)]">错误信息</p>
        <p class="mt-1 font-mono text-sm" style="color: var(--expense)">{{ scan.error_message }}</p>
      </div>

      <div v-if="progressError" class="border border-[var(--app-border)] bg-[var(--app-surface)] p-4">
        <p class="text-xs font-bold text-[var(--app-muted)]">扫描推进异常</p>
        <p class="mt-1 font-mono text-sm" style="color: var(--expense)">{{ progressError }}</p>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <MetricCard label="已扫描" :value="String(progress?.scanned ?? scan?.progress_scanned ?? 0)" />
        <MetricCard label="已跳过" :value="String(progress?.skipped ?? scan?.progress_skipped ?? 0)" />
        <MetricCard label="有效发现" :value="String(displayedFindingCount)" tone="warning" />
      </div>

      <div class="flex gap-4 text-xs text-[var(--app-muted)]">
        <span>上限: {{ scan?.limit_count === 0 ? '无限' : (scan?.limit_count ?? 30) }}</span>
        <span>熵阈值: {{ scan?.min_entropy ?? 4.5 }}</span>
        <span v-if="scan?.keyword">关键词: {{ scan.keyword }}</span>
        <span v-if="scan?.org">组织: {{ scan.org }}</span>
        <span v-if="scan?.lang">语言: {{ scan.lang }}</span>
      </div>

      <!-- Real-time log -->
      <section>
        <button class="mb-2 flex items-center gap-2 font-mono text-xs font-extrabold text-[var(--app-muted)] hover:text-[var(--app-text)]" @click="showLog = !showLog">
          <Terminal class="h-3.5 w-3.5" /> 实时日志 <span class="font-normal opacity-50">{{ showLog ? '收起' : '展开' }}</span>
        </button>
        <div v-if="showLog" ref="logContainer" class="border border-[var(--app-border)] bg-[var(--app-subtle)] p-3 max-h-80 overflow-y-auto leading-relaxed" style="font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px;">
          <div v-if="logEntries.length === 0" class="text-[var(--app-muted)]">{{ scan?.status === 'running' ? '等待日志...' : '暂无日志' }}</div>
          <div v-for="(e, i) in logEntries" :key="i" class="flex gap-1.5" :style="{ color: levelColor(e.level) }">
            <span class="shrink-0 opacity-50">{{ new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
            <span class="shrink-0 font-extrabold">{{ levelPrefix(e.level) }}</span>
            <span class="break-all">{{ e.msg }}</span>
          </div>
        </div>
      </section>

      <!-- Findings -->
      <section>
        <h2 class="mb-3 font-mono text-sm font-extrabold text-[var(--app-muted)]">发现列表 ({{ findingsTotal }})</h2>
        <p v-if="findingsError" class="mb-3 text-xs font-bold" style="color: var(--expense)">{{ findingsError }}</p>
        <p v-else-if="findingsTotal > findings.length" class="mb-3 text-xs text-[var(--app-muted)]">当前显示前 {{ findings.length }} 条</p>
        <DataTable :columns="findingColumns" :rows="findings" :row-key="(f: Finding) => f.id" empty-message="暂无发现" @row-click="goFinding">
          <template #cell-severity="{ row }"><SeverityBadge :severity="(row as Finding).severity" /></template>
          <template #cell-validation_status="{ row }"><span class="font-mono text-xs font-bold" :style="{ color: validationColor((row as Finding).validation_status) }">{{ validationLabel((row as Finding).validation_status) }}</span></template>
        </DataTable>
      </section>
    </div>
  </AppLayout>
</template>
