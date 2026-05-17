export interface Rule {
  name: string
  pattern: RegExp
  description: string
  severity: 'critical' | 'high' | 'medium' | 'low'
}

const OPENAI_API_KEY_PATTERN = /sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{32,})/g
const DEEPSEEK_API_KEY_PATTERN = /sk-[A-Za-z0-9_-]{32,}/g
const DEEPSEEK_CONTEXT_PATTERN = /(deepseek|DEEPSEEK_API_KEY|deepseek_api)\s*[=:]\s*['"]?(sk-[A-Za-z0-9_-]{20,})['"]?/gi

export const DEFAULT_RULES: Rule[] = [
  {
    name: 'AWS Access Key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: 'AWS Access Key ID',
    severity: 'critical'
  },
  {
    name: 'AWS Secret Key',
    pattern: /(aws_secret_access_key|aws_secret|secret_key)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    description: 'AWS Secret Access Key',
    severity: 'critical'
  },
  {
    name: 'GitHub Token',
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    description: 'GitHub Personal Access Token / Fine-grained Token',
    severity: 'critical'
  },
  {
    name: 'GitHub OAuth Access Token',
    pattern: /gho_[A-Za-z0-9_]{36,}/g,
    description: 'GitHub OAuth Access Token',
    severity: 'critical'
  },
  {
    name: 'GitLab Token',
    pattern: /glpat-[A-Za-z0-9\-_]{20,}/g,
    description: 'GitLab Personal Access Token',
    severity: 'critical'
  },
  {
    name: 'Slack Bot Token',
    pattern: /xoxb-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{24,}/g,
    description: 'Slack Bot Token',
    severity: 'high'
  },
  {
    name: 'Slack User Token',
    pattern: /xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32}/g,
    description: 'Slack User OAuth Token',
    severity: 'high'
  },
  {
    name: 'Slack Webhook URL',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/g,
    description: 'Slack Incoming Webhook URL',
    severity: 'high'
  },
  {
    name: 'Stripe Secret Key',
    pattern: /sk_live_[A-Za-z0-9]{24,}/g,
    description: 'Stripe Secret Key (Production)',
    severity: 'critical'
  },
  {
    name: 'Stripe Publishable Key',
    pattern: /pk_live_[A-Za-z0-9]{24,}/g,
    description: 'Stripe Publishable Key (Production)',
    severity: 'medium'
  },
  {
    name: 'Stripe Test Key',
    pattern: /[sr]k_test_[A-Za-z0-9]{24,}/g,
    description: 'Stripe Test Key',
    severity: 'low'
  },
  {
    name: 'Google API Key',
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    description: 'Google API Key',
    severity: 'high'
  },
  {
    name: 'Google OAuth Client Secret',
    pattern: /GOCSPX-[A-Za-z0-9_\-]{28,}/g,
    description: 'Google OAuth Client Secret',
    severity: 'critical'
  },
  {
    name: 'OpenAI API Key',
    pattern: OPENAI_API_KEY_PATTERN,
    description: 'OpenAI API Key',
    severity: 'high'
  },
  {
    name: 'DeepSeek API Key',
    pattern: DEEPSEEK_API_KEY_PATTERN,
    description: 'DeepSeek / OpenAI-compatible API Key',
    severity: 'high'
  },
  {
    name: 'DeepSeek Key with Context',
    pattern: DEEPSEEK_CONTEXT_PATTERN,
    description: 'DeepSeek API Key with context',
    severity: 'critical'
  },
  {
    name: 'Anthropic API Key',
    pattern: /sk-ant-[A-Za-z0-9\-_]{40,}/g,
    description: 'Anthropic API Key',
    severity: 'high'
  },
  {
    name: 'Telegram Bot Token',
    pattern: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/g,
    description: 'Telegram Bot Token',
    severity: 'high'
  },
  {
    name: 'SendGrid API Key',
    pattern: /SG\.[A-Za-z0-9_\-]{22,}\.[A-Za-z0-9_\-]{43,}/g,
    description: 'SendGrid API Key',
    severity: 'high'
  },
  {
    name: 'Twilio API Key',
    pattern: /SK[0-9a-fA-F]{32}/g,
    description: 'Twilio API Key',
    severity: 'high'
  },
  {
    name: 'Mailgun API Key',
    pattern: /key-[0-9a-zA-Z]{32}/g,
    description: 'Mailgun API Key',
    severity: 'high'
  },
  {
    name: 'Heroku API Key',
    pattern: /heroku.*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gi,
    description: 'Heroku API Key',
    severity: 'high'
  },
  {
    name: 'Private Key Block',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    description: 'Private Key (PEM format)',
    severity: 'critical'
  },
  {
    name: 'Generic Secret Assignment',
    pattern: /(api_key|api_secret|secret_key|access_token|auth_token|client_secret|db_password)\s*[=:]\s*['"]?[A-Za-z0-9+/=_\-]{16,}['"]?/gi,
    description: 'Generic secret/token assignment',
    severity: 'medium'
  }
]
