import { afterEach, describe, expect, it, vi } from 'vitest'
import { site } from '#/config/site'
import { createKieProvider, KIE_TIMEOUT_MS } from '#/server/video/kie'

const env = { KIE_API_KEY: 'kie_test' } as Env
const provider = () => createKieProvider(env)
const input = () => ({
  generationId: 'gen_1', durationSeconds: 6,
  imageUrl: 'https://example.com/photo.png', imageContentType: 'image/png',
  sourceVideoUrl: 'https://example.com/source.mp4', sourceVideoKey: 'templates/source.mp4',
  webhookUrl: 'https://example.com/api/webhooks/kie?gen=gen_1&token=test', meta: {},
})
const serve = (data: unknown, code = 200, http = 200) => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ code, data }, { status: http }))
const job = (data: object) => serve({ taskId: 'task_1', ...data })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('KIE Motion Control 契约', () => {
  it('提交官方模型和字段，读取 taskId；本地 HTTP callback 不发送', async () => {
    const fetch = serve({ taskId: 'task_1' })
    expect(await provider().submit(input())).toEqual({ requestId: 'task_1', meta: { model: 'kling-2.6/motion-control', mode: '720p', characterOrientation: 'video' } })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.kie.ai/api/v1/jobs/createTask')
    expect(init?.headers).toEqual({ Authorization: 'Bearer kie_test', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'kling-2.6/motion-control', callBackUrl: input().webhookUrl,
      input: { prompt: '', input_urls: [input().imageUrl], video_urls: [input().sourceVideoUrl], mode: '720p', character_orientation: 'video' },
    })
    await provider().submit({ ...input(), webhookUrl: 'http://localhost:3000/callback' })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).not.toHaveProperty('callBackUrl')
  })

  it.each(['waiting', 'queuing', 'generating'])('%s 映射为 pending，只查询不重新提交', async (state) => {
    const fetch = job({ state })
    expect(await provider().status('task_1', {})).toEqual({ state: 'pending' })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task_1')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('成功解析 resultJson，保留确认的 credits，不用 costTime 或挂牌价冒充美元费用', async () => {
    job({ state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/out.mp4'] }), creditsConsumed: 66, costTime: 25 })
    expect(await provider().status('task_1', {})).toEqual({ state: 'completed', output: { url: 'https://cdn.example/out.mp4' }, billing: { creditsConsumed: 66 } })
    expect(provider().costCents(6)).toBeNull()
    expect(provider().retryInterruptedSubmit).toBe(false)
  })

  it.each([undefined, null, '66', -1])('费用缺失或无效 %s：保持未知', async (creditsConsumed) => {
    job({ state: 'success', resultJson: '{"resultUrls":["https://cdn.example/out.mp4"]}', creditsConsumed })
    expect(await provider().status('task_1', {})).toMatchObject({ state: 'completed', billing: undefined })
  })

  it('终态失败保留错误码和已确认消耗，不回显可能包含密钥的上游消息', async () => {
    job({ state: 'fail', failCode: '422', failMsg: 'kie_test secret echoed', creditsConsumed: 0 })
    const result = await provider().status('task_1', {})
    expect(result).toMatchObject({ state: 'failed', code: 'kie_422', billing: { creditsConsumed: 0 } })
    expect(JSON.stringify(result)).not.toContain('kie_test')
  })

  it.each([undefined, 'bad json', '{}', 'null', '{"resultUrls":[]}', '{"resultUrls":["http://cdn.example/out.mp4"]}'])('成功但结果损坏：%s', async (resultJson) => {
    job({ state: 'success', resultJson })
    expect(await provider().status('task_1', {})).toMatchObject({ state: 'failed', code: 'kie_no_video' })
  })

  it.each([{ state: 'other' }, { state: 'success', taskId: 'wrong' }, {}])('拒绝无效状态或不匹配任务 %j', async (data) => {
    job(data)
    await expect(provider().status('task_1', {})).rejects.toMatchObject({ code: 'kie_invalid_status', retryable: false })
  })

  it.each([null, {}, { taskId: '' }, { taskId: 1 }])('提交响应缺少 taskId 不重试 %j', async (data) => {
    serve(data)
    await expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_submit_unknown', retryable: false })
  })

  it.each([401, 402, 422, 429, 500])('HTTP 200 中的错误 code=%s 也生效，只有明确拒绝入队的 429 可重提', async (code) => {
    serve(null, code)
    await expect(provider().submit(input())).rejects.toMatchObject({ retryable: code === 429 })
    await expect(provider().status('task_1', {})).rejects.toMatchObject({ retryable: code === 429 || code >= 500 })
  })

  it('HTTP 网关错误和非 JSON 响应：提交不重发，查询网关错误可重试', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad gateway', { status: 503 }))
    await expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_submit_503', retryable: false })
    await expect(provider().status('task_1', {})).rejects.toMatchObject({ code: 'kie_status_503', retryable: true })
    vi.mocked(fetch).mockImplementation(async () => new Response('bad json'))
    await expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_submit_invalid_response', retryable: false })
  })

  it('响应体读取中断仍是网络错误；无效 code 和 failCode 不回显密钥', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ json: async () => { throw new TypeError('body interrupted') } }) as unknown as Response)
    await expect(provider().status('task_1', {})).rejects.toMatchObject({ code: 'kie_status_network', retryable: true })
    vi.mocked(fetch).mockImplementation(async () => Response.json({ code: 'kie_test' }))
    await expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_submit_invalid_response', retryable: false })
    job({ state: 'fail', failCode: 'echo_kie_test' })
    expect(await provider().status('task_1', {})).toMatchObject({ code: 'kie_failed' })
  })

  it('网络失败：提交结果不明不重发，状态查询可重试', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network kie_test'))
    await expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_submit_network', retryable: false })
    await expect(provider().status('task_1', {})).rejects.toMatchObject({ code: 'kie_status_network', retryable: true })
  })

  it.each(['submit', 'status'] as const)('%s 超时会中止请求，提交结果不明不重发', async (stage) => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const pending = stage === 'submit' ? provider().submit(input()) : provider().status('task_1', {})
    const assertion = expect(pending).rejects.toMatchObject({ code: `kie_${stage}_timeout`, retryable: stage === 'status' })
    await vi.advanceTimersByTimeAsync(KIE_TIMEOUT_MS)
    await assertion
  })

  it('读取响应体也受超时约束', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => ({
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    }) as Response)
    const assertion = expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_submit_timeout', retryable: false })
    await vi.advanceTimersByTimeAsync(KIE_TIMEOUT_MS)
    await assertion
  })

  it('缺密钥、无效时长、WebP 和非 HTTPS 媒体在请求前拒绝', async () => {
    const fetch = serve({ taskId: 'unused' })
    await expect(createKieProvider({} as Env).submit(input())).rejects.toMatchObject({ code: 'provider_not_configured' })
    for (const durationSeconds of [2, 31, NaN]) await expect(provider().submit({ ...input(), durationSeconds })).rejects.toMatchObject({ code: 'kie_invalid_duration' })
    await expect(provider().submit({ ...input(), imageContentType: 'image/webp' })).rejects.toMatchObject({ code: 'kie_invalid_image' })
    await expect(provider().submit({ ...input(), sourceVideoUrl: 'http://localhost/source.mp4' })).rejects.toMatchObject({ code: 'kie_invalid_media_url' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('站点可配置 1080p、image 方向和通用 prompt，image 方向最长 10 秒', async () => {
    const original = { ...site.video.kie }
    try {
      Object.assign(site.video.kie, { mode: '1080p', characterOrientation: 'image', prompt: 'Keep the outfit' })
      const fetch = serve({ taskId: 'task_1' })
      await provider().submit(input())
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).input).toMatchObject({ mode: '1080p', character_orientation: 'image', prompt: 'Keep the outfit' })
      await expect(provider().submit({ ...input(), durationSeconds: 12 })).rejects.toMatchObject({ code: 'kie_invalid_duration' })
      Object.assign(site.video.kie, { prompt: 'x'.repeat(2501) })
      await expect(provider().submit(input())).rejects.toMatchObject({ code: 'kie_invalid_config' })
    } finally { Object.assign(site.video.kie, original) }
  })
})
