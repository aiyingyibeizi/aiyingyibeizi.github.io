/**
 * 通知外发：把管理后台的高危事件推送到可配置的 webhook。
 *
 * 支持两类目标：
 *  - 飞书/Lark 自定义机器人 webhook（URL 含 open.feishu/larksuite.cn 或 feishu/larksuite）
 *    按交互式卡片格式发送；
 *  - 其它通用 webhook（JSON POST，字段展开）。
 *
 * 一律 fire-and-forget（可经 waitUntil 注册），任何失败只记日志、绝不阻塞主流程。
 */

export interface NotifyPayload {
  title: string;
  theme: 'red' | 'orange' | 'green' | 'blue' | 'grey';
  text?: string; // 可选正文
  lines: Array<{ label: string; value: string }>;
}

export function sendNotify(
  webhook: string | undefined,
  payload: NotifyPayload,
  waitUntil?: (p: Promise<unknown>) => void
): void {
  if (!webhook) return;

  const task = (async () => {
    const isFeishu = /feishu|larksuite/i.test(webhook);
    const body = isFeishu ? JSON.stringify(buildFeishuCard(payload)) : JSON.stringify(buildGeneric(payload));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) console.warn('sendNotify non-2xx:', res.status);
    } catch (err) {
      console.error('sendNotify failed:', err);
    } finally {
      clearTimeout(timer);
    }
  })();
  task.catch(() => {});

  if (waitUntil) {
    try {
      waitUntil(task);
    } catch {
      /* ignore */
    }
  }
}

function buildFeishuCard(p: NotifyPayload): Record<string, unknown> {
  const colorMap: Record<string, string> = {
    red: 'red',
    orange: 'orange',
    green: 'green',
    blue: 'blue',
    grey: 'grey',
  };
  const elements: unknown[] = p.lines.map((l) => ({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${l.label}**　${l.value}` },
  }));
  if (p.text) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: p.text } });
  }
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: colorMap[p.theme] || 'grey',
        title: { tag: 'plain_text', content: p.title },
      },
      elements,
    },
  };
}

function buildGeneric(p: NotifyPayload): Record<string, unknown> {
  return {
    title: p.title,
    text: p.text || p.title,
    theme: p.theme,
    fields: Object.fromEntries(p.lines.map((l) => [l.label, l.value])),
  };
}