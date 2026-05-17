import { http } from './http'
import type { PageResult } from '@/types/api'
import type { Scan, ScanProgress, CreateScanInput } from '@/types/domain'

export const scansApi = {
  list(page = 0, pageSize = 20, status?: string) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (status) params.set('status', status)
    return http.get<PageResult<Scan>>(`/scans?${params}`)
  },

  get(scanId: string) {
    return http.get<Scan>(`/scans/${scanId}`)
  },

  progress(scanId: string) {
    return http.get<ScanProgress>(`/scans/${scanId}/progress`)
  },

  advance(scanId: string) {
    return http.post<ScanProgress>(`/scans/${scanId}/advance`)
  },

  create(input: CreateScanInput) {
    return http.post<Scan>('/scans', input)
  },

  cancel(scanId: string) {
    return http.post<{ cancelled: boolean }>(`/scans/${scanId}/cancel`)
  },

  delete(scanId: string) {
    return http.delete<{ deleted: boolean }>(`/scans/${scanId}`)
  },

  log(scanId: string) {
    return http.get<{ entries: Array<{ ts: string; level: string; msg: string }> }>(`/scans/${scanId}/log`)
  }
}
