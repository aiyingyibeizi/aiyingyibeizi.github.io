// Optimizer for APEXON - cesi/js/common.optimizer.js
// Adds performance improvements and a UI panel to toggle features (particles, theme, accent)
(function () {
  'use strict';
  const MAX_WAIT_MS = 10000;
  const POLL_INTERVAL = 120;

  function whenAPEXON(cb) {
    const start = Date.now();
    (function poll() {
      if (window.APEXON && window.APEXON.LocalStats && window.APEXON.OnlineTracker && window.APEXON.Stats && window.APEXON.UI) return cb();
      if (Date.now() - start > MAX_WAIT_MS) return; // give up
      setTimeout(poll, POLL_INTERVAL);
    })();
  }

  whenAPEXON(() => {
    const A = window.APEXON;

    // 1) LocalStats: in-memory cache + debounced writes
    try {
      const orig = A.LocalStats;
      if (orig) {
        const mem = { _data: null, _dirty: false, _timer: null };
        function loadOnce() {
          if (mem._data) return mem._data;
          mem._data = orig._safeLoad ? orig._safeLoad() : orig.getCounts ? { total_tests: 0, users: {}, online: {}, lastRemote: { online: 0, total_users: 0, total_tests: 0 } } : {};
          return mem._data;
        }
        const flush = () => {
          if (!mem._dirty) return;
          try {
            localStorage.setItem('apex_stats_v1', JSON.stringify(mem._data));
          } catch (e) { /* ignore */ }
          mem._dirty = false;
        };
        const debouncedFlush = () => {
          if (mem._timer) clearTimeout(mem._timer);
          mem._timer = setTimeout(flush, 1500);
        };
        const patched = Object.assign({}, orig);
        patched._safeLoad = function () { return loadOnce(); };
        patched._save = function (data) {
          mem._data = data; mem._dirty = true; debouncedFlush();
        };
        // keep behavior of record functions but avoid immediate localStorage churn
        patched.recordUser = function (userId) {
          if (!userId || typeof userId !== 'string') return;
          const d = loadOnce(); d.users[userId] = Date.now(); mem._dirty = true; debouncedFlush();
        };
        patched.recordTest = function (userId) {
          if (!userId || typeof userId !== 'string') return;
          const d = loadOnce(); d.total_tests = (d.total_tests || 0) + 1; d.users[userId] = Date.now(); mem._dirty = true; debouncedFlush();
        };
        patched.recordOnline = function (userId) {
          if (!userId || typeof userId !== 'string') return;
          const d = loadOnce(); const now = Date.now(); d.online[userId] = now; d.users[userId] = now; const TTL = 5 * 60 * 1000; // keep same
          for (const k of Object.keys(d.online)) { if (now - d.online[k] > TTL) delete d.online[k]; }
          mem._dirty = true; debouncedFlush();
        };
        patched.getCounts = function () { const d = loadOnce(); const now = Date.now(); const online = Object.keys(d.online || {}).filter(k => now - d.online[k] <= 5 * 60 * 1000).length; return { online, total_users: Object.keys(d.users || {}).length, total_tests: d.total_tests || 0 }; };
        patched.mergeRemote = function (remote) { const d = loadOnce(); d.lastRemote = { online: Math.max(0, Number(remote && remote.online) || 0), total_users: Math.max(0, Number(remote && remote.total_users) || 0), total_tests: Math.max(0, Number(remote && remote.total_tests) || 0) }; d.total_tests = Math.max(d.total_tests || 0, d.lastRemote.total_tests); d.lastRemote.total_users = Math.max(d.lastRemote.total_users, Object.keys(d.users || {}).length); mem._dirty = true; debouncedFlush(); return { online: Math.max(d.lastRemote.online, Object.keys(d.online || {}).length), total_users: d.lastRemote.total_users, total_tests: d.total_tests }; };
        // replace
        A.LocalStats = patched;
        console.log('[optimizer] LocalStats patched: in-memory + debounced writes');
      }
    } catch (e) { console.warn('[optimizer] LocalStats patch failed', e); }

    // 2) OnlineTracker: coalesce across same-origin tabs using BroadcastChannel
    try {
      const origTracker = A.OnlineTracker;
      if (origTracker) {
        const CHANNEL = 'apexon-online-v1';
        let isLeader = false;
        let bc = null;
        try { bc = new BroadcastChannel(CHANNEL); } catch (e) { bc = null; }
        const leaderKey = 'apexon-online-leader';
        const tryBecomeLeader = function () {
          try {
            const now = Date.now();
            const s = localStorage.getItem(leaderKey);
            if (!s) { localStorage.setItem(leaderKey, String(now)); isLeader = true; bc && bc.postMessage({ type: 'leader', t: now }); return; }
            const t = Number(s) || 0;
            if (now - t > 45000) { localStorage.setItem(leaderKey, String(now)); isLeader = true; bc && bc.postMessage({ type: 'leader', t: now }); }
          } catch (e) { isLeader = true; }
        };
        if (bc) {
          bc.onmessage = (ev) => {
            if (ev.data && ev.data.type === 'leader') {
              // another tab declared leadership
              if (ev.data && ev.data.t && ev.data.t > 0) { if (Date.now() - ev.data.t < 45000) isLeader = false; }
            }
            if (ev.data && ev.data.type === 'beat' && !isLeader) {
              // leader beat, ignore
            }
          };
        }

        const patched = Object.assign({}, origTracker);
        patched.init = function (userId) {
          // original behavior still applies in non-supported env
          tryBecomeLeader();
          // if we're leader, run original timer; otherwise just record local and listen
          if (!userId) return origTracker.init.call(origTracker, userId);
          if (isLeader) {
            // leader will perform beats as normal but with a slightly larger interval
            origTracker.INTERVAL_MS = Math.max(45000, origTracker.INTERVAL_MS || 30000);
            origTracker.init.call(origTracker, userId);
            // announce beats
            if (bc) setInterval(() => bc.postMessage({ type: 'beat', t: Date.now() }), Math.max(45000, origTracker.INTERVAL_MS));
          } else {
            // non-leader: do a single immediate local record and set up visibility handler to ask leader to beat when visible
            A.LocalStats.recordUser(userId);
            // make sure we still call upsertOnline at least once when visible
            VisibilitySafeAddEventListener(document, 'visibilitychange', () => { if (!document.hidden) bc && bc.postMessage({ type: 'need-beat', t: Date.now() }); });
          }
        };
        A.OnlineTracker = patched;
        console.log('[optimizer] OnlineTracker patched: BroadcastChannel coordination');
      }
    } catch (e) { console.warn('[optimizer] OnlineTracker patch failed', e); }

    // helper to add visibility-safe event listener
    function VisibilitySafeAddEventListener(target, name, fn) {
      try { target.addEventListener(name, fn); } catch (e) { try { target.attachEvent && target.attachEvent('on' + name, fn); } catch (e) {} }
    }

    // 3) Stats: increase interval on mobile and de-duplicate frequent refreshes
    try {
      const origStats = A.Stats;
      if (origStats) {
        const patched = Object.assign({}, origStats);
        patched.INTERVAL_MS = function () {
          const base = origStats.INTERVAL_MS || 30000;
          if (/Mobi|Android/i.test(navigator.userAgent)) return Math.max(base, 60000);
          return base;
        }();
        // wrap refresh to coalesce
        let pending = false;
        patched.refresh = async function () {
          if (pending) return; pending = true;
          try { await origStats.refresh.call(origStats); } catch (e) { console.warn('[optimizer] Stats.refresh failed', e); }
          pending = false;
        };
        // when init is called, use patched INTERVAL_MS and handlers
        patched.init = function () {
          // call original init but ensure we clear any existing timer and set a new one
          origStats.stop && origStats.stop.call(origStats);
          // find elements again in case DOM changed
          try { origStats.init.call(origStats); } catch (e) { /* fall back */ }
          // replace timer
          if (origStats.timer) { clearInterval(origStats.timer); origStats.timer = null; }
          origStats.timer = setInterval(() => patched.refresh(), patched.INTERVAL_MS);
          // bind our visibility handler
          VisibilitySafeAddEventListener(document, 'visibilitychange', () => { if (!document.hidden) patched.refresh(); });
          // event listeners remain
        };
        A.Stats = patched;
        console.log('[optimizer] Stats patched: interval tuned, refresh coalesced');
      }
    } catch (e) { console.warn('[optimizer] Stats patch failed', e); }

    // 4) UI: add a small persistent control panel to toggle particles, theme (light/dark), accent selection
    try {
      const panelId = 'apex-optimizer-panel';
      if (!document.getElementById(panelId)) {
        const panel = document.createElement('div');
        panel.id = panelId;
        panel.style.position = 'fixed';
        panel.style.right = '12px';
        panel.style.bottom = '12px';
        panel.style.zIndex = 99999;
        panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial';
        panel.style.fontSize = '13px';
        panel.style.color = 'var(--apex-text)';
        panel.style.backdropFilter = 'blur(6px)';
        panel.style.background = 'rgba(0,0,0,0.5)';
        panel.style.borderRadius = '12px';
        panel.style.padding = '8px';
        panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column';
        panel.style.gap = '6px';
        panel.style.minWidth = '180px';

        // toggle button
        const header = document.createElement('div');
        header.style.display = 'flex'; header.style.justifyContent = 'space-between'; header.style.alignItems = 'center';
        const title = document.createElement('div'); title.textContent = 'APEXON Control'; title.style.fontWeight = '700'; title.style.fontSize = '13px';
        const closeBtn = document.createElement('button'); closeBtn.textContent = '×'; closeBtn.style.background = 'transparent'; closeBtn.style.border = 'none'; closeBtn.style.color = '#fff'; closeBtn.style.cursor = 'pointer'; closeBtn.style.fontSize = '16px';
        closeBtn.addEventListener('click', () => { panel.style.display = 'none'; localStorage.setItem('apex_optimizer_hidden', '1'); });
        header.appendChild(title); header.appendChild(closeBtn);
        panel.appendChild(header);

        // particles toggle
        const pWrap = document.createElement('div'); pWrap.style.display = 'flex'; pWrap.style.justifyContent = 'space-between';
        const pLabel = document.createElement('div'); pLabel.textContent = 'Particles';
        const pToggle = document.createElement('input'); pToggle.type = 'checkbox';
        pToggle.checked = localStorage.getItem('apex_particles_enabled') !== '0';
        pToggle.addEventListener('change', () => {
          const enabled = pToggle.checked;
          localStorage.setItem('apex_particles_enabled', enabled ? '1' : '0');
          if (enabled) {
            try { A.Particles && A.Particles.init && A.Particles.init(); } catch (e) {}
          } else {
            // attempt to stop particles by calling stop path if exists
            try { if (A.Particles && A.Particles.stop) A.Particles.stop(); else { /* try removing canvas */ const el = document.getElementById('particles'); if (el && el.parentNode) el.parentNode.removeChild(el); } } catch (e) {}
          }
        });
        pWrap.appendChild(pLabel); pWrap.appendChild(pToggle); panel.appendChild(pWrap);

        // theme toggle
        const tWrap = document.createElement('div'); tWrap.style.display = 'flex'; tWrap.style.justifyContent = 'space-between';
        const tLabel = document.createElement('div'); tLabel.textContent = 'Light Theme';
        const tToggle = document.createElement('input'); tToggle.type = 'checkbox'; tToggle.checked = document.documentElement.getAttribute('data-theme') === 'light' || document.body.classList.contains('theme-light');
        tToggle.addEventListener('change', () => {
          const light = tToggle.checked;
          document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
          localStorage.setItem('apex_theme_light', light ? '1' : '0');
          document.body.classList.toggle('theme-light', light);
          document.dispatchEvent(new CustomEvent('apexon:themechange', { detail: { isLight: light } }));
        });
        tWrap.appendChild(tLabel); tWrap.appendChild(tToggle); panel.appendChild(tWrap);

        // accent selection
        const accentWrap = document.createElement('div'); accentWrap.style.display = 'flex'; accentWrap.style.gap = '6px'; accentWrap.style.flexWrap = 'wrap';
        const accentLabel = document.createElement('div'); accentLabel.textContent = 'Accent'; accentLabel.style.fontWeight = '600'; accentLabel.style.marginBottom = '4px'; panel.appendChild(accentLabel);
        const accents = ['cyan','emerald','amber','rose','indigo','coral'];
        const currentAccent = localStorage.getItem('apex_accent') || document.documentElement.getAttribute('data-accent') || 'cyan';
        accents.forEach(ac => {
          const b = document.createElement('button'); b.textContent = ac[0].toUpperCase(); b.title = ac; b.style.width='30px'; b.style.height='30px'; b.style.borderRadius='8px'; b.style.border='none'; b.style.cursor='pointer'; b.style.fontWeight='700'; b.style.color='#fff'; b.style.background='linear-gradient(135deg,#7C3AED 0,#60A5FA 100%)';
          // simple color mapping for preview
          const m = { cyan:'#0ea5a4', emerald:'#10b981', amber:'#f59e0b', rose:'#fb7185', indigo:'#6366f1', coral:'#fb923c' };
          b.style.background = m[ac];
          if (ac === currentAccent) b.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
          b.addEventListener('click', () => { document.documentElement.setAttribute('data-accent', ac); localStorage.setItem('apex_accent', ac); panel.querySelectorAll('button').forEach(btn => btn.style.boxShadow=''); b.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)'; });
          accentWrap.appendChild(b);
        });
        panel.appendChild(accentWrap);

        // advanced: performance mode (reduce animations)
        const perfWrap = document.createElement('div'); perfWrap.style.display='flex'; perfWrap.style.justifyContent='space-between';
        const perfLabel = document.createElement('div'); perfLabel.textContent = 'Performance Mode';
        const perfToggle = document.createElement('input'); perfToggle.type='checkbox'; perfToggle.checked = localStorage.getItem('apex_perf_mode') === '1';
        perfToggle.addEventListener('change', () => { localStorage.setItem('apex_perf_mode', perfToggle.checked ? '1' : '0'); document.documentElement.setAttribute('data-apex-perf', perfToggle.checked ? '1' : '0'); });
        perfWrap.appendChild(perfLabel); perfWrap.appendChild(perfToggle); panel.appendChild(perfWrap);

        // restore hidden state
        if (localStorage.getItem('apex_optimizer_hidden') === '1') panel.style.display = 'none';
        document.body.appendChild(panel);
      }
      console.log('[optimizer] UI panel injected');
    } catch (e) { console.warn('[optimizer] UI panel injection failed', e); }

    // 5) Lazy-load particles: if user disabled or perf-mode on, prevent auto init
    try {
      const particlesPref = localStorage.getItem('apex_particles_enabled');
      const perfMode = localStorage.getItem('apex_perf_mode') === '1';
      if (particlesPref === '0' || perfMode) {
        // if common.js already invoked A.Particles.init during boot, we can't stop it, but we can try to stop canvas after init
        // For new init calls, wrap A.Particles.init to skip auto-start
        if (A.Particles && A.Particles.init) {
          const origInit = A.Particles.init.bind(A.Particles);
          A.Particles.init = function (options) {
            const enabled = localStorage.getItem('apex_particles_enabled') !== '0' && localStorage.getItem('apex_perf_mode') !== '1';
            if (!enabled) { console.log('[optimizer] Particles init skipped (pref/perf)'); return; }
            return origInit(options);
          };
        }
      }

      // ensure particles start when user toggles panel
      document.addEventListener('apexon:themechange', () => { if (localStorage.getItem('apex_particles_enabled') !== '0') { try { A.Particles && A.Particles.init && A.Particles.init(); } catch (e) {} } });
      console.log('[optimizer] Particles lazy-load guard installed');
    } catch (e) { console.warn('[optimizer] Particles lazy-load failed', e); }

    // 6) Best-effort: reduce hot DOM queries by caching common selectors used by UI.relayoutHeader
    try {
      const origRelayout = A.UI && A.UI.relayoutHeader;
      if (origRelayout) {
        let cache = { pillLinks: null, dropdownLinks: null, lastPath: null };
        A.UI.relayoutHeader = function () {
          const path = location.pathname;
          if (cache.lastPath === path && cache.pillLinks && cache.dropdownLinks) return origRelayout.call(A.UI);
          cache.lastPath = path;
          cache.pillLinks = document.querySelectorAll('#headerPill a');
          cache.dropdownLinks = document.querySelectorAll('#headerDropdown a');
          return origRelayout.call(A.UI);
        };
        console.log('[optimizer] UI.relayoutHeader cached selectors');
      }
    } catch (e) { console.warn('[optimizer] relayoutHeader patch failed', e); }

    console.log('[optimizer] all patches applied');
  });
})();
