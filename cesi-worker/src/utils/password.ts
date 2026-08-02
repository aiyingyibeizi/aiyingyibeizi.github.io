/**
 * 密码哈希工具
 *
 * 所有密码哈希运算必须在后端（Cloudflare Workers）完成，前端只传输明文密码
 * （通过 HTTPS），绝不暴露哈希算法、盐值或迭代次数。
 *
 * 格式：pbkdf2:sha256:<iterations>:<hex-salt>:<hex-hash>
 * 支持旧版明文密码自动迁移：登录时若发现旧明文，验证通过后立即重哈希存储。
 */

const ALGORITHM = 'PBKDF2';
const HASH_ALG = 'SHA-256';
const ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;

async function deriveKey(password: string, salt: ArrayBufferView): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: ALGORITHM },
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    {
      name: ALGORITHM,
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: HASH_ALG,
    },
    keyMaterial,
    KEY_LENGTH_BITS
  );
}

function bytesToHex(buffer: ArrayBuffer | ArrayBufferView): string {
  const arr = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomSalt();
  const derived = await deriveKey(password, salt);
  return `pbkdf2:sha256:${ITERATIONS}:${bytesToHex(salt)}:${bytesToHex(derived)}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || typeof storedHash !== 'string') return false;

  // 旧版明文兼容：若存储的不是 pbkdf2 格式，按明文比较。
  if (!storedHash.startsWith('pbkdf2:')) {
    return storedHash === password;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 5 || parts[1] !== 'sha256') return false;

  const iterations = parseInt(parts[2], 10);
  const salt = hexToBytes(parts[3]);
  const hash = parts[4];

  if (!iterations || !salt.length || !hash) return false;

  const keyMaterial = await deriveKey(password, salt);
  return bytesToHex(keyMaterial) === hash;
}

export function isLegacyPassword(storedHash: string): boolean {
  return !storedHash || typeof storedHash !== 'string' || !storedHash.startsWith('pbkdf2:');
}
