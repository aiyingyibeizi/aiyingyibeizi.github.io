/**
 * APEXON 测试系统 — 安全核心模块 v2.0
 * 防御层：XSS过滤 / 暴力破解防护 / 数据校验 / 密码哈希 / 输入过滤 / 防篡改签名
 */

(function (global) {
    'use strict';
    const APEXON = global.APEXON = global.APEXON || {};

    // ===== 0. 安全工具层 =====
    const Security = {
        // HTML 实体转义（核心 XSS 防御）
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

        // 危险内容过滤（用于评论/反馈/用户名）
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

        // 数据校验（防止篡改数据写入）
        validateRecord(type, data) {
            if (!data || typeof data !== 'object') return false;
            if (type === 'reaction') {
                const avg = parseFloat(data.avg);
                if (isNaN(avg) || avg < 0 || avg > 5000) return false;
                if (data.times && !Array.isArray(data.times)) return false;
                if (data.times) {
                    for (const t of data.times) { const v = parseFloat(t); if (isNaN(v) || v < 0 || v > 5000) return false; }
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
            return false;
        },

        // 防篡改签名（纯前端深度防御）
        signData(data) {
            const str = JSON.stringify(data);
            let h = 0;
            for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
            return Math.abs(h).toString(36);
        },

        verifyData(data, sig) { return this.signData(data) === sig; }
    };
    APEXON.Security = Security;

    // ===== 1. 暴力破解防护（基于 localStorage） =====
    const BruteForceGuard = {
        KEY: 'apexon_brute_guard',
        MAX_ATTEMPTS: 5,
        LOCKOUT_MS: 15 * 60 * 1000,

        _get() {
            try { const raw = localStorage.getItem(this.KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
        },
        _set(data) { localStorage.setItem(this.KEY, JSON.stringify(data)); },

        recordAttempt(success) {
            const now = Date.now();
            let data = this._get();
            if (success) { data = { count: 0, lockedUntil: 0 }; }
            else {
                data.count = (data.count || 0) + 1;
                if (data.count >= this.MAX_ATTEMPTS) { data.lockedUntil = now + this.LOCKOUT_MS; data.count = 0; }
            }
            this._set(data);
        },

        isLocked() {
            const data = this._get();
            if (data.lockedUntil && Date.now() < data.lockedUntil) return true;
            if (data.lockedUntil && Date.now() >= data.lockedUntil) { this._set({ count: 0, lockedUntil: 0 }); }
            return false;
        },

        getLockInfo() {
            const data = this._get();
            if (data.lockedUntil && Date.now() < data.lockedUntil) {
                return { locked: true, remainingSeconds: Math.ceil((data.lockedUntil - Date.now()) / 1000) };
            }
            return { locked: false };
        }
    };

    // ===== 2. 账号管理器（安全增强版） =====
    const AccountManager = {
        ACCOUNTS_KEY: 'apexon_accounts',
        LOGIN_KEY: 'apexon_login',
        EXPIRE_DAYS: 30,

        validatePassword(password) {
            const errors = [];
            const p = password || '';
            if (p.length < 8) errors.push('密码至少8位');
            if (!/[a-zA-Z]/.test(p)) errors.push('需包含字母');
            if (!/\d/.test(p)) errors.push('需包含数字');
            return { valid: errors.length === 0, errors };
        },

        // 增强哈希：盐 + 1000轮迭代混合
        _hash(password, salt) {
            if (!salt) salt = 'default';
            let result = password + salt;
            for (let round = 0; round < 1000; round++) {
                let h1 = 0, h2 = 0, h3 = 0;
                for (let i = 0; i < result.length; i++) {
                    h1 = ((h1 << 5) - h1 + result.charCodeAt(i)) | 0;
                    h2 = ((h2 << 3) ^ h2 + result.charCodeAt(i) * 31) | 0;
                    h3 = ((h3 << 7) + h3 - result.charCodeAt(i) * 17) | 0;
                }
                result = Math.abs(h1).toString(36) + ':' + Math.abs(h2).toString(16) + ':' + Math.abs(h3).toString(32) + ':' + salt + ':' + round;
            }
            return 's2:' + result;
        },

        // 旧版哈希（兼容旧数据）
        _hashOld(password) {
            let h = 0;
            const p = password || '';
            for (let i = 0; i < p.length; i++) { h = ((h << 5) - h) + p.charCodeAt(i); h |= 0; }
            return 'h' + Math.abs(h).toString(36);
        },

        _getAccounts() {
            try { const raw = localStorage.getItem(this.ACCOUNTS_KEY); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
        },
        _saveAccounts(accounts) { localStorage.setItem(this.ACCOUNTS_KEY, JSON.stringify(accounts)); },

        register(username, password) {
            if (BruteForceGuard.isLocked()) {
                const info = BruteForceGuard.getLockInfo();
                return { success: false, message: '尝试次数过多，请' + Math.ceil(info.remainingSeconds / 60) + '分钟后重试' };
            }
            const name = Security.filterDangerous((username || '').trim()).slice(0, 20);
            if (!name) return { success: false, message: '请输入用户名' };
            if (name.length < 2) return { success: false, message: '用户名至少2位' };
            const passCheck = this.validatePassword(password);
            if (!passCheck.valid) return { success: false, message: passCheck.errors.join('，') };
            const accounts = this._getAccounts();
            if (accounts[name]) return { success: false, message: '用户名已被注册' };
            accounts[name] = { password: this._hash(password, name), created: Date.now() };
            this._saveAccounts(accounts);
            this._doLogin(name, true);
            BruteForceGuard.recordAttempt(true);
            return { success: true, message: '注册成功' };
        },

        login(username, password, remember) {
            if (BruteForceGuard.isLocked()) {
                const info = BruteForceGuard.getLockInfo();
                return { success: false, message: '尝试次数过多，请' + Math.ceil(info.remainingSeconds / 60) + '分钟后重试' };
            }
            const name = (username || '').trim();
            if (!name) return { success: false, message: '请输入用户名' };
            if (!password) return { success: false, message: '请输入密码' };
            const accounts = this._getAccounts();
            const account = accounts[name];
            if (!account) { BruteForceGuard.recordAttempt(false); return { success: false, message: '用户名或密码错误' }; }
            const newHash = this._hash(password, name);
            const oldHash = this._hashOld(password);
            let matched = false;
            if (account.password === newHash) { matched = true; }
            else if (account.password === oldHash) { matched = true; account.password = newHash; this._saveAccounts(accounts); }
            if (!matched) { BruteForceGuard.recordAttempt(false); return { success: false, message: '用户名或密码错误' }; }
            BruteForceGuard.recordAttempt(true);
            this._doLogin(name, remember);
            return { success: true, message: '登录成功' };
        },

        _doLogin(username, remember) {
            const expire = remember ? Date.now() + this.EXPIRE_DAYS * 24 * 60 * 60 * 1000 : Date.now() + 24 * 60 * 60 * 1000;
            localStorage.setItem(this.LOGIN_KEY, JSON.stringify({ username, expire, remember: !!remember }));
        },

        isLoggedIn() {
            try {
                const raw = localStorage.getItem(this.LOGIN_KEY);
                if (!raw) return false;
                const data = JSON.parse(raw);
                if (data.timestamp && !data.expire) { data.expire = data.timestamp + this.EXPIRE_DAYS * 24 * 60 * 60 * 1000; localStorage.setItem(this.LOGIN_KEY, JSON.stringify(data)); }
                return Date.now() < data.expire;
            } catch (e) { return false; }
        },

        getUser() {
            try {
                const raw = localStorage.getItem(this.LOGIN_KEY);
                if (!raw) return null;
                const data = JSON.parse(raw);
                if (data.timestamp && !data.expire) { data.expire = data.timestamp + this.EXPIRE_DAYS * 24 * 60 * 60 * 1000; localStorage.setItem(this.LOGIN_KEY, JSON.stringify(data)); }
                return Date.now() < data.expire ? data.username : null;
            } catch (e) { return null; }
        },

        logout() { localStorage.removeItem(this.LOGIN_KEY); },

        deleteAccount() {
            const user = this.getUser();
            if (!user) return;
            const accounts = this._getAccounts();
            delete accounts[user];
            this._saveAccounts(accounts);
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key && key.includes('_' + user + '_')) keys.push(key); }
            keys.forEach(k => localStorage.removeItem(k));
            this.logout();
        }
    };
    APEXON.Account = AccountManager;

    // ===== 3. 数据存储（安全增强版） =====
    const StorageManager = {
        MAX_HISTORY: 50,

        _userKey(suffix) { const user = AccountManager.getUser() || 'guest'; return 'apexon_' + user + '_' + suffix; },
        _globalKey(suffix) { return 'apexon_all_' + suffix; },

        _get(key, def) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : def; } catch (e) { return def; } },
        _set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },

        saveRecord(type, data) {
            const user = AccountManager.getUser();
            if (!user) return;
            if (!Security.validateRecord(type, data)) { console.warn('[SECURITY] Invalid record rejected:', type, data); return; }
            const signedData = { ...data, _sig: Security.signData(data) };
            const hKey = this._userKey(type + '_history');
            const history = this._get(hKey, []);
            const record = { id: Date.now(), timestamp: new Date().toISOString(), date: new Date().toLocaleString('zh-CN'), ...signedData };
            history.unshift(record);
            if (history.length > this.MAX_HISTORY) history.length = this.MAX_HISTORY;
            this._set(hKey, history);
            this._updateBest(type, signedData);
            this._updateLeaderboard(user, type, signedData);
        },

        _updateBest(type, data) {
            const bKey = this._userKey(type + '_best');
            const current = this._get(bKey, null);
            const score = data.avg || data.score || 0;
            const isBetter = !current || score < (current.avg || current.score || Infinity);
            if (isBetter) this._set(bKey, { ...data, timestamp: Date.now() });
        },

        _updateLeaderboard(user, type, data) {
            const lKey = this._globalKey('scores');
            const board = this._get(lKey, {});
            if (!board[user]) board[user] = {};
            const score = data.avg || data.score || 0;
            const current = board[user][type];
            const isBetter = !current || score < (current.avg || current.score || Infinity);
            if (isBetter) { board[user][type] = { ...data, timestamp: Date.now() }; this._set(lKey, board); }
        },

        getHistory(type, limit) { return this._get(this._userKey(type + '_history'), []).slice(0, limit || 10); },
        getBest(type) { return this._get(this._userKey(type + '_best'), null); },

        getStats(type) {
            const history = this.getHistory(type, 9999);
            if (!history.length) return null;
            return { totalCount: history.length, avg: history.reduce((s, r) => s + (r.avg || r.score || 0), 0) / history.length, best: this.getBest(type), last: history[0] };
        },

        getLeaderboard(type, limit) {
            const lKey = this._globalKey('scores');
            const board = this._get(lKey, {});
            const entries = Object.entries(board).map(([user, scores]) => { const s = scores[type]; if (!s) return null; return { user, ...s }; }).filter(Boolean);
            entries.sort((a, b) => { const aVal = a.avg || a.score || 0; const bVal = b.avg || b.score || 0; return type === 'stick' ? bVal - aVal : aVal - bVal; });
            return entries.slice(0, limit || 10);
        }
    };
    APEXON.Storage = StorageManager;

    // ===== 4. 讨论区（安全增强版） =====
    const CommentManager = {
        KEY: 'apexon_comments',
        add(text) {
            const user = AccountManager.getUser();
            if (!user) return { success: false, message: '请先登录' };
            let content = Security.filterDangerous((text || '').trim());
            if (!content) return { success: false, message: '内容不能为空' };
            if (content.length > 500) return { success: false, message: '内容最多500字' };
            const list = this._get();
            list.unshift({ id: Date.now(), user, content, time: new Date().toLocaleString('zh-CN') });
            if (list.length > 200) list.length = 200;
            this._set(list);
            return { success: true };
        },
        get(limit) { return this._get().slice(0, limit || 50); },
        _get() { try { const raw = localStorage.getItem(this.KEY); return raw ? JSON.parse(raw) : []; } catch (e) { return []; } },
        _set(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); }
    };
    APEXON.Comment = CommentManager;

    // ===== 5. 反馈（安全增强版） =====
    const FeedbackManager = {
        KEY: 'apexon_feedback',
        EMAIL: 'luoyangmengjin2025@163.com',
        add(name, email, content) {
            let n = Security.filterDangerous((name || '').trim());
            let e = Security.filterDangerous((email || '').trim());
            let c = Security.filterDangerous((content || '').trim());
            if (!n) return { success: false, message: '请填写姓名' };
            if (!e) return { success: false, message: '请填写邮箱' };
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { success: false, message: '邮箱格式不正确' };
            if (!c) return { success: false, message: '请填写反馈内容' };
            if (c.length > 2000) return { success: false, message: '内容最多2000字' };
            const list = this._get();
            list.unshift({ id: Date.now(), name: n, email: e, content: c, time: new Date().toLocaleString('zh-CN') });
            if (list.length > 100) list.length = 100;
            this._set(list);
            return { success: true };
        },
        get() { return this._get(); },
        _get() { try { const raw = localStorage.getItem(this.KEY); return raw ? JSON.parse(raw) : []; } catch (e) { return []; } },
        _set(list) { localStorage.setItem(this.KEY, JSON.stringify(list)); }
    };
    APEXON.Feedback = FeedbackManager;

    // ===== 6. 音频管理器 =====
    const AudioManager = {
        ctx: null, enabled: true,
        _init() { if (this.ctx) return; try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.enabled = false; } },
        play(freq, dur, type) {
            if (!this.enabled) return;
            this._init(); if (!this.ctx) return;
            const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
            o.connect(g); g.connect(this.ctx.destination);
            o.type = type || 'sine';
            o.frequency.setValueAtTime(freq, this.ctx.currentTime);
            g.gain.setValueAtTime(0.1, this.ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
            o.start(); o.stop(this.ctx.currentTime + dur);
        },
        playClick() { this.play(800, 0.1); },
        playSuccess() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.play(f, 0.3), i * 80)); },
        playFail() {
            this._init(); if (!this.ctx) return;
            const o = this.ctx.createOscillator(), g = this.ctx.createGain();
            o.connect(g); g.connect(this.ctx.destination);
            o.type = 'sawtooth';
            o.frequency.setValueAtTime(300, this.ctx.currentTime);
            o.frequency.exponentialRampToValueAtTime(150, this.ctx.currentTime + 0.3);
            g.gain.setValueAtTime(0.1, this.ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
            o.start(); o.stop(this.ctx.currentTime + 0.3);
        },
        playTick() { this.play(1000, 0.05, 'square'); }
    };
    APEXON.Audio = AudioManager;

    // ===== 7. 页面可见性 =====
    const VisibilityManager = {
        callbacks: [], isVisible: true,
        init() { document.addEventListener('visibilitychange', () => { this.isVisible = !document.hidden; this.callbacks.forEach(cb => cb(this.isVisible)); }); },
        onChange(cb) { this.callbacks.push(cb); }
    };
    APEXON.Visibility = VisibilityManager;

    // ===== 8. 工具函数 =====
    const Utils = {
        debounce(fn, ms) { let timer; return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); }; },
        throttle(fn, ms) { let last = 0; return function (...args) { const now = Date.now(); if (now - last >= ms) { last = now; fn.apply(this, args); } }; },
        vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); },
        reactionPenalty() { const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0; return isTouch ? 30 : 10; },
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

    // ===== 9. 全局接口 =====
    global.backHome = function () { document.body.style.opacity = '0'; setTimeout(() => { location.href = 'index.html'; }, 300); };
    global.APEXON.logout = function () { AccountManager.logout(); location.reload(); };
    global.APEXON.deleteAccount = function () { if (confirm('确定注销账号？所有数据将被删除，不可恢复。')) { AccountManager.deleteAccount(); location.reload(); } };

    // ===== 10. 初始化 =====
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => { VisibilityManager.init(); }); }
    else { VisibilityManager.init(); }

})(window);
