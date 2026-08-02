import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MixedData, Meta } from './types/models';

// In-memory stores shared by mocked DB backends.
let mixedData: MixedData[] = [];
let meta: Meta[] = [];
let redisStore: Map<string, number> = new Map();

function resetStores() {
  mixedData = [];
  meta = [];
  redisStore = new Map();
}

function setUsedBytes(dbName: string, used: number) {
  const idx = meta.findIndex((m) => m.db_name === dbName);
  const now = new Date().toISOString();
  if (idx >= 0) {
    meta[idx] = { ...meta[idx], used_bytes: used, updated_at: now };
  } else {
    meta.push({ db_name: dbName, used_bytes: used, max_bytes: 450 * 1024 * 1024, updated_at: now });
  }
}

function fillAllDbs() {
  for (const name of ['APEXON', 'APEXON_1', 'APEXON_2', 'NEON', 'SUPABASE']) {
    setUsedBytes(name, 450 * 1024 * 1024);
  }
}

vi.mock('./db/redis', () => ({
  createRedis: () => ({
    get: async (key: string) => redisStore.get(key) ?? null,
    set: async (key: string, value: number) => { redisStore.set(key, value); },
    incrby: async (key: string, delta: number) => {
      const next = (redisStore.get(key) ?? 0) + delta;
      redisStore.set(key, next);
      return next;
    },
  }),
}));

function matchMixedData(type: string, options: { userId?: string; subtype?: string; limit?: number; orderByScore?: 'asc' | 'desc' }) {
  let rows = mixedData.filter((r) => r.type === type);
  if (options.userId) rows = rows.filter((r) => r.user_id === options.userId);
  if (options.subtype) rows = rows.filter((r) => r.subtype === options.subtype);

  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  if (options.orderByScore === 'asc') {
    rows.sort((a, b) => (a.score_value ?? Infinity) - (b.score_value ?? Infinity));
  } else if (options.orderByScore === 'desc') {
    rows.sort((a, b) => (b.score_value ?? -Infinity) - (a.score_value ?? -Infinity));
  }

  const limit = options.limit && options.limit > 0 ? options.limit : rows.length;
  return rows.slice(0, limit);
}

function createDbMocks(dbName: string) {
  return {
    insert: vi.fn(async (_client: unknown, data: MixedData) => {
      // Simulate write failure when used bytes would exceed capacity.
      const used = meta.find((m) => m.db_name === dbName)?.used_bytes ?? 0;
      const estimated = 1024;
      if (used + estimated > 450 * 1024 * 1024) {
        throw new Error('Database is full');
      }
      mixedData.push(data);
      setUsedBytes(dbName, used + estimated);
    }),
    selectByUser: vi.fn(async (_client: unknown, userId: string, limit: number) => {
      return matchMixedData('', { userId, limit }).filter(() => true); // placeholder
    }),
    selectByType: vi.fn(async (_client: unknown, type: string, options: { userId?: string; subtype?: string; limit?: number; orderByScore?: 'asc' | 'desc' }) => {
      return matchMixedData(type, options);
    }),
    selectById: vi.fn(async (_client: unknown, id: string) => {
      return mixedData.find((r) => r.id === id);
    }),
    deleteById: vi.fn(async (_client: unknown, id: string) => {
      mixedData = mixedData.filter((r) => r.id !== id);
    }),
    countByType: vi.fn(async (_client: unknown, type: string) => {
      return mixedData.filter((r) => r.type === type).length;
    }),
    getMetaUsedBytes: vi.fn(async (_client: unknown, dbNameArg: string) => {
      return meta.find((m) => m.db_name === dbNameArg)?.used_bytes ?? 0;
    }),
    updateMetaUsedBytes: vi.fn(async (_client: unknown, dbNameArg: string, _maxBytes: number, usedBytes: number) => {
      setUsedBytes(dbNameArg, usedBytes);
    }),
  };
}

const tursoMocks = createDbMocks('APEXON');
const neonMocks = createDbMocks('NEON');
const supabasePgMocks = createDbMocks('SUPABASE');

vi.mock('./db/turso', () => ({
  createTursoClient: vi.fn(() => ({ name: 'turso' })),
  tursoInsert: (client: unknown, data: MixedData) => tursoMocks.insert(client, data),
  tursoSelectByUser: (client: unknown, userId: string, limit: number) => tursoMocks.selectByUser(client, userId, limit),
  tursoSelectByType: (client: unknown, type: string, options: { userId?: string; subtype?: string; limit?: number; orderByScore?: 'asc' | 'desc' }) => tursoMocks.selectByType(client, type, options),
  tursoSelectById: (client: unknown, id: string) => tursoMocks.selectById(client, id),
  tursoDeleteById: (client: unknown, id: string) => tursoMocks.deleteById(client, id),
  tursoCountByType: (client: unknown, type: string) => tursoMocks.countByType(client, type),
  tursoGetMetaUsedBytes: (client: unknown, dbNameArg: string) => tursoMocks.getMetaUsedBytes(client, dbNameArg),
  tursoUpdateMetaUsedBytes: (client: unknown, dbNameArg: string, maxBytes: number, usedBytes: number) => tursoMocks.updateMetaUsedBytes(client, dbNameArg, maxBytes, usedBytes),
}));

vi.mock('./db/neon', () => ({
  createNeonPool: vi.fn(() => ({ name: 'neon' })),
  neonInsert: (pool: unknown, data: MixedData) => neonMocks.insert(pool, data),
  neonSelectByUser: (pool: unknown, userId: string, limit: number) => neonMocks.selectByUser(pool, userId, limit),
  neonSelectByType: (pool: unknown, type: string, options: { userId?: string; subtype?: string; limit?: number; orderByScore?: 'asc' | 'desc' }) => neonMocks.selectByType(pool, type, options),
  neonSelectById: (pool: unknown, id: string) => neonMocks.selectById(pool, id),
  neonDeleteById: (pool: unknown, id: string) => neonMocks.deleteById(pool, id),
  neonCountByType: (pool: unknown, type: string) => neonMocks.countByType(pool, type),
  neonGetMetaUsedBytes: (pool: unknown, dbNameArg: string) => neonMocks.getMetaUsedBytes(pool, dbNameArg),
  neonUpdateMetaUsedBytes: (pool: unknown, dbNameArg: string, maxBytes: number, usedBytes: number) => neonMocks.updateMetaUsedBytes(pool, dbNameArg, maxBytes, usedBytes),
}));

vi.mock('./db/supabase-pg', () => ({
  createSupabasePgPool: vi.fn(() => ({ name: 'supabase-pg' })),
  supabasePgInsert: (pool: unknown, data: MixedData) => supabasePgMocks.insert(pool, data),
  supabasePgSelectByUser: (pool: unknown, userId: string, limit: number) => supabasePgMocks.selectByUser(pool, userId, limit),
  supabasePgSelectByType: (pool: unknown, type: string, options: { userId?: string; subtype?: string; limit?: number; orderByScore?: 'asc' | 'desc' }) => supabasePgMocks.selectByType(pool, type, options),
  supabasePgSelectById: (pool: unknown, id: string) => supabasePgMocks.selectById(pool, id),
  supabasePgDeleteById: (pool: unknown, id: string) => supabasePgMocks.deleteById(pool, id),
  supabasePgCountByType: (pool: unknown, type: string) => supabasePgMocks.countByType(pool, type),
  supabasePgGetMetaUsedBytes: (pool: unknown, dbNameArg: string) => supabasePgMocks.getMetaUsedBytes(pool, dbNameArg),
  supabasePgUpdateMetaUsedBytes: (pool: unknown, dbNameArg: string, maxBytes: number, usedBytes: number) => supabasePgMocks.updateMetaUsedBytes(pool, dbNameArg, maxBytes, usedBytes),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('mock') })),
    },
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => ({ data: { path: 'test' }, error: null })),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'http://example.com/test' } })),
      })),
    },
  })),
}));

// Import the app after mocks are defined.
const { default: app } = await import('./index');

const env = {
  NEON_DSN: 'mock',
  TURSO_URL_APEXON: 'mock',
  TURSO_TOKEN_APEXON: 'mock',
  TURSO_URL_APEXON_1: 'mock',
  TURSO_TOKEN_APEXON_1: 'mock',
  TURSO_URL_APEXON_2: 'mock',
  TURSO_TOKEN_APEXON_2: 'mock',
  SUPABASE_URL: 'mock',
  SUPABASE_SERVICE_ROLE_KEY: 'mock',
  SUPABASE_DSN: 'mock',
  UPSTASH_REDIS_URL: 'mock',
  UPSTASH_REDIS_TOKEN: 'mock',
};

function createAccount(userId: string, username: string, passwordHash: string, token: string, expiresAt: string) {
  mixedData.push({
    id: crypto.randomUUID(),
    user_id: userId,
    type: 'account',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({ username, password_hash: passwordHash, session_token: token, session_expires_at: expiresAt }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function createScore(userId: string, scoreId: string, testType: string, value: number) {
  mixedData.push({
    id: scoreId,
    user_id: userId,
    type: 'score',
    subtype: testType,
    score_value: value,
    payload: JSON.stringify({ username: userId, test_type: testType, score_value: value }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function createProfile(userId: string, bio: string) {
  mixedData.push({
    id: crypto.randomUUID(),
    user_id: userId,
    type: 'profile',
    subtype: null,
    score_value: null,
    payload: JSON.stringify({ bio }),
    file_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

describe('DELETE /api/scores', () => {
  beforeEach(resetStores);

  it('allows owners to delete their own scores', async () => {
    const userId = 'user-1';
    const token = 'token-1';
    const scoreId = 'score-1';
    const future = new Date(Date.now() + 60_000).toISOString();
    createAccount(userId, 'alice', 'pbkdf2:sha256:100000:abc:def', token, future);
    createScore(userId, scoreId, 'reaction', 100);

    const res = await app.request('/api/scores?id=' + scoreId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    }, env);

    expect(res.status).toBe(200);
    expect(mixedData.some((r) => r.id === scoreId)).toBe(false);
  });

  it('forbids deleting another user\'s score', async () => {
    const ownerId = 'user-owner';
    const attackerId = 'user-attacker';
    const ownerToken = 'token-owner';
    const attackerToken = 'token-attacker';
    const scoreId = 'score-target';
    const future = new Date(Date.now() + 60_000).toISOString();
    createAccount(ownerId, 'owner', 'pbkdf2:sha256:100000:abc:def', ownerToken, future);
    createAccount(attackerId, 'attacker', 'pbkdf2:sha256:100000:abc:def', attackerToken, future);
    createScore(ownerId, scoreId, 'reaction', 100);

    const res = await app.request('/api/scores?id=' + scoreId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + attackerToken },
    }, env);

    expect(res.status).toBe(403);
    expect(mixedData.some((r) => r.id === scoreId)).toBe(true);
  });
});

describe('POST /api/profiles', () => {
  beforeEach(resetStores);

  it('preserves the existing profile when the new write fails', async () => {
    const userId = 'user-1';
    const token = 'token-1';
    const future = new Date(Date.now() + 60_000).toISOString();
    createAccount(userId, 'alice', 'pbkdf2:sha256:100000:abc:def', token, future);
    createProfile(userId, 'original bio');

    // Fill all DBs so the write fails.
    fillAllDbs();

    const res = await app.request('/api/profiles', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio: 'new bio' }),
    }, env);

    expect(res.status).toBe(503);
    const profiles = mixedData.filter((r) => r.type === 'profile' && r.user_id === userId);
    expect(profiles.length).toBe(1);
    expect(JSON.parse(profiles[0].payload).bio).toBe('original bio');
  });
});

describe('POST /api/auth/register', () => {
  beforeEach(resetStores);

  it('returns 503 when the account cannot be persisted', async () => {
    fillAllDbs();

    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'newuser', password: 'password123' }),
    }, env);

    expect(res.status).toBe(503);
    expect(mixedData.some((r) => r.type === 'account' && r.user_id === 'newuser')).toBe(false);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(resetStores);

  it('returns 503 and keeps the old session when the update write fails', async () => {
    const userId = 'user-1';
    const username = 'alice';
    const oldToken = 'old-token';
    const future = new Date(Date.now() + 60_000).toISOString();
    createAccount(userId, username, 'plaintext-password', oldToken, future);

    // Fill all DBs so the write fails.
    fillAllDbs();

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'plaintext-password' }),
    }, env);

    expect(res.status).toBe(503);
    const accounts = mixedData.filter((r) => r.type === 'account' && r.user_id === userId);
    expect(accounts.length).toBe(1);
    const payload = JSON.parse(accounts[0].payload);
    expect(payload.session_token).toBe(oldToken);
  });
});
