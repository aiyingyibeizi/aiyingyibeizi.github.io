/**
 * 可观测性：轻量访问采样日志 + 未捕获错误上报。
 *
 * 设计：
 *   - 采样日志默认关闭（OBSERVABILITY_SAMPLE=0）。>0 时按比例输出一行结构化 JSON，
 *     便于用 wrangler tail / 日志平台做请求级分析。采样本身不落库、不阻塞请求。
 *   - 错误上报：onError 捕获到未处理异常时，若配置了 OBSERVABILITY_WEBHOOK，
 *     以 fire-and-forget 方式 POST 该错误（绝不阻塞返回 500 的流程）。
 */

export interface LogLine {
  t: string;
  level: 'access';
  m: string;
  path: string;
  status: number;
  dur_ms: number;
  ip?: string;
  ua?: string;
}

export interface ErrorReport {
  t: string;
  level: 'error';
  m: string;
  path: string;
  message: string;
}

/** 按采样率输出访问日志；sample ∈ (0,1] 才有效。0 表示关闭。 */
export function sampleRequest(opts: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  sample: number;
  ip?: string;
  ua?: string;
}): void {
  const r = Number(opts.sample) || 0;
  if (!(r > 0)) return;
  if (Math.random() > Math.min(Math.max(r, 0.001), 1)) return;
  const line: LogLine = {
    t: new Date().toISOString(),
    level: 'access',
    m: opts.method,
    path: opts.path,
    status: opts.status,
    dur_ms: Math.round(opts.durationMs),
  };
  if (opts.ip) line.ip = opts.ip;
  if (opts.ua) line.ua = String(opts.ua).slice(0, 120);
  console.log('[obs:access] ' + JSON.stringify(line));
}

/** 上报未捕获错误到 webhook（可选）；失败只记日志，不影响主流程。 */
export function reportError(
  webhook: string | undefined,
  payload: { method: string; path: string; message: string },
  waitUntil?: (p: Promise<unknown>) => void
): void {
  if (!webhook) return;
  const body: ErrorReport = {
    t: new Date().toISOString(),
    level: 'error',
    m: payload.method,
    path: payload.path,
    message: String(payload.message).slice(0, 1000),
  };
  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      console.error('reportError push failed:', err);
    } finally {
      clearTimeout(timer);
    }
  })();
  task.catch(() => {});
  if (waitUntil) {
    try { waitUntil(task); } catch { /* ignore */ }
  }
}