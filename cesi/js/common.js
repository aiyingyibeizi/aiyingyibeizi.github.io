/**
 * APEXON 核心模块 v4.1
 * 职责：安全、Clerk 认证、Supabase 数据、音频、主题、UserButton、测试引擎
 */

(function (global) {
  'use strict';
  const APEXON = global.APEXON = global.APEXON || {};

  // ===== 配置 =====
  const SUPABASE_URL = 'https://kpmsljgonualekjyrkzs.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_u7AUQG2_8iq24jR_mBU38Q_LrqEkt3u';

  // ===== 0. 安全层 =====
  const Security = {
    escapeHtml(text) {
      if (text == null) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/`/g, '&#x60;');
    },

    filterDangerous(input) {
      if (!input || typeof input !== 'string') return input;
      const dangerousPattern = /<(script|iframe|object|embed|applet|form|input|textarea|button|link|style|meta|base|svg|math|audio|video|source|track|canvas|map|area|frame|frameset|param|xml|xss)[\s>\/]/gi;
      const jsProtocol = /javascript:|data:|vbscript:|file:|about:|blob:/gi;
      const eventHandler = /on\w+\s*=/gi;
      const sqlInjection = /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|SCRIPT|ALTER|CREATE|TRUNCATE)\b|--|;|\/\*|\*\/)/gi;
      if (dangerousPattern.test(input) || jsProtocol.test(input) || eventHandler.test(input) || sqlInjection.test(input)) {
        return '[内容已过滤]';
      }
      return input.replace(/<[^>]*>/g, '');
    },

    validateRecord(type, data) {
      if (!data || typeof data !== 'object') return false;
      if (type === 'reaction') {
        const avg = parseFloat(data.avg);
        if (isNaN(avg) || avg < 0 || avg > 5000) return false;
        if (data.times && !Array.isArray(data.times)) return false;
        if (data.times) {
          for (const t of data.times) {
            if (t === null || t === undefined || t === 'skip') continue;
            const v = parseFloat(t);
            if (isNaN(v) || v < 0 || v > 5000) return false;
          }
        }
        return true;
      }
      if (type === 'type') {
        const avg = parseFloat(data.avg);
        if (isNaN(avg) || avg < 0 || avg > 600) return false;
        const acc = parseFloat(data.accuracy);
        if (isNaN(acc) || acc < 0 || acc > 100) return false;
        return true;
      }
      if (type === 'stick') {
        const score = parseInt(data.score, 10);
        if (isNaN(score) || score < 0 || score > 100000) return false;
        return true;
      }
      if (['number', 'sequence', 'visual', 'verbal'].includes(type)) {
        const score = parseInt(data.score, 10);
        if (isNaN(score) || score < 0 || score > 10000) return false;
        return true;
      }
      if (type === 'aim') {
        const avg = parseFloat(data.avg);
        if (isNaN(avg) || avg < 0 || avg > 100000) return false;
        return true;
      }
      return false;
    }
  };
  APEXON.Security = Security;

  // ===== 1. Supabase 数据库 =====
  const DB = {
    async request(table, method, body, query) {
      let url = `${SUPABASE_URL}/rest/v1/${table}`;
      if (query) url += '?' + query;
      const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation,resolution=merge-duplicates' : 'return=representation'
      };
      const options = { method, headers };
      if (body) options.body = JSON.stringify(body);
      try {
        const res = await fetch(url, options);
        if (!res.ok) {
          const errText = await res.text();
          throw new Error('DB error ' + res.status + ': ' + errText);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (e) {
        console.error('DB request failed:', e);
        return null;
      }
    },

    async syncUser(userId, username, email) {
      if (!userId) return false;
      const body = {
        user_id: userId,
        username: username || '',
        email: email || '',
        updated_at: new Date().toISOString()
      };
      const result = await this.request('users', 'POST', body, 'on_conflict=user_id');
      return !!result;
    },

    async saveScore(userId, username, testType, data) {
      if (!userId) {
        console.error('saveScore rejected: missing userId');
        return false;
      }
      if (!Security.validateRecord(testType, data)) return false;
      const scoreValue = parseFloat(data.avg || data.score || 0);
      const result = await this.request('scores', 'POST', {
        user_id: userId,
        username: username || '',
        test_type: testType,
        score_value: scoreValue,
        accuracy: data.accuracy != null ? data.accuracy : (data.fouls != null ? data.fouls : null),
        wpm: data.wpm || null,
        cpm: data.cpm || null,
        created_at: new Date().toISOString()
      });
      return !!result;
    },

    async getLeaderboard(testType, limit = 10) {
      const order = testType === 'stick' ? 'score_value.desc' : 'score_value.asc';
      const url = `${SUPABASE_URL}/rest/v1/scores?test_type=eq.${encodeURIComponent(testType)}&order=${order}&limit=${limit}`;
      try {
        const res = await fetch(url, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!res.ok) return [];
        return await res.json();
      } catch (e) {
        return [];
      }
    },

    async getHistoryByUserAndType(userId, type, limit = 20) {
      if (!userId || !type) return [];
      const url = `${SUPABASE_URL}/rest/v1/scores?user_id=eq.${encodeURIComponent(userId)}&test_type=eq.${encodeURIComponent(type)}&order=created_at.desc&limit=${limit}`;
      try {
        const res = await fetch(url, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!res.ok) return [];
        const rows = await res.json();
        return rows.map(r => ({
          id: r.id,
          user_id: r.user_id,
          username: r.username,
          test_type: r.test_type,
          score: r.score_value,
          avg: r.score_value,
          accuracy: r.accuracy,
          wpm: r.wpm,
          cpm: r.cpm,
          timestamp: r.created_at,
          date: new Date(r.created_at).toLocaleDateString('zh-CN')
        }));
      } catch (e) {
        return [];
      }
    },

    async addComment(userId, username, content) {
      const filtered = Security.filterDangerous(content.trim());
      if (!filtered || filtered.length > 500) return false;
      const result = await this.request('comments', 'POST', {
        user_id: userId,
        username: username,
        content: filtered
      });
      return !!result;
    },

    async getComments(limit = 50) {
      const url = `${SUPABASE_URL}/rest/v1/comments?order=created_at.desc&limit=${limit}`;
      try {
        const res = await fetch(url, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!res.ok) return [];
        return await res.json();
      } catch (e) {
        return [];
      }
    },

    async addFeedback(name, email, content) {
      const n = Security.filterDangerous(name.trim());
      const e = Security.filterDangerous(email.trim());
      const c = Security.filterDangerous(content.trim());
      if (!n || !e || !c) return false;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
      const result = await this.request('feedback', 'POST', {
        name: n,
        email: e,
        content: c
      });
      return !!result;
    },

    async getProfile(userId) {
      const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&limit=1`;
      try {
        const res = await fetch(url, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data[0] || null;
      } catch (e) {
        return null;
      }
    },

    async saveProfile(userId, username, payload) {
      const bio = typeof payload === 'string' ? payload : (payload && payload.bio) || '';
      const filteredBio = Security.filterDangerous(bio.trim()).slice(0, 200);
      const location = Security.filterDangerous((payload && payload.location) || '').slice(0, 80);
      const website = Security.filterDangerous((payload && payload.website) || '').slice(0, 200);
      const social = Security.filterDangerous((payload && payload.social) || '').slice(0, 200);
      const avatarUrl = (payload && payload.avatar_url) || null;

      const body = {
        user_id: userId,
        username: username,
        bio: filteredBio,
        location: location,
        website: website,
        social_links: social,
        updated_at: new Date().toISOString()
      };
      if (avatarUrl) body.avatar_url = avatarUrl;

      const result = await this.request('profiles', 'POST', body, 'on_conflict=user_id');
      return !!result;
    },

    async uploadAvatarToSupabase(userId, file) {
      if (!userId || !file) throw new Error('缺少用户或文件');
      const ext = (file.name && file.name.split('.').pop()) || 'png';
      const path = `avatars/${userId}/${Date.now()}.${ext}`;
      const url = `${SUPABASE_URL}/storage/v1/object/avatars/${path}`;
      const uploadUrl = `${SUPABASE_URL}/storage/v1/object/avatars/${path}`;

      try {
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'x-upsert': 'true'
          },
          body: file
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error('头像上传失败 ' + res.status + ': ' + text);
        }
        return url;
      } catch (e) {
        console.error('Supabase avatar upload failed:', e);
        return null;
      }
    }
  };
  APEXON.DB = DB;

  // ===== 2. Clerk 认证 =====
  /* ===== 登录系统已临时禁用，取消下方块注释即可恢复 =====
  const ClerkAuth = {
    user: null,
    isReady: false,

    async init() {
      if (this.isReady) return;
      await new Promise(resolve => {
        const finish = () => {
          this.isReady = true;
          this.user = window.Clerk ? window.Clerk.user : null;
          // 登录后立即同步到 SQL users 表
          if (this.user && this.user.id) {
            const email = this.user.primaryEmailAddress && this.user.primaryEmailAddress.emailAddress
              ? this.user.primaryEmailAddress.emailAddress
              : (this.user.emailAddresses && this.user.emailAddresses[0] ? this.user.emailAddresses[0].emailAddress : '');
            DB.syncUser(this.user.id, this.getUser(), email).catch(e => console.error('users sync failed:', e));
          }
          resolve();
        };

        if (window.Clerk && window.Clerk.loaded) {
          finish();
          return;
        }

        const check = setInterval(() => {
          if (window.Clerk) {
            clearInterval(check);
            // Clerk 需要显式 load() 以完成初始化
            window.Clerk.load()
              .then(finish)
              .catch(() => finish());
          }
        }, 100);

        setTimeout(() => { clearInterval(check); finish(); }, 8000);
      });
    },

    isLoggedIn() {
      return !!this.user;
    },

    getUser() {
      if (!this.user) return null;
      return this.user.username || this.user.fullName || (this.user.firstName && this.user.lastName ? this.user.firstName + ' ' + this.user.lastName : this.user.firstName) || (this.user.emailAddresses && this.user.emailAddresses[0] && this.user.emailAddresses[0].emailAddress) || '用户';
    },

    getUserId() {
      return this.user?.id || null;
    },

    async logout() {
      if (window.Clerk) await window.Clerk.signOut();
      this.user = null;
      location.reload();
    },

    async deleteAccount() {
      if (!confirm('确定注销账号？本地数据将被清除，不可恢复。')) return;
      await this.logout();
    },

    async updateUser(updates) {
      if (!window.Clerk || !window.Clerk.user) throw new Error('未登录，无法更新资料');

      const user = window.Clerk.user;
      let updated = null;

      // Clerk 不同版本兼容：优先使用直接 update，其次 setProfileImage 处理头像
      if (updates.username != null) {
        if (typeof user.update === 'function') {
          updated = await user.update({ username: updates.username });
        } else if (typeof user.updateUsername === 'function') {
          updated = await user.updateUsername({ username: updates.username });
        } else {
          throw new Error('当前 Clerk 环境不支持修改用户名');
        }
      }

      if (updates.firstName != null || updates.lastName != null) {
        const namePayload = {};
        if (updates.firstName != null) namePayload.firstName = updates.firstName;
        if (updates.lastName != null) namePayload.lastName = updates.lastName;
        if (typeof user.update === 'function') {
          updated = await user.update(namePayload);
        } else {
          throw new Error('当前 Clerk 环境不支持修改姓名');
        }
      }

      this.user = updated || user;
      UI.updateUserDisplay();
      return this.user;
    },

    async uploadAvatar(file) {
      if (!window.Clerk || !window.Clerk.user) throw new Error('未登录，无法上传头像');
      const user = window.Clerk.user;

      // Clerk v5 官方 API：setProfileImage
      if (typeof user.setProfileImage === 'function') {
        const result = await user.setProfileImage({ file });
        this.user = user;
        UI.updateUserDisplay();
        return result;
      }

      // 部分版本挂在 createProfileImage
      if (typeof user.createProfileImage === 'function') {
        const result = await user.createProfileImage({ file });
        this.user = user;
        UI.updateUserDisplay();
        return result;
      }

      throw new Error('当前 Clerk 环境不支持头像上传');
    },

    getAvatarUrl() {
      if (!this.user) return null;
      return this.user.imageUrl || this.user.profileImageUrl || null;
    },

    getCreatedAt() {
      if (!this.user || !this.user.createdAt) return null;
      return new Date(this.user.createdAt).toLocaleDateString('zh-CN');
    }
  };
  APEXON.Auth = ClerkAuth;
  */

  // 登录系统已临时禁用，改用匿名身份继续记录成绩到数据库
  const AnonymousAuth = {
    user: null,
    isReady: true,

    _ensureIdentity() {
      if (this.user) return this.user;
      let id = localStorage.getItem('apexon-anon-id');
      let name = localStorage.getItem('apexon-anon-name');
      let createdAt = localStorage.getItem('apexon-anon-created');
      if (!id) {
        id = this._generateId();
        name = this._generateName();
        createdAt = new Date().toISOString();
        localStorage.setItem('apexon-anon-id', id);
        localStorage.setItem('apexon-anon-name', name);
        localStorage.setItem('apexon-anon-created', createdAt);
      }
      this.user = { id, name, createdAt };
      return this.user;
    },

    _generateId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
      return 'anon_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    },

    _generateName() {
      const adjectives = ['快乐', '勇敢', '安静', '聪明', '好奇', '机灵', '温柔', '调皮', '稳重', '活泼', '神秘', '幸运'];
      const nouns = ['小猫', '熊猫', '海豚', '狐狸', '企鹅', '松鼠', '考拉', '兔子', '老虎', '狮子', '猫头鹰', '蝴蝶'];
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const noun = nouns[Math.floor(Math.random() * nouns.length)];
      return adj + noun + Math.floor(Math.random() * 1000);
    },

    async init() {
      this._ensureIdentity();
    },

    isLoggedIn() {
      return false;
    },

    getUser() {
      return this._ensureIdentity().name;
    },

    getUserId() {
      return this._ensureIdentity().id;
    },

    async logout() {
      localStorage.removeItem('apexon-anon-id');
      localStorage.removeItem('apexon-anon-name');
      localStorage.removeItem('apexon-anon-created');
      this.user = null;
      location.reload();
    },

    async deleteAccount() {
      if (!confirm('确定清除本地匿名记录？历史数据仍会保留在数据库中。')) return;
      await this.logout();
    },

    async updateUser(updates) {
      if (updates.username != null) {
        const user = this._ensureIdentity();
        user.name = String(updates.username).slice(0, 30);
        localStorage.setItem('apexon-anon-name', user.name);
        this.user = user;
      }
      return this.user;
    },

    async uploadAvatar() {
      throw new Error('匿名模式不支持上传头像');
    },

    getAvatarUrl() {
      return null;
    },

    getCreatedAt() {
      const createdAt = this._ensureIdentity().createdAt;
      return createdAt ? new Date(createdAt).toLocaleDateString('zh-CN') : null;
    }
  };
  APEXON.Auth = AnonymousAuth;

  // ===== 3. 音频 =====
  const AudioManager = {
    ctx: null,
    enabled: true,
    _init() {
      if (this.ctx) return;
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.enabled = false; }
    },
    play(freq, dur, type) {
      if (!this.enabled) return;
      this._init();
      if (!this.ctx) return;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.connect(g);
      g.connect(this.ctx.destination);
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, this.ctx.currentTime);
      g.gain.setValueAtTime(0.1, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      o.start();
      o.stop(this.ctx.currentTime + dur);
    },
    playClick() { this.play(800, 0.1); },
    playSuccess() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.play(f, 0.3), i * 80)); },
    playFail() {
      this._init();
      if (!this.ctx) return;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.connect(g);
      g.connect(this.ctx.destination);
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(300, this.ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(150, this.ctx.currentTime + 0.3);
      g.gain.setValueAtTime(0.1, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
      o.start();
      o.stop(this.ctx.currentTime + 0.3);
    },
    playTick() { this.play(1000, 0.05, 'square'); }
  };
  APEXON.Audio = AudioManager;

  // ===== 4. 页面可见性 =====
  const VisibilityManager = {
    callbacks: [],
    isVisible: true,
    init() {
      document.addEventListener('visibilitychange', () => {
        this.isVisible = !document.hidden;
        this.callbacks.forEach(cb => cb(this.isVisible));
      });
    },
    onChange(cb) { this.callbacks.push(cb); }
  };
  APEXON.Visibility = VisibilityManager;

  // ===== 5. 工具函数 =====
  const Utils = {
    debounce(fn, ms) {
      let timer;
      return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
    },
    throttle(fn, ms) {
      let last = 0;
      return function (...args) {
        const now = Date.now();
        if (now - last >= ms) { last = now; fn.apply(this, args); }
      };
    },
    vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); },
    reactionPenalty() {
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      return isTouch ? 30 : 10;
    },
    getGrade(val, type) {
      if (type === 'reaction') {
        if (val < 180) return { grade: 'S', color: '#FFD700' };
        if (val < 230) return { grade: 'A', color: '#FF6B6B' };
        if (val < 280) return { grade: 'B', color: '#4ECDC4' };
        if (val < 350) return { grade: 'C', color: '#95E1D3' };
        return { grade: 'D', color: '#aaa' };
      }
      if (type === 'type') {
        if (val < 20) return { grade: 'S', color: '#FFD700' };
        if (val < 30) return { grade: 'A', color: '#FF6B6B' };
        if (val < 40) return { grade: 'B', color: '#4ECDC4' };
        if (val < 50) return { grade: 'C', color: '#95E1D3' };
        return { grade: 'D', color: '#aaa' };
      }
      return { grade: '-', color: '#aaa' };
    }
  };
  APEXON.Utils = Utils;

  // ===== 6. UI 工具 =====
  const UI = {
    toast(msg, duration = 2500) {
      let el = document.getElementById('apex-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'apex-toast';
        el.className = 'toast';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), duration);
    },

    initTheme() {
      // 深色科技风 / 白色明亮主题切换（由 data-bw 与 body.theme-light 控制）
      const applyBW = (isBW) => {
        document.documentElement.setAttribute('data-bw', String(isBW));
        if (document.body) document.body.classList.toggle('theme-light', isBW);
        document.dispatchEvent(new CustomEvent('apexon:themechange', { detail: { isLight: isBW } }));
      };
      const bwStored = localStorage.getItem('apex-bw-mode');
      const isBW = bwStored === 'true';
      applyBW(isBW);
      const bwInput = document.getElementById('bwToggleInput');
      const bwToggle = document.getElementById('bwToggle');
      if (bwInput) {
        bwInput.checked = isBW;
        const handler = () => {
          const next = bwInput.checked;
          applyBW(next);
          localStorage.setItem('apex-bw-mode', String(next));
        };
        bwInput.addEventListener('change', handler);
        // 兼容移动端 label/track 点击，避免与 input change 重复触发
        if (bwToggle) {
          bwToggle.addEventListener('click', (e) => {
            if (e.target === bwInput || bwInput.contains(e.target)) return;
            e.preventDefault();
            bwInput.checked = !bwInput.checked;
            handler();
          });
        }
      }
    },

    /* ===== 登录系统已临时禁用，取消下方块注释即可恢复 =====
    async mountUserButton(containerId = 'user-menu-container') {
      await ClerkAuth.init();
      let container = document.getElementById(containerId);
      // 兼容旧页面仍使用 #user-button
      if (!container) container = document.getElementById('user-button');
      if (!container || !window.Clerk || !window.Clerk.mountUserButton) return;

      const doMount = () => {
        if (container.dataset.clerkMounted === 'true') return;
        container.dataset.clerkMounted = 'true';
        try {
          window.Clerk.mountUserButton(container, {
            afterSignOutUrl: window.location.href,
            appearance: {
              variables: {
                colorPrimary: '#6d5dfc',
                colorTextOnPrimaryBackground: '#ffffff',
                colorText: 'var(--apex-text)',
                colorBackground: 'var(--apex-surface)',
                colorAlphaShade: 'var(--apex-text-tertiary)',
                colorDanger: '#dc2626',
                borderRadius: '12px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif'
              },
              elements: {
                userButtonTrigger: 'apex-clerk-trigger',
                userButtonAvatarBox: 'apex-clerk-avatar',
                userButtonPopoverCard: 'apex-clerk-popover',
                userButtonPopoverActionButton: 'apex-clerk-action',
                userButtonPopoverActionButtonDanger: 'apex-clerk-action--danger'
              }
            }
          });
        } catch (e) {
          console.error('Clerk UserButton mount failed:', e);
        }
      };

      doMount();

      if (window.Clerk.addListener) {
        window.Clerk.addListener(({ user }) => {
          ClerkAuth.user = user || null;
          // 登录态变化时同步 users 表
          if (user && user.id) {
            const email = user.primaryEmailAddress && user.primaryEmailAddress.emailAddress
              ? user.primaryEmailAddress.emailAddress
              : (user.emailAddresses && user.emailAddresses[0] ? user.emailAddresses[0].emailAddress : '');
            const name = user.username || user.firstName || user.lastName || '';
            DB.syncUser(user.id, name, email).catch(e => console.error('users sync failed:', e));
          }
          UI.updateUserDisplay();
          doMount();
        });
      }

      UI.updateUserDisplay();
    },
    */

    // 登录系统禁用期间的占位方法
    async mountUserButton() { return; },

    /* ===== 登录系统已临时禁用，取消下方块注释即可恢复 =====
    updateUserDisplay() {
      const nameEl = document.getElementById('headerUserName');
      const wrap = document.getElementById('headerUserWrap');
      const forumTip = document.getElementById('forumLoginTip');
      const forumInput = document.getElementById('forumInputWrap');
      const personalContent = document.getElementById('personalContent');

      if (!ClerkAuth.isLoggedIn()) {
        if (wrap) wrap.classList.add('is-guest');
        if (nameEl) nameEl.textContent = '登录';
        if (forumTip) forumTip.style.display = 'block';
        if (forumInput) forumInput.style.display = 'none';
        document.dispatchEvent(new CustomEvent('apexon:userchange', { detail: { loggedIn: false } }));
        return;
      }

      if (wrap) wrap.classList.remove('is-guest');
      const name = ClerkAuth.getUser() || '用户';
      if (nameEl) { nameEl.textContent = name; nameEl.style.cssText = ''; }
      if (forumTip) forumTip.style.display = 'none';
      if (forumInput) forumInput.style.display = 'flex';
      document.dispatchEvent(new CustomEvent('apexon:userchange', { detail: { loggedIn: true, user: ClerkAuth.user } }));
    },
    */

    backHome() {
      document.body.style.opacity = '0';
      setTimeout(() => { location.href = 'index.html'; }, 300);
    }
  };
  APEXON.UI = UI;

  // ===== 7. 粒子背景系统 =====
  const ParticleSystem = {
    defaults: {
      selector: 'particles',
      // 科技感冷色：青、蓝、紫、白
      darkPalette: ['#22d3ee', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e2e8f0'],
      // 白色背景下使用高饱和、高对比的亮蓝/电紫/深靛，避免发灰
      lightPalette: ['#0066ff', '#0088ff', '#6d28ff', '#4f46e5', '#0891b2', '#1e1b4b', '#0f172a'],
      baseCount: 44,
      mobileCount: 24,
      connectionDistance: 130,
      mouseDistance: 150,
      speed: 0.42
    },

    init(options = {}) {
      const config = Object.assign({}, this.defaults, options);
      const canvas = typeof config.selector === 'string' ? document.getElementById(config.selector) : config.selector;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      const offscreen = document.createElement('canvas');
      const offCtx = offscreen.getContext('2d');
      let w, h, particles = [], stars = [], bursts = [];
      let packets = [], scanLines = [], glyphs = [], rings = [];
      let mouse = { x: null, y: null, active: false };
      let frameId = null;
      let isActive = true;
      let frameCount = 0;

      const isLight = () =>
        document.documentElement.getAttribute('data-bw') === 'true' ||
        document.documentElement.getAttribute('data-theme') === 'light' ||
        document.body.classList.contains('theme-light');
      const colorPalette = () => isLight() ? config.lightPalette : config.darkPalette;
      let palette = colorPalette();
      const accent = () => palette[0];
      const lightBoost = () => isLight() ? 1.8 : 1;

      const drawHexGridToOffscreen = () => {
        const r = 64;
        const hh = r * Math.sqrt(3);
        offscreen.width = window.innerWidth;
        offscreen.height = window.innerHeight;
        offCtx.clearRect(0, 0, offscreen.width, offscreen.height);
        offCtx.strokeStyle = accent();
        offCtx.lineWidth = isLight() ? 1.1 : 0.8;
        offCtx.globalAlpha = isLight() ? 0.16 : 0.11;
        const cols = Math.ceil(window.innerWidth / (r * 3)) + 1;
        const rows = Math.ceil(window.innerHeight / hh) + 1;
        for (let row = -1; row < rows; row++) {
          for (let col = -1; col < cols; col++) {
            const cx = col * r * 3 + (row % 2) * r * 1.5;
            const cy = row * hh * 0.5;
            offCtx.beginPath();
            for (let i = 0; i < 6; i++) {
              const a = Math.PI / 3 * i;
              const hx = cx + r * Math.cos(a);
              const hy = cy + r * Math.sin(a);
              if (i === 0) offCtx.moveTo(hx, hy);
              else offCtx.lineTo(hx, hy);
            }
            offCtx.closePath();
            offCtx.stroke();
          }
        }
        offCtx.globalAlpha = 1;
      };

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cw = window.innerWidth;
        const ch = window.innerHeight;
        w = canvas.width = cw * dpr;
        h = canvas.height = ch * dpr;
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawHexGridToOffscreen();
      };

      const randColor = () => palette[Math.floor(Math.random() * palette.length)];

      const createParticles = () => {
        particles = [];
        const isMobile = window.innerWidth < 768;
        const area = window.innerWidth * window.innerHeight;
        const density = isMobile ? 26000 : 16000;
        const count = Math.min(Math.floor(area / density), isMobile ? config.mobileCount : config.baseCount);
        for (let i = 0; i < count; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = config.speed * (Math.random() * 0.9 + 0.5);
          const isCore = Math.random() < 0.18;
          particles.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            baseR: isCore ? Math.random() * 1.6 + 1.1 : Math.random() * 1.0 + 0.4,
            color: randColor(),
            alpha: Math.random() * 0.32 + 0.28,
            pulse: Math.random() * Math.PI * 2,
            pulseSpeed: Math.random() * 0.04 + 0.02,
            core: isCore,
            ring: Math.random() * Math.PI * 2
          });
        }
      };

      const spawnStar = () => {
        if (stars.length >= 3 || Math.random() > 0.005) return;
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 3 + 2;
        stars.push({
          x: Math.random() * window.innerWidth,
          y: Math.random() * window.innerHeight,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          len: Math.random() * 100 + 80,
          life: 1,
          decay: Math.random() * 0.008 + 0.005,
          color: accent()
        });
      };

      const spawnBurst = (x, y) => {
        const color = accent();
        const shapes = ['circle', 'triangle', 'diamond', 'hex', 'cross'];
        const count = 16;
        for (let i = 0; i < count; i++) {
          const angle = (Math.PI * 2 / count) * i + Math.random() * 0.4;
          const speed = Math.random() * 3.5 + 1.8;
          bursts.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1,
            decay: Math.random() * 0.025 + 0.018,
            color,
            size: Math.random() * 2.4 + 0.9,
            core: i < 4,
            shape: shapes[Math.floor(Math.random() * shapes.length)],
            rot: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random() - 0.5) * 0.18
          });
        }
        rings.push({ x, y, r: 2, alpha: 0.85, color, width: 2.5 });
      };

      const spawnGlyph = () => {
        if (glyphs.length >= 4 || Math.random() > 0.006) return;
        const x = Math.random() * window.innerWidth;
        const y = Math.random() * window.innerHeight;
        glyphs.push({
          x, y,
          size: Math.random() * 16 + 14,
          life: 1,
          decay: Math.random() * 0.006 + 0.004,
          color: randColor(),
          rot: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.03,
          type: Math.random() < 0.5 ? 'cross' : 'hex'
        });
      };

      const buildConnectionList = () => {
        const maxDist = config.connectionDistance;
        const maxLinks = 3;
        for (let i = 0; i < particles.length; i++) {
          particles[i].links = [];
        }
        for (let i = 0; i < particles.length; i++) {
          let links = 0;
          for (let j = i + 1; j < particles.length; j++) {
            const dx = particles[i].x - particles[j].x;
            const dy = particles[i].y - particles[j].y;
            const d2 = dx * dx + dy * dy;
            if (d2 < maxDist * maxDist) {
              const dist = Math.sqrt(d2);
              particles[i].links.push({ idx: j, dist });
              particles[j].links.push({ idx: i, dist });
              links++;
              if (links >= maxLinks) break;
            }
          }
        }
      };

      const spawnPackets = () => {
        if (packets.length >= 10 || Math.random() > 0.06) return;
        for (let i = 0; i < particles.length; i++) {
          if (particles[i].links && particles[i].links.length && Math.random() < 0.3) {
            const link = particles[i].links[Math.floor(Math.random() * particles[i].links.length)];
            const target = particles[link.idx];
            packets.push({
              from: i,
              to: link.idx,
              t: 0,
              speed: 0.01 + Math.random() * 0.02,
              color: particles[i].color,
              size: Math.random() * 1.5 + 0.8
            });
            break;
          }
        }
      };

      const updateParticles = () => {
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;

          if (p.x < 0) { p.x = 0; p.vx *= -1; }
          if (p.x > window.innerWidth) { p.x = window.innerWidth; p.vx *= -1; }
          if (p.y < 0) { p.y = 0; p.vy *= -1; }
          if (p.y > window.innerHeight) { p.y = window.innerHeight; p.vy *= -1; }

          if (mouse.active) {
            const dx = p.x - mouse.x;
            const dy = p.y - mouse.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < config.mouseDistance && d > 1) {
              const force = (config.mouseDistance - d) / config.mouseDistance;
              // 磁场排斥 + 切向旋转
              const push = 0.06;
              const swirl = 0.04;
              const nx = dx / d, ny = dy / d;
              p.vx += nx * force * push - ny * force * swirl;
              p.vy += ny * force * push + nx * force * swirl;
            }
          }

          p.vx *= 0.994;
          p.vy *= 0.994;
          p.pulse += p.pulseSpeed;
          p.ring += 0.03;
        }
      };

      const updateBursts = () => {
        for (let i = bursts.length - 1; i >= 0; i--) {
          const b = bursts[i];
          b.x += b.vx;
          b.y += b.vy;
          b.vx *= 0.95;
          b.vy *= 0.95;
          b.rot += b.rotSpeed;
          b.life -= b.decay;
          if (b.life <= 0) bursts.splice(i, 1);
        }
        for (let i = rings.length - 1; i >= 0; i--) {
          const r = rings[i];
          r.r += 5;
          r.alpha -= 0.015;
          r.width *= 0.985;
          if (r.alpha <= 0) rings.splice(i, 1);
        }
      };

      const updatePackets = () => {
        spawnPackets();
        for (let i = packets.length - 1; i >= 0; i--) {
          const pk = packets[i];
          pk.t += pk.speed;
          if (pk.t >= 1) packets.splice(i, 1);
        }
      };

      const updateGlyphs = () => {
        spawnGlyph();
        for (let i = glyphs.length - 1; i >= 0; i--) {
          const g = glyphs[i];
          g.life -= g.decay;
          g.rot += g.rotSpeed;
          if (g.life <= 0) glyphs.splice(i, 1);
        }
      };

      const updateScanLines = () => {
        if (scanLines.length < 2 && Math.random() < 0.012) {
          scanLines.push({ y: -4, speed: Math.random() * 1.8 + 1.2, alpha: 0.45, width: Math.random() * 2 + 1 });
        }
        for (let i = scanLines.length - 1; i >= 0; i--) {
          const s = scanLines[i];
          s.y += s.speed;
          if (s.y > window.innerHeight + 10) scanLines.splice(i, 1);
        }
      };

      const drawHexGrid = () => {
        ctx.drawImage(offscreen, 0, 0);
      };

      const drawConnections = () => {
        const maxDist = config.connectionDistance;
        const maxLinks = 2;
        const boost = lightBoost();
        ctx.lineWidth = isLight() ? 1.6 : 1.4;
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (let i = 0; i < particles.length; i++) {
          const p1 = particles[i];
          let links = 0;
          for (let j = i + 1; j < particles.length; j++) {
            const p2 = particles[j];
            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < maxDist * maxDist) {
              const dist = Math.sqrt(d2);
              const alpha = (1 - dist / maxDist) * 0.28 * boost;
              ctx.strokeStyle = p1.color;
              ctx.globalAlpha = alpha;
              ctx.beginPath();
              ctx.moveTo(p1.x, p1.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.stroke();
              links++;
              if (links >= maxLinks) break;
            }
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      };

      const drawPackets = () => {
        const boost = lightBoost();
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (const pk of packets) {
          const p1 = particles[pk.from];
          const p2 = particles[pk.to];
          if (!p1 || !p2) continue;
          const x = p1.x + (p2.x - p1.x) * pk.t;
          const y = p1.y + (p2.y - p1.y) * pk.t;
          ctx.beginPath();
          ctx.arc(x, y, pk.size * 2.2, 0, Math.PI * 2);
          ctx.fillStyle = pk.color;
          ctx.globalAlpha = 0.45 * boost;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, pk.size * 0.7, 0, Math.PI * 2);
          ctx.fillStyle = isLight() ? '#000000' : '#ffffff';
          ctx.globalAlpha = 0.95;
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      };

      const drawParticles = () => {
        const boost = lightBoost();
        // 光晕层：白色背景用 source-over 更干净，深色背景用 lighter 更发光
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (const p of particles) {
          const r = p.baseR * (1 + Math.sin(p.pulse) * 0.3);
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.5, r * (p.core ? 4 : 2.6)), 0, Math.PI * 2);
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.alpha * (p.core ? 0.35 : 0.22) * boost;
          ctx.fill();
        }
        // 核心层
        ctx.globalCompositeOperation = 'source-over';
        for (const p of particles) {
          const r = p.baseR * (1 + Math.sin(p.pulse) * 0.3);

          if (p.core) {
            const ringR = r * 3 + Math.sin(p.ring) * 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.5, ringR), 0, Math.PI * 2);
            ctx.strokeStyle = p.color;
            ctx.lineWidth = isLight() ? 1.4 : 1;
            ctx.globalAlpha = p.alpha * 0.6 * boost;
            ctx.stroke();
          }

          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fillStyle = p.core ? (isLight() ? '#000000' : '#ffffff') : p.color;
          ctx.globalAlpha = p.core ? 0.95 : p.alpha * boost;
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      };

      const drawBurstShape = (b, s, glow) => {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.beginPath();
        const shape = b.shape || 'circle';
        if (shape === 'circle') {
          ctx.arc(0, 0, s, 0, Math.PI * 2);
        } else if (shape === 'triangle') {
          for (let i = 0; i < 3; i++) {
            const a = -Math.PI / 2 + (Math.PI * 2 / 3) * i;
            const px = s * Math.cos(a);
            const py = s * Math.sin(a);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
        } else if (shape === 'diamond') {
          ctx.moveTo(0, -s);
          ctx.lineTo(s, 0);
          ctx.lineTo(0, s);
          ctx.lineTo(-s, 0);
          ctx.closePath();
        } else if (shape === 'hex') {
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i;
            const px = s * Math.cos(a);
            const py = s * Math.sin(a);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
        } else if (shape === 'cross') {
          const t = s * 0.35;
          const l = s;
          ctx.moveTo(-t, -l); ctx.lineTo(t, -l); ctx.lineTo(t, -t);
          ctx.lineTo(l, -t); ctx.lineTo(l, t); ctx.lineTo(t, t);
          ctx.lineTo(t, l); ctx.lineTo(-t, l); ctx.lineTo(-t, t);
          ctx.lineTo(-l, t); ctx.lineTo(-l, -t); ctx.lineTo(-t, -t);
          ctx.closePath();
        }
        if (glow) {
          ctx.fillStyle = b.color;
          ctx.fill();
        } else {
          ctx.fillStyle = b.core ? (isLight() ? '#000000' : '#ffffff') : b.color;
          ctx.fill();
          if (!b.core) {
            ctx.strokeStyle = b.color;
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
        ctx.restore();
      };

      const drawBursts = () => {
        const boost = lightBoost();
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (const b of bursts) {
          const s = b.size * b.life * (b.core ? 2.6 : 1.8);
          ctx.globalAlpha = b.life * (b.core ? 0.5 : 0.32) * boost;
          drawBurstShape(b, s, true);
        }
        ctx.globalCompositeOperation = 'source-over';
        for (const b of bursts) {
          const s = b.size * b.life * (b.core ? 1.6 : 1.1);
          ctx.globalAlpha = b.life * (b.core ? 0.95 : 0.7) * boost;
          drawBurstShape(b, s, false);
        }
        for (const r of rings) {
          ctx.beginPath();
          ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
          ctx.strokeStyle = r.color;
          ctx.lineWidth = Math.max(0.5, r.width * (isLight() ? 1.4 : 1));
          ctx.globalAlpha = r.alpha * boost;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      };

      const drawStars = () => {
        spawnStar();
        const boost = lightBoost();
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (let i = stars.length - 1; i >= 0; i--) {
          const s = stars[i];
          s.x += s.vx;
          s.y += s.vy;
          s.life -= s.decay;
          if (s.life <= 0 || s.x < -120 || s.x > window.innerWidth + 120 || s.y < -120 || s.y > window.innerHeight + 120) {
            stars.splice(i, 1);
            continue;
          }
          const tailX = s.x - s.vx * (s.len / 5);
          const tailY = s.y - s.vy * (s.len / 5);
          ctx.beginPath();
          ctx.strokeStyle = s.color;
          ctx.lineWidth = isLight() ? 3 : 2.2;
          ctx.globalAlpha = s.life * 0.35 * boost;
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(tailX, tailY);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      };

      const drawGlyphs = () => {
        const boost = lightBoost();
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (const g of glyphs) {
          ctx.save();
          ctx.translate(g.x, g.y);
          ctx.rotate(g.rot);
          ctx.strokeStyle = g.color;
          ctx.lineWidth = isLight() ? 2.6 : 2;
          ctx.globalAlpha = g.life * 0.55 * boost;
          const s = g.size;
          if (g.type === 'cross') {
            ctx.beginPath();
            ctx.moveTo(-s, 0); ctx.lineTo(s, 0);
            ctx.moveTo(0, -s); ctx.lineTo(0, s);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 0, s * 0.35, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
              const a = Math.PI / 3 * i;
              const hx = s * Math.cos(a);
              const hy = s * Math.sin(a);
              if (i === 0) ctx.moveTo(hx, hy);
              else ctx.lineTo(hx, hy);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 0, s * 0.25, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      };

      const drawScanLines = () => {
        const boost = lightBoost();
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        for (const s of scanLines) {
          ctx.beginPath();
          ctx.strokeStyle = accent();
          ctx.lineWidth = s.width * (isLight() ? 3.2 : 2.5);
          ctx.globalAlpha = s.alpha * 0.5 * boost;
          ctx.moveTo(0, s.y);
          ctx.lineTo(window.innerWidth, s.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      };

      const drawMouseField = () => {
        if (!mouse.active) return;
        const boost = lightBoost();
        ctx.globalCompositeOperation = isLight() ? 'source-over' : 'lighter';
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, config.mouseDistance * 0.6, 0, Math.PI * 2);
        ctx.strokeStyle = accent();
        ctx.lineWidth = isLight() ? 2.6 : 2;
        ctx.globalAlpha = 0.18 * boost;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, config.mouseDistance * 0.3, 0, Math.PI * 2);
        ctx.globalAlpha = 0.28 * boost;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      };

      const draw = () => {
        if (!isActive) return;
        frameCount++;
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        drawHexGrid();
        updateParticles();
        if (frameCount % 2 === 0) buildConnectionList();
        updatePackets();
        updateBursts();
        updateGlyphs();
        drawConnections();
        drawPackets();
        drawParticles();
        drawBursts();
        drawStars();
        drawGlyphs();
        frameId = requestAnimationFrame(draw);
      };

      const onResize = () => { resize(); createParticles(); };
      const onMouseMove = (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; };
      const onMouseLeave = () => { mouse.active = false; };
      const onTouchMove = (e) => {
        if (e.touches && e.touches[0]) {
          mouse.x = e.touches[0].clientX;
          mouse.y = e.touches[0].clientY;
          mouse.active = true;
        }
      };
      const onTouchEnd = () => { mouse.active = false; };
      const onMouseDown = (e) => {
        spawnBurst(e.clientX, e.clientY);
        mouse.active = true;
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      };
      const onTouchStart = (e) => {
        if (e.touches && e.touches[0]) {
          spawnBurst(e.touches[0].clientX, e.touches[0].clientY);
          mouse.active = true;
          mouse.x = e.touches[0].clientX;
          mouse.y = e.touches[0].clientY;
        }
      };
      const onVisibility = () => {
        if (document.hidden) {
          isActive = false;
          if (frameId) cancelAnimationFrame(frameId);
        } else {
          isActive = true;
          draw();
        }
      };
      const onThemeChange = () => {
        palette = colorPalette();
        drawHexGridToOffscreen();
        for (const p of particles) p.color = randColor();
        for (const s of stars) s.color = accent();
        for (const g of glyphs) g.color = randColor();
      };

      document.addEventListener('apexon:themechange', onThemeChange);
      window.addEventListener('resize', Utils.debounce(onResize, 250));
      window.addEventListener('mousemove', onMouseMove, { passive: true });
      window.addEventListener('mouseleave', onMouseLeave);
      window.addEventListener('touchmove', onTouchMove, { passive: true });
      window.addEventListener('touchend', onTouchEnd);
      window.addEventListener('mousedown', onMouseDown, { passive: true });
      window.addEventListener('touchstart', onTouchStart, { passive: true });
      document.addEventListener('visibilitychange', onVisibility);

      resize();
      createParticles();
      draw();
    }
  };
  APEXON.Particles = ParticleSystem;

  // ===== 8. 测试引擎 =====
  const Tests = {
    // ---------- 打字测试 ----------
    Type: {
      TOTAL_ROUNDS: 5,
      ROUND_DELAY_MS: 800,
      MS_PER_SECOND: 1000,
      sentences: [
        "星光不问赶路人人心依旧奔赴远方从未停下脚步",
        "生活原本平淡无风奔跑起来自有清风和光亮",
        "心怀温柔奔赴前路认真生活不负时光不负自己",
        "保持初心踏实前行每一步都向着理想慢慢靠近",
        "看淡世事内心安然静静努力默默沉淀慢慢发光",
        "迎着风雨勇敢向前所有坎坷终会变成过往云烟",
        "守住本心稳住心态安静成长不慌不忙变优秀",
        "一路向前不问归途只管努力剩下的交给时光吧",
        "平凡日子认真过点滴努力终会汇聚成万丈光芒",
        "心怀热爱奔赴山海不惧前路漫长只管踏实前行",
        "放下焦虑稳住脚步慢慢沉淀终会遇见更好的自己",
        "岁月无言沉淀成长默默坚持总有一天会闪闪发光",
        "晨雾不阻行者步履始终向着理想不曾停歇",
        "岁月本就寻常坚持前行自会遇见温暖与希望",
        "怀揣赤诚踏遍征途用心度日不负韶华不负初心",
        "坚守信念稳步向前每段征程都向美好缓缓抵达",
        "看透纷扰心境平和默默耕耘静静积蓄悄然绽放",
        "直面困境无畏前行所有磨难终将化作成长勋章",
        "坚守自我放平心境悄然蜕变从容不迫成为更好",
        "坚定前行不问终点全心付出余下皆为岁月馈赠",
        "寻常岁月用心经营微小付出终将凝聚成耀眼光芒",
        "怀揣热忱踏遍山河不畏征途遥远只管坚定向前",
        "抛开浮躁放缓步伐默默积蓄终将邂逅更优秀的你",
        "时光不语滋养成长恒久坚守终有一日绽放璀璨"
      ],

      getRandomText() {
        return this.sentences[Math.floor(Math.random() * this.sentences.length)];
      },

      isChineseChar(str) {
        return /^[\u4E00-\u9FA5]$/.test(str);
      },

      getValidChineseCount(str) {
        let count = 0;
        for (const c of str) { if (this.isChineseChar(c)) count++; }
        return count;
      },

      calcAvg(arr) {
        const sum = arr.reduce((acc, item) => acc + parseFloat(item), 0);
        return (sum / arr.length).toFixed(1);
      },

      init() {
        const box = document.getElementById('testBox');
        const input = document.getElementById('inputArea');
        if (!box || !input || box.dataset.apexInitialized === 'type') return;
        box.dataset.apexInitialized = 'type';

        const resDom = document.getElementById('result');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const liveWpm = document.getElementById('liveWpm');
        const liveCpm = document.getElementById('liveCpm');
        const liveAcc = document.getElementById('liveAcc');
        const liveTime = document.getElementById('liveTime');
        const historyContent = document.getElementById('historyContent');
        const typeHint = document.getElementById('typeHint');

        let nowText = '';
        let startTime = 0;
        let isStart = false;
        let currentRound = 0;
        let timeList = [];
        let accList = [];
        let cpmList = [];
        let wpmList = [];
        let timer = null;

        const updateProgress = () => {
          if (progressFill) progressFill.style.width = (currentRound / this.TOTAL_ROUNDS * 100) + '%';
          if (progressText) progressText.textContent = currentRound + ' / ' + this.TOTAL_ROUNDS;
        };

        const updateLiveStats = (inputVal, right) => {
          if (!isStart) return;
          const elapsed = (performance.now() - startTime) / this.MS_PER_SECOND;
          const chineseCount = this.getValidChineseCount(inputVal);
          const cpm = elapsed > 0 ? (chineseCount / elapsed * 60).toFixed(0) : 0;
          const wpm = elapsed > 0 ? (chineseCount / elapsed * 60 / 5).toFixed(0) : 0;
          const accuracy = inputVal.length > 0 ? ((right / inputVal.length) * 100).toFixed(0) : 0;
          if (liveWpm) liveWpm.textContent = wpm;
          if (liveCpm) liveCpm.textContent = cpm;
          if (liveAcc) liveAcc.textContent = accuracy + '%';
          if (liveTime) liveTime.textContent = elapsed.toFixed(1) + 's';
        };

        const renderHistory = async () => {
          if (!historyContent) return;
          if (!APEXON.Auth.isLoggedIn()) {
            historyContent.innerHTML = '<div class="forum-empty">暂无记录</div>';
            return;
          }
          try {
            const history = await DB.getHistoryByUserAndType(APEXON.Auth.getUserId(), 'type', 5);
            if (!history.length) {
              historyContent.innerHTML = '<div class="forum-empty">还没有记录</div>';
              return;
            }
            historyContent.innerHTML = history.map(h =>
              '<div class="history-item"><span class="history-date">' + Security.escapeHtml(h.date) + '</span><span class="history-score">' + Security.escapeHtml(h.avg) + ' s / ' + Security.escapeHtml(h.accuracy) + '%</span></div>'
            ).join('');
          } catch (e) {
            historyContent.innerHTML = '<div class="forum-empty">加载记录失败</div>';
          }
        };

        const initText = () => {
          isStart = false;
          input.value = '';
          nowText = this.getRandomText();
          if (currentRound === 0) { timeList = []; accList = []; cpmList = []; wpmList = []; }
          if (typeHint) typeHint.innerHTML = '<strong>第' + (currentRound + 1) + '/' + this.TOTAL_ROUNDS + '轮</strong>输入这段文字';
          box.innerHTML = '<span class="pending">' + Security.escapeHtml(nowText) + '</span>';
          if (resDom) resDom.textContent = '';
          input.disabled = false;
          input.focus();
          updateProgress();
          if (liveWpm) liveWpm.textContent = '0';
          if (liveCpm) liveCpm.textContent = '0';
          if (liveAcc) liveAcc.textContent = '0%';
          if (liveTime) liveTime.textContent = '0.0s';
        };

        global.restartTest = () => {
          currentRound = 0;
          if (timer) clearTimeout(timer);
          initText();
        };

        const showAllResult = async () => {
          const avgTime = this.calcAvg(timeList);
          const avgAcc = this.calcAvg(accList);
          const avgWpm = this.calcAvg(wpmList);
          const avgCpm = this.calcAvg(cpmList);
          const grade = Utils.getGrade(parseFloat(avgTime), 'type');

          const rows = [];
          for (let i = 0; i < this.TOTAL_ROUNDS; i++) {
            rows.push('<div class="score-detail-item"><div class="score-detail-value">' + Security.escapeHtml(timeList[i]) + 's</div><div class="score-detail-label">第' + (i + 1) + '轮 ' + Security.escapeHtml(accList[i]) + '%</div></div>');
          }

          if (resDom) {
            resDom.innerHTML = '<div class="score-card"><div class="score-grade" style="color:' + grade.color + '">' + grade.grade + '</div><div class="score-label">平均用时 ' + avgTime + ' 秒 · 正确率 ' + avgAcc + '%</div><div class="score-details"><div class="score-detail-item"><div class="score-detail-value">' + avgWpm + '</div><div class="score-detail-label">WPM</div></div><div class="score-detail-item"><div class="score-detail-value">' + avgCpm + '</div><div class="score-detail-label">CPM</div></div><div class="score-detail-item"><div class="score-detail-value">' + avgTime + 's</div><div class="score-detail-label">平均用时</div></div><div class="score-detail-item"><div class="score-detail-value">' + avgAcc + '%</div><div class="score-detail-label">正确率</div></div></div><div class="score-details" style="margin-top:12px">' + rows.join('') + '</div></div>';
          }

          if (APEXON.Auth.isLoggedIn()) {
            const saved = await DB.saveScore(APEXON.Auth.getUserId(), APEXON.Auth.getUser(), 'type', { avg: avgTime, accuracy: avgAcc, wpm: avgWpm, cpm: avgCpm });
            if (!saved) UI.toast('数据保存失败，请重试');
          }

          try { AudioManager.playSuccess(); } catch (e) {}
          try { Utils.vibrate(30); } catch (e) {}
          renderHistory();
        };

        const completeRound = (timeS, accuracy, wpm, cpm) => {
          timeList.push(timeS);
          accList.push(accuracy);
          wpmList.push(wpm);
          cpmList.push(cpm);
          currentRound++;
          updateProgress();
          input.disabled = true;
          if (currentRound >= this.TOTAL_ROUNDS) showAllResult();
          else {
            if (resDom) resDom.innerHTML = '<strong>本轮用时：' + timeS + ' 秒</strong> &nbsp;&nbsp; 正确率：' + accuracy + '% &nbsp;&nbsp; WPM：' + wpm;
            timer = setTimeout(() => { input.disabled = false; initText(); }, this.ROUND_DELAY_MS);
          }
        };

        input.addEventListener('input', () => {
          if (!isStart) { isStart = true; startTime = performance.now(); }
          const inputVal = input.value;
          let right = 0;
          let showHtml = '';
          for (let i = 0; i < nowText.length; i++) {
            if (i < inputVal.length) {
              const isCorrect = inputVal[i] === nowText[i];
              showHtml += isCorrect ? '<span class="right">' + Security.escapeHtml(nowText[i]) + '</span>' : '<span class="wrong">' + Security.escapeHtml(nowText[i]) + '</span>';
              if (isCorrect) right++;
            } else {
              showHtml += '<span class="pending">' + Security.escapeHtml(nowText[i]) + '</span>';
            }
          }
          box.innerHTML = showHtml;
          updateLiveStats(inputVal, right);
          const inputChineseLen = this.getValidChineseCount(inputVal);
          const targetLen = this.getValidChineseCount(nowText);
          if (inputChineseLen >= targetLen) {
            const elapsed = (performance.now() - startTime) / this.MS_PER_SECOND;
            const timeS = elapsed.toFixed(1);
            const accuracy = ((right / nowText.length) * 100).toFixed(1);
            const chineseCount = this.getValidChineseCount(inputVal);
            const cpm = elapsed > 0 ? (chineseCount / elapsed * 60).toFixed(0) : 0;
            const wpm = elapsed > 0 ? (chineseCount / elapsed * 60 / 5).toFixed(0) : 0;
            completeRound(timeS, accuracy, wpm, cpm);
          }
        });

        input.addEventListener('keydown', (e) => {
          if (e.ctrlKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'v')) { e.preventDefault(); return false; }
          if (e.key === 'Escape') UI.backHome();
          if (e.key === 'r' || e.key === 'R') { if (e.ctrlKey) return; global.restartTest(); }
        });

        input.addEventListener('paste', (e) => { e.preventDefault(); return false; });
        box.addEventListener('contextmenu', (e) => e.preventDefault());

        VisibilityManager.onChange((visible) => {
          if (!visible && isStart && currentRound < this.TOTAL_ROUNDS) { input.disabled = true; if (resDom) resDom.textContent = '测试已暂停'; }
        });

        initText();
        renderHistory();
      }
    },

    // ---------- 反应测试 ----------
    Reaction: {
      STATE_IDLE: 0,
      STATE_WAITING: 1,
      STATE_CLICK: 2,
      TOTAL_ROUNDS: 5,
      MIN_WAIT_MS: 2000,
      MAX_WAIT_MS: 5000,

      init() {
        const box = document.getElementById('testBox');
        if (!box || box.dataset.apexInitialized === 'reaction') return;
        box.dataset.apexInitialized = 'reaction';
        box.className = 'reaction-click-area';

        const resDom = document.getElementById('result');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const historyContent = document.getElementById('historyContent');

        let state = this.STATE_IDLE;
        let timer = null;
        let isFinished = false;
        let currentRound = 0;
        let timeList = [];
        let foulCount = 0;
        let isLocked = false;
        let frameStartTime = 0;
        let isProcessing = false;
        let lastClickTime = 0;

        const updateProgress = () => {
          if (progressFill) progressFill.style.width = (currentRound / this.TOTAL_ROUNDS * 100) + '%';
          if (progressText) progressText.textContent = currentRound + ' / ' + this.TOTAL_ROUNDS;
        };

        const renderHistory = async () => {
          if (!historyContent) return;
          if (!APEXON.Auth.isLoggedIn()) {
            historyContent.innerHTML = '<div class="forum-empty">暂无记录</div>';
            return;
          }
          try {
            const history = await DB.getHistoryByUserAndType(APEXON.Auth.getUserId(), 'reaction', 5);
            if (!history.length) {
              historyContent.innerHTML = '<div class="forum-empty">还没有记录</div>';
              return;
            }
            historyContent.innerHTML = history.map(h =>
              '<div class="history-item"><span class="history-date">' + Security.escapeHtml(h.date) + '</span><span class="history-score">' + Security.escapeHtml(h.avg) + ' ms</span></div>'
            ).join('');
          } catch (e) {
            historyContent.innerHTML = '<div class="forum-empty">加载记录失败</div>';
          }
        };

        const resetAll = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          state = this.STATE_IDLE;
          box.className = 'reaction-click-area';
        };

        const initRound = () => {
          resetAll();
          box.textContent = `第${currentRound + 1}/${this.TOTAL_ROUNDS}轮\n点击开始`;
          if (resDom) resDom.textContent = '';
          updateProgress();
          isLocked = false;
        };

        const showScoreCard = async () => {
          isFinished = true;
          const validTimes = timeList.filter(t => t !== null);
          const sum = validTimes.reduce((a, b) => a + parseFloat(b), 0);
          const avg = validTimes.length ? (sum / validTimes.length) : 0;
          const grade = validTimes.length ? Utils.getGrade(avg, 'reaction') : { grade: '违规', color: 'var(--apex-danger)' };

          const rows = timeList.map((t, i) => {
            const value = t === null ? '<span style="color:var(--apex-danger)">提前点击</span>' : Security.escapeHtml(t) + ' ms';
            return '<div class="score-detail-item"><div class="score-detail-value">' + value + '</div><div class="score-detail-label">第' + (i + 1) + '轮</div></div>';
          });

          const foulTag = foulCount > 0 ? '<div class="score-foul">违规 ' + foulCount + ' 次</div>' : '';

          if (resDom) {
            resDom.innerHTML = '<div class="score-card"><div class="score-grade" style="color:' + grade.color + '">' + grade.grade + '</div><div class="score-label">平均反应时间 ' + avg.toFixed(2) + ' ms</div>' + foulTag + '<div class="score-details">' + rows.join('') + '</div></div>';
          }

          if (APEXON.Auth.isLoggedIn()) {
            const saved = await DB.saveScore(APEXON.Auth.getUserId(), APEXON.Auth.getUser(), 'reaction', { avg: avg.toFixed(2), times: timeList, fouls: foulCount });
            if (!saved) UI.toast('数据保存失败，请重试');
          }

          try { AudioManager.playSuccess(); } catch (e) {}
          try { Utils.vibrate(30); } catch (e) {}
          renderHistory();
        };

        const advanceRound = () => {
          currentRound++;
          updateProgress();
          if (currentRound >= this.TOTAL_ROUNDS) showScoreCard();
          else initRound();
        };

        global.restartTest = () => {
          isFinished = false;
          currentRound = 0;
          timeList = [];
          foulCount = 0;
          initRound();
        };

        const handleClick = () => {
          if (isFinished || isProcessing) return;
          const now = performance.now();
          if (now - lastClickTime < 50) return;
          lastClickTime = now;
          if (isLocked) return;

          switch (state) {
            case this.STATE_IDLE: {
              box.textContent = `第${currentRound + 1}/${this.TOTAL_ROUNDS}轮\n等待变绿`;
              state = this.STATE_WAITING;
              box.className = 'reaction-click-area waiting';
              isLocked = true;
              const wait = Math.floor(Math.random() * (this.MAX_WAIT_MS - this.MIN_WAIT_MS + 1)) + this.MIN_WAIT_MS;
              timer = setTimeout(() => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    frameStartTime = performance.now();
                    box.className = 'reaction-click-area green';
                    box.textContent = '立刻点击！';
                    state = this.STATE_CLICK;
                    isLocked = false;
                    try { AudioManager.playTick(); } catch (e) {}
                  });
                });
              }, wait);
              break;
            }
            case this.STATE_WAITING: {
              resetAll();
              foulCount++;
              timeList.push(null); // 记录本轮为违规跳过
              box.className = 'reaction-click-area foul';
              box.textContent = '提前点击，本轮跳过';
              try { AudioManager.playFail(); } catch (e) {}
              timer = setTimeout(advanceRound, 900);
              break;
            }
            case this.STATE_CLICK: {
              isProcessing = true;
              const clickTime = performance.now();
              const raw = clickTime - frameStartTime;
              let penalty = Utils.reactionPenalty();
              let final = raw - penalty;
              if (final < 0) final = 0;
              const t = final.toFixed(2);
              timeList.push(t);
              box.className = 'reaction-click-area blue';
              box.textContent = t + ' ms';
              state = this.STATE_IDLE;
              try { AudioManager.playSuccess(); } catch (e) {}
              try { Utils.vibrate(15); } catch (e) {}
              timer = setTimeout(() => { isProcessing = false; advanceRound(); }, 1200);
              break;
            }
          }
        };

        if (window.PointerEvent) {
          box.addEventListener('pointerdown', handleClick);
        } else {
          box.addEventListener('mousedown', handleClick);
          box.addEventListener('touchstart', function (e) { e.preventDefault(); handleClick(); }, { passive: false });
        }

        VisibilityManager.onChange((visible) => {
          if (!visible && state === this.STATE_WAITING) {
            resetAll();
            box.textContent = '测试已暂停，点击重新开始';
            isLocked = false;
          }
        });

        document.addEventListener('keydown', (e) => {
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleClick(); }
          if (e.key === 'r' || e.key === 'R') global.restartTest();
        });

        initRound();
        renderHistory();
      }
    }
  };
  APEXON.Tests = Tests;

  // ===== 8. 全局接口 =====
  global.backHome = UI.backHome;
  /* ===== 登录系统已临时禁用，取消下方块注释即可恢复 =====
  global.APEXON.logout = ClerkAuth.logout.bind(ClerkAuth);
  global.APEXON.deleteAccount = ClerkAuth.deleteAccount.bind(ClerkAuth);
  */

  // ===== 9. 初始化 =====
  function boot() {
    VisibilityManager.init();
    UI.initTheme();

    // 注意：Clerk user-button 与测试引擎由各页面显式初始化，
    // 不在此处自动挂载/启动，避免重复绑定导致事件/状态错乱。
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window);
