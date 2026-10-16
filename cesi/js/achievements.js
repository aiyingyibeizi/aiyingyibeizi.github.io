(function (global) {
  'use strict';

  // 10 个基础成就定义
  const ACHIEVEMENTS = [
    { id: 'first_test',     icon: '🎯', title: '初心者',     desc: '完成第一次测试',          check: (s) => s.totalTests >= 1 },
    { id: 'ten_tests',      icon: '🔟', title: '勤奋练习',   desc: '累计完成 10 次测试',      check: (s) => s.totalTests >= 10 },
    { id: 'fifty_tests',    icon: '💎', title: '坚持不懈',   desc: '累计完成 50 次测试',      check: (s) => s.totalTests >= 50 },
    { id: 'reaction_master',icon: '⚡', title: '闪电反应',   desc: '反应测试低于 250ms',      check: (s) => s.bestReaction !== null && s.bestReaction < 250 },
    { id: 'memory_expert',  icon: '🧠', title: '记忆大师',   desc: '数字记忆达到 8 位',        check: (s) => s.bestNumber !== null && s.bestNumber >= 8 },
    { id: 'aim_sharp',      icon: '🔫', title: '神枪手',     desc: '瞄准训练低于 600ms',      check: (s) => s.bestAim !== null && s.bestAim < 600 },
    { id: 'all_rounder',    icon: '🌟', title: '全能选手',   desc: '完成全部 10 种测试',      check: (s) => s.uniqueTypes >= 10 },
    { id: 'daily_streak',   icon: '🔥', title: '连续打卡',   desc: '连续 3 天测试',           check: (s) => s.streakDays >= 3 },
    { id: 'early_bird',     icon: '🌅', title: '早起鸟',     desc: '在 6:00-8:00 完成测试',   check: (s) => s.morningTests >= 1 },
    { id: 'night_owl',      icon: '🌙', title: '夜猫子',     desc: '在 0:00-4:00 完成测试',   check: (s) => s.nightTests >= 1 },
  ];

  const STORAGE_KEY = 'apex_achievements';
  const STATS_KEY = 'apex_achievement_stats';

  const Achievements = {
    // 获取用户成就统计（从 localStorage 读取并补充）
    getStats() {
      try {
        const raw = localStorage.getItem(STATS_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return {
        totalTests: 0,
        uniqueTypes: 0,
        bestReaction: null,
        bestNumber: null,
        bestAim: null,
        streakDays: 0,
        morningTests: 0,
        nightTests: 0,
        completedTypes: {},
        lastTestDate: null,
        testDates: []
      };
    },

    // 记录一次测试完成
    recordTest(testType, score) {
      const stats = this.getStats();
      stats.totalTests++;
      stats.completedTypes[testType] = (stats.completedTypes[testType] || 0) + 1;
      stats.uniqueTypes = Object.keys(stats.completedTypes).length;

      // 更新最佳成绩（按测试类型分别记录，避免串分：没玩过瞄准不会因反应成绩解锁神枪手成就）
      if (testType === 'reaction') {
        if (stats.bestReaction === null || score < stats.bestReaction) stats.bestReaction = score;
      } else if (testType === 'aim') {
        if (stats.bestAim === null || score < stats.bestAim) stats.bestAim = score;
      } else if (testType === 'number') {
        if (stats.bestNumber === null || score > stats.bestNumber) stats.bestNumber = score;
      }

      // 时间段统计
      const hour = new Date().getHours();
      if (hour >= 6 && hour < 8) stats.morningTests++;
      if (hour >= 0 && hour < 4) stats.nightTests++;

      // 连续打卡天数
      const today = new Date().toDateString();
      if (stats.lastTestDate !== today) {
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        if (stats.lastTestDate === yesterday) stats.streakDays++;
        else stats.streakDays = 1;
        stats.lastTestDate = today;
        stats.testDates.push(today);
        if (stats.testDates.length > 30) stats.testDates = stats.testDates.slice(-30);
      }

      localStorage.setItem(STATS_KEY, JSON.stringify(stats));

      // 检查新成就
      this.checkAndNotify(stats);
    },

    // 检查成就解锁并通知
    checkAndNotify(stats) {
      const unlocked = this.getUnlocked();
      const newlyUnlocked = [];
      for (const ach of ACHIEVEMENTS) {
        if (!unlocked.includes(ach.id) && ach.check(stats)) {
          newlyUnlocked.push(ach);
        }
      }
      if (newlyUnlocked.length > 0) {
        const all = [...unlocked, ...newlyUnlocked.map(a => a.id)];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        // 逐个展示解锁通知（带延迟）
        newlyUnlocked.forEach((ach, i) => {
          setTimeout(() => this.showUnlockToast(ach), i * 600 + 400);
        });
      }
    },

    // 获取已解锁成就 ID 列表
    getUnlocked() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return [];
    },

    // 获取全部成就（含解锁状态）
    getAll() {
      const unlocked = this.getUnlocked();
      return ACHIEVEMENTS.map(a => ({ ...a, unlocked: unlocked.includes(a.id) }));
    },

    // 成就解锁 Toast 通知
    showUnlockToast(ach) {
      if (global.APEXON && APEXON.UI && APEXON.UI.Toast && APEXON.UI.Toast.show) {
        APEXON.UI.Toast.show(ach.icon + ' 成就解锁：' + ach.title, 'success', 4000);
      }
    },

    // 渲染成就墙到指定容器
    renderWall(container) {
      if (!container) return;
      const all = this.getAll();
      const unlockedCount = all.filter(a => a.unlocked).length;
      container.innerHTML = `
        <div class="apex-ach-header">
          <div class="apex-ach-title">🏆 成就墙</div>
          <div class="apex-ach-count">${unlockedCount} / ${all.length}</div>
        </div>
        <div class="apex-ach-grid">
          ${all.map(a => `
            <div class="apex-ach-badge ${a.unlocked ? 'unlocked' : 'locked'}" title="${a.desc}">
              <div class="apex-ach-icon">${a.unlocked ? a.icon : '🔒'}</div>
              <div class="apex-ach-name">${a.title}</div>
              <div class="apex-ach-desc">${a.desc}</div>
            </div>
          `).join('')}
        </div>
      `;
    }
  };

  global.APEXON = global.APEXON || {};
  global.APEXON.Achievements = Achievements;
})(window);
