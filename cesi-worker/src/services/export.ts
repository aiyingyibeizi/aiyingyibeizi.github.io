/**
 * CSV 导出工具：生成带 BOM 的 UTF-8 CSV，供后续下载/保存。
 *
 * 设计要点：
 *  - 字段级转义：含逗号/引号/换行的字段加引号并对引号翻倍（RFC 4180 兼容）。
 *  - 统一 CRLF 行结束符，Excel/WPS 打开不乱码、不错行。
 *  - 前置 \ufeff BOM，避免中文标题在 Excel 直接打开时乱码。
 *  - 返回标准 Response（Content-Disposition attachment），可直接作为接口响应。
 */

/** RFC 4180 字段转义 */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  // 含逗号、双引号、换行才需要加引号包裹（避免把字段截断成多列/多行）
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 把表头与二维数组拼成 CSV 文本（含 BOM + 尾行换行） */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const line = (r: Array<unknown>) => r.map(csvCell).join(',');
  return '\ufeff' + line(headers) + '\r\n' + rows.map(line).join('\r\n') + '\r\n';
}

/** 包一层下载响应头；filename 会做 URL 编码，防止中文/特殊字符导致 Content-Disposition 被截断 */
export function csvDownload(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/** 生成带时间戳的文件名（如 users-2026-09-18.csv） */
export function csvFilename(prefix: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
}