export interface ValidationResult {
  valid: boolean
  available: boolean
  balance: number
  currency: string
  account?: string
  arn?: string
  remaining?: number
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function checkDeepSeekBalance(apiKey: string): Promise<ValidationResult | null> {
  try {
    const resp = await fetchWithTimeout('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    })

    if (resp.status !== 200) {
      return { valid: false, available: false, balance: 0, currency: '' }
    }

    const data = (await resp.json()) as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>
    }

    const isAvailable = data.is_available ?? true
    const balanceInfos = data.balance_infos || []

    if (balanceInfos.length === 0) {
      return { valid: true, available: false, balance: 0, currency: '' }
    }

    let balance = 0
    let currency = ''
    for (const info of balanceInfos) {
      const cur = (info.currency || '').toUpperCase()
      let total = parseFloat(info.total_balance || '0')
      if (total <= 0) {
        total = parseFloat(info.granted_balance || '0') + parseFloat(info.topped_up_balance || '0')
      }
      if (cur === 'CNY' && total > 0) {
        balance = total
        currency = 'CNY'
        break
      }
      if (cur === 'USD' && total > 0 && currency !== 'CNY') {
        balance = total
        currency = 'USD'
      }
      if (!currency) {
        balance = total
        currency = cur
      }
    }

    return { valid: true, available: isAvailable && balance > 0, balance, currency }
  } catch {
    return null
  }
}

export async function checkOpenAiKey(apiKey: string): Promise<ValidationResult | null> {
  try {
    const resp = await fetchWithTimeout('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    })

    if (resp.status === 401) {
      return { valid: false, available: false, balance: 0, currency: '' }
    }
    if (resp.status === 429) {
      return { valid: true, available: false, balance: 0, currency: '' }
    }
    if (resp.status < 200 || resp.status >= 300) {
      return { valid: false, available: false, balance: 0, currency: '' }
    }

    let remaining = -1
    for (const headerKey of ['x-ratelimit-remaining-tokens', 'x-ratelimit-remaining', 'x-ratelimit-remaining-requests']) {
      const val = resp.headers.get(headerKey)
      if (val !== null) {
        const parsed = parseInt(val, 10)
        if (!isNaN(parsed)) {
          remaining = parsed
          break
        }
      }
    }

    return { valid: true, available: remaining !== 0, balance: remaining, currency: remaining >= 0 ? 'tokens' : 'unknown', remaining }
  } catch {
    return null
  }
}

export async function checkGoogleApiKey(apiKey: string): Promise<ValidationResult | null> {
  try {
    const resp = await fetchWithTimeout(`https://www.googleapis.com/discovery/v1/apis?key=${apiKey}`)

    if (resp.status === 200) {
      return { valid: true, available: true, balance: 0, currency: 'Google' }
    }
    if (resp.status === 400) {
      const data = (await resp.json()) as { error?: { code?: number; message?: string } }
      if (data.error?.code === 400 && (data.error?.message || '').includes('API key not valid')) {
        return { valid: false, available: false, balance: 0, currency: '' }
      }
      return { valid: false, available: false, balance: 0, currency: '' }
    }
    if (resp.status === 403) {
      return { valid: true, available: false, balance: 0, currency: 'Google' }
    }
    return { valid: false, available: false, balance: 0, currency: '' }
  } catch {
    return null
  }
}

export async function checkAnthropicKey(apiKey: string): Promise<ValidationResult | null> {
  try {
    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json'
      }
    })

    if (resp.status === 200) {
      return { valid: true, available: true, balance: 0, currency: 'Anthropic' }
    }
    if (resp.status === 401) {
      return { valid: false, available: false, balance: 0, currency: '' }
    }
    if (resp.status === 403 || resp.status === 429) {
      return { valid: true, available: false, balance: 0, currency: 'Anthropic' }
    }
    return { valid: false, available: false, balance: 0, currency: '' }
  } catch {
    return null
  }
}

// Key extraction patterns ported from cli.py
const SK_KEY_PATTERN = /sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,})/
const ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9\-_]{40,}/
const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z\-_]{35}/

export function extractApiKey(rawText: string): string | null {
  const m = SK_KEY_PATTERN.exec(rawText)
  return m ? m[0] : null
}

export function extractAnthropicKey(rawText: string): string | null {
  const m = ANTHROPIC_KEY_PATTERN.exec(rawText)
  return m ? m[0] : null
}

export function extractGoogleKey(rawText: string): string | null {
  const m = GOOGLE_KEY_PATTERN.exec(rawText)
  return m ? m[0] : null
}

const DEEPSEEK_RULES = new Set(['DeepSeek API Key', 'DeepSeek Key with Context'])
const OPENAI_RULES = new Set(['OpenAI API Key'])
const GOOGLE_RULES = new Set(['Google API Key'])
const ANTHROPIC_RULES = new Set(['Anthropic API Key'])

export async function validateFinding(ruleName: string, rawText: string): Promise<ValidationResult | null> {
  if (DEEPSEEK_RULES.has(ruleName)) {
    const key = extractApiKey(rawText)
    if (key) return checkDeepSeekBalance(key)
  }
  if (OPENAI_RULES.has(ruleName)) {
    const key = extractApiKey(rawText)
    if (key) return checkOpenAiKey(key)
  }
  if (GOOGLE_RULES.has(ruleName)) {
    const key = extractGoogleKey(rawText)
    if (key) return checkGoogleApiKey(key)
  }
  if (ANTHROPIC_RULES.has(ruleName)) {
    const key = extractAnthropicKey(rawText)
    if (key) return checkAnthropicKey(key)
  }
  return null
}
