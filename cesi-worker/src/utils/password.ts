/**
 * 密码哈希
 *
 * 只在后端（Cloudflare Workers）跑哈希，前端仅通过 HTTPS 传明文，
 * 绝不把算法、盐值、迭代次数暴露给浏览器。
 *
 * 存库格式（一段字符串，自描述，兼容 read/upgrade）：
 *   pbkdf2:<sha256|sha512>:<迭代次数>:<十六进制盐>:<十六进制哈希>
 *
 * 算法选择：Workers 的 Web Crypto 只提供 PBKDF2（没有 Argon2/bcrypt），
 * 因此在当前栈下能落地的"最强"组合是 PBKDF2-HMAC-SHA512（比 SHA-256 慢、
 * 更抗 GPU 并行），加每用户独立 32 字节 CSPRNG 盐 + 常数时间比较。
 * 迭代次数方面：OWASP 2023 对 PBKDF2-SHA512 建议 ≥ 600k，这里取 600k。
 * 历史遗留：早期可能用 sha256（31 万次）甚至明文。存量数据无法在线强升级，
 * 只能在用户下次登录时做一次性迁移——验明密码没错后立刻用新参数重哈希落库。
 */

const SALT_BYTES = 32; // 256-bit 盐
// Cloudflare Workers 的 WebCrypto 实现将 PBKDF2 迭代次数上限限制为 100000，
// 超过会抛 NotSupportedError（此前设 600k 导致注册/登录直接 500）。
// 此处取平台允许的最大值 100000，兼顾安全与可用性。
const DEFAULT_ITERATIONS = 100000; // PBKDF2-HMAC-SHA512（Cloudflare WebCrypto 上限 100000）
const DEFAULT_HASH = 'SHA-512'; // 抗 GPU 并行强于 SHA-256

/**
 * 跑一轮 PBKDF2。密码是原始字符串，盐是字节数组，迭代次数与摘要算法显式传入，
 * 这样校验老记录能按存储值算、其摘要也能跟着对应；新建记录则用当前更高参数。
 */
async function derive(
  password: string,
  salt: Uint8Array,
  iters: number,
  hash: 'SHA-256' | 'SHA-512' = DEFAULT_HASH
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: iters,
      hash,
    },
    key,
    256 // 输出 32 字节
  );
}

/** 普通字节 → 小写十六进制字符串 */
function toHex(bytes: ArrayBuffer | ArrayBufferView): string {
  const arr = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array((bytes as ArrayBufferView).buffer, (bytes as ArrayBufferView).byteOffset, (bytes as ArrayBufferView).byteLength);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 十六进制字符串 → 字节。长度不成对时丢弃最后一位。 */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 字符串比较，耗时与内容无关（防时序旁路）。
 * Workers 上没有 Node 的 timingSafeEqual，这里自己写一版。
 * 不管长度是否一致都走满循环，避免提前返回去泄露长度信息。
 */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** 新密码 → 可存库的自描述哈希串（默认最强参数：sha512 + 600k）。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(password, salt, DEFAULT_ITERATIONS, DEFAULT_HASH);
  const tag = DEFAULT_HASH.replace('SHA-', 'sha').toLowerCase();
  return `pbkdf2:${tag}:${DEFAULT_ITERATIONS}:${toHex(salt)}:${toHex(key)}`;
}

/** 校验密码。兼容旧明文（一次性，见文件头注释）与旧版 sha256 记录。 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || typeof storedHash !== 'string') return false;

  // 不是 pbkdf2: 开头，按老逻辑当成明文比。只在登录迁移时命中。
  if (!storedHash.startsWith('pbkdf2:')) {
    return safeEqual(storedHash, password);
  }

  const parts = storedHash.split(':');
  // 结构不对直接判失败，绝不抛错。摘要名只认 sha256/sha512，防脏数据。
  if (parts.length !== 5) return false;
  const hashLabel = parts[1];
  const hashName = hashLabel === 'sha256' ? 'SHA-256' : hashLabel === 'sha512' ? 'SHA-512' : null;
  if (!hashName) return false;

  const iters = parseInt(parts[2], 10);
  const salt = fromHex(parts[3]);
  const expected = parts[4];

  // 防御：脏数据如果把迭代次数写成天文数字，这里会卡到超时。拦一道。
  // 同时 Cloudflare WebCrypto 上限 100000，超过会抛 NotSupportedError，必须失败关闭而非抛错。
  if (!iters || iters < 1 || iters > 100000 || !salt.length || !expected) return false;

  const derived = await derive(password, salt, iters, hashName);
  return safeEqual(toHex(derived), expected);
}

/** 是否仍是旧明文（历史上没哈希过的存量数据） */
export function isLegacyPassword(storedHash: string): boolean {
  return !storedHash || typeof storedHash !== 'string' || !storedHash.startsWith('pbkdf2:');
}

/** 是否需要升级（旧 sha256 / 旧迭代次数 / 旧明文）。登录成功且命中时重哈希落库。 */
export function needsRehash(storedHash: string): boolean {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.startsWith('pbkdf2:')) return true;
  const parts = storedHash.split(':');
  if (parts.length !== 5) return true;
  const iters = parseInt(parts[2], 10);
  return parts[1] !== DEFAULT_HASH.replace('SHA-', 'sha').toLowerCase() || iters < DEFAULT_ITERATIONS;
}