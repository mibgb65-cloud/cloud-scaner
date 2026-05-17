import { Hono } from 'hono'
import type { AppVariables, Env } from '../types/env'
import { createScanSchema, listScansSchema, type CreateScanInput } from '../schemas/scan.schema'
import { GitHubClient, type SearchResult } from '../services/github.service'
import { scanContent, deduplicate, findingToRow } from '../services/scanner.service'
import { DEFAULT_RULES } from '../services/rules.data'
import { newId } from '../utils/crypto'
import { nowIso } from '../utils/date'
import { ok } from '../utils/response'
import { assertFound } from '../utils/http-error'
import { consumeRateLimit, getClientIp, rateLimitKey } from '../utils/rate-limit'
import { paramsToObject } from '../utils/params'
import { TokenRotator } from '../services/token-rotation.service'
import { logAction } from '../utils/logger'
import type { ValidationResult } from '../services/validator.service'

const scansRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>()
const SCAN_CHUNK_FILE_LIMIT = 2
const SCAN_CHUNK_MAX_MS = 15_000
const SCAN_LOCK_TTL = 60

const SCAN_RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scan_runtime (
  scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  lock_until TEXT,
  updated_at TEXT NOT NULL
)`

type LogLevel = 'info' | 'found' | 'skip' | 'error'

interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
}

interface ScanLogger {
  entries: LogEntry[]
}

interface ScanState {
  query: string
  queries: string[]
  queryIndex: number
  page: number
  pageItems: SearchResult[]
  pageHasNext: boolean
  itemOffset: number
  resultsSeen: number
  scanned: number
  skipped: number
  findings: number
  limitCount: number
  minEntropy: number
  autoValidate: boolean
  skipHistory: boolean
  rules?: string[]
  userId?: string
  ip: string
  started?: boolean
}

function createLogger(): ScanLogger {
  return { entries: [] }
}

async function pushLog(logger: ScanLogger, level: LogLevel, msg: string, ts: string) {
  logger.entries.push({ ts, level, msg })
}

// Helper: check if scan is cancelled
async function isCancelled(kv: KVNamespace, scanId: string): Promise<boolean> {
  const raw = await kv.get(`scan:cancel:${scanId}`)
  return raw === '1'
}

function describeValidation(result: ValidationResult | null): string {
  if (!result) return '验证失败: 请求异常、超时或规则暂不支持'
  if (!result.valid) return '验证未通过: 密钥无效'

  const detail = result.currency ? ` (${result.balance} ${result.currency})` : ''
  if (!result.available) return `验证未通过: 密钥有效但不可用${detail}`

  return `验证通过: 可用${detail}`
}

function summarizeRules(findings: Array<{ ruleName: string }>): string {
  const counts = new Map<string, number>()
  for (const finding of findings) {
    counts.set(finding.ruleName, (counts.get(finding.ruleName) || 0) + 1)
  }
  return Array.from(counts.entries()).map(([rule, count]) => `${rule} x${count}`).join(', ')
}

async function ensureScanRuntimeSchema(db: D1Database): Promise<void> {
  await db.prepare(SCAN_RUNTIME_SCHEMA_SQL).run()
}

async function loadScanState(db: D1Database, scanId: string): Promise<ScanState | null> {
  await ensureScanRuntimeSchema(db)
  const row = await db.prepare('SELECT state_json FROM scan_runtime WHERE scan_id = ?')
    .bind(scanId)
    .first<{ state_json: string }>()
  return row?.state_json ? JSON.parse(row.state_json) as ScanState : null
}

async function saveScanState(db: D1Database, scanId: string, state: ScanState): Promise<void> {
  await ensureScanRuntimeSchema(db)
  await db.prepare(`
    INSERT INTO scan_runtime (scan_id, state_json, lock_until, updated_at)
    VALUES (?, ?, NULL, ?)
    ON CONFLICT(scan_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `).bind(scanId, JSON.stringify(state), nowIso()).run()
}

async function deleteScanState(db: D1Database, scanId: string): Promise<void> {
  await ensureScanRuntimeSchema(db)
  await db.prepare('DELETE FROM scan_runtime WHERE scan_id = ?').bind(scanId).run()
}

async function acquireScanLock(db: D1Database, scanId: string): Promise<'acquired' | 'locked' | 'missing'> {
  await ensureScanRuntimeSchema(db)
  const existing = await db.prepare('SELECT lock_until FROM scan_runtime WHERE scan_id = ?')
    .bind(scanId)
    .first<{ lock_until: string | null }>()
  if (!existing) return 'missing'

  const now = nowIso()
  if (existing.lock_until && existing.lock_until > now) return 'locked'

  const lockUntil = new Date(Date.now() + SCAN_LOCK_TTL * 1000).toISOString()
  const result = await db.prepare(`
    UPDATE scan_runtime
    SET lock_until = ?, updated_at = ?
    WHERE scan_id = ? AND (lock_until IS NULL OR lock_until <= ?)
  `).bind(lockUntil, now, scanId, now).run() as { meta?: { changes?: number } }

  return (result.meta?.changes ?? 0) > 0 ? 'acquired' : 'locked'
}

async function releaseScanLock(db: D1Database, scanId: string): Promise<void> {
  await db.prepare('UPDATE scan_runtime SET lock_until = NULL, updated_at = ? WHERE scan_id = ?')
    .bind(nowIso(), scanId)
    .run()
}

function buildQuery(input: CreateScanInput): string {
  if (input.query) return input.query

  const parts: string[] = []
  if (input.keyword) parts.push(input.keyword)
  if (input.org) parts.push(`org:${input.org}`)
  if (input.lang) parts.push(`language:${input.lang}`)
  return parts.join(' ')
}

function createInitialState(input: CreateScanInput, query: string, userId: string | undefined, ip: string): ScanState {
  return {
    query,
    queries: GitHubClient.buildSearchQueries(query, input.limit === 0),
    queryIndex: 0,
    page: 1,
    pageItems: [],
    pageHasNext: false,
    itemOffset: 0,
    resultsSeen: 0,
    scanned: 0,
    skipped: 0,
    findings: 0,
    limitCount: input.limit,
    minEntropy: input.minEntropy,
    autoValidate: input.autoValidate,
    skipHistory: input.skipHistory,
    rules: input.rules,
    userId,
    ip
  }
}

// List scans with pagination and status filter
scansRoutes.get('/api/v1/scans', async (c) => {
  const query = listScansSchema.parse(paramsToObject(new URL(c.req.url).searchParams))
  const db = c.env.DB

  let sql = 'SELECT id, query, keyword, org, lang, status, progress_scanned, progress_skipped, progress_findings, limit_count, min_entropy, error_message, created_at, updated_at, completed_at FROM scans'
  const conditions: string[] = []
  const binds: unknown[] = []

  if (query.status) {
    conditions.push('status = ?')
    binds.push(query.status)
  }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  binds.push(query.pageSize, query.page * query.pageSize)

  const rows = await db.prepare(sql).bind(...binds).all()
  return ok(c, { items: rows.results || [], page: query.page, pageSize: query.pageSize })
})

// Get scan detail
scansRoutes.get('/api/v1/scans/:scanId', async (c) => {
  const scanId = c.req.param('scanId')
  const db = c.env.DB

  const scan = await db.prepare('SELECT id, query, keyword, org, lang, status, progress_scanned, progress_skipped, progress_findings, limit_count, min_entropy, error_message, created_at, updated_at, completed_at FROM scans WHERE id = ?').bind(scanId).first()
  assertFound(scan, '扫描任务不存在')

  return ok(c, scan)
})

// Get scan log (real-time)
scansRoutes.get('/api/v1/scans/:scanId/log', async (c) => {
  return ok(c, { entries: [] })
})

// Get scan progress (lightweight, for polling)
scansRoutes.get('/api/v1/scans/:scanId/progress', async (c) => {
  const scanId = c.req.param('scanId')
  const db = c.env.DB

  const progressScan = await db.prepare('SELECT status, progress_scanned, progress_skipped, progress_findings, updated_at FROM scans WHERE id = ?').bind(scanId).first<{ status: string; progress_scanned: number; progress_skipped: number; progress_findings: number; updated_at: string }>()
  assertFound(progressScan, '扫描任务不存在')
  if (!progressScan) throw new Error('unreachable')

  return ok(c, {
    scanned: progressScan.progress_scanned,
    skipped: progressScan.progress_skipped,
    findings: progressScan.progress_findings,
    status: progressScan.status,
    updatedAt: progressScan.updated_at,
    logs: []
  })
})

scansRoutes.post('/api/v1/scans/:scanId/advance', async (c) => {
  const scanId = c.req.param('scanId')
  const db = c.env.DB
  const kv = c.env.SCAN_KV
  const logger = createLogger()

  const scan = await db.prepare('SELECT status, progress_scanned, progress_skipped, progress_findings, updated_at FROM scans WHERE id = ?').bind(scanId).first<{ status: string; progress_scanned: number; progress_skipped: number; progress_findings: number; updated_at: string }>()
  assertFound(scan, '扫描任务不存在')
  if (!scan) throw new Error('unreachable')

  if (scan.status === 'running') {
    await advanceScanChunk(scanId, db, kv, logger)
  }

  const freshScan = await db.prepare('SELECT status, progress_scanned, progress_skipped, progress_findings, updated_at FROM scans WHERE id = ?').bind(scanId).first<{ status: string; progress_scanned: number; progress_skipped: number; progress_findings: number; updated_at: string }>()
  return ok(c, {
    scanned: freshScan?.progress_scanned ?? scan.progress_scanned,
    skipped: freshScan?.progress_skipped ?? scan.progress_skipped,
    findings: freshScan?.progress_findings ?? scan.progress_findings,
    status: freshScan?.status ?? scan.status,
    updatedAt: freshScan?.updated_at ?? scan.updated_at,
    logs: logger.entries
  })
})

// Cancel scan
scansRoutes.post('/api/v1/scans/:scanId/cancel', async (c) => {
  const scanId = c.req.param('scanId')
  const db = c.env.DB
  const kv = c.env.SCAN_KV

  const scan = await db.prepare("SELECT status FROM scans WHERE id = ? AND status = 'running'").bind(scanId).first<{ status: string }>()
  assertFound(scan, '没有正在运行的扫描任务')

  // Set cancel flag in KV (checked in scan loop)
  await kv.put(`scan:cancel:${scanId}`, '1', { expirationTtl: 3600 })
  await db.prepare("UPDATE scans SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(nowIso(), scanId).run()
  await deleteScanState(db, scanId)

  return ok(c, { cancelled: true })
})

// Delete scan and cascade-delete findings
scansRoutes.delete('/api/v1/scans/:scanId', async (c) => {
  const scanId = c.req.param('scanId')
  const db = c.env.DB

  const scan = await db.prepare('SELECT id FROM scans WHERE id = ?').bind(scanId).first()
  assertFound(scan, '扫描任务不存在')

  await db.prepare('DELETE FROM scans WHERE id = ?').bind(scanId).run()
  logAction(db, 'scan_delete', JSON.stringify({ scanId }), c.get('currentUserId'), getClientIp(c))

  return ok(c, { deleted: true })
})

async function nextSearchResult(client: GitHubClient, state: ScanState): Promise<SearchResult | null> {
  while (true) {
    if (state.limitCount > 0 && state.resultsSeen >= state.limitCount) return null

    if (state.itemOffset < state.pageItems.length) {
      const result = state.pageItems[state.itemOffset++]
      state.resultsSeen++
      return result
    }

    if (state.pageItems.length > 0) {
      if (state.pageHasNext) {
        state.page++
      } else {
        state.queryIndex++
        state.page = 1
      }
      state.pageItems = []
      state.pageHasNext = false
      state.itemOffset = 0
    }

    const currentQuery = state.queries[state.queryIndex]
    if (!currentQuery) return null

    const searchPage = await client.searchCodePage(currentQuery, state.page, 100)
    state.pageItems = searchPage.items
    state.pageHasNext = searchPage.hasNext
    state.itemOffset = 0

    if (state.pageItems.length === 0) {
      state.queryIndex++
      state.page = 1
      state.pageHasNext = false
      continue
    }
  }
}

async function hasSeenFile(db: D1Database, scanId: string, fileKey: string, skipHistory: boolean): Promise<boolean> {
  const current = await db.prepare('SELECT 1 FROM scanned_files WHERE scan_id = ? AND file_key = ? LIMIT 1').bind(scanId, fileKey).first()
  if (current) return true
  if (skipHistory) return false

  const historical = await db.prepare(
    'SELECT 1 FROM scanned_files sf JOIN scans s ON sf.scan_id = s.id WHERE s.status = ? AND sf.file_key = ? LIMIT 1'
  ).bind('completed', fileKey).first()

  return Boolean(historical)
}

async function processSearchResult(scanId: string, state: ScanState, sr: SearchResult, db: D1Database, kv: KVNamespace, client: GitHubClient, logger: ScanLogger) {
  const activeRules = state.rules && state.rules.length > 0
    ? DEFAULT_RULES.filter((r) => state.rules!.includes(r.name))
    : DEFAULT_RULES
  const fileKey = `${sr.repo}/${sr.filePath}`

  if (await hasSeenFile(db, scanId, fileKey, state.skipHistory)) {
    state.skipped++
    await pushLog(logger, 'skip', `跳过历史文件: ${fileKey}`, nowIso())
    return
  }

  state.scanned++
  await pushLog(logger, 'info', `[${state.scanned}] 扫描: ${fileKey}`, nowIso())

  const content = await client.getFileContent(sr.repo, sr.filePath)
  if (!content) {
    await pushLog(logger, 'skip', `跳过文件: 无法读取或内容为空 -> ${fileKey}`, nowIso())
    await db.prepare('INSERT OR IGNORE INTO scanned_files (scan_id, file_key, created_at) VALUES (?, ?, ?)').bind(scanId, fileKey, nowIso()).run()
    return
  }

  const findings = scanContent(sr.repo, sr.filePath, sr.url, content, activeRules, state.minEntropy)
  const unique = deduplicate(findings)
  if (unique.length === 0) {
    await pushLog(logger, 'info', `未命中候选: ${fileKey}`, nowIso())
  } else {
    await pushLog(logger, 'info', `命中候选: ${fileKey} -> ${unique.length} 条 (${summarizeRules(unique)})`, nowIso())
  }

  if (unique.length > 0) {
    const savedFindings: Array<{ finding: typeof unique[0]; validation?: { status: string; json: string } }> = []
    for (const f of unique) {
      if (state.autoValidate) {
        const { validateFinding } = await import('../services/validator.service')
        await pushLog(logger, 'info', `正在验证候选: ${f.ruleName} → ${f.repo}/${f.filePath}:${f.lineNumber}`, nowIso())
        const result = await validateFinding(f.ruleName, f.rawText)
        await pushLog(logger, result?.valid && result.available ? 'found' : 'skip', `${describeValidation(result)} -> ${f.ruleName} @ ${f.repo}/${f.filePath}:${f.lineNumber}`, nowIso())
        if (!result || !result.valid || !result.available) {
          await pushLog(logger, 'info', `跳过无效: ${f.ruleName} → ${f.repo}/${f.filePath}:${f.lineNumber}`, nowIso())
          continue
        }
        savedFindings.push({ finding: f, validation: { status: 'valid', json: JSON.stringify(result) } })
        await pushLog(logger, 'found', `[${f.severity.toUpperCase()}][已验证] ${f.ruleName} | 余额: ${result.balance} ${result.currency} → ${f.repo}/${f.filePath}:${f.lineNumber}`, nowIso())
      } else {
        savedFindings.push({ finding: f })
        await pushLog(logger, 'found', `[${f.severity.toUpperCase()}] ${f.ruleName} → ${f.repo}/${f.filePath}:${f.lineNumber}`, nowIso())
      }
    }

    if (savedFindings.length > 0) {
      const batch: D1PreparedStatement[] = []
      const rawWrites: Promise<void>[] = []
      for (const sf of savedFindings) {
        const row = await findingToRow(sf.finding, scanId)
        const vStatus = sf.validation?.status || 'unvalidated'
        const vJson = sf.validation?.json || null
        batch.push(db.prepare(`INSERT INTO findings (id, scan_id, rule_name, severity, repo, file_path, line_number, url, matched_text, raw_text_hash, validation_status, validation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(row.id, row.scan_id, row.rule_name, row.severity, row.repo, row.file_path, row.line_number, row.url, row.matched_text, row.raw_text_hash, vStatus, vJson, row.created_at))
        rawWrites.push(kv.put(`raw:${row.id}`, sf.finding.rawText, { expirationTtl: 3600 }))
      }
      batch.push(db.prepare('INSERT OR IGNORE INTO scanned_files (scan_id, file_key, created_at) VALUES (?, ?, ?)').bind(scanId, fileKey, nowIso()))
      await db.batch(batch)
      await Promise.all(rawWrites)
      state.findings += savedFindings.length
      await pushLog(logger, 'found', `已保存发现: ${fileKey} -> ${savedFindings.length} 条, 累计 ${state.findings} 条`, nowIso())
      return
    }

    await pushLog(logger, 'skip', `候选均未保存: ${fileKey}`, nowIso())
  }

  await db.prepare('INSERT OR IGNORE INTO scanned_files (scan_id, file_key, created_at) VALUES (?, ?, ?)').bind(scanId, fileKey, nowIso()).run()
}

async function completeScan(scanId: string, state: ScanState, db: D1Database, logger: ScanLogger) {
  const now = nowIso()
  await db.prepare(`UPDATE scans SET status = 'completed', progress_scanned = ?, progress_skipped = ?, progress_findings = ?, updated_at = ?, completed_at = ? WHERE id = ?`).bind(state.scanned, state.skipped, state.findings, now, now, scanId).run()
  await pushLog(logger, 'info', `扫描完成: ${state.scanned} 个文件, ${state.skipped} 跳过, ${state.findings} 发现`, nowIso())
  await deleteScanState(db, scanId)
  await logAction(db, 'scan_create', JSON.stringify({ scanId, query: state.query, scanned: state.scanned, findings: state.findings }), state.userId, state.ip)
}

async function failScan(scanId: string, message: string, db: D1Database, logger: ScanLogger) {
  await db.prepare("UPDATE scans SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?").bind(message, nowIso(), scanId).run()
  await pushLog(logger, 'error', `扫描失败: ${message}`, nowIso())
  await deleteScanState(db, scanId)
}

async function advanceScanChunk(scanId: string, db: D1Database, kv: KVNamespace, logger: ScanLogger) {
  let lockAcquired = false

  try {
    const lock = await acquireScanLock(db, scanId)
    if (lock === 'locked') {
      await pushLog(logger, 'info', '上一个扫描分片仍在执行，等待下一次轮询...', nowIso())
      return
    }
    if (lock === 'missing') {
      await failScan(scanId, '扫描状态不存在，请重新创建扫描', db, logger)
      return
    }
    lockAcquired = true

    const scan = await db.prepare("SELECT status FROM scans WHERE id = ?").bind(scanId).first<{ status: string }>()
    if (!scan || scan.status !== 'running') return

    const state = await loadScanState(db, scanId)
    if (!state) {
      await failScan(scanId, '扫描状态不存在，请重新创建扫描', db, logger)
      return
    }

    if (!state.started) {
      await logScanStart(state, logger)
      state.started = true
    }

    const rotator = await TokenRotator.load(db)
    const token = rotator.next()
    if (!token) {
      await failScan(scanId, '未添加 GitHub Token', db, logger)
      return
    }
    await TokenRotator.markUsed(db, token)

    const client = new GitHubClient(token, (message) => pushLog(logger, 'info', message, nowIso()))
    const startedAt = Date.now()
    let processed = 0

    while (processed < SCAN_CHUNK_FILE_LIMIT && Date.now() - startedAt < SCAN_CHUNK_MAX_MS) {
      if (await isCancelled(kv, scanId)) {
        await pushLog(logger, 'error', '扫描已终止', nowIso())
        await deleteScanState(db, scanId)
        return
      }

      const result = await nextSearchResult(client, state)
      if (!result) {
        await completeScan(scanId, state, db, logger)
        return
      }

      await processSearchResult(scanId, state, result, db, kv, client, logger)
      processed++

      await db.prepare("UPDATE scans SET progress_scanned = ?, progress_skipped = ?, progress_findings = ?, updated_at = ? WHERE id = ?").bind(state.scanned, state.skipped, state.findings, nowIso(), scanId).run()
      if (state.scanned % 10 === 0) {
        await pushLog(logger, 'info', `进度: 已扫描 ${state.scanned}, 已跳过 ${state.skipped}, 有效发现 ${state.findings}`, nowIso())
      }
    }

    if (await isCancelled(kv, scanId)) {
      await deleteScanState(db, scanId)
      return
    }

    await saveScanState(db, scanId, state)
    if (processed > 0) {
      await pushLog(logger, 'info', `分片完成: 本次处理 ${processed} 个文件，等待下一次进度轮询继续`, nowIso())
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    try {
      await failScan(scanId, message, db, logger)
    } catch (failErr) {
      console.error('failed to mark scan failed', failErr)
      throw err
    }
  } finally {
    if (lockAcquired) await releaseScanLock(db, scanId)
  }
}

async function logScanStart(state: ScanState, logger: ScanLogger) {
  const activeRules = state.rules && state.rules.length > 0
    ? DEFAULT_RULES.filter((r) => state.rules!.includes(r.name))
    : DEFAULT_RULES

  await pushLog(logger, 'info', `扫描已创建: ${state.query}`, nowIso())
  if (state.rules && state.rules.length > 0) {
    await pushLog(logger, 'info', `使用 ${activeRules.length}/${DEFAULT_RULES.length} 条规则: ${state.rules.join(', ')}`, nowIso())
  } else {
    await pushLog(logger, 'info', `使用全部 ${activeRules.length} 条规则`, nowIso())
  }
  if (state.autoValidate) await pushLog(logger, 'info', '已启用自动验证（仅保存有效密钥）', nowIso())
  await pushLog(logger, 'info', `开始扫描: ${state.query} (limit: ${state.limitCount === 0 ? '无限' : state.limitCount})`, nowIso())
  await pushLog(logger, 'info', state.skipHistory ? '已关闭历史记录去重（将扫描所有文件）' : '已启用历史记录去重', nowIso())
  await pushLog(logger, 'info', `分片扫描已就绪: 每次前端轮询最多处理 ${SCAN_CHUNK_FILE_LIMIT} 个文件`, nowIso())
  await pushLog(logger, 'info', '详情页轮询已连接，开始推进扫描...', nowIso())
}

// Create scan (returns immediately, runs in background)
type CreateScanInputType = CreateScanInput
scansRoutes.post('/api/v1/scans', async (c) => {
  const parsed = createScanSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) throw parsed.error
  const input = parsed.data

  // Rate limit
  const ip = getClientIp(c)
  const rlKey = await rateLimitKey('scan', ip)
  await consumeRateLimit(c.env.SCAN_KV, rlKey, 5, 120, '扫描请求过于频繁，请稍后再试')

  const query = buildQuery(input)

  const scanId = newId('scan')
  const now = nowIso()
  const db = c.env.DB
  const state = createInitialState(input, query, c.get('currentUserId'), ip)

  await db.prepare(`INSERT INTO scans (id, query, keyword, org, lang, status, limit_count, min_entropy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`).bind(scanId, query, input.keyword || '', input.org || '', input.lang || '', input.limit, input.minEntropy, now, now).run()

  await saveScanState(db, scanId, state)

  return ok(c, { id: scanId, query, status: 'running' }, 202)
})

export { scansRoutes }
