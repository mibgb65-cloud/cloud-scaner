import app from './app'
import { ensureDefaultAdmin } from './services/bootstrap.service'
import type { Env } from './types/env'

export default {
  async fetch(request, env, executionContext) {
    const url = new URL(request.url)

    if (url.pathname === '/api/init' || url.pathname === '/api/init/') {
      const result = await ensureDefaultAdmin(env)
      return Response.json({
        code: 'OK',
        message: 'ok',
        data: { initialized: true, ...result },
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString()
      })
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, executionContext)
    }

    return env.ASSETS.fetch(request)
  }
} satisfies ExportedHandler<Env>
