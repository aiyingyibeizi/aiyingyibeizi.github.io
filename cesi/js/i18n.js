/**
 * APEXON 国际化模块 i18n
 * 支持多语言切换，国旗 + 语言名选择器，localStorage 持久化
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'apexon_lang';

  const LANGUAGES = [
    { code: 'zh', name: '中文', flag: '🇨🇳' },
    { code: 'en', name: 'English', flag: '🇬🇧' }
  ];

  const DEFAULT_LANG = 'zh';

  // 翻译字典：key 尽量语义化，对应 data-i18n 属性
  const TRANSLATIONS = {
    zh: {
      // 页面标题 / meta
      siteTitle: 'APEXON — 全能能力测试',
      // header 导航
      navHome: '首页',
      navReaction: '反应测试',
      navType: '打字测试',
      navStick: '注意力测试',
      navNumber: '数字记忆',
      navVerbal: '单词记忆',
      navVisual: '视觉记忆',
      navAim: '瞄准训练',
      navSequence: '序列记忆',
      menuOpen: '打开菜单',
      themeToggle: '切换深色/明亮主题',
      // 首页 hero
      heroTitle: 'APEXON',
      heroTagline: '全能能力测试系统 · 挑战人类极限',
      statOnline: '在线人数',
      statTotalUsers: '总玩家数量',
      statTotalTests: '总测试数',
      // 搜索框
      searchPlaceholder: '输入关键词，搜索全世界',
      searchButton: '搜索',
      // 测试卡片
      cardReactionTitle: '反应时间测试',
      cardReactionDesc: '测试你的神经反应速度，毫秒级精准测量',
      cardTypeTitle: '打字训练测试',
      cardTypeDesc: '提升打字速度与准确度，挑战中文输入极限',
      cardStickTitle: '持续注意力测试',
      cardStickDesc: '60秒专注力挑战，追踪你的注意力曲线',
      cardNumberTitle: '数字记忆测试',
      cardNumberDesc: '挑战数字记忆广度，逐级突破记忆极限',
      cardVerbalTitle: '单词记忆测试',
      cardVerbalDesc: '辨别新旧词汇，评估言语工作记忆能力',
      cardVisualTitle: '视觉记忆测试',
      cardVisualDesc: '记住闪烁方块位置，锻炼空间视觉记忆',
      cardAimTitle: '瞄准训练',
      cardAimDesc: '快速精准点击目标，提升手眼协调',
      cardSequenceTitle: '序列记忆测试',
      cardSequenceDesc: '复现闪烁顺序，训练短时序列记忆',
      // 排行榜
      leaderboardTitle: '🏆 排行榜',
      lbReaction: '反应',
      lbType: '打字',
      lbStick: '注意力',
      lbNumber: '数字',
      lbVerbal: '单词',
      lbVisual: '视觉',
      lbAim: '瞄准',
      lbSequence: '序列',
      lbEmpty: '还没有人上榜',
      // 讨论区 / 成绩
      discussionTitle: '💬 玩家讨论区',
      discussionEmpty: '还没有讨论，来做第一个发言的人吧',
      myScoresTitle: '📊 我的成绩',
      myScoresEmpty: '暂无成绩，快去测试一下吧',
      // 通用
      loading: '加载中...',
      online: '在线',
      offline: '离线',
      submit: '提交',
      cancel: '取消',
      confirm: '确认',
      close: '关闭',
      // 用户资料弹窗（common.js 使用）
      profileTitle: '我的资料',
      editProfile: '编辑资料',
      editUsername: '修改用户名',
      logoutAccount: '退出账号',
      deleteAccount: '注销账号',
      selectAvatar: '选择头像',
      saveProfile: '保存资料',
      save: '保存',
      logout: '退出登录',
      login: '登录',
      register: '注册',
      loginRegister: '登录 / 注册',
      loginSuccess: '登录成功',
      registerSuccess: '注册成功',
      profileSaved: '资料已保存',
      saveFailed: '保存失败，请重试',
      saveScoreFailed: '数据保存失败，请重试',
      pleaseLogin: '请先登录',
      publishFailed: '发布失败，请检查网络或稍后重试（详细错误请查看控制台）',
      registerFailed: '注册失败，请重试',
      loginFailed: '登录失败，请重试',
      guestModeTip: '游客模式可正常使用全部功能，登录后可修改用户名与资料',
      confirmLogout: '确定删除本地登录状态？数据库中的成绩仍会保留。',
      operationFailed: '操作失败',
      // 测试页面通用
      startTest: '开始测试',
      testAgain: '再测一次',
      yourResult: '你的成绩',
      bestRecord: '最佳纪录',
      // 页脚
      footerPrivacy: '隐私政策',
      footerTerms: '服务条款'
    },
    en: {
      siteTitle: 'APEXON — Cognitive Ability Tests',
      navHome: 'Home',
      navReaction: 'Reaction',
      navType: 'Typing',
      navStick: 'Attention',
      navNumber: 'Number Memory',
      navVerbal: 'Verbal Memory',
      navVisual: 'Visual Memory',
      navAim: 'Aim Training',
      navSequence: 'Sequence Memory',
      menuOpen: 'Open menu',
      themeToggle: 'Toggle dark/light theme',
      heroTitle: 'APEXON',
      heroTagline: 'All-in-One Cognitive Ability Testing System',
      statOnline: 'Online',
      statTotalUsers: 'Players',
      statTotalTests: 'Tests',
      searchPlaceholder: 'Search the world...',
      searchButton: 'Search',
      cardReactionTitle: 'Reaction Time Test',
      cardReactionDesc: 'Measure your neural reaction speed in milliseconds',
      cardTypeTitle: 'Typing Test',
      cardTypeDesc: 'Improve typing speed and accuracy',
      cardStickTitle: 'Attention Test',
      cardStickDesc: '60-second focus challenge',
      cardNumberTitle: 'Number Memory Test',
      cardNumberDesc: 'Challenge your digit span memory',
      cardVerbalTitle: 'Verbal Memory Test',
      cardVerbalDesc: 'Distinguish new words from seen words',
      cardVisualTitle: 'Visual Memory Test',
      cardVisualDesc: 'Remember flashing block positions',
      cardAimTitle: 'Aim Training',
      cardAimDesc: 'Click targets fast and accurately',
      cardSequenceTitle: 'Sequence Memory Test',
      cardSequenceDesc: 'Reproduce flashing sequences',
      leaderboardTitle: '🏆 Leaderboard',
      lbReaction: 'Reaction',
      lbType: 'Typing',
      lbStick: 'Attention',
      lbNumber: 'Number',
      lbVerbal: 'Verbal',
      lbVisual: 'Visual',
      lbAim: 'Aim',
      lbSequence: 'Sequence',
      lbEmpty: 'No scores yet. Be the first!',
      discussionTitle: '💬 Discussion',
      discussionEmpty: 'No comments yet. Start the conversation!',
      myScoresTitle: '📊 My Scores',
      myScoresEmpty: 'No scores yet. Take a test!',
      loading: 'Loading...',
      online: 'Online',
      offline: 'Offline',
      submit: 'Submit',
      cancel: 'Cancel',
      confirm: 'Confirm',
      close: 'Close',// 用户资料弹窗（common.js 使用）
      profileTitle: 'My Profile',
      editProfile: 'Edit Profile',
      editUsername: 'Edit Username',
      logoutAccount: 'Logout',
      deleteAccount: 'Delete Account',
      selectAvatar: 'Select Avatar',
      saveProfile: 'Save Profile',
      save: 'Save',
      logout: 'Logout',
      login: 'Login',
      register: 'Register',
      loginRegister: 'Login / Register',
      loginSuccess: 'Login successful',
      registerSuccess: 'Registration successful',
      profileSaved: 'Profile saved',
      saveFailed: 'Save failed, please try again',
      saveScoreFailed: 'Failed to save score, please try again',
      pleaseLogin: 'Please log in first',
      publishFailed: 'Publish failed, please check your network or try again later (see console for details)',
      registerFailed: 'Registration failed, please try again',
      loginFailed: 'Login failed, please try again',
      guestModeTip: 'Guest mode has full access. Log in to edit username and profile.',
      confirmLogout: 'Are you sure you want to clear local login state? Your scores in the database will be retained.',
      operationFailed: 'Operation failed',
      startTest: 'Start Test',
      testAgain: 'Try Again',
      yourResult: 'Your Result',
      bestRecord: 'Best Record',
      footerPrivacy: 'Privacy Policy',
      footerTerms: 'Terms of Service'
    }
  };

  const i18n = {
    current: DEFAULT_LANG,

    init() {
      const saved = localStorage.getItem(STORAGE_KEY);
      const preferred = saved || this.detectBrowserLang();
      this.setLang(preferred, false);
      this.injectSelector();
      this.apply();
    },

    detectBrowserLang() {
      const lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
      return lang.startsWith('zh') ? 'zh' : 'en';
    },

    setLang(lang, persist = true) {
      if (!TRANSLATIONS[lang]) lang = DEFAULT_LANG;
      this.current = lang;
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      if (persist) localStorage.setItem(STORAGE_KEY, lang);
      this.apply();
      this.updateSelector();
    },

    t(key, fallback) {
      const value = TRANSLATIONS[this.current]?.[key];
      return value !== undefined ? value : (fallback !== undefined ? fallback : key);
    },

    apply() {
      // 翻译所有 data-i18n 元素
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const text = this.t(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          if (el.placeholder) el.placeholder = text;
        } else if (el.title) {
          // 保留 title 提示，只替换文本内容
          if (el.childNodes.length && el.childNodes[0].nodeType === Node.TEXT_NODE) {
            el.childNodes[0].textContent = text;
          } else {
            el.textContent = text;
          }
        } else {
          el.textContent = text;
        }
      });

      // 翻译 placeholder
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = this.t(key);
      });

      // 翻译 title
      document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.title = this.t(key);
      });

      // 页面标题
      const titleKey = document.querySelector('title[data-i18n]');
      if (titleKey) {
        document.title = this.t(titleKey.getAttribute('data-i18n'));
      }
    },

    injectSelector() {
      if (document.getElementById('apexon-lang-selector')) return;

      const wrapper = document.createElement('div');
      wrapper.id = 'apexon-lang-selector';
      wrapper.className = 'apexon-lang-selector';

      const current = LANGUAGES.find(l => l.code === this.current) || LANGUAGES[0];

      wrapper.innerHTML = `
        <button class="apexon-lang-selector__btn" aria-haspopup="true" aria-expanded="false" aria-label="选择语言">
          <span class="apexon-lang-selector__flag">${current.flag}</span>
          <span class="apexon-lang-selector__name">${current.name}</span>
          <span class="apexon-lang-selector__arrow">▾</span>
        </button>
        <div class="apexon-lang-selector__dropdown" role="menu">
          ${LANGUAGES.map(l => `
            <button class="apexon-lang-selector__item" data-lang="${l.code}" role="menuitem">
              <span class="apexon-lang-selector__flag">${l.flag}</span>
              <span class="apexon-lang-selector__name">${l.name}</span>
            </button>
          `).join('')}
        </div>
      `;

      // 绑定展开/收起
      const btn = wrapper.querySelector('.apexon-lang-selector__btn');
      const dropdown = wrapper.querySelector('.apexon-lang-selector__dropdown');

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const expanded = dropdown.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', expanded);
      });

      document.addEventListener('click', () => {
        dropdown.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      });

      wrapper.querySelectorAll('.apexon-lang-selector__item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const lang = item.getAttribute('data-lang');
          this.setLang(lang);
        });
      });

      // 插入到 header-actions 末尾，如果没有则 body 开头
      const actions = document.querySelector('.header-actions');
      if (actions) {
        actions.appendChild(wrapper);
      } else {
        document.body.insertBefore(wrapper, document.body.firstChild);
      }
    },

    updateSelector() {
      const wrapper = document.getElementById('apexon-lang-selector');
      if (!wrapper) return;
      const current = LANGUAGES.find(l => l.code === this.current) || LANGUAGES[0];
      const btn = wrapper.querySelector('.apexon-lang-selector__btn');
      btn.querySelector('.apexon-lang-selector__flag').textContent = current.flag;
      btn.querySelector('.apexon-lang-selector__name').textContent = current.name;
      const dropdown = wrapper.querySelector('.apexon-lang-selector__dropdown');
      dropdown.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }
  };

  global.APEXON = global.APEXON || {};
  global.APEXON.i18n = i18n;

  // DOM 就绪后自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => i18n.init());
  } else {
    i18n.init();
  }
})(window);
