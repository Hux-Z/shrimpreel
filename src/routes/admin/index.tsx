import { Link, createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AdminPage, LoadState, marginCents, money, useAdminData } from '#/components/admin'
import type { ConfigIssue } from '#/server/config-health'

export const Route = createFileRoute('/admin/')({
  component: AdminOverview,
})

type Revenue = { currency: string; orders: number; cents: number }
type Stats = {
  users: number
  newUsers7d: number
  revenue: Revenue[]
  revenue30d: Revenue[]
  generations: { status: string; n: number }[]
  outstandingCredits: number
  openMessages: number
  failedPaymentEvents: number
  openTakedowns: number
  overdueTakedowns: number
  failedEmails: number
  generationCost30d: { videos: number; costCents: number; creditsUsed: number }
  revenuePerCreditCents: number | null
  config: ConfigIssue[]
}

function revenueText(rows: Revenue[]) {
  if (!rows.length) return money(0)
  return rows.map((r) => money(r.cents, r.currency)).join(' + ')
}

function AdminOverview() {
  const { data, error, loading } = useAdminData<Stats>('/api/admin/stats')
  const gen = Object.fromEntries((data?.generations ?? []).map((g) => [g.status, g.n])) as Record<string, number>
  const genTotal = Object.values(gen).reduce((a, b) => a + b, 0)
  const cost = data?.generationCost30d
  const margin = cost && data ? marginCents(cost.creditsUsed, data.revenuePerCreditCents, cost.costCents) : null

  return (
    <AdminPage title="概览">
      <LoadState loading={loading && !data} error={error} />
      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="admin-stats">
            <Stat label="用户总数" value={data.users} hint={`近 7 天新增 ${data.newUsers7d}`} />
            <Stat
              label="累计收入"
              value={revenueText(data.revenue)}
              hint={`${data.revenue.reduce((a, r) => a + r.orders, 0)} 笔已支付订单`}
            />
            <Stat label="近 30 天收入" value={revenueText(data.revenue30d)} hint={`${data.revenue30d.reduce((a, r) => a + r.orders, 0)} 笔`} />
            <Stat label="未消耗积分" value={data.outstandingCredits} hint="用户余额合计（递延负债）" />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card space-y-3 p-5 lg:col-span-2">
              <h2 className="font-semibold">生成任务</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(['queued', 'processing', 'succeeded', 'failed'] as const).map((s) => (
                  <div key={s} className="rounded-xl bg-bg-soft p-3">
                    <p className="text-xs text-muted">{{ queued: '排队中', processing: '生成中', succeeded: '成功', failed: '失败' }[s]}</p>
                    <p className="mt-1 text-2xl font-semibold">{gen[s] ?? 0}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted">
                共 {genTotal} 个，失败率 {genTotal ? (((gen.failed ?? 0) / genTotal) * 100).toFixed(1) : '0.0'}%
              </p>
              {cost ? (
                <div className="grid grid-cols-3 gap-3 border-t border-line pt-3" data-testid="admin-margin">
                  <div>
                    <p className="text-xs text-muted">近 30 天服务商成本</p>
                    <p className="mt-1 font-semibold">{money(cost.costCents)}</p>
                    <p className="text-xs text-muted">{cost.videos} 条已记录美元成本</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">消耗积分折算收入</p>
                    <p className="mt-1 font-semibold">
                      {data.revenuePerCreditCents === null ? '—' : money(Math.round(cost.creditsUsed * data.revenuePerCreditCents))}
                    </p>
                    <p className="text-xs text-muted">
                      {cost.creditsUsed} 积分
                      {data.revenuePerCreditCents === null ? '' : ` × ${money(Math.round(data.revenuePerCreditCents))}`}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">估算毛利</p>
                    <p className="mt-1 font-semibold">{margin === null ? '—' : money(margin)}</p>
                    <p className="text-xs text-muted">仅统计已记录美元成本的任务</p>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="card space-y-3 p-5">
              <h2 className="font-semibold">待处理</h2>
              <Todo
                to="/admin/takedowns"
                label={data.overdueTakedowns ? `待处理举报（${data.overdueTakedowns} 条已超时）` : '待处理举报'}
                n={data.openTakedowns}
              />
              <Todo to="/admin/messages" label="待回复留言" n={data.openMessages} />
              <Todo to="/admin/events" label="待核对的支付事件" n={data.failedPaymentEvents} />
              <Todo to="/admin/emails" label="发送失败的邮件" n={data.failedEmails} />
              <Todo to="/admin/generations" label="生成中的任务" n={(gen.queued ?? 0) + (gen.processing ?? 0)} />
            </div>
          </div>
          <ConfigCheck issues={data.config} />
        </>
      ) : null}
    </AdminPage>
  )
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint: string }) {
  return (
    <div className="card p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  )
}

function ConfigCheck({ issues }: { issues: ConfigIssue[] }) {
  const errors = issues.filter((i) => i.level === 'error').length
  return (
    <div className="card space-y-3 p-5" data-testid="admin-config">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">上线配置检查</h2>
        <p className="text-xs text-muted">
          {issues.length ? `${errors} 个错误，${issues.length - errors} 个提醒` : '全部通过'} · 部署前用 npm run doctor 另查资源 id、密钥名和远端 migration
        </p>
      </div>
      {issues.length ? (
        <ul className="space-y-1 text-sm">
          {issues.map((issue) => (
            <li key={`${issue.key}:${issue.message}`} className="flex gap-2">
              <span className={`shrink-0 font-semibold ${issue.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
                {issue.level === 'error' ? '错误' : '提醒'}
              </span>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

type TodoPath = '/admin/messages' | '/admin/events' | '/admin/emails' | '/admin/generations' | '/admin/takedowns'

function Todo({ to, label, n }: { to: TodoPath; label: string; n: number }) {
  return (
    <Link to={to} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-bg-soft">
      <span>{label}</span>
      <span className={`font-semibold ${n ? 'text-red-600' : 'text-muted'}`}>{n}</span>
    </Link>
  )
}
