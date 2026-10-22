import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleVideoJob, runScheduledMaintenance } from '#/server/jobs'
import { ledgerStatements } from '#/server/credits'
import { d1Shim, migrate } from './d1-sqlite'

vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: vi.fn() }))
vi.mock('#/server/reconcile', () => ({ reconcilePendingOrders: async () => ({ checked: 0 }) }))
vi.mock('#/server/subscriptions', () => ({ grantDueSubscriptions: async () => ({ checked: 0 }) }))
vi.mock('#/server/retention', () => ({ sweepExpiredMedia: async () => ({ uploads: 0, outputs: 0 }) }))

let sqlite: DatabaseSync
let env: Env
let db: ReturnType<typeof d1Shim>
const poll = () => handleVideoJob(env, { kind: 'poll', generationId: 'g' })
const submit = () => handleVideoJob(env, { kind: 'submit', generationId: 'g' })
const row = () => sqlite.prepare('SELECT * FROM generations WHERE id = ?').get('g') as Record<string, unknown>
const balance = () => (sqlite.prepare('SELECT credits FROM users WHERE id = ?').get('u') as { credits: number }).credits
const refunds = () => sqlite.prepare("SELECT * FROM credit_ledger WHERE reason = 'generation_refund'").all()
const json = (data: object, code = 200) => Response.json({ code, data })

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  db = d1Shim(sqlite)
  const now = new Date().toISOString()
  sqlite.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run('u', 'test@example.com', now)
  sqlite.prepare('INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('up', 'u', 'uploads/up.png', 'image/png', 10, now)
  env = { DB: db, SITE_URL: 'https://example.com', SESSION_SECRET: 'x'.repeat(64), APP_ENV: 'production', KIE_API_KEY: 'test',
    VIDEO_QUEUE: { send: vi.fn() }, MEDIA: { put: vi.fn(), delete: vi.fn() },
  } as unknown as Env
  await env.DB.batch(ledgerStatements(env.DB, { userId: 'u', delta: 20, reason: 'purchase', idempotencyKey: 'order:o' }))
  await env.DB.batch(ledgerStatements(env.DB, { userId: 'u', delta: -6, reason: 'generation', refId: 'g', idempotencyKey: 'generation:g' }))
  sqlite.prepare(`INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, provider, created_at, updated_at)
    VALUES ('g', 'u', 'template', 'short', 6, 6, 'up', 'kie', ?, ?)`).run(now, now)
})
afterEach(() => { vi.restoreAllMocks(); sqlite.close() })

function serveJob(data: object) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).endsWith('/createTask')) return json({ taskId: 'task_1' })
    if (String(url).includes('/recordInfo?')) return json({ taskId: 'task_1', ...data })
    if (String(url) === 'https://cdn.example/out.mp4') return new Response(new Uint8Array([1, 2, 3]))
    throw new Error('Unexpected URL')
  })
}

describe('KIE 复用任务队列、R2 和账务', () => {
  it('重复提交只发送一次 createTask；完成落 R2、保存积分消耗，美元费用 NULL；重复轮询不重复处理', async () => {
    const fetch = serveJob({ state: 'success', resultJson: '{"resultUrls":["https://cdn.example/out.mp4"]}', creditsConsumed: 66 })
    await Promise.all([submit(), submit()])
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/createTask'))).toHaveLength(1)
    await Promise.all([poll(), poll()])
    expect(row()).toMatchObject({ status: 'succeeded', provider_request_id: 'task_1', provider_cost_cents: null, refunded: 0, output_r2_key: 'outputs/u/g.mp4' })
    expect(JSON.parse(String(row().provider_meta))).toMatchObject({ billing: { creditsConsumed: 66 } })
    expect(env.MEDIA.put).toHaveBeenCalled()
    expect(env.MEDIA.delete).not.toHaveBeenCalled()
    const count = fetch.mock.calls.length
    await poll()
    expect(fetch.mock.calls.length).toBe(count)
    expect(balance()).toBe(14)
    expect(refunds()).toHaveLength(0)
  })

  it('处理中只续投 poll，不重发生成请求', async () => {
    const fetch = serveJob({ state: 'generating' })
    await submit(); await poll()
    expect(row().status).toBe('processing')
    expect(env.VIDEO_QUEUE.send).toHaveBeenLastCalledWith({ kind: 'poll', generationId: 'g' }, { delaySeconds: 20 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('失败保存确认消耗、原路退积分；重复消息只退款一次', async () => {
    serveJob({ state: 'fail', failCode: '422', creditsConsumed: 0 })
    await submit()
    await Promise.all([poll(), poll()])
    await poll()
    expect(row()).toMatchObject({ status: 'failed', refunded: 1, error_code: 'kie_422', provider_cost_cents: null })
    expect(JSON.parse(String(row().provider_meta)).billing).toEqual({ creditsConsumed: 0 })
    expect(balance()).toBe(20)
    expect(refunds()).toHaveLength(1)
  })

  it('提交响应丢失不重提，失败退款', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection lost'))
    await submit(); await submit()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ status: 'failed', refunded: 1, error_code: 'kie_submit_network' })
    expect(balance()).toBe(20)
  })

  it('明确 429 未入队可重试；后续提交成功', async () => {
    const fetch = serveJob({ state: 'waiting' })
    fetch.mockResolvedValueOnce(json({}, 429))
    await expect(submit()).rejects.toMatchObject({ retryable: true })
    expect(row().status).toBe('queued')
    await submit()
    expect(row()).toMatchObject({ status: 'processing', provider_request_id: 'task_1' })
    expect(balance()).toBe(14)
  })

  it('拿到 taskId 后落库失败也不重新提交', async () => {
    const fetch = serveJob({ state: 'waiting' })
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('SET provider_request_id')) throw new Error('DB write interrupted')
      return prepare(sql)
    })
    await submit(); await submit()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ status: 'failed', error_code: 'kie_submit_unknown' })
    expect(balance()).toBe(20)
  })

  it('taskId 已保存但入队失败时保留 processing，由 Cron 补投 poll', async () => {
    const fetch = serveJob({ state: 'waiting' })
    vi.mocked(env.VIDEO_QUEUE.send).mockRejectedValueOnce(new Error('queue unavailable'))
    await expect(submit()).rejects.toThrow('queue unavailable')
    await submit()
    expect(row()).toMatchObject({ status: 'processing', provider_request_id: 'task_1' })
    sqlite.prepare('UPDATE generations SET updated_at = ?').run(new Date(Date.now() - 6 * 60_000).toISOString())
    await runScheduledMaintenance(env)
    expect(env.VIDEO_QUEUE.send).toHaveBeenLastCalledWith({ kind: 'poll', generationId: 'g' }, undefined)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('Worker 中断且没有 taskId，Cron 退款而不重新提交', async () => {
    const fetch = serveJob({ state: 'waiting' })
    sqlite.prepare("UPDATE generations SET status = 'processing', attempts = 1, updated_at = ?").run(new Date(Date.now() - 6 * 60_000).toISOString())
    await runScheduledMaintenance(env)
    expect(row()).toMatchObject({ status: 'failed', error_code: 'kie_submit_unknown' })
    expect(fetch).not.toHaveBeenCalled()
    expect(env.VIDEO_QUEUE.send).not.toHaveBeenCalled()
    expect(balance()).toBe(20)
  })
})
