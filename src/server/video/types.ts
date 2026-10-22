export interface VideoSubmitInput {
  generationId: string
  durationSeconds: number
  imageUrl: string
  imageContentType?: string
  sourceVideoUrl: string
  sourceVideoKey: string
  webhookUrl: string
  meta: Record<string, unknown>
}

export interface VideoSubmitResult {
  requestId: string
  meta: Record<string, unknown>
}

// 保留服务商确认的原始积分消耗，不按充值挂牌价换算为实际美元账单。
export interface VideoBilling { creditsConsumed: number }

export type VideoStatus =
  | { state: 'pending' }
  // costCents：已结算的实际美元费用；缺失时沿用服务商的成本策略（允许未知）。
  | { state: 'completed'; output: { url: string } | { r2Key: string }; costCents?: number; billing?: VideoBilling }
  | { state: 'failed'; code: string; message: string; retryable?: boolean; billing?: VideoBilling }

export interface VideoProvider {
  id: 'fal' | 'yir' | 'kie' | 'mock'
  // 未提供提交幂等保证的服务商，中断后不能自动重新提交。默认沿用原有重试行为。
  retryInterruptedSubmit?: boolean
  submit(input: VideoSubmitInput): Promise<VideoSubmitResult>
  status(requestId: string, meta: Record<string, unknown>): Promise<VideoStatus>
  // 成本（美分）；未知返回 null，不能用估算冒充已确认账单
  costCents(durationSeconds: number): number | null
}

// 可重试错误由服务商按阶段判定，队列重投；不可重试错误直接失败并退积分。
export class VideoProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
