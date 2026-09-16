import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ShardService } from './shard';
import type { DbConfig, MixedData } from '../types/models';

function makeDb(overrides: Partial<DbConfig> & { name: string }): DbConfig {
  return {
    name: overrides.name,
    maxBytes: 100,
    type: 'turso',
    insert: overrides.insert || (async () => {}),
    selectByUser: overrides.selectByUser || (async () => []),
    selectByType: overrides.selectByType || (async () => []),
    selectById: overrides.selectById || (async () => undefined),
    deleteById: overrides.deleteById || (async () => {}),
    countByType: overrides.countByType || (async () => 0),
    getMetaUsedBytes: overrides.getMetaUsedBytes || (async () => 0),
    updateMetaUsedBytes: overrides.updateMetaUsedBytes || (async () => {}),
    selectLeaderboard: overrides.selectLeaderboard,
    deleteOldByType: overrides.deleteOldByType,
    selectAccountByUsername: overrides.selectAccountByUsername,
    selectAccountBySessionToken: overrides.selectAccountBySessionToken,
    updateAccountPayload: overrides.updateAccountPayload,
  };
}

function makeDbWithUpdate(name: string, updates: Array<{ id: string; payload: string; updatedAt: string }>): DbConfig {
  return makeDb({
    name,
    updateAccountPayload: async (id, payload, updatedAt) => {
      updates.push({ id, payload, updatedAt });
    },
  });
}

const fakeRedis = {} as any;

const mockAccount = (payload: Record<string, unknown>): MixedData => ({
  id: 'id-' + Math.random().toString(36).slice(2),
  user_id: 'u-' + Math.random().toString(36).slice(2),
  type: 'account',
  subtype: null,
  score_value: null,
  payload: JSON.stringify(payload),
  file_url: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
});

describe('ShardService.selectAccountByUsername', () => {
  it('returns account from the first db', async () => {
    const account = mockAccount({ username: 'alice' });
    const shard = new ShardService(fakeRedis, [
      makeDb({ name: 'DB1', selectAccountByUsername: async () => account }),
    ]);
    const result = await shard.selectAccountByUsername('alice');
    assert.strictEqual(result, account);
  });

  it('falls back to the second db when the first fails', async () => {
    const account = mockAccount({ username: 'bob' });
    const shard = new ShardService(fakeRedis, [
      makeDb({
        name: 'DB1',
        selectAccountByUsername: async () => {
          throw new Error('db1 down');
        },
      }),
      makeDb({ name: 'DB2', selectAccountByUsername: async () => account }),
    ]);
    const result = await shard.selectAccountByUsername('bob');
    assert.strictEqual(result, account);
  });

  it('returns undefined when no db has the account', async () => {
    const shard = new ShardService(fakeRedis, [
      makeDb({ name: 'DB1', selectAccountByUsername: async () => undefined }),
    ]);
    const result = await shard.selectAccountByUsername('charlie');
    assert.strictEqual(result, undefined);
  });

  it('skips dbs that do not implement selectAccountByUsername', async () => {
    const account = mockAccount({ username: 'dave' });
    const shard = new ShardService(fakeRedis, [
      makeDb({ name: 'DB1' }),
      makeDb({ name: 'DB2', selectAccountByUsername: async () => account }),
    ]);
    const result = await shard.selectAccountByUsername('dave');
    assert.strictEqual(result, account);
  });
});

describe('ShardService.selectAccountBySessionToken', () => {
  it('returns account matching the token', async () => {
    const account = mockAccount({ session_token: 'tok-abc', session_expires_at: '2099-01-01T00:00:00Z' });
    const shard = new ShardService(fakeRedis, [
      makeDb({ name: 'DB1', selectAccountBySessionToken: async () => account }),
    ]);
    const result = await shard.selectAccountBySessionToken('tok-abc');
    assert.strictEqual(result, account);
  });

  it('falls back when the first db fails', async () => {
    const account = mockAccount({ session_token: 'tok-def', session_expires_at: '2099-01-01T00:00:00Z' });
    const shard = new ShardService(fakeRedis, [
      makeDb({
        name: 'DB1',
        selectAccountBySessionToken: async () => {
          throw new Error('timeout');
        },
      }),
      makeDb({ name: 'DB2', selectAccountBySessionToken: async () => account }),
    ]);
    const result = await shard.selectAccountBySessionToken('tok-def');
    assert.strictEqual(result, account);
  });
});

describe('ShardService.updateAccountPayload', () => {
  it('updates all dbs that support the operation', async () => {
    const updates1: Array<{ id: string; payload: string; updatedAt: string }> = [];
    const updates2: Array<{ id: string; payload: string; updatedAt: string }> = [];
    const shard = new ShardService(fakeRedis, [
      makeDbWithUpdate('DB1', updates1),
      makeDbWithUpdate('DB2', updates2),
    ]);
    const result = await shard.updateAccountPayload('acc-1', '{"x":1}', '2024-01-02T00:00:00Z');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(updates1.length, 1);
    assert.strictEqual(updates2.length, 1);
    assert.deepStrictEqual(updates1[0], { id: 'acc-1', payload: '{"x":1}', updatedAt: '2024-01-02T00:00:00Z' });
  });

  it('succeeds if at least one db updates', async () => {
    const updates: Array<{ id: string; payload: string; updatedAt: string }> = [];
    const shard = new ShardService(fakeRedis, [
      makeDb({
        name: 'DB1',
        updateAccountPayload: async () => {
          throw new Error('db1 down');
        },
      }),
      makeDbWithUpdate('DB2', updates),
    ]);
    const result = await shard.updateAccountPayload('acc-2', '{"x":2}', '2024-01-02T00:00:00Z');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(updates.length, 1);
  });

  it('fails when all dbs fail or do not support the operation', async () => {
    const shard = new ShardService(fakeRedis, [
      makeDb({
        name: 'DB1',
        updateAccountPayload: async () => {
          throw new Error('db1 down');
        },
      }),
      makeDb({ name: 'DB2' }),
    ]);
    const result = await shard.updateAccountPayload('acc-3', '{"x":3}', '2024-01-02T00:00:00Z');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });
});
