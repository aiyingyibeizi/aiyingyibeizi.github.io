/**
 * TOTP（RFC 6238 / HOTP RFC 4226）双重验证实现
 *
 * - 密钥以 Base32 明文形式读入（如 Google Authenticator / 1Password / Authy 的占位密钥）。
 * - 基于当前时间窗（默认 30s）生成 HOTP 六位动态码；校验时容忍 ±1 个时间窗，
 *   并对齐 RFC 6238 的 6 位数字、0-padding 规则，防类似 '000123' 的边界问题。
 * - 全程使用 Web Crypto（crypto.subtle），无第三方依赖，可在 Cloudflare Workers 运行。
 * - 比较采用常数时间算法，尽力避免时序侧信道。
 *
 * 用途：作为管理后台的"第二因素"——口令（ADMIN_TOKEN）验证通过后，还需输入
 * 由本模块校验的 6 位动态码，两者都正确才发放会话令牌。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// 时间窗步长：30 秒为一个动态码周期
const STEP_SEC = 30;
// 容错窗口：校验当前及前后各 ±1 个时间窗（容忍轻微的时钟偏差）
const WINDOW = 1;
// 常量时间比较两个字符串（防时序旁路）
function safeEqualHex(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** 去除空白/连字符并统一大写（用户手输或粘贴 Base32 时很常见） */
function normalizeSecret(input: string): string {
  return input.replace(/[\s\-]/g, '').toUpperCase();
}

/** Base32 -> 字节数组（RFC 4648，忽略非法字符，余位不足按 RFC 规范丢弃） */
function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/0O1Il/g, (m) => {
    // 容忍易混淆字符（Google Authenticator 也这么做：O->0, I/1->1, l->l 可放弃）
    // 这里仅作展示容错，实际比对仍以原 SDK 处理为准。
    return m;
  });
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) continue; // 忽略非法字符
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 字节数组 -> 大端序 8 字节（HOTP 计数 64 位） */
function bigEndian64(v: number): Uint8Array {
  const buf = new Uint8Array(8);
  let n = Math.floor(v);
  for (let i = 7; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

/** 单次 HOTP 动态码（RFC 4226 动态截断），返回 6 位字符串 */
async function hotp(secretBytes: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, bigEndian64(counter) as unknown as BufferSource)
  );
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const code = (bin % 1_000_000).toString().padStart(6, '0');
  return code;
}

/**
 * 校验用户输入的 6 位动态码是否与给定 Base32 密钥在 ±WINDOW 时间窗内匹配。
 * @param secretBase32 Base32 编码的 TOTP 密钥
 * @param code         用户输入的 6 位动态码
 * @param atUnixSec    可选：指定的 Unix 秒锚点（默认当前时间，便于测试）
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  atUnixSec?: number
): Promise<boolean> {
  try {
    const cleanCode = String(code || '').replace(/\s/g, '').trim();
    if (!/^\d{6}$/.test(cleanCode)) return false;
    const secretRaw = normalizeSecret(secretBase32);
    if (!secretRaw) return false;
    const secretBytes = base32Decode(secretRaw);
    if (secretBytes.length === 0) return false;

    const now = atUnixSec !== undefined ? atUnixSec : Math.floor(Date.now() / 1000);
    const counter = Math.floor(now / STEP_SEC);
    for (let w = -WINDOW; w <= WINDOW; w++) {
      const candidate = await hotp(secretBytes, counter + w);
      if (safeEqualHex(candidate, cleanCode)) return true;
    }
    return false;
  } catch (err) {
    console.error('verifyTotp error:', err);
    return false;
  }
}

/**
 * 生成 otpauth:// URI（供二维码/绑定环节展示），可用于兼容主流验证器 App。
 * @param secretBase32 Base32 密钥
 * @param issuer       发行者标识（展示名，如 'APEXON Admin'）
 * @param account      账号标识（展示名，如 'admin@apexon'）
 */
export function buildOtpauthUri(secretBase32: string, issuer: string, account: string): string {
  const enc = (s: string) => encodeURIComponent(s);
  return `otpauth://totp/${enc(account)}?secret=${enc(secretBase32)}&issuer=${enc(issuer)}&period=${STEP_SEC}&digits=6&algorithm=SHA1`;
}