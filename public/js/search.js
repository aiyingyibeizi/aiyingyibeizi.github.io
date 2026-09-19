/**
 * APEXON.Search v1.0
 * 站内搜索：本地索引（能力测试 / 站内页面 / 音乐曲目），支持多语言标题匹配。
 * 首页搜索框不再跳转外部搜索引擎，而是跳转到 search.html?q= 查看分组结果，
 * 并在首页提供即时建议下拉。
 */
(function (global) {
  'use strict';

  // 编号 → URL 与 i18n key 的映射，避免重复写死每项标题
  const TEST_MAP = [
    { slug: 'reaction', titleKey: 'cardReactionTitle', descKey: 'cardReactionDesc', kw: ['反应', '速度', '测试', 'reaction', '毫秒', 'ms'] },
    { slug: 'type', titleKey: 'cardTypeTitle', descKey: 'cardTypeDesc', kw: ['打字', 'wpm', 'cpm', 'typing', '键盘', '输入'] },
    { slug: 'stick', titleKey: 'cardStickTitle', descKey: 'cardStickDesc', kw: ['注意力', '专注', 'focus', 'attention', '注意'] },
    { slug: 'number', titleKey: 'cardNumberTitle', descKey: 'cardNumberDesc', kw: ['数字', '记忆', 'number', 'memory', '广度'] },
    { slug: 'verbal', titleKey: 'cardVerbalTitle', descKey: 'cardVerbalDesc', kw: ['单词', '记忆', 'word', 'verbal', '词汇', '语言'] },
    { slug: 'visual', titleKey: 'cardVisualTitle', descKey: 'cardVisualDesc', kw: ['视觉', '记忆', 'visual', 'memory', '格子', '方块'] },
    { slug: 'aim', titleKey: 'cardAimTitle', descKey: 'cardAimDesc', kw: ['瞄准', 'aim', 'aimbot', '手眼', '点击'] },
    { slug: 'sequence', titleKey: 'cardSequenceTitle', descKey: 'cardSequenceDesc', kw: ['序列', '顺序', '记忆', 'sequence', '顺序记忆'] },
    { slug: 'stroop', titleKey: 'cardStroopTitle', descKey: 'cardStroopDesc', kw: ['stroop', '抑制', '颜色', 'inhibition', '色'] },
    { slug: 'nback', titleKey: 'cardNbackTitle', descKey: 'cardNbackDesc', kw: ['nback', 'n-back', '工作记忆', 'working', '更新'] },
    { slug: 'taskswitch', titleKey: 'navTaskswitch', descKey: 'cardTaskswitchDesc', descFallback: '在多项认知任务间快速切换，测量认知灵活性与多任务处理能力', kw: ['任务切换', '切换', 'task', 'switch'] },
    { slug: 'visualsearch', titleKey: 'cardVisualsearchTitle', descKey: 'cardVisualsearchDesc', kw: ['视觉搜索', 'visual', 'search', '搜索'] }
  ];

  // 站内页面入口
  const PAGE_MAP = [
    { url: 'music.html', titleKey: 'navMusic', titleFallback: '音乐', descFallback: '免费在线音乐播放器，发现无版权独立音乐，支持搜索、收藏、最近播放', kw: ['音乐', 'music', '播放', '歌', 'play', 'song'] },
    { url: 'about.html', titleFallback: '关于本站', descFallback: '了解 APEXON 平台、我们的使命与团队', kw: ['关于', 'about', '我们', '平台'] },
    { url: 'terms.html', titleFallback: '服务条款', descFallback: '使用本站服务需遵守的服务条款与用户约定', kw: ['条款', '服务', 'terms', '协议', '约定'] },
    { url: 'privacy.html', titleFallback: '隐私政策', descFallback: '了解我们如何收集、使用与保护你的个人信息', kw: ['隐私', 'policy', 'privacy', '隐私政策'] }
  ];

  // 音乐曲目（与 music.js 的 DEMO_TRACKS 同名，方便匹配中文语境）
  const MUSIC_TRACKS = [
    { name: 'Neon Horizon', artist: 'SoundHelix', kw: ['neon', 'horizon', '电子', '霓虹'] },
    { name: 'Midnight Drive', artist: 'SoundHelix', kw: ['midnight', 'drive', '午夜', '驾驶'] },
    { name: 'Solar Flare', artist: 'SoundHelix', kw: ['solar', 'flare', '太阳', '耀斑'] },
    { name: 'Deep Ocean', artist: 'SoundHelix', kw: ['deep', 'ocean', '深海', '海洋'] },
    { name: 'Urban Pulse', artist: 'SoundHelix', kw: ['urban', 'pulse', '城市', '脉搏'] },
    { name: 'Golden Hour', artist: 'SoundHelix', kw: ['golden', 'hour', '黄金', '时刻'] },
    { name: 'Cyber Funk', artist: 'SoundHelix', kw: ['cyber', 'funk', '赛博', '放克'] },
    { name: 'Silent Rain', artist: 'SoundHelix', kw: ['silent', 'rain', '静雨', '雨'] },
    { name: 'Velocity', artist: 'SoundHelix', kw: ['velocity', '速度', '动能'] },
    { name: 'Lunar Lounge', artist: 'SoundHelix', kw: ['lunar', 'lounge', '月球', '休闲'] },
    { name: 'Electric Heart', artist: 'SoundHelix', kw: ['electric', 'heart', '电子', '心'] },
    { name: 'Mountain Echo', artist: 'SoundHelix', kw: ['mountain', 'echo', '山', '回声'] },
    { name: 'Street Beat', artist: 'SoundHelix', kw: ['street', 'beat', '街道', '节拍'] },
    { name: 'Starlight Waltz', artist: 'SoundHelix', kw: ['starlight', 'waltz', '星光', '华尔兹'] },
    { name: 'Digital Dawn', artist: 'SoundHelix', kw: ['digital', 'dawn', '数字', '黎明'] },
    { name: 'Echoes of Time', artist: 'SoundHelix', kw: ['echoes', 'time', '时光', '回声'] }
  ];

  const Search = {
    _index: null,

    _t(key, fb) {
      if (global.APEXON && global.APEXON.i18n && global.APEXON.i18n.t) {
        return global.APEXON.i18n.t(key, fb);
      }
      return fb;
    },

    // 构建完整索引（懒加载，含当前语言的标题/描述）
    index() {
      if (this._index) return this._index;
      const list = [];
      TEST_MAP.forEach((t) => {
        list.push({
          type: 'test',
          url: t.slug + '.html',
          title: this._t(t.titleKey, t.slug),
          desc: this._t(t.descKey, t.descFallback || ''),
          kw: t.kw
        });
      });
      PAGE_MAP.forEach((p) => {
        list.push({
          type: 'page',
          url: p.url,
          title: this._t(p.titleKey, p.titleFallback || p.url),
          desc: p.descFallback || '',
          kw: p.kw
        });
      });
      MUSIC_TRACKS.forEach((m) => {
        list.push({
          type: 'music',
          url: 'music.html',
          title: m.name,
          desc: m.artist,
          kw: m.kw.concat([m.name.toLowerCase(), m.artist.toLowerCase()])
        });
      });
      this._index = list;
      return list;
    },

    // 关键词匹配，返回 { item, score }
    search(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      const tokens = q.split(/[\s,，\-_]+/).filter(Boolean);
      const results = [];
      this.index().forEach((item) => {
        const haystack = (item.title + ' ' + item.desc + ' ' + (item.kw || []).join(' ')).toLowerCase();
        let score = 0;
        tokens.forEach((tk) => {
          if (haystack.indexOf(tk) !== -1) score += 1;
        });
        // 标题命中加权
        if ((item.title || '').toLowerCase().indexOf(q) !== -1) score += 2;
        if (score > 0) results.push({ item, score });
      });
      results.sort((a, b) => b.score - a.score);
      return results;
    },

    // 在给定容器渲染搜索结果（search.html 使用）
    renderResults(query, containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      const q = String(query || '').trim();
      const results = this.search(q);

      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

      if (!q) {
        container.innerHTML = '<div class="apex-empty-state"><div class="apex-empty-state__icon">🔎</div><div class="apex-empty-state__title">' + esc(this._t('searchPleaseInput', '请输入搜索关键词')) + '</div></div>';
        return;
      }
      if (!results.length) {
        container.innerHTML = '<div class="apex-empty-state"><div class="apex-empty-state__icon">🔍</div><div class="apex-empty-state__title">' + esc(this._t('searchNoResult', '没有找到与 “{q}” 相关的内容')) + '</div><div class="apex-empty-state__desc">' + esc(this._t('searchNoResultTip', '换个关键词试试，或直接浏览全部测试')) + '</div><a class="apex-empty-state__cta" href="index.html">' + esc(this._t('navHome', '返回首页')) + '</a></div>';
        return;
      }

      // 按类型分组
      const groups = {
        test: { label: this._t('searchGroupTest', '能力测试'), items: [] },
        page: { label: this._t('searchGroupPage', '站内页面'), items: [] },
        music: { label: this._t('searchGroupMusic', '音乐'), items: [] }
      };
      results.forEach((r) => { if (groups[r.item.type]) groups[r.item.type].items.push(r.item); });

      const typeIcon = { test: '🎯', page: '📄', music: '🎵' };
      let html = '<div class="search-results">';
      html += '<div class="search-results__meta">' + esc(this._t('searchFound', '找到 {n} 条与 “{q}” 相关的结果')) + '</div>';
      Object.keys(groups).forEach((g) => {
        if (!groups[g].items.length) return;
        html += '<div class="search-group"><div class="search-group__title">' + typeIcon[g] + ' ' + esc(groups[g].label) + '</div>';
        groups[g].items.forEach((item) => {
          html += '<a class="search-result" href="' + esc(item.url) + '">';
          html += '<div class="search-result__icon">' + typeIcon[item.type] + '</div><div class="search-result__body"><div class="search-result__title">' + esc(item.title) + '</div>' + (item.desc ? '<div class="search-result__desc">' + esc(item.desc) + '</div>' : '') + '</div><div class="search-result__arrow">→</div></a>';
        });
        html += '</div>';
      });
      html += '</div>';
      // 替换占位符 {q}/{n}
      html = html.replace(/\{q\}/g, esc(q));
      html = html.replace(/\{n\}/g, String(results.length));
      container.innerHTML = html;
    },

    // 首页即时建议下拉
    attachLive(inputEl, panelEl) {
      if (!inputEl || !panelEl) return;
      let timer = null;
      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const hide = () => { panelEl.classList.remove('show'); };

      const onInput = () => {
        clearTimeout(timer);
        const q = inputEl.value.trim();
        if (!q) { hide(); return; }
        timer = setTimeout(() => {
          const results = this.search(q).slice(0, 6);
          if (!results.length) { hide(); return; }
          const icon = { test: '🎯', page: '📄', music: '🎵' };
          panelEl.innerHTML = results.map((r) => {
            return '<a class="search-suggest" href="' + esc(r.item.url) + '"><span class="search-suggest__icon">' + icon[r.item.type] + '</span><span class="search-suggest__text">' + esc(r.item.title) + '</span></a>';
          }).join('') + '<a class="search-suggest search-suggest--more" href="search.html?q=' + encodeURIComponent(q) + '"><span>🔎 ' + esc(this._t('searchAll', '查看全部结果')) + '</span></a>';
          panelEl.classList.add('show');
        }, 120);
      };

      inputEl.addEventListener('input', onInput);
      inputEl.addEventListener('focus', onInput);
      inputEl.addEventListener('blur', () => setTimeout(hide, 150));
      document.addEventListener('click', (e) => {
        if (!panelEl.contains(e.target) && !inputEl.contains(e.target)) hide();
      });
    }
  };

  global.APEXON = global.APEXON || {};
  global.APEXON.Search = Search;
})(window);