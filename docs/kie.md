# KIE.ai 视频服务商

KIE 是模板的可选能力，不包含业务站点素材或专属 Prompt。首个且唯一支持的模型是 `kling-2.6/motion-control`。未调用真实收费 API，契约与队列流程均用 Mock 验证。

## 启用与本地开发

1. 在站点的 `wrangler.jsonc` 中设 `VIDEO_PROVIDER=kie`；使用预发配置时在 `wrangler.staging.jsonc` 同样选择 `kie`。默认服务商保持原值。
2. 本地从 `.dev.vars.example` 复制 `.dev.vars`，只在本机填写 `KIE_API_KEY`。正式环境由站点维护者设置同名 Worker secret。不要提交或打印密钥。上线配置检查和 `npm run doctor` 只对所选服务商要求密钥。
3. 配置 `src/config/site.ts` 的 `video.kie`：`model` 固定为上述 ID；`prompt` 可为空，最多 2500 字符；`mode` 为 `720p` 或 `1080p`；`characterOrientation` 为 `image` 或 `video`（默认 `video`）。
4. 站点的 `upload.contentTypes` 建议配置为 `['image/jpeg', 'image/png']`，与 KIE 支持格式一致；API 在选择 KIE 时会拒绝 WebP，已有的 WebP 上传在提交生成前失败退款。fal、yir、mock 的上传类型不变。
5. 配置可由公网访问的 HTTPS `SITE_URL`，图片签名 URL 和模板源视频均从该域名生成。普通 localhost 无法供 KIE 拉取素材，本地只运行 Mock 测试，不需要密钥或公网隧道。

后台“测试连接”只检查 KIE 密钥是否存在，并明确提示未核验鉴权或余额，不发起生成请求。切换服务商后，旧任务仍按数据库里保存的 provider 处理，因此旧密钥需保留到任务结束。

## 官方接口契约

2026-10-22 核对以下官方来源：

- [Motion Control API 与请求 schema](https://docs.kie.ai/market/kling/motion-control)（[中文](https://docs.kie.ai/cn/market/kling/motion-control)）。`POST https://api.kie.ai/api/v1/jobs/createTask`，Bearer 鉴权。请求为 `{ model, input, callBackUrl? }`；`input` 使用 `input_urls: [图片地址]`、`video_urls: [参考视频地址]`、`prompt`、`mode`、`character_orientation`。响应必须是 `code=200` 且带 `data.taskId`。API schema 的 `mode` 枚举是 `720p` / `1080p`；营销页另有 `std` / `pro` 描述，本实现按 API schema 和请求示例传值。
- [任务详情](https://docs.kie.ai/market/common/get-task-detail)。`GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=…`；验证返回的任务 ID 一致。`waiting`、`queuing`、`generating` 为处理中，`success` 为成功，`fail` 为失败。`data.resultJson` 是 JSON 字符串，从 `resultUrls[0]` 读取 HTTPS 成片地址。`costTime` 是耗时，不能作为费用。
- [入门、错误和限流规则](https://docs.kie.ai/getting-started)。不仅检查 HTTP 状态，也检查响应体 `code`：接口可能以 HTTP 200 返回 401 / 422 / 429 等错误。默认每账号 10 秒最多 20 个新生成请求；429 请求不进入队列。任务详情 422 表示 ID 缺失、不存在或不属于此账号。图片/视频链接需对服务商可读。生成文件保留 14 天，日志保留 2 个月。
- [模型页与计费](https://kie.ai/kling-2.6-motion-control)、[最新价格](https://kie.ai/pricing)。按参考视频长度计费；核对时 720p 为 11 credits/秒、1080p 为 18 credits/秒，挂牌等价约 $0.055/秒、$0.09/秒，充值优惠会改变有效兑换价。以服务商最新报价和账单为准。

每个任务最多一张 JPEG/PNG 图片（10 MB，尺寸大于 300 px，宽高比 2:5–5:2）和一个 MP4/QuickTime 视频（100 MB）。参考视频至少 3 秒；`image` 方向最多 10 秒，`video` 方向最多 30 秒。代码在提交前验证配置、配置时长、已知图片类型和 HTTPS 地址；尺寸、视频编码、实际长度与内容质量由站点准备素材时核对，并由 KIE 最终校验，未增加媒体转码或探测系统。成片可能保留参考视频原声。

## 队列、错误与退款

复用 `src/server/jobs.ts` 的原子抢占、20 秒轮询、45 分钟任务超时、死信处理、R2 下载上限和 `generationRefundStatements`。回调 `/api/webhooks/kie` 只验证任务 token 后投递 poll 消息，不能直接改变状态或注入结果地址；结果仍用服务端 API Key 查询。重复提交消息不会重复创建任务，重复轮询不能重复落库通知或重复退款。

每次 KIE 请求包含响应体读取在内最多 30 秒。查询遇到网络错误、超时、408、429 或 5xx，交给现有队列退避重试；鉴权失败、任务不存在、未知状态等无效响应直接失败退款。成功但没有有效输出也失败退款。上游原始错误文本不写入日志、数据库或用户响应，避免回显密钥和签名媒体 URL；失败原因在 KIE logs 按 taskId 查询。

官方文档未给出可核实的 createTask 幂等键或按业务 ID 找回任务的契约，因此：

- 只有明确拒绝入队的 429 允许提交重试。
- 提交网络错误、超时、408、5xx、响应损坏或缺少 taskId 时失败退款，不自动重新创建收费任务。
- Worker 抢占后中断、或拿到 taskId 但未保存时，Cron 发现处理中且没有 taskId，会以 `kie_submit_unknown` 失败退款。不会套用其它 Provider 的中断重提机制。
- taskId 已保存但后续入队失败时保持 processing，由 Cron 重新投递 poll。

结果不明时 KIE 仍可能已生成并扣费，但站点会退款且无法自动找回成片。需由维护者根据生成时间和 KIE logs 人工对账。这是避免重复计费的保守取舍，不宣称跨服务商的 exactly-once 提交保证。无法在发送前持久化抢占状态时，不会发送请求。

## 费用记录

任务终态返回有效、非负数值的 `data.creditsConsumed` 时，保存到 `generations.provider_meta.billing.creditsConsumed`，成功和失败都可保存，缺失/无效时保持未知。它是 KIE 的确认消耗量，与本站用户积分账本无关。

`generations.provider_cost_cents` 对 KIE 保持 NULL，后台美元成本和毛利显示未知，不用挂牌美元兑换价或配置时长推算实际账单，也不把未返回费用记成 0。不增加数据库迁移。后台汇总的收入与毛利仅统计已记录美元成本的任务，避免把未知成本当作 0；fal 与 yir 继续沿用原有费用策略。

如果提交结果不明，或在查询返回后、费用保存前发生 Worker 中断，可能无法取得消耗记录。系统没有账单导入或终态任务费用回补功能，维护者需在 KIE logs 核对。

## 测试与 upstream 同步

`npm run typecheck`、`npm test`、`npm run build`；`npm run seed:local` 后运行 `npm run test:e2e`。2026-10-22 本地验证：类型检查、260 项单元测试、构建通过；完整 e2e 65 项通过，费用汇总修正后的后台与生成 e2e 9 项通过。构建输出有非阻断的 Vite CSS sourcemap 警告。

新增契约、队列与费用汇总测试在 `tests/unit/kie.test.ts`、`tests/unit/kie-jobs.test.ts`、`tests/unit/kie-cost.test.ts`，使用 Mock API 与内存 SQLite；不需要 KIE Key，也不会请求收费 API。

本功能先在 ShrimpReel 功能分支评审并合并到 main。之后业务站点按 [.claude/skills/sync-upstream/SKILL.md](../.claude/skills/sync-upstream/SKILL.md) 出同步计划，使用 `git merge` 合并 upstream/main，保留站点品牌、素材和 Prompt，接受新增 `video.kie` 字段、密钥登记与通用实现。合并提交包含 `Template-sync: <模板 SHA>` trailer。站点维护者再选择 `VIDEO_PROVIDER=kie` 并配置密钥；合并模板本身不会自动切换 Provider。本任务不修改业务站点，不推送、合并或部署。

## 变更文件

- Provider 与任务：`src/server/video/kie.ts`（新增），`src/server/video/types.ts`、`src/server/video/index.ts`、`src/server/jobs.ts`、`src/server/app.ts`。
- 后台费用与检查：`src/server/admin.ts`、`src/routes/admin/index.tsx`、`src/routes/admin/generations.tsx`、`src/server/config-health.ts`、`src/server/probes.ts`。
- 配置与类型：`src/config/site.ts`、`src/env.d.ts`、`.dev.vars.example`、`wrangler.jsonc`、`wrangler.staging.jsonc`、`worker-configuration.d.ts`。
- 测试：新增 `tests/unit/kie.test.ts`、`tests/unit/kie-jobs.test.ts`、`tests/unit/kie-cost.test.ts`；修改 `tests/unit/providers.test.ts`、`tests/unit/config-health.test.ts`、`tests/unit/probes.test.ts`、`tests/e2e/generation.spec.ts`、`tests/e2e/CATALOG.md`、`tests/smoke/production.spec.ts`。
- 文档：本文件（新增），`docs/env.md`、`README.md`、`README.zh-CN.md`、`ROADMAP.md`。
