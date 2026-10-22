// KIE Market API：https://docs.kie.ai/cn/market/kling/motion-control
// createTask 没有公开的幂等契约；只重试明确被限流拒绝的提交，避免响应丢失后重复计费。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import { VideoProviderError, type VideoBilling, type VideoProvider, type VideoStatus } from './types'

const API = 'https://api.kie.ai/api/v1/jobs'
export const KIE_TIMEOUT_MS = 30_000

interface KieResponse {
  code?: number
  data?: {
    taskId?: string
    state?: string
    resultJson?: string
    failCode?: string
    creditsConsumed?: number
  }
}

export function createKieProvider(env: Env): VideoProvider {
  async function request(stage: 'submit' | 'status', path: string, body?: object) {
    const key = cleanSecret(env.KIE_API_KEY)
    if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
    const controller = new AbortController()
    // 包含响应体读取的超时；错误信息不拼接响应或网络异常，防止回显密钥与签名 URL。
    const timer = setTimeout(() => controller.abort(), KIE_TIMEOUT_MS)
    let response: Response
    let result: KieResponse | null
    try {
      response = await fetch(`${API}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      result = await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null
        throw error
      }) as KieResponse | null
    } catch {
      const cause = controller.signal.aborted ? 'timeout' : 'network'
      throw new VideoProviderError(`kie_${stage}_${cause}`, `KIE ${stage} ${cause}; outcome may be unknown`, stage === 'status')
    } finally {
      clearTimeout(timer)
    }
    const code = response.ok ? (typeof result?.code === 'number' ? result.code : undefined) : response.status
    if (!response.ok || code !== 200) {
      // 429 明确不入队；408/5xx 可能已经创建任务，不能自动重新提交。
      const retryable = stage === 'submit' ? code === 429 : code === 408 || code === 429 || (typeof code === 'number' && code >= 500)
      throw new VideoProviderError(`kie_${stage}_${code ?? 'invalid_response'}`, `KIE ${stage} rejected or invalid response (${code ?? 'unknown'})`, retryable)
    }
    return result?.data
  }

  return {
    id: 'kie',
    retryInterruptedSubmit: false,
    async submit(input) {
      const { model, prompt, mode, characterOrientation } = site.video.kie
      if (model !== 'kling-2.6/motion-control' || !['720p', '1080p'].includes(mode) || !['image', 'video'].includes(characterOrientation) || prompt.length > 2500) {
        throw new VideoProviderError('kie_invalid_config', 'Invalid KIE Motion Control configuration', false)
      }
      const maxSeconds = characterOrientation === 'image' ? 10 : 30
      if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 3 || input.durationSeconds > maxSeconds) {
        throw new VideoProviderError('kie_invalid_duration', `KIE reference video must be 3-${maxSeconds} seconds`, false)
      }
      if (input.imageContentType && !['image/jpeg', 'image/png'].includes(input.imageContentType)) {
        throw new VideoProviderError('kie_invalid_image', 'KIE requires JPEG or PNG', false)
      }
      if (![input.imageUrl, input.sourceVideoUrl].every(isHttps)) {
        throw new VideoProviderError('kie_invalid_media_url', 'KIE requires public HTTPS media URLs', false)
      }
      const data = await request('submit', 'createTask', {
        model,
        ...(isHttps(input.webhookUrl) ? { callBackUrl: input.webhookUrl } : {}),
        input: { prompt, input_urls: [input.imageUrl], video_urls: [input.sourceVideoUrl], mode, character_orientation: characterOrientation },
      })
      if (typeof data?.taskId !== 'string' || !data.taskId.trim()) {
        throw new VideoProviderError('kie_submit_unknown', 'KIE submit response has no taskId; automatic resubmission disabled', false)
      }
      return { requestId: data.taskId, meta: { model, mode, characterOrientation } }
    },
    async status(requestId): Promise<VideoStatus> {
      const data = await request('status', `recordInfo?taskId=${encodeURIComponent(requestId)}`)
      if (data?.taskId !== requestId) throw new VideoProviderError('kie_invalid_status', 'KIE taskId missing or mismatched', false)
      if (['waiting', 'queuing', 'generating'].includes(data.state ?? '')) return { state: 'pending' }
      const billing: VideoBilling | undefined = typeof data.creditsConsumed === 'number' && Number.isFinite(data.creditsConsumed) && data.creditsConsumed >= 0
        ? { creditsConsumed: data.creditsConsumed }
        : undefined
      if (data.state === 'fail') {
        const code = typeof data.failCode === 'string' && /^[\w.-]{1,80}$/.test(data.failCode) && !data.failCode.includes(cleanSecret(env.KIE_API_KEY) ?? '') ? data.failCode : 'failed'
        return { state: 'failed', code: `kie_${code}`, message: 'KIE generation failed; inspect task details in KIE logs', billing }
      }
      if (data.state !== 'success') throw new VideoProviderError('kie_invalid_status', 'KIE returned an unknown task state', false)
      let result: { resultUrls?: unknown } | null = null
      try { result = JSON.parse(data.resultJson ?? '') } catch { /* 缺失或损坏的结果统一判失败退款。 */ }
      const url = Array.isArray(result?.resultUrls) ? result.resultUrls[0] : undefined
      if (!isHttps(url)) return { state: 'failed', code: 'kie_no_video', message: 'KIE result has no HTTPS video URL', billing }
      return { state: 'completed', output: { url }, billing }
    },
    // creditsConsumed 是已确认的积分消耗，但充值优惠会改变兑换价，无法确认实际美元支出。
    costCents: () => null,
  }
}

function isHttps(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return new URL(value).protocol === 'https:' } catch { return false }
}
