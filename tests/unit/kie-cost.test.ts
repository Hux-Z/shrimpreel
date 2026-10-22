import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { adminRoutes } from '#/server/admin'
import type { AppContext, UserRow } from '#/server/types'
import { d1Shim, migrate } from './d1-sqlite'

it('后台毛利只统计已记录美元成本的任务，不把 KIE 未知费用当作零成本', async () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    migrate(sqlite)
    const now = new Date().toISOString()
    sqlite.prepare("INSERT INTO users (id, email, role, created_at) VALUES ('u', 'admin@example.com', 'admin', ?)").run(now)
    const insert = sqlite.prepare(`INSERT INTO generations
      (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, provider, status, provider_cost_cents, created_at, updated_at, completed_at)
      VALUES (?, 'u', 'template', 'short', 6, 6, 'upload', ?, 'succeeded', ?, ?, ?, ?)`)
    insert.run('kie', 'kie', null, now, now, now)
    insert.run('fal', 'fal', 36, now, now, now)
    const app = new Hono<AppContext>()
    app.use('*', async (c, next) => { c.set('user', { id: 'u', role: 'admin' } as UserRow); await next() })
    app.route('/', adminRoutes)
    const response = await app.request('/stats', undefined, { DB: d1Shim(sqlite), APP_ENV: 'development' } as unknown as Env)
    expect(response.status).toBe(200)
    const body = await response.json() as { generationCost30d: object }
    expect(body.generationCost30d).toEqual({ videos: 1, costCents: 36, creditsUsed: 6 })
  } finally { sqlite.close() }
})
