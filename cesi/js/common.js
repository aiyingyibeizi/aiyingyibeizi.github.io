/**
 * APEXON 核心模块 v4.1
 * 职责：安全、认证、Supabase 数据、音频、主题、测试引擎
 */

(function (global) {
  'use strict';
  const APEXON = global.APEXON = global.APEXON || {};

  // ===== 配置 =====
  const SUPABASE_URL = 'https://kpmsijgonualekjyrkzs.supabase.co';
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
      if (dangerousPattern.test(input) || jsProtocol.test(input) || eventHandler.test(input)) {
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
    async request(table, method, body, query, extraHeaders) {
      let url = `${SUPABASE_URL}/rest/v1/${table}`;
      if (query) url += '?' + query;
      const isMergeUpsert = method === 'POST' && query && query.includes('on_conflict');
      const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': isMergeUpsert ? 'return=representation,resolution=merge-duplicates' : 'return=representation'
      };
      if (extraHeaders) Object.assign(headers, extraHeaders);
      const options = { method, headers };
      if (body) options.body = JSON.stringify(body);
      try {
        const res = await fetch(url, options);
        if (!res.ok) {
          const errText = await res.text();
          console.error(`[DB ${method}] ${table} ${res.status}:`, errText, 'body=', body);
          throw new Error('DB error ' + res.status + ': ' + errText);
        }
        const text = await res.text();
        // 空响应视为成功（如 INSERT 不返回 representation 时）
        return text ? JSON.parse(text) : {};
      } catch (e) {
        console.error('[DB request failed]', table, method, e);
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

    async upsertOnline(userId) {
      if (!userId) return false;
      const result = await this.request('online_users', 'POST', {
        user_id: String(userId),
        last_seen: new Date().toISOString()
      }, 'on_conflict=user_id');
      return !!result;
    },

    async getSiteStats() {
      const url = `${SUPABASE_URL}/rest/v1/rpc/get_site_stats`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: '{}'
        });
        if (!res.ok) {
          const text = await res.text();
          console.error('[getSiteStats]', res.status, text);
          return null;
        }
        const data = await res.json();
        return data || null;
      } catch (e) {
        console.error('[getSiteStats] failed:', e);
        return null;
      }
    },

    async saveScore(userId, username, testType, data) {
      if (!userId) {
        console.error('saveScore rejected: missing userId');
        return false;
      }
      if (!Security.validateRecord(testType, data)) {
        console.warn('[saveScore] validation failed:', testType, data);
        return false;
      }
      const scoreValue = parseFloat(data.avg || data.score || 0);
      const lowerIsBetter = ['reaction', 'type', 'aim'].includes(testType);

      const history = await this.getHistoryByUserAndType(userId, testType, 1);
      if (history.length) {
        const best = history[0].score;
        const isBetter = lowerIsBetter ? scoreValue < best : scoreValue > best;
        if (!isBetter) {
          console.log('[saveScore] not better than current best, skipped');
          return true;
        }
        await this.deleteScore(history[0].id, userId);
      }

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
      console.log('[saveScore]', testType, scoreValue, 'result:', result);
      return !!result;
    },

    async deleteScore(id, userId) {
      if (!id) return false;
      const extraHeaders = userId ? { 'x-user-id': userId } : undefined;
      const result = await this.request('scores', 'DELETE', null, `id=eq.${id}`, extraHeaders);
      return !!result;
    },

    async getLeaderboard(testType, limit = 100) {
      // 反应/打字/瞄准：数值越低越好；其他：数值越高越好
      const lowerIsBetter = ['reaction', 'type', 'aim'];
      const order = lowerIsBetter.includes(testType) ? 'score_value.asc' : 'score_value.desc';
      const url = `${SUPABASE_URL}/rest/v1/scores?test_type=eq.${encodeURIComponent(testType)}&order=${order}&limit=1000`;
      try {
        const res = await fetch(url, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!res.ok) return [];
        const rows = await res.json();
        const bestByUser = new Map();
        for (const row of rows) {
          const existing = bestByUser.get(row.user_id);
          if (!existing) {
            bestByUser.set(row.user_id, row);
            continue;
          }
          const isBetter = lowerIsBetter.includes(testType)
            ? row.score_value < existing.score_value
            : row.score_value > existing.score_value;
          if (isBetter) bestByUser.set(row.user_id, row);
        }
        const bestRows = Array.from(bestByUser.values());
        bestRows.sort((a, b) => lowerIsBetter.includes(testType)
          ? a.score_value - b.score_value
          : b.score_value - a.score_value);
        return bestRows.slice(0, limit);
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
      const raw = String(content || '').trim();
      const filtered = Security.filterDangerous(raw);
      console.log('[addComment] raw length:', raw.length, 'filtered length:', filtered && filtered.length);
      if (!filtered) {
        console.warn('[addComment] rejected: empty content');
        return { success: false, error: '评论内容不能为空' };
      }
      if (filtered.length > 500) {
        console.warn('[addComment] rejected: too long', filtered.length);
        return { success: false, error: '评论内容超过 500 字限制' };
      }
      const result = await this.request('comments', 'POST', {
        user_id: userId,
        username: username,
        content: filtered
      });
      console.log('[addComment] result:', result);
      if (!result) {
        return { success: false, error: '发布失败，请检查网络或稍后重试（详细错误请查看控制台）' };
      }
      return { success: true };
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
      const gender = (payload && payload.gender) || null;

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
      if (gender) body.gender = gender;

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
    },

    async changeUsername(oldUsername, newUsername, token) {
      const url = `${SUPABASE_URL}/rest/v1/rpc/change_username`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ old_un: oldUsername, new_un: newUsername, token: token })
        });
        if (!res.ok) {
          const text = await res.text();
          console.error('[changeUsername]', res.status, text);
          return { success: false, error: '修改失败，请重试' };
        }
        const data = await res.json();
        return data || { success: false, error: '未知错误' };
      } catch (e) {
        console.error('[changeUsername] failed:', e);
        return { success: false, error: '网络错误' };
      }
    },

    async getProfilesForUsers(userIds) {
      if (!userIds || !userIds.length) return [];
      const list = userIds.map(id => encodeURIComponent(String(id))).join(',');
      const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=in.(${list})`;
      try {
        const res = await fetch(url, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!res.ok) return [];
        return await res.json();
      } catch (e) {
        return [];
      }
    }
  };
  APEXON.DB = DB;

  // ===== 2. 认证 =====
  const Auth = {
    currentUser: null,
    anonId: null,
    SESSION_DAYS: 7,

    init() {
      let anonId = localStorage.getItem('apexon-anon-id');
      if (!anonId) {
        anonId = this._generateAnonId();
        localStorage.setItem('apexon-anon-id', anonId);
      }
      this.anonId = anonId;

      const saved = localStorage.getItem('apexon-session');
      if (!saved) return;
      try {
        const session = JSON.parse(saved);
        if (!session || !session.username || !session.token || !session.expiresAt) {
          this._clearSession();
          return;
        }
        if (Date.now() > session.expiresAt) {
          this._clearSession();
          return;
        }
        this.currentUser = { username: session.username, token: session.token, expiresAt: session.expiresAt };
      } catch (e) {
        this._clearSession();
      }
    },

    async validateSession() {
      if (!this.currentUser) return true;
      const username = this.currentUser.username;
      const token = this.currentUser.token;
      const nowIso = new Date().toISOString();
      const rows = await DB.request(
        'accounts',
        'GET',
        null,
        `username=eq.${encodeURIComponent(username)}&session_token=eq.${encodeURIComponent(token)}&session_expires_at=gte.${encodeURIComponent(nowIso)}&limit=1`,
        { 'x-username': username, 'x-token': token }
      );
      if (rows && rows.length) {
        this._extendSession();
        return true;
      }
      this._clearSession();
      return true;
    },

    isLoggedIn() {
      return !!this.currentUser && !!this.currentUser.username && Date.now() < (this.currentUser.expiresAt || 0);
    },

    isAnonymous() {
      return !this.isLoggedIn();
    },

    getUser() {
      if (this.currentUser) return this.currentUser.username;
      return '游客 ' + (this.anonId ? this.anonId.slice(-4) : 'xxxx');
    },

    getUserId() {
      return this.currentUser ? this.currentUser.username : this.anonId;
    },

    getToken() {
      return this.currentUser ? this.currentUser.token : null;
    },

    async mergeAnonymousData() {
      if (!this.currentUser || !this.anonId) return;
      const anonId = this.anonId;
      const username = this.currentUser.username;
      const token = this.currentUser.token;

      await DB.request(
        'scores',
        'PATCH',
        { user_id: username, username: username },
        `user_id=eq.${encodeURIComponent(anonId)}`,
        { 'x-anon-id': anonId, 'x-username': username, 'x-token': token }
      ).catch(e => console.error('[merge] scores failed:', e));

      await DB.request(
        'comments',
        'PATCH',
        { user_id: username, username: username },
        `user_id=eq.${encodeURIComponent(anonId)}`,
        { 'x-anon-id': anonId, 'x-username': username, 'x-token': token }
      ).catch(e => console.error('[merge] comments failed:', e));

      const newAnonId = this._generateAnonId();
      localStorage.setItem('apexon-anon-id', newAnonId);
      this.anonId = newAnonId;
    },

    async changeUsername(newUsername, password) {
      if (!this.isLoggedIn()) return { success: false, error: '请先登录' };
      const oldUsername = this.currentUser.username;
      const u = String(newUsername).trim().slice(0, 30);
      const nameErr = this._validateUsername(u);
      if (nameErr) return { success: false, error: nameErr };
      if (u === oldUsername) return { success: false, error: '新用户名与当前相同' };

      const loginResult = await this.login(oldUsername, password, true);
      if (!loginResult.success) return { success: false, error: '密码错误' };

      const token = this.currentUser.token;
      const result = await DB.changeUsername(oldUsername, u, token);
      if (!result || !result.success) {
        return { success: false, error: result && result.error ? result.error : '修改失败' };
      }

      this._setSession(u, token, this.currentUser.expiresAt);
      return { success: true };
    },

    _generateAnonId() {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return 'anon_' + crypto.randomUUID();
      }
      return 'anon_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    },

    _validateUsername(u) {
      if (!u || u.length < 2 || u.length > 30) return '用户名需 2-30 位';
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(u)) return '用户名支持中英文、数字、下划线';
      return null;
    },

    _validatePassword(p) {
      if (!p || p.length < 8) return '密码至少 8 位';
      if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return '密码需同时包含字母和数字';
      if (/\s/.test(p)) return '密码不能包含空格';
      return null;
    },

    async register(username, password, remember, gender) {
      const u = String(username).trim().slice(0, 30);
      const nameErr = this._validateUsername(u);
      if (nameErr) return { success: false, error: nameErr };
      const passErr = this._validatePassword(password);
      if (passErr) return { success: false, error: passErr };

      const exists = await DB.request('accounts', 'GET', null, `username=eq.${encodeURIComponent(u)}&limit=1`, { 'x-username': u });
      if (exists && exists.length) {
        return { success: false, error: '用户名已存在' };
      }

      const salt = this._generateSalt();
      const hash = await this._hashPassword(password, salt);
      const token = this._generateToken();
      const expiresAt = this._computeExpires(remember);
      const result = await DB.request('accounts', 'POST', {
        username: u,
        password_hash: hash,
        salt: salt,
        session_token: token,
        session_expires_at: new Date(expiresAt).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      if (!result) return { success: false, error: '注册失败，请重试' };

      await DB.saveProfile(u, u, {
        bio: '',
        location: '',
        website: '',
        social: '',
        gender: ['male', 'female', 'secret'].includes(gender) ? gender : 'secret'
      });

      this._setSession(u, token, expiresAt);
      await this.mergeAnonymousData();
      return { success: true };
    },

    async login(username, password, remember) {
      const u = String(username).trim();
      if (!u || !password) {
        return { success: false, error: '请输入用户名和密码' };
      }
      const rows = await DB.request('accounts', 'GET', null, `username=eq.${encodeURIComponent(u)}&limit=1`, { 'x-username': u });
      if (!rows || !rows.length) {
        return { success: false, error: '用户名或密码错误' };
      }
      const account = rows[0];
      const hash = await this._hashPassword(password, account.salt);
      if (hash !== account.password_hash) {
        return { success: false, error: '用户名或密码错误' };
      }

      const token = this._generateToken();
      const expiresAt = this._computeExpires(remember);
      const updateResult = await DB.request(
        'accounts',
        'PATCH',
        { session_token: token, session_expires_at: new Date(expiresAt).toISOString(), updated_at: new Date().toISOString() },
        `username=eq.${encodeURIComponent(u)}`,
        { 'x-username': u }
      );
      if (!updateResult) return { success: false, error: '登录失败，请重试' };

      this._setSession(u, token, expiresAt);
      await this.mergeAnonymousData();
      return { success: true };
    },

    async logout() {
      const username = this.getUser();
      const token = this.getToken();
      if (username && token) {
        await DB.request(
          'accounts',
          'PATCH',
          { session_token: null, session_expires_at: null, updated_at: new Date().toISOString() },
          `username=eq.${encodeURIComponent(username)}`,
          { 'x-username': username, 'x-token': token }
        ).catch(() => {});
      }
      this._clearSession();
      location.reload();
    },

    async deleteAccount() {
      if (!this.isLoggedIn()) return;
      if (!confirm('确定删除本地登录状态？数据库中的成绩仍会保留。')) return;
      await this.logout();
    },

    _setSession(username, token, expiresAt) {
      this.currentUser = { username, token, expiresAt };
      localStorage.setItem('apexon-session', JSON.stringify(this.currentUser));
    },

    _clearSession() {
      this.currentUser = null;
      localStorage.removeItem('apexon-session');
    },

    _extendSession() {
      if (!this.currentUser) return;
      const days = this.SESSION_DAYS;
      this.currentUser.expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      localStorage.setItem('apexon-session', JSON.stringify(this.currentUser));
    },

    _computeExpires(remember) {
      const days = remember ? 30 : this.SESSION_DAYS;
      return Date.now() + days * 24 * 60 * 60 * 1000;
    },

    _generateSalt() {
      const arr = new Uint8Array(32);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
      } else {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      }
      return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    },

    _generateToken() {
      const arr = new Uint8Array(32);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
      } else {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      }
      return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    },

    async _hashPassword(password, salt) {
      if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new Error('当前环境不支持安全密码哈希');
      }
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
      const params = { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' };
      const derived = await crypto.subtle.deriveBits(params, keyMaterial, 256);
      return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  };
  APEXON.Auth = Auth;

  // ===== 3. 音频 =====
  const AudioManager = {
    ctx: null,
    enabled: true,
    _init() {
      if (this.ctx) return;
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.enabled = false; }
    },
    warmUp() {
      // 在用户首次交互时预热 AudioContext，避免首次播放阻塞测试计时
      this._init();
      if (this.ctx && this.ctx.state === 'suspended') {
        try { this.ctx.resume(); } catch (e) {}
      }
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

  // ===== 5. 在线状态追踪 =====
  const OnlineTracker = {
    timer: null,
    INTERVAL_MS: 30000,

    init(userId) {
      if (!userId) return;
      this.stop();
      this._boundUserId = userId;
      this._beat(userId);
      this.timer = setInterval(() => this._beat(userId), this.INTERVAL_MS);
      this._visibilityHandler = () => {
        if (!document.hidden) this._beat(userId);
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    },

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this._visibilityHandler) {
        document.removeEventListener('visibilitychange', this._visibilityHandler);
        this._visibilityHandler = null;
      }
    },

    async _beat(userId) {
      if (document.hidden) return;
      await DB.upsertOnline(userId);
    }
  };
  APEXON.OnlineTracker = OnlineTracker;

  // ===== 6. 工具函数 =====
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

  // ===== 7. UI 工具 =====
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

    injectAuthStyles() {
      if (document.getElementById('apex-auth-styles')) return;
      const style = document.createElement('style');
      style.id = 'apex-auth-styles';
      style.textContent = `
        .apex-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--apex-surface); color: var(--apex-text); padding: 10px 18px; border-radius: 12px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .25s ease, transform .25s ease; box-shadow: 0 8px 24px rgba(0,0,0,0.2); border: 1px solid var(--apex-border-subtle); z-index: 2000; }
        .apex-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
        .apex-user-menu { display: flex; align-items: center; margin-left: 12px; position: relative; }
        .apex-login-btn {
          border: none; border-radius: 20px; padding: 6px 16px; font-size: 13px; font-weight: 600;
          color: #fff; cursor: pointer; background: linear-gradient(135deg, #7C3AED 0%, #8B5CF6 40%, #60A5FA 100%);
          box-shadow: 0 4px 14px rgba(124, 58, 237, 0.35); transition: transform .15s ease, box-shadow .15s ease;
        }
        .apex-login-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(124, 58, 237, 0.45); }
        .apex-user-bar {
          display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 6px;
          border-radius: 24px; background: rgba(124, 58, 237, 0.1); border: 1px solid rgba(124, 58, 237, 0.2);
          cursor: pointer; transition: background .15s ease, box-shadow .15s ease; user-select: none;
        }
        .apex-user-bar:hover { background: rgba(124, 58, 237, 0.16); box-shadow: 0 4px 14px rgba(124, 58, 237, 0.15); }
        .apex-avatar-wrap { position: relative; width: 32px; height: 32px; flex-shrink: 0; }
        .apex-avatar { width: 32px; height: 32px; border-radius: 50%; overflow: hidden; background: linear-gradient(135deg, #7C3AED 0%, #60A5FA 100%); display: flex; align-items: center; justify-content: center; }
        .apex-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .apex-avatar svg { width: 22px; height: 22px; }
        .apex-mini-icon { width: 14px; height: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .apex-mini-icon svg { width: 100%; height: 100%; }
        .apex-user-name { font-size: 13px; font-weight: 600; color: var(--apex-text); max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .apex-user-caret { font-size: 10px; color: var(--apex-text-secondary); margin-left: 2px; }
        .apex-user-dropdown {
          position: absolute; top: calc(100% + 8px); right: 0; min-width: 150px;
          background: var(--apex-surface); border: 1px solid var(--apex-border-subtle);
          border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.2); padding: 6px;
          opacity: 0; pointer-events: none; transform: translateY(-6px); transition: opacity .2s ease, transform .2s ease; z-index: 1001;
        }
        .apex-user-dropdown.show { opacity: 1; pointer-events: auto; transform: translateY(0); }
        .apex-user-dropdown button {
          width: 100%; text-align: left; padding: 10px 14px; border: none; border-radius: 10px;
          background: transparent; color: var(--apex-text); font-size: 13px; cursor: pointer;
          transition: background .15s ease;
        }
        .apex-user-dropdown button:hover { background: rgba(124, 58, 237, 0.1); }
        .apex-user-dropdown button.danger { color: #ef4444; }
        .apex-user-dropdown button.danger:hover { background: rgba(239, 68, 68, 0.1); }
        .apex-login-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity .25s ease; }
        .apex-login-modal.show { opacity: 1; pointer-events: auto; }
        .apex-login-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); backdrop-filter: blur(4px); }
        .apex-login-card { position: relative; width: 92%; max-width: 360px; border-radius: 20px; padding: 28px 24px 24px; background: var(--apex-surface); box-shadow: 0 20px 50px rgba(0,0,0,0.25); overflow: hidden; transform: translateY(12px); transition: transform .25s ease; }
        .apex-login-modal.show .apex-login-card { transform: translateY(0); }
        .apex-login-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #7C3AED 0%, #8B5CF6 40%, #60A5FA 100%); }
        .apex-login-close { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border: none; border-radius: 50%; background: transparent; color: var(--apex-text-secondary); font-size: 18px; cursor: pointer; }
        .apex-login-close:hover { background: rgba(124, 58, 237, 0.1); color: #7C3AED; }
        .apex-login-header { text-align: center; margin-bottom: 20px; }
        .apex-login-logo { font-size: 22px; font-weight: 800; letter-spacing: 1px; background: linear-gradient(135deg, #7C3AED 0%, #60A5FA 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .apex-login-subtitle { font-size: 13px; color: var(--apex-text-secondary); margin-top: 4px; }
        .apex-login-tabs { display: flex; gap: 8px; margin-bottom: 16px; background: rgba(124, 58, 237, 0.08); border-radius: 12px; padding: 4px; }
        .apex-login-tab { flex: 1; border: none; border-radius: 10px; padding: 8px; font-size: 13px; font-weight: 600; color: var(--apex-text-secondary); background: transparent; cursor: pointer; }
        .apex-login-tab.active { background: var(--apex-surface); color: #7C3AED; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .apex-login-body { display: flex; flex-direction: column; gap: 12px; }
        .apex-login-body input { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(124, 58, 237, 0.2); background: rgba(124, 58, 237, 0.04); color: var(--apex-text); font-size: 14px; outline: none; }
        .apex-login-body input:focus { border-color: #8B5CF6; background: rgba(124, 58, 237, 0.08); }
        .apex-login-error { min-height: 18px; font-size: 12px; color: #ef4444; text-align: center; }
        .apex-login-submit { width: 100%; padding: 12px; border: none; border-radius: 12px; font-size: 14px; font-weight: 700; color: #fff; cursor: pointer; background: linear-gradient(135deg, #7C3AED 0%, #8B5CF6 40%, #60A5FA 100%); box-shadow: 0 4px 14px rgba(124, 58, 237, 0.35); transition: transform .15s ease, box-shadow .15s ease; }
        .apex-login-submit:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(124, 58, 237, 0.45); }
        .apex-login-submit:disabled { opacity: .7; cursor: not-allowed; transform: none; }
        .apex-password-wrap { position: relative; }
        .apex-password-wrap input { padding-right: 40px; }
        .apex-password-toggle {
          position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
          width: 28px; height: 28px; border: none; border-radius: 8px; background: transparent;
          color: var(--apex-text-secondary); font-size: 13px; cursor: pointer; display: flex;
          align-items: center; justify-content: center;
        }
        .apex-password-toggle:hover { background: rgba(124, 58, 237, 0.1); color: #7C3AED; }
        .apex-remember {
          display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--apex-text-secondary);
          cursor: pointer; user-select: none;
        }
        .apex-remember input { width: 16px; height: 16px; accent-color: #7C3AED; cursor: pointer; }
        .apex-hint { font-size: 12px; color: var(--apex-text-tertiary); min-height: 16px; }
        .apex-hint.invalid { color: #ef4444; }
        .apex-hint.valid { color: #10b981; }
        .apex-gender-group { margin-bottom: 12px; }
        .apex-gender-label { font-size: 12px; color: var(--apex-text-secondary); margin-bottom: 6px; }
        .apex-gender-options { display: flex; gap: 8px; }
        .apex-gender-option { flex: 1; position: relative; cursor: pointer; }
        .apex-gender-option input { position: absolute; opacity: 0; width: 0; height: 0; }
        .apex-gender-option span { display: block; text-align: center; padding: 10px 4px; border-radius: 12px; border: 1px solid rgba(124, 58, 237, 0.2); background: rgba(124, 58, 237, 0.04); color: var(--apex-text); font-size: 13px; transition: all .15s ease; }
        .apex-gender-option input:checked + span { border-color: #8B5CF6; background: rgba(124, 58, 237, 0.18); color: #7C3AED; font-weight: 600; box-shadow: 0 2px 8px rgba(124, 58, 237, 0.15); }
        .apex-gender-tip { font-size: 12px; color: var(--apex-text-tertiary); margin-top: 6px; line-height: 1.4; }
        .apex-terms { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--apex-text-secondary); cursor: pointer; user-select: none; margin-bottom: 12px; }
        .apex-terms input { width: 16px; height: 16px; accent-color: #7C3AED; cursor: pointer; margin-top: 2px; flex-shrink: 0; }
        .apex-terms a { color: #8B5CF6; text-decoration: none; }
        .apex-terms a:hover { text-decoration: underline; }
        .apex-profile-modal { position: fixed; inset: 0; z-index: 1002; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity .25s ease; }
        .apex-profile-modal.show { opacity: 1; pointer-events: auto; }
        .apex-profile-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); backdrop-filter: blur(4px); }
        .apex-profile-card { position: relative; width: 92%; max-width: 400px; max-height: 86vh; overflow-y: auto; border-radius: 20px; padding: 24px; background: var(--apex-surface); box-shadow: 0 20px 50px rgba(0,0,0,0.25); transform: translateY(12px); transition: transform .25s ease; }
        .apex-profile-modal.show .apex-profile-card { transform: translateY(0); }
        .apex-profile-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg, #7C3AED 0%, #8B5CF6 40%, #60A5FA 100%); }
        .apex-profile-close { position: absolute; top: 12px; right: 12px; width: 28px; height: 28px; border: none; border-radius: 50%; background: transparent; color: var(--apex-text-secondary); font-size: 18px; cursor: pointer; }
        .apex-profile-close:hover { background: rgba(124, 58, 237, 0.1); color: #7C3AED; }
        .apex-profile-header { display: flex; flex-direction: column; align-items: center; margin-bottom: 20px; }
        .apex-profile-avatar { width: 72px; height: 72px; border-radius: 50%; overflow: hidden; background: linear-gradient(135deg, #7C3AED 0%, #60A5FA 100%); display: flex; align-items: center; justify-content: center; margin-bottom: 10px; }
        .apex-profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .apex-profile-avatar svg { width: 44px; height: 44px; }
        .apex-profile-name { font-size: 18px; font-weight: 700; color: var(--apex-text); }
        .apex-profile-section { margin-bottom: 16px; }
        .apex-profile-label { font-size: 12px; color: var(--apex-text-secondary); margin-bottom: 4px; }
        .apex-profile-value { font-size: 14px; color: var(--apex-text); word-break: break-word; }
        .apex-profile-value a { color: #8B5CF6; text-decoration: none; }
        .apex-profile-value a:hover { text-decoration: underline; }
        .apex-profile-body input, .apex-profile-body textarea { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(124, 58, 237, 0.2); background: rgba(124, 58, 237, 0.04); color: var(--apex-text); font-size: 14px; outline: none; margin-bottom: 12px; }
        .apex-profile-body input:focus, .apex-profile-body textarea:focus { border-color: #8B5CF6; background: rgba(124, 58, 237, 0.08); }
        .apex-profile-body textarea { resize: vertical; min-height: 80px; font-family: inherit; }
        .apex-avatar-upload { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 16px; }
        .apex-avatar-upload input { display: none; }
        .apex-avatar-upload-label { cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .apex-avatar-upload-text { font-size: 12px; color: var(--apex-text-secondary); }
        .apex-profile-submit { width: 100%; padding: 12px; border: none; border-radius: 12px; font-size: 14px; font-weight: 700; color: #fff; cursor: pointer; background: linear-gradient(135deg, #7C3AED 0%, #8B5CF6 40%, #60A5FA 100%); box-shadow: 0 4px 14px rgba(124, 58, 237, 0.35); transition: transform .15s ease, box-shadow .15s ease; }
        .apex-profile-submit:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(124, 58, 237, 0.45); }
        .apex-profile-submit:disabled { opacity: .7; cursor: not-allowed; transform: none; }
        .apex-profile-error { min-height: 18px; font-size: 12px; color: #ef4444; text-align: center; margin-top: -4px; margin-bottom: 8px; }
        .leaderboard-avatar { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; background: linear-gradient(135deg, #7C3AED 0%, #60A5FA 100%); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; margin-right: 10px; }
        .leaderboard-avatar img { width: 100%; height: 100%; object-fit: cover; }
        .leaderboard-avatar svg { width: 18px; height: 18px; }
        @media (max-width: 480px) { .apex-login-card { padding: 24px 20px 20px; } .apex-user-name { max-width: 80px; } .apex-profile-card { padding: 20px; } }
      `;
      document.head.appendChild(style);
    },

    mountUserButton() {
      this.injectAuthStyles();
      const actions = document.querySelector('.header-actions');
      if (!actions) return;
      let menu = document.getElementById('apex-user-menu');
      if (menu) return;
      menu = document.createElement('div');
      menu.id = 'apex-user-menu';
      menu.className = 'apex-user-menu';
      actions.appendChild(menu);
      this.updateUserDisplay();
    },

    updateUserDisplay() {
      APEXON.OnlineTracker.init(APEXON.Auth.getUserId());

      const menu = document.getElementById('apex-user-menu');
      const forumTip = document.getElementById('forumLoginTip');
      const forumInput = document.getElementById('forumInputWrap');
      const personalContent = document.getElementById('personalContent');

      const isLoggedIn = APEXON.Auth.isLoggedIn();
      const name = APEXON.Auth.getUser() || '用户';
      const userId = APEXON.Auth.getUserId();

      if (menu) {
        const miniIcon = '<svg viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(124,58,237,0.3));"><defs><linearGradient id="miniGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#7C3AED"/><stop offset="100%" stop-color="#60A5FA"/></linearGradient></defs><path d="M12 2l10 6-10 6L2 8l10-6z" fill="url(#miniGrad)"/></svg>';
        if (!isLoggedIn) {
          menu.innerHTML = '<div class="apex-user-bar" id="apexUserBar"><div class="apex-avatar-wrap"><div class="apex-avatar">' + this._renderAvatarHTML(null) + '</div></div><div class="apex-mini-icon">' + miniIcon + '</div><span class="apex-user-name">' + Security.escapeHtml(name) + '</span><span class="apex-user-caret">▼</span></div><div class="apex-user-dropdown" id="apexUserDropdown"><button data-action="login">登录 / 注册</button></div>';
        } else {
          menu.innerHTML = '<div class="apex-user-bar" id="apexUserBar"><div class="apex-avatar-wrap"><div class="apex-avatar" id="apexHeaderAvatar">' + this._renderAvatarHTML(null) + '</div></div><div class="apex-mini-icon">' + miniIcon + '</div><span class="apex-user-name">' + Security.escapeHtml(name) + '</span><span class="apex-user-caret">▼</span></div><div class="apex-user-dropdown" id="apexUserDropdown"><button data-action="edit-profile">编辑资料</button><button data-action="change-username">修改用户名</button><button data-action="logout">退出账号</button><button data-action="delete-account" class="danger">注销账号</button></div>';
        }
        this._loadHeaderAvatar(userId);
        this._bindUserMenu();
      }

      if (!isLoggedIn) {
        if (forumTip) {
          forumTip.style.display = 'block';
          forumTip.textContent = '游客模式可正常使用全部功能，登录后可修改用户名与资料';
        }
        if (forumInput) forumInput.style.display = 'flex';
        document.dispatchEvent(new CustomEvent('apexon:userchange', { detail: { loggedIn: false } }));
        return;
      }

      if (forumTip) forumTip.style.display = 'none';
      if (forumInput) forumInput.style.display = 'flex';
      document.dispatchEvent(new CustomEvent('apexon:userchange', { detail: { loggedIn: true, user: name } }));
    },

    _renderAvatarHTML(avatarUrl) {
      if (avatarUrl) {
        return '<img src="' + Security.escapeHtml(avatarUrl) + '" alt="avatar" onerror="this.style.display=\'none\'; this.parentNode.classList.add(\'fallback\')">';
      }
      return '<svg viewBox="0 0 64 64" style="width:62%;height:62%;"><circle cx="32" cy="32" r="30" fill="#fff" fill-opacity="0.2"/><circle cx="32" cy="24" r="10" fill="#fff" fill-opacity="0.95"/><path d="M16 52c0-12 8-18 16-18s16 6 16 18" fill="#fff" fill-opacity="0.95"/></svg>';
    },

    async _loadHeaderAvatar(userId) {
      if (!userId) return;
      const profile = await DB.getProfile(userId);
      if (!profile || !profile.avatar_url) return;
      const avatarEl = document.getElementById('apexHeaderAvatar');
      if (avatarEl) avatarEl.innerHTML = this._renderAvatarHTML(profile.avatar_url);
    },

    _bindUserMenu() {
      const bar = document.getElementById('apexUserBar');
      const dropdown = document.getElementById('apexUserDropdown');
      if (!bar || !dropdown) return;
      bar.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('show');
      });
      dropdown.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          dropdown.classList.remove('show');
          const action = btn.dataset.action;
          if (action === 'login') this.showLoginModal();
          if (action === 'edit-profile') this.showProfileModal('edit', APEXON.Auth.getUserId());
          if (action === 'change-username') this.showChangeUsernameModal();
          if (action === 'logout') APEXON.Auth.logout();
          if (action === 'delete-account') APEXON.Auth.deleteAccount();
        });
      });
      const closeDropdown = (e) => {
        if (!e.target.closest('#apex-user-menu')) dropdown.classList.remove('show');
      };
      document.removeEventListener('click', this._dropdownCloser);
      document.addEventListener('click', closeDropdown);
      this._dropdownCloser = closeDropdown;
    },

    showProfileModal(mode, userId) {
      if (!userId) return;
      const isEdit = mode === 'edit' && userId === APEXON.Auth.getUserId();
      let modal = document.getElementById('apex-profile-modal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.id = 'apex-profile-modal';
      modal.className = 'apex-profile-modal';
      modal.innerHTML = '<div class="apex-profile-backdrop"></div><div class="apex-profile-card"><button class="apex-profile-close" id="apexProfileClose">×</button><div id="apexProfileBody"></div></div>';
      document.body.appendChild(modal);

      const close = () => modal.classList.remove('show');
      modal.querySelector('#apexProfileClose').addEventListener('click', close);
      modal.querySelector('.apex-profile-backdrop').addEventListener('click', close);

      const load = async () => {
        const profile = await DB.getProfile(userId);
        const username = profile && profile.username ? profile.username : userId;
        const body = modal.querySelector('#apexProfileBody');
        if (isEdit) {
          body.innerHTML = this._buildProfileEditHTML(profile, username);
          this._bindProfileEdit(profile, username);
        } else {
          body.innerHTML = this._buildProfileViewHTML(profile, username);
        }
        requestAnimationFrame(() => modal.classList.add('show'));
      };
      load();
    },

    _genderLabel(value) {
      if (value === 'male') return '男';
      if (value === 'female') return '女';
      return '保密';
    },

    _buildProfileViewHTML(profile, username) {
      const esc = Security.escapeHtml;
      const p = profile || {};
      const avatar = '<div class="apex-profile-avatar">' + this._renderAvatarHTML(p.avatar_url) + '</div>';
      const bio = p.bio || '这个人很懒，什么都没有写。';
      const location = p.location || '未知';
      const website = p.website ? '<a href="' + esc(p.website) + '" target="_blank" rel="noopener">' + esc(p.website) + '</a>' : '未填写';
      const social = p.social_links ? '<a href="' + esc(p.social_links) + '" target="_blank" rel="noopener">' + esc(p.social_links) + '</a>' : '未填写';
      return '<div class="apex-profile-header">' + avatar + '<div class="apex-profile-name">' + esc(username) + '</div></div>' +
        '<div class="apex-profile-section"><div class="apex-profile-label">性别</div><div class="apex-profile-value">' + esc(this._genderLabel(p.gender)) + '</div></div>' +
        '<div class="apex-profile-section"><div class="apex-profile-label">个人简介</div><div class="apex-profile-value">' + esc(bio) + '</div></div>' +
        '<div class="apex-profile-section"><div class="apex-profile-label">所在地</div><div class="apex-profile-value">' + esc(location) + '</div></div>' +
        '<div class="apex-profile-section"><div class="apex-profile-label">个人网站</div><div class="apex-profile-value">' + website + '</div></div>' +
        '<div class="apex-profile-section"><div class="apex-profile-label">社交链接</div><div class="apex-profile-value">' + social + '</div></div>';
    },

    _buildProfileEditHTML(profile, username) {
      const esc = Security.escapeHtml;
      const p = profile || {};
      const avatar = '<div class="apex-profile-avatar" id="apexEditAvatar">' + this._renderAvatarHTML(p.avatar_url) + '</div>';
      const genderChecked = (value) => p.gender === value ? ' checked' : '';
      const genderSelect = '<div class="apex-gender-group"><div class="apex-gender-label">性别</div><div class="apex-gender-options"><label class="apex-gender-option"><input type="radio" name="apexEditGender" value="male"' + genderChecked('male') + '><span>男</span></label><label class="apex-gender-option"><input type="radio" name="apexEditGender" value="female"' + genderChecked('female') + '><span>女</span></label><label class="apex-gender-option"><input type="radio" name="apexEditGender" value="secret"' + genderChecked('secret') + '><span>保密</span></label></div><div class="apex-gender-tip">建议选择真实性别，以便更准确地为各测试项目评级。</div></div>';
      return '<div class="apex-profile-header"><div class="apex-profile-name">' + esc(username) + '</div></div>' +
        '<div class="apex-avatar-upload"><label class="apex-avatar-upload-label" for="apexAvatarInput">' + avatar + '<span class="apex-avatar-upload-text">点击更换头像</span></label><input type="file" id="apexAvatarInput" accept="image/*"></div>' +
        '<div class="apex-profile-body">' +
        genderSelect +
        '<textarea id="apexEditBio" placeholder="个人简介（最多 200 字）" maxlength="200">' + esc(p.bio || '') + '</textarea>' +
        '<input type="text" id="apexEditLocation" placeholder="所在地" maxlength="80" value="' + esc(p.location || '') + '">' +
        '<input type="text" id="apexEditWebsite" placeholder="个人网站" maxlength="200" value="' + esc(p.website || '') + '">' +
        '<input type="text" id="apexEditSocial" placeholder="社交链接" maxlength="200" value="' + esc(p.social_links || '') + '">' +
        '<div class="apex-profile-error" id="apexProfileError"></div>' +
        '<button class="apex-profile-submit" id="apexProfileSubmit">保存资料</button>' +
        '</div>';
    },

    _bindProfileEdit(profile, username) {
      const fileInput = document.getElementById('apexAvatarInput');
      const avatarPreview = document.getElementById('apexEditAvatar');
      let pendingFile = null;
      if (fileInput && avatarPreview) {
        fileInput.addEventListener('change', () => {
          const file = fileInput.files[0];
          if (!file) return;
          if (file.size > 2 * 1024 * 1024) { UI.toast('头像大小不能超过 2MB'); return; }
          pendingFile = file;
          const url = URL.createObjectURL(file);
          avatarPreview.innerHTML = this._renderAvatarHTML(url);
        });
      }
      const submit = document.getElementById('apexProfileSubmit');
      if (submit) {
        submit.addEventListener('click', async () => {
          const errorEl = document.getElementById('apexProfileError');
          errorEl.textContent = '';
          submit.disabled = true;
          const genderEl = document.querySelector('input[name="apexEditGender"]:checked');
          const payload = {
            bio: document.getElementById('apexEditBio').value,
            location: document.getElementById('apexEditLocation').value,
            website: document.getElementById('apexEditWebsite').value,
            social: document.getElementById('apexEditSocial').value,
            gender: genderEl ? genderEl.value : 'secret'
          };
          if (pendingFile) {
            const avatarUrl = await DB.uploadAvatarToSupabase(APEXON.Auth.getUserId(), pendingFile);
            if (avatarUrl) payload.avatar_url = avatarUrl;
            else { errorEl.textContent = '头像上传失败'; submit.disabled = false; return; }
          }
          const saved = await DB.saveProfile(APEXON.Auth.getUserId(), APEXON.Auth.getUser(), payload);
          submit.disabled = false;
          if (saved) {
            UI.toast('资料已保存');
            this._loadHeaderAvatar(APEXON.Auth.getUserId());
            document.getElementById('apex-profile-modal').classList.remove('show');
          } else {
            errorEl.textContent = '保存失败，请重试';
          }
        });
      }
    },

    showChangeUsernameModal() {
      if (!APEXON.Auth.isLoggedIn()) return;
      let modal = document.getElementById('apex-username-modal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.id = 'apex-username-modal';
      modal.className = 'apex-profile-modal';
      modal.innerHTML = '<div class="apex-profile-backdrop"></div><div class="apex-profile-card"><button class="apex-profile-close" id="apexUsernameClose">×</button><div class="apex-profile-header"><div class="apex-profile-name">修改用户名</div></div><div class="apex-profile-body"><div class="apex-profile-section" style="margin-bottom:12px;"><div class="apex-profile-label">当前用户名</div><div class="apex-profile-value">' + Security.escapeHtml(APEXON.Auth.getUser()) + '</div></div><input type="text" id="apexNewUsername" placeholder="新用户名" maxlength="30"><div class="apex-hint" id="apexNewUsernameHint">2-30 位，支持中英文、数字、下划线</div><div class="apex-password-wrap" style="margin-top:12px;"><input type="password" id="apexUsernamePassword" placeholder="当前密码" maxlength="64"></div><div class="apex-profile-error" id="apexUsernameError"></div><button class="apex-profile-submit" id="apexUsernameSubmit">确认修改</button></div></div>';
      document.body.appendChild(modal);

      const close = () => modal.classList.remove('show');
      modal.querySelector('#apexUsernameClose').addEventListener('click', close);
      modal.querySelector('.apex-profile-backdrop').addEventListener('click', close);

      const nameInput = modal.querySelector('#apexNewUsername');
      const hint = modal.querySelector('#apexNewUsernameHint');
      const submit = modal.querySelector('#apexUsernameSubmit');
      const validate = () => {
        const err = APEXON.Auth._validateUsername(nameInput.value.trim());
        hint.textContent = err || (nameInput.value.trim() ? '格式正确' : '2-30 位，支持中英文、数字、下划线');
        hint.className = 'apex-hint' + (err ? ' invalid' : (nameInput.value.trim() ? ' valid' : ''));
        submit.disabled = !!err;
      };
      nameInput.addEventListener('input', validate);

      submit.addEventListener('click', async () => {
        const errorEl = document.getElementById('apexUsernameError');
        errorEl.textContent = '';
        submit.disabled = true;
        const newName = document.getElementById('apexNewUsername').value.trim();
        const password = document.getElementById('apexUsernamePassword').value;
        const result = await APEXON.Auth.changeUsername(newName, password);
        submit.disabled = false;
        if (result.success) {
          UI.toast('用户名已修改');
          modal.classList.remove('show');
          this.updateUserDisplay();
        } else {
          errorEl.textContent = result.error || '修改失败';
        }
      });

      requestAnimationFrame(() => modal.classList.add('show'));
      validate();
    },

    showLoginModal() {
      let modal = document.getElementById('apex-login-modal');
      if (modal) {
        modal.classList.add('show');
        return;
      }
      modal = document.createElement('div');
      modal.id = 'apex-login-modal';
      modal.className = 'apex-login-modal';
      modal.innerHTML = '<div class="apex-login-backdrop"></div><div class="apex-login-card"><button class="apex-login-close" id="apexLoginClose">×</button><div class="apex-login-header"><div class="apex-login-logo">APEXON</div><div class="apex-login-subtitle">游客模式可正常使用，登录后可修改用户名与资料</div></div><div class="apex-login-tabs"><button class="apex-login-tab active" data-tab="login">登录</button><button class="apex-login-tab" data-tab="register">注册</button></div><div class="apex-login-body"><input type="text" id="apexLoginUsername" placeholder="用户名" maxlength="30" autocomplete="username"><div class="apex-hint" id="apexUsernameHint">2-30 位，支持中英文、数字、下划线</div><div class="apex-password-wrap"><input type="password" id="apexLoginPassword" placeholder="密码" maxlength="64" autocomplete="current-password"><button class="apex-password-toggle" id="apexPasswordToggle" type="button" title="显示密码">显示</button></div><div class="apex-hint" id="apexPasswordHint">至少 8 位，同时包含字母和数字</div><div class="apex-password-wrap" id="apexConfirmWrap" style="display:none;"><input type="password" id="apexConfirmPassword" placeholder="确认密码" maxlength="64" autocomplete="new-password"></div><div class="apex-hint" id="apexConfirmHint" style="display:none;">请再次输入密码</div><div class="apex-gender-group" id="apexGenderGroup" style="display:none;"><div class="apex-gender-label">性别</div><div class="apex-gender-options"><label class="apex-gender-option"><input type="radio" name="apexGender" value="male"><span>男</span></label><label class="apex-gender-option"><input type="radio" name="apexGender" value="female"><span>女</span></label><label class="apex-gender-option"><input type="radio" name="apexGender" value="secret" checked><span>保密</span></label></div><div class="apex-gender-tip">建议选择真实性别，以便更准确地为各测试项目评级。</div></div><label class="apex-terms" id="apexTermsGroup" style="display:none;"><input type="checkbox" id="apexTerms"><span>我已阅读并同意 <a href="#" onclick="event.preventDefault();">服务条款</a> 和 <a href="#" onclick="event.preventDefault();">隐私政策</a></span></label><label class="apex-remember"><input type="checkbox" id="apexRememberMe"><span>记住我（30 天）</span></label><div class="apex-login-error" id="apexLoginError"></div><button class="apex-login-submit" id="apexLoginSubmit">登录</button></div></div>';
      document.body.appendChild(modal);

      const tabs = modal.querySelectorAll('.apex-login-tab');
      const submitBtn = modal.querySelector('#apexLoginSubmit');
      const errorEl = modal.querySelector('#apexLoginError');
      const usernameInput = modal.querySelector('#apexLoginUsername');
      const passwordInput = modal.querySelector('#apexLoginPassword');
      const usernameHint = modal.querySelector('#apexUsernameHint');
      const passwordHint = modal.querySelector('#apexPasswordHint');
      const rememberMe = modal.querySelector('#apexRememberMe');
      const toggleBtn = modal.querySelector('#apexPasswordToggle');
      const confirmWrap = modal.querySelector('#apexConfirmWrap');
      const confirmInput = modal.querySelector('#apexConfirmPassword');
      const confirmHint = modal.querySelector('#apexConfirmHint');
      const genderGroup = modal.querySelector('#apexGenderGroup');
      const termsGroup = modal.querySelector('#apexTermsGroup');
      const termsCheckbox = modal.querySelector('#apexTerms');
      let mode = 'login';

      const setMode = (m) => {
        mode = m;
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === m));
        submitBtn.textContent = m === 'login' ? '登录' : '注册';
        errorEl.textContent = '';
        const isRegister = m === 'register';
        confirmWrap.style.display = isRegister ? 'block' : 'none';
        confirmHint.style.display = isRegister ? 'block' : 'none';
        genderGroup.style.display = isRegister ? 'block' : 'none';
        termsGroup.style.display = isRegister ? 'flex' : 'none';
        if (!isRegister) {
          confirmInput.value = '';
          termsCheckbox.checked = false;
        }
        validate();
      };

      const getGender = () => {
        const checked = modal.querySelector('input[name="apexGender"]:checked');
        return checked ? checked.value : 'secret';
      };

      const validate = () => {
        const u = usernameInput.value.trim();
        const p = passwordInput.value;
        const nameErr = APEXON.Auth._validateUsername(u);
        const passErr = APEXON.Auth._validatePassword(p);
        usernameHint.textContent = nameErr || (u ? '格式正确' : '2-30 位，支持中英文、数字、下划线');
        usernameHint.className = 'apex-hint' + (nameErr ? ' invalid' : (u ? ' valid' : ''));
        passwordHint.textContent = passErr || (p ? '格式正确' : '至少 8 位，同时包含字母和数字');
        passwordHint.className = 'apex-hint' + (passErr ? ' invalid' : (p ? ' valid' : ''));

        let confirmErr = null;
        let termsErr = null;
        if (mode === 'register') {
          if (confirmInput.value !== p) confirmErr = '两次输入的密码不一致';
          if (!termsCheckbox.checked) termsErr = '请同意服务条款和隐私政策';
        }
        confirmHint.textContent = confirmErr || (mode === 'register' ? (confirmInput.value ? '密码一致' : '请再次输入密码') : '');
        confirmHint.className = 'apex-hint' + (confirmErr ? ' invalid' : (mode === 'register' && confirmInput.value ? ' valid' : ''));
        confirmHint.style.display = mode === 'register' ? 'block' : 'none';

        submitBtn.disabled = !!(nameErr || passErr || confirmErr || termsErr);
      };

      const togglePassword = () => {
        const isHidden = passwordInput.type === 'password';
        passwordInput.type = isHidden ? 'text' : 'password';
        toggleBtn.textContent = isHidden ? '隐藏' : '显示';
        toggleBtn.title = isHidden ? '隐藏密码' : '显示密码';
      };

      tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.tab)));
      modal.querySelector('#apexLoginClose').addEventListener('click', () => modal.classList.remove('show'));
      modal.querySelector('.apex-login-backdrop').addEventListener('click', () => modal.classList.remove('show'));
      usernameInput.addEventListener('input', validate);
      passwordInput.addEventListener('input', validate);
      toggleBtn.addEventListener('click', togglePassword);

      const doSubmit = async () => {
        const u = usernameInput.value.trim();
        const p = passwordInput.value;
        if (submitBtn.disabled) return;
        submitBtn.disabled = true;
        submitBtn.textContent = '处理中...';
        errorEl.textContent = '';
        const result = mode === 'login'
          ? await APEXON.Auth.login(u, p, rememberMe.checked)
          : await APEXON.Auth.register(u, p, rememberMe.checked, getGender());
        submitBtn.disabled = false;
        if (result.success) {
          modal.classList.remove('show');
          this.updateUserDisplay();
          this.toast(mode === 'login' ? '登录成功' : '注册成功');
          document.dispatchEvent(new CustomEvent('apexon:userchange', { detail: { loggedIn: true, user: APEXON.Auth.getUser() } }));
        } else {
          submitBtn.textContent = mode === 'login' ? '登录' : '注册';
          errorEl.textContent = result.error || '操作失败';
        }
      };

      submitBtn.addEventListener('click', doSubmit);
      passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
        if (mode === 'register') confirmInput.focus();
        else doSubmit();
      }});
      confirmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
      confirmInput.addEventListener('input', validate);
      termsCheckbox.addEventListener('change', validate);
      modal.querySelectorAll('input[name="apexGender"]').forEach(r => r.addEventListener('change', validate));
      usernameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passwordInput.focus(); });

      validate();
      requestAnimationFrame(() => modal.classList.add('show'));
    },

    backHome() {
      document.body.style.opacity = '0';
      setTimeout(() => { location.href = 'index.html'; }, 300);
    }
  };
  APEXON.UI = UI;

  // ===== 8. 粒子背景系统 =====
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

  // ===== 9. 测试引擎 =====
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

          const saved = await DB.saveScore(APEXON.Auth.getUserId(), APEXON.Auth.getUser(), 'type', { avg: avgTime, accuracy: avgAcc, wpm: avgWpm, cpm: avgCpm });
          if (!saved) UI.toast('数据保存失败，请重试');

          AudioManager.playSuccess();
          Utils.vibrate(30);
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
        let frameStartTime = 0;
        let isProcessing = false;
        let lastClickTime = 0;

        const updateProgress = () => {
          if (progressFill) progressFill.style.width = (currentRound / this.TOTAL_ROUNDS * 100) + '%';
          if (progressText) progressText.textContent = currentRound + ' / ' + this.TOTAL_ROUNDS;
        };

        const renderHistory = async () => {
          if (!historyContent) return;
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

          const saved = await DB.saveScore(APEXON.Auth.getUserId(), APEXON.Auth.getUser(), 'reaction', { avg: avg.toFixed(2), times: timeList, fouls: foulCount });
          if (!saved) UI.toast('数据保存失败，请重试');

          AudioManager.playSuccess();
          Utils.vibrate(30);
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
          if (now - lastClickTime < 80) return;
          lastClickTime = now;

          // 首次交互时预热音频上下文，避免第一轮因创建 AudioContext 产生额外延迟
          AudioManager.warmUp();

          switch (state) {
            case this.STATE_IDLE: {
              box.textContent = `第${currentRound + 1}/${this.TOTAL_ROUNDS}轮\n等待变绿`;
              state = this.STATE_WAITING;
              box.className = 'reaction-click-area waiting';
              const wait = Math.floor(Math.random() * (this.MAX_WAIT_MS - this.MIN_WAIT_MS + 1)) + this.MIN_WAIT_MS;
              timer = setTimeout(() => {
                // 单次 rAF 即可同步样式与计时，双重 rAF 会引入额外一帧延迟
                requestAnimationFrame(() => {
                  frameStartTime = performance.now();
                  box.className = 'reaction-click-area green';
                  box.textContent = '立刻点击！';
                  state = this.STATE_CLICK;
                  AudioManager.playTick();
                });
              }, wait);
              break;
            }
            case this.STATE_WAITING: {
              resetAll();
              isProcessing = true;
              foulCount++;
              timeList.push(null); // 记录本轮为违规跳过
              box.className = 'reaction-click-area foul';
              box.textContent = '提前点击，本轮跳过';
              AudioManager.playFail();
              timer = setTimeout(() => { isProcessing = false; advanceRound(); }, 900);
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
              AudioManager.playSuccess();
              Utils.vibrate(15);
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

  // ===== 10. 全局接口 =====
  global.backHome = UI.backHome;
  global.APEXON.logout = Auth.logout.bind(Auth);
  global.APEXON.deleteAccount = Auth.deleteAccount.bind(Auth);

  // ===== 11. 全局防复制/防选中（输入框除外）=====
  function initTextProtection() {
    const isEditable = (target) => !!target && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable ||
      target.closest('input, textarea, [contenteditable="true"]')
    );

    document.addEventListener('selectstart', (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    });

    document.addEventListener('copy', (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    });

    document.addEventListener('cut', (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    });

    document.addEventListener('paste', (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    });

    document.addEventListener('keydown', (e) => {
      if (isEditable(e.target)) return;
      const key = e.key.toLowerCase();
      // 仅拦截与复制、粘贴、全选相关的快捷键
      if ((e.ctrlKey || e.metaKey) && ['c', 'v', 'x', 'a'].includes(key)) {
        e.preventDefault();
      }
    });
  }

  // ===== 12. 初始化 =====
  async function boot() {
    VisibilityManager.init();
    UI.initTheme();
    Auth.init();
    await Auth.validateSession();
    OnlineTracker.init(Auth.getUserId());
    UI.mountUserButton();
    initTextProtection();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window);
