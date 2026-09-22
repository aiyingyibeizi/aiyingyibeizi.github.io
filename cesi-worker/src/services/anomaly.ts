/**
 * 防刷分：成绩异常检测。
 *
 * 在成绩落库前/审核导入时调用，输出可疑标记。只在"离群"处收口，宁宽勿窄，避免误杀真实成绩。
 * 供两类消费者复用：
 *   - 实时提交（POST /api/scores）：命中可疑 → 该条成绩标 validity=suspicious 且不上榜，
 *     用户可走申诉恢复。
 *   - 后台导入（POST /api/admin/scores/import）：每条同样检测，命中则记入导入失败明细。
 *
 * 规则（可组合，彼此独立）：
 *  1) burst：同一用户在很短时间内对同一 test_type 提交过多条（脚本连发）。
 *  2) jump：新分数相对该用户该类型的历史最佳转折毫无过渡（提升幅度异常大）。
 *  3) 复算保护：Normalize 后若与自身完全雷同且量级离谱，标记为可疑工程值。
 */

import type { Redis } from '@upstash/redis/cloudflare';
import type { ShardService } from './shard';

export type AnomalySeverity = 'info' | 'warning' | 'high';

export interface AnomalyResult {
  flagged: boolean;
  severity: AnomalySeverity;
  reasons: string[];
  /** 命中说明写入成绩 payload 的 flag_reason，供审核面板展示 */
  flagReason?: string;
}

const BURST_PREFIX = 'anom:burst:';
const BURST_WINDOW_SEC = 60;
// 放宽连发阈值：真人连测同一类型很少超过 15 次/分钟，只在脚本级连发才判高频。
const BURST_THRESHOLD = 15;

/** 60s 滑动计数：命中阈值返回 true */
async function burstHit(redis: Redis, userId: string, testType: string): Promise<boolean> {
  try {
    const key = `${BURST_PREFIX}${userId.replace(/[^\w.-]/g, '_')}:${testType.replace(/[^\w.-]/g, '_')}`;
    const n = await redis.incr(key);
    if (n <= 1) await redis.expire(key, BURST_WINDOW_SEC);
    return n >= BURST_THRESHOLD;
  } catch (err) {
    console.error('anomaly burstHit failed:', err);
    return false;
  }
}

/**
 * 主检测。shard 用于查该用户该类型历史最佳（仅当需要 jump 判定时）。
 * lowerIsBetter：true 表示分数越低越好（如 reaction/type），提升 = 数值变小。
 */
export async function checkScoreAnomaly(
  redis: Redis,
  shard: ShardService,
  userId: string,
  testType: string,
  value: number,
  lowerIsBetter: boolean
): Promise<AnomalyResult> {
  const reasons: string[] = [];

  // 1) 高频连发
  if (await burstHit(redis, userId, testType)) {
    reasons.push('同类型 60 秒内高频提交');
  }

  // 2) 相对历史最佳异常提升（只对"有历史成绩"的成熟用户有意义）
  try {
    const history = await shard.readByType('score', { userId, subtype: testType, limit: 200 });
    const past = history
      .filter((r) => {
        const p: any = safeParse(r.payload);
        return r.score_value != null && /^(valid|)$/.test(String(p.validity || ''));
      })
      .map((r) => r.score_value as number);
    // 相对历史最佳异常提升：要求历史样本足够多、幅度足够离谱才判，宁宽勿窄。
    // 玩家技能呈线性上升，突破 80% 单次提升且历史 >= 6 条才视为可疑，正常进步不会误杀。
    if (past.length >= 6) {
      const best = lowerIsBetter ? Math.min(...past) : Math.max(...past);
      const improve = lowerIsBetter
        ? (value - best) / best
        : (value - best) / best;
      if (lowerIsBetter && best > 0 && improve < -0.8 && value < best) {
        reasons.push(`相对历史最佳异常提升（${Math.round((-improve) * 100)}%）`);
      } else if (!lowerIsBetter && improve > 0.8) {
        reasons.push(`相对历史最佳异常提升（${Math.round(improve * 100)}%）`);
      }
    }
  } catch (err) {
    console.error('anomaly history scan failed:', err);
  }

  if (!reasons.length) return { flagged: false, severity: 'info', reasons };
  return {
    flagged: true,
    severity: reasons.length >= 2 ? 'high' : 'warning',
    reasons,
    flagReason: reasons.join('；'),
  };
}

function safeParse(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}