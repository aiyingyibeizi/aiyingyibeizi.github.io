/**
 * RFC 4180 风格 CSV 解析（含 BOM，兼容 Excel 导出的 UTF-8 with BOM 文件）。
 *
 * 与 export.ts 的序列化规则互为镜像，用于后台"成绩批量导入"等场景。
 * 规则：
 *  - 支持引号包裹字段（字段内含逗号/引号/换行时必须有引号），内部双引号翻倍还原。
 *  - 统一 CRLF/LF 都按行分隔；首行若带 \ufeff 则剥离。
 *  - 解析失败返回 null（调用方据此报"文件不是合法 CSV"），绝不抛异常。
 */

/**
 * 把一段文本解析成二维数组（第一行为表头，后续为数据行）。
 * 空行跳过；返回 null 表示存在无法闭合的引号，属于非法 CSV。
 */
export function parseCsv(text: string): string[][] | null {
  if (!text) return [];
  // 去掉 BOM
  let s = text.replace(/^\uFEFF/, '');
  // 统一换行符
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        // 双引号：要么是转义（另有一个引号），要么是闭合
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  // 收尾
  if (inQuotes) return null; // 引号未闭合 → 非法
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}