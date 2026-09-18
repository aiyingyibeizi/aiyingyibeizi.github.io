/**
 * 后台管理面板 —— 单文件自包含页面
 *
 * 由 Worker 在 GET /admin 时内联返回，无需额外静态资源。
 * 鉴权：
 *   1) password（ADMIN_TOKEN）
 *   2) TOTP 6 位动态码（验证器 App 生成，/api/admin/2fa/setup 取回密钥绑定）
 *   登录成功后发放短期会话令牌，接口只认会话令牌。
 *
 * 布局：现代后台风格 —— 左侧导航 + 顶栏 + 卡片式内容区。
 */

const API_PREFIX = '/api/admin';

/** 侧边导航 / 顶栏图标（在模板渲染阶段输出为内联 SVG） */
const ICON_PATHS: Record<string, string> = {
  grid: '<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z" fill="none" stroke="currentColor" stroke-width="1.7"/>',
  users: '<path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 0114 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  doc: '<path d="M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  bell: '<path d="M12 4a5 5 0 015 5v4l2 3H5l2-3V9a5 5 0 015-5zM10 20a2 2 0 004 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  logout: '<path d="M9 4h8v16H9M4 12h11M12 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
};
function iconSvg(id: string): string {
  return '<svg width="18" height="18" viewBox="0 0 24 24">' + (ICON_PATHS[id] || ICON_PATHS.grid) + '</svg>';
}

export function renderAdminUI(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>APEXON Console · 管理后台</title>
<style>
:root{
  --bg:#0b0f1a;--bg2:#0f1524;--panel:#151c30;--panel2:#1a2340;--line:#232e4d;
  --text:#eaf0ff;--muted:#8b98c0;--accent:#6c8cff;--accent2:#5eead4;
  --danger:#ff6b81;--warn:#f5b84b;--info:#6c8cff;--ok:#4ade80;
  --radius:12px;--shadow:0 10px 30px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:
  radial-gradient(1200px 600px at 80% -10%, rgba(108,140,255,.16), transparent 60%),
  radial-gradient(900px 500px at -10% 10%, rgba(94,234,212,.10), transparent 55%),
  var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}

/* ---------- 登录 ---------- */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.login-card{width:100%;max-width:400px;background:linear-gradient(180deg,var(--panel),var(--bg2));border:1px solid var(--line);border-radius:20px;padding:32px;box-shadow:var(--shadow)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.brand-mark{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#0b0f1a;font-size:18px}
.brand h1{font-size:19px;margin:0;letter-spacing:.3px}
.brand h1 span{color:var(--accent2)}
.login-sub{color:var(--muted);font-size:13px;margin:0 0 6px}
.login-card label{display:block;margin:14px 0 6px;font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.4px}
.login-card input{width:100%;background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:11px 12px;font-size:14px;outline:none;transition:border-color .15s}
.login-card input:focus{border-color:var(--accent)}
.row{display:flex;gap:8px;align-items:center}
.hint{min-height:18px;font-size:12px;margin:10px 0 2px}
.hint.err{color:var(--danger)}
.hint.ok{color:var(--ok)}
.btn{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:10px 16px;font-size:14px;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap}
.btn:hover{background:var(--line)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#0b0f1a;font-weight:700}
.btn.primary:hover{filter:brightness(1.08)}
.btn.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
.btn.danger:hover{background:rgba(255,107,129,.12)}
.btn.ghost{background:transparent}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn.block{width:100%;margin-top:18px}
.link{background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0;font-family:inherit}
.link:hover{text-decoration:underline}
.sep{height:1px;background:var(--line);margin:18px 0 6px}

/* ---------- 布局 ---------- */
#appView{display:flex;min-height:100vh}
.sidebar{width:232px;flex:0 0 232px;background:linear-gradient(180deg,var(--bg2),var(--bg));border-right:1px solid var(--line);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.side-brand{display:flex;align-items:center;gap:10px;padding:20px 18px;border-bottom:1px solid var(--line)}
.side-brand h2{font-size:16px;margin:0}
.side-brand h2 span{color:var(--accent2)}
.nav{flex:1;padding:14px 12px;display:flex;flex-direction:column;gap:4px;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:10px;cursor:pointer;color:var(--muted);border:none;background:transparent;font-size:14px;font-family:inherit;text-align:left;width:100%;transition:all .14s}
.nav-item svg{flex:0 0 auto}
.nav-item:hover{color:var(--text);background:rgba(255,255,255,.03)}
.nav-item.active{color:var(--text);background:linear-gradient(90deg,rgba(108,140,255,.18),transparent);box-shadow:inset 2px 0 0 var(--accent);font-weight:600}
.side-foot{padding:14px;border-top:1px solid var(--line)}
.side-foot .who{color:var(--muted);font-size:12px;margin-bottom:10px;word-break:break-all}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:14px 24px;background:rgba(11,15,26,.8);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.topbar h2{margin:0;font-size:17px;font-weight:700}
.topbar .spacer{flex:1}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:5px 11px;border-radius:20px;border:1px solid var(--line);color:var(--muted)}
.chip.on{color:var(--ok);border-color:rgba(74,222,128,.4);background:rgba(74,222,128,.08)}
.content{padding:24px;max-width:1360px;width:100%;margin:0 auto}

/* ---------- 卡片 / 表格 ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:0 4px 14px rgba(0,0,0,.18)}
.card .num{font-size:28px;font-weight:800;letter-spacing:.3px}
.card .label{color:var(--muted);font-size:12px;margin-top:3px}
.card h3{margin:0 0 12px;font-size:15px}
.section-title{font-size:15px;font-weight:700;margin:24px 0 12px;color:var(--text)}
.table-wrap{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:auto}
table{width:100%;border-collapse:collapse;min-width:720px}
th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle;font-size:13px}
th{color:var(--muted);font-weight:600;background:var(--panel2);font-size:12px;letter-spacing:.3px;position:sticky;top:0}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
input,select,textarea{background:var(--bg2);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:9px 11px;font-size:13px;outline:none}
input:focus,select:focus{border-color:var(--accent)}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.3px}
.badge.critical{background:rgba(255,107,129,.14);color:var(--danger)}
.badge.warning{background:rgba(245,184,75,.14);color:var(--warn)}
.badge.info{background:rgba(108,140,255,.14);color:var(--info)}
.badge.ok{background:rgba(74,222,128,.13);color:var(--ok)}
.badge.off{background:var(--line);color:var(--muted)}
.empty{color:var(--muted);padding:40px;text-align:center;font-size:13px}
.bar{background:var(--panel2);border-radius:6px;height:8px;overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent)}
.bar.warn>i{background:var(--warn)}
.bar.danger>i{background:var(--danger)}
.dbinfo{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin:5px 0}
pre{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px}
.actions{display:flex;gap:6px;flex-wrap:wrap}

/* ---------- 弹窗 ---------- */
.modal{position:fixed;inset:0;background:rgba(4,6,12,.7);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;z-index:60;padding:18px}
.modal.show{display:flex}
.modal-box{background:var(--panel);border:1px solid var(--line);border-radius:16px;max-width:860px;width:100%;max-height:88vh;overflow:auto;padding:22px;box-shadow:var(--shadow)}
.modal-box h3{margin:0 0 14px;font-size:17px}
.modal-close{float:right;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}
.secret-box{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;letter-spacing:2px;background:var(--bg2);border:1px dashed var(--accent);border-radius:10px;padding:14px;text-align:center;word-break:break-all;margin:10px 0}
.steps{margin:10px 0;padding-left:20px;color:var(--muted);font-size:13px}
.steps li{margin:6px 0}
.apps{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}

/* ---------- 提示 ---------- */
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px 18px;z-index:80;display:none;box-shadow:var(--shadow);font-size:13px;max-width:90vw}
.toast.show{display:block;animation:pop .18s ease}
.toast.err{border-color:var(--danger)}
@keyframes pop{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
.muted{color:var(--muted)}
.mt{margin-top:14px}
@media(max-width:760px){.sidebar{width:64px;flex-basis:64px}.side-brand h2,.nav-item span,.side-foot .who{display:none}.nav-item{justify-content:center}.field-row{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>

<!-- ============ 登录 ============ -->
<div id="loginView" class="login-wrap" style="display:none">
  <div class="login-card">
    <div class="brand">
      <div class="brand-mark">A</div>
      <h1>APEXON <span>Console</span></h1>
    </div>
    <p class="login-sub">双重验证登录</p>
    <label>管理员口令</label>
    <input type="password" id="tokenInput" autocomplete="off" placeholder="输入口令">
    <label>动态验证码</label>
    <input type="text" id="totpInput" autocomplete="one-time-code" inputmode="numeric" maxlength="6" placeholder="验证器 6 位数字">
    <div class="hint" id="loginHint"></div>
    <button class="btn primary block" onclick="doLogin()">登 录</button>
    <div class="sep"></div>
    <button class="link" onclick="openSetup2FA()">首次使用？扫码 / 粘贴密钥绑定验证器 →</button>
  </div>
</div>

<!-- ============ 主界面 ============ -->
<div id="appView" style="display:none">
  <aside class="sidebar">
    <div class="side-brand">
      <div class="brand-mark">A</div>
      <h2>APEXON <span>Console</span></h2>
    </div>
    <nav class="nav">
      <button class="nav-item active" data-nav="overview" onclick="show('overview')">${iconSvg('grid')}<span>仪表盘</span></button>
      <button class="nav-item" data-nav="users" onclick="show('users')">${iconSvg('users')}<span>用户管理</span></button>
      <button class="nav-item" data-nav="content" onclick="show('content')">${iconSvg('doc')}<span>内容审核</span></button>
      <button class="nav-item" data-nav="alerts" onclick="show('alerts')">${iconSvg('bell')}<span>安全告警</span></button>
      <button class="nav-item" data-nav="audit" onclick="show('audit')">${iconSvg('list')}<span>审计日志</span></button>
    </nav>
    <div class="side-foot">
      <div class="who" id="whoami"></div>
      <button class="btn ghost block" onclick="logout()">${iconSvg('logout')} 退出登录</button>
    </div>
  </aside>
  <div class="main">
    <div class="topbar">
      <h2 id="pageTitle">仪表盘</h2>
      <div class="spacer"></div>
      <span class="chip on" id="totpChip">${iconSvg('shield')} 双重验证</span>
    </div>
    <div class="content">
      <div id="view-overview"></div>
      <div id="view-users" style="display:none"></div>
      <div id="view-content" style="display:none"></div>
      <div id="view-alerts" style="display:none"></div>
      <div id="view-audit" style="display:none"></div>
    </div>
  </div>
</div>

<!-- 用户详情弹窗 -->
<div class="modal" id="userModal">
  <div class="modal-box" id="userModalBody"></div>
</div>

<!-- 2FA 绑定弹窗 -->
<div class="modal" id="setupModal">
  <div class="modal-box" id="setupModalBody"></div>
</div>

<div class="toast" id="toast"></div>

<script>
var API_PREFIX = '${API_PREFIX}';
var TOKEN_KEY = 'apexon_admin_token';
var state = { user: null, totpEnabled: true };
var TITLES = { overview:'仪表盘', users:'用户管理', content:'内容审核', alerts:'安全告警', audit:'审计日志' };

function $(id){ return document.getElementById(id); }
function api(path, opts){
  opts = opts || {};
  var headers = opts.headers || {};
  headers['Content-Type'] = 'application/json';
  headers['Authorization'] = 'Bearer ' + sessionStorage.getItem(TOKEN_KEY);
  var init = { method: opts.method || 'GET', headers: headers };
  if (opts.body) init.body = JSON.stringify(opts.body);
  return fetch(API_PREFIX + path, init).then(function(res){
    return res.json().catch(function(){ return { success:false, error:'响应解析失败' }; }).then(function(data){
      if (res.status >= 400) {
        var e = new Error((data && data.error) || ('HTTP ' + res.status));
        e.status = res.status;
        throw e;
      }
      return data;
    });
  });
}
function toast(msg, isErr){
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(function(){ t.className = 'toast'; }, 2600);
}
function esc(s){
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(s){
  if (!s) return '-';
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString();
}
function trunc(s, n){ s = String(s||''); return s.length > n ? (s.slice(0,n) + '…') : s; }
function badge(sev){
  var m = { critical:'危险', warning:'警告', info:'信息', ok:'正常' };
  return '<span class="badge ' + (m[sev] ? esc(sev) : 'off') + '">' + (m[sev] || esc(sev)) + '</span>';
}

/* ---------- 登录 / 登出 / 2FA 设置 ---------- */
function doLogin(){
  var t = $('tokenInput').value.trim();
  var code = $('totpInput').value.trim();
  var hint = $('loginHint');
  if (!t) { hint.className='hint err'; hint.textContent = '请输入管理员口令'; return; }
  if (!code) { hint.className='hint err'; hint.textContent = '请输入 6 位动态验证码'; return; }
  hint.className='hint'; hint.textContent = '校验中…';
  fetch(API_PREFIX + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: t, code: code })
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(data){
      if (res.status >= 400) {
        var msg;
        if (data && data.locked) {
          msg = '失败次数过多，来源已临时冻结（15 分钟）';
        } else {
          msg = (data && data.error) || ('登录失败（HTTP ' + res.status + '）');
        }
        hint.className='hint err';
        hint.textContent = msg;
        var codeHint = data && data.code_mismatch ? '　请核对验证器动态码' : '';
        hint.textContent = msg + codeHint;
        var e = new Error(msg); e.status = res.status; throw e;
      }
      return data;
    });
  }).then(function(data){
    sessionStorage.setItem(TOKEN_KEY, data.session);
    state.totpEnabled = data.totp_enabled !== false;
    boot();
  }).catch(function(){ /* hint already set */ });
}
function logout(){
  var s = sessionStorage.getItem(TOKEN_KEY);
  if (s) {
    fetch(API_PREFIX + '/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + s } }).catch(function(){});
  }
  sessionStorage.removeItem(TOKEN_KEY);
  $('appView').style.display = 'none';
  $('loginView').style.display = 'flex';
  $('tokenInput').value = '';
  $('totpInput').value = '';
}
function boot(){
  $('loginView').style.display = 'none';
  $('appView').style.display = 'flex';
  var tip = state.totpEnabled ? '双重验证已开启' : '未开启 2FA';
  $('whoami').innerHTML = '会话已登录<br>' + tip;
  $('totpChip').style.display = state.totpEnabled ? '' : 'none';
  show('overview');
}
function show(view){
  var items = document.querySelectorAll('.nav-item');
  for (var i=0;i<items.length;i++){
    items[i].classList.toggle('active', items[i].getAttribute('data-nav') === view);
  }
  var views = ['overview','users','content','alerts','audit'];
  for (var j=0;j<views.length;j++){ $('view-' + views[j]).style.display = views[j] === view ? 'block' : 'none'; }
  $('pageTitle').textContent = TITLES[view] || view;
  if (view === 'overview') renderOverview();
  if (view === 'users') renderUsers();
  if (view === 'content') renderContent();
  if (view === 'alerts') renderAlerts();
  if (view === 'audit') renderAudit();
}
function openSetup2FA(){
  var t = $('tokenInput').value.trim();
  if (!t) { toast('请先输入管理员口令', true); return; }
  var body = $('setupModalBody');
  body.innerHTML = '<h3>设置双重验证</h3><p class="muted">正在获取绑定信息…</p>';
  $('setupModal').classList.add('show');
  fetch(API_PREFIX + '/2fa/setup', { headers: { 'Authorization': 'Bearer ' + t } })
    .then(function(res){ return res.json().catch(function(){ return {}; }).then(function(data){
      if (res.status >= 400) throw new Error((data && data.error) || ('HTTP ' + res.status));
      return data;
    }); })
    .then(function(d){
      if (!d.enabled || !d.secret) { body.innerHTML = '<h3>设置双重验证</h3><div class="empty">后端未配置 ADMIN_TOTP_SECRET</div><button class="btn mt" onclick="closeSetup()">关闭</button>'; return; }
      var grouped = String(d.secret).replace(/[^A-Za-z2-7]/g, '').toUpperCase();
      var pretty = grouped.replace(/(.{4})/g, '$1 ');
      body.innerHTML =
        '<h3>绑定双重验证器</h3>' +
        '<p class="muted">在你的验证器 App 中用下方密钥添加账户，然后回到登录页输入它生成的 6 位动态码。</p>' +
        '<div class="apps">' +
          '<span class="badge info">Google 身份验证器</span>' +
          '<span class="badge info">Microsoft Authenticator</span>' +
          '<span class="badge info">Authy</span>' +
          '<span class="badge info">1Password</span>' +
        '</div>' +
        '<label class="muted" style="font-size:12px">密钥（Base32）</label>' +
        '<div class="secret-box">' + esc(pretty) + '</div>' +
        '<div class="actions">' +
          '<button class="btn primary" onclick="copySecret(\\'' + esc(grouped) + '\\')">复制密钥</button>' +
          '<button class="btn" onclick="window.open(\\'' + esc(String(d.otpauth||'')) + '\\')">用 otpauth 打开</button>' +
          '<button class="btn ghost" onclick="closeSetup()">关闭</button>' +
        '</div>' +
        '<div class="sep"></div>' +
        '<p class="muted" style="font-size:12px;margin:0">操作步骤：① 安装任意上面的一款验证器 App → ② 点“+”手动输入密钥 → ③ 粘贴密钥并保存 → ④ 回到登录页输入 App 里显示的 6 位动态码与口令即可登录。</p>';
    })
    .catch(function(e){
      body.innerHTML = '<h3>设置双重验证</h3><div class="empty">' + esc(e.message || '获取失败') + '</div><button class="btn mt" onclick="closeSetup()">关闭</button>';
    });
}
function copySecret(s){
  (navigator.clipboard ? navigator.clipboard.writeText(s).then(function(){ toast('密钥已复制'); }, function(){ fallbackCopy(s); }) : fallbackCopy(s));
}
function fallbackCopy(s){
  var ta = document.createElement('textarea');
  ta.value = s; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta);
  ta.select(); try { document.execCommand('copy'); toast('密钥已复制'); } catch(e){ toast('复制失败，请手动选中', true); }
  document.body.removeChild(ta);
}
function closeSetup(){ $('setupModal').classList.remove('show'); }

/* ---------- Overview ---------- */
function renderOverview(){
  var el = $('view-overview');
  el.innerHTML = '<p class="muted">加载中…</p>';
  api('/overview').then(function(d){
    var data = d.data || {};
    var online = data.online || 0, users = data.total_users || 0;
    var tests = data.total_tests || 0, comments = data.total_comments || 0;
    var feedback = data.feedback || 0, openAl = data.open_alerts || 0;
    var dbs = data.dbs || [];
    var html = '<div class="grid">';
    html += '<div class="card"><div class="num">' + online + '</div><div class="label">在线（5 分钟内）</div></div>';
    html += '<div class="card"><div class="num">' + users + '</div><div class="label">注册用户</div></div>';
    html += '<div class="card"><div class="num">' + tests + '</div><div class="label">测试成绩</div></div>';
    html += '<div class="card"><div class="num">' + comments + '</div><div class="label">评论</div></div>';
    html += '<div class="card"><div class="num">' + feedback + '</div><div class="label">反馈</div></div>';
    html += '<div class="card"><div class="num" style="color:' + (openAl ? 'var(--danger)' : 'var(--ok)') + '">' + openAl + '</div><div class="label">未解决安全告警</div></div>';
    html += '</div>';
    html += '<div class="section-title">存储（分片）</div><div class="grid">';
    for (var i=0;i<dbs.length;i++){
      var db = dbs[i];
      var pct = db.max_bytes ? Math.min(100, (db.used_bytes/db.max_bytes)*100) : 0;
      var cls = pct > 85 ? 'danger' : (pct > 65 ? 'warn' : '');
      html += '<div class="card">';
      html += '<div class="label">' + esc(db.name) + '</div>';
      html += '<div class="dbinfo"><span>' + fmtBytes(db.used_bytes) + ' / ' + fmtBytes(db.max_bytes) + '</span><span>' + pct.toFixed(1) + '%</span></div>';
      html += '<div class="bar ' + cls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
      html += '<div class="dbinfo"><span class="' + (db.healthy ? 'badge ok' : 'badge critical') + '">' + (db.healthy ? '正常' : '异常') + '</span></div>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="section-title">最近未解决告警</div>';
    renderAlertMini(html, el);
    el.innerHTML = html;
  }).catch(function(e){ el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}
function renderAlertMini(prefix, el){
  api('/alerts?status=open&limit=5').then(function(d){
    var rows = d.data || [];
    if (!rows.length) { el.innerHTML = prefix + '<div class="empty">暂无待处理告警 🎉</div>'; return; }
    var h = prefix + '<div class="table-wrap"><table><tr><th>等级</th><th>类型</th><th>消息</th><th>来源</th><th>时间</th></tr>';
    for (var i=0;i<rows.length;i++){
      var r = rows[i];
      h += '<tr><td>' + badge(r.severity) + '</td><td class="mono">' + esc(r.kind) + '</td><td>' + esc(trunc(r.message,60)) + '</td><td class="mono">' + esc(r.source_ip || r.target || '-') + '</td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }
    h += '</table></div>';
    el.innerHTML = h;
  }).catch(function(){ el.innerHTML = prefix + '<div class="empty">暂无待处理告警</div>'; });
}
function fmtBytes(b){
  b = Number(b) || 0;
  if (b >= 1073741824) return (b/1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b/1048576).toFixed(2) + ' MB';
  if (b >= 1024) return (b/1024).toFixed(1) + ' KB';
  return b + ' B';
}

/* ---------- Users ---------- */
var userFilter = '';
function renderUsers(){
  var el = $('view-users');
  var q = prompt('搜索用户（用户名 / user_id；留空显示全部）', userFilter);
  userFilter = q === null ? userFilter : q.trim();
  var url = '/users?limit=300' + (userFilter ? ('&q=' + encodeURIComponent(userFilter)) : '');
  el.innerHTML = '<p class="muted">加载中…</p>';
  api(url).then(function(d){
    var rows = d.data || [];
    if (!rows.length){ el.innerHTML = '<div class="empty">没有匹配的用户</div>'; return; }
    var h = '<div class="toolbar"><button class="btn ghost" onclick="renderUsers()">重新搜索</button><span class="muted">共 ' + rows.length + ' 个账号</span></div>';
    h += '<div class="table-wrap"><table><tr><th>用户名</th><th>user_id</th><th>状态</th><th>注册时间</th><th>操作</th></tr>';
    for (var i=0;i<rows.length;i++){
      var u = rows[i];
      h += '<tr><td>' + esc(u.username) + '</td><td class="mono">' + esc(trunc(u.user_id,28)) + '</td>';
      h += '<td>' + (u.banned ? '<span class="badge danger">已封禁</span>' : '<span class="badge ok">正常</span>') + '</td>';
      h += '<td>' + fmtDate(u.created_at) + '</td>';
      h += '<td class="actions"><button class="btn" onclick="openUser(\\'' + esc(u.user_id) + '\\')">详情</button>';
      h += '<button class="btn danger" onclick="delUser(\\'' + esc(u.user_id) + '\\',\\'' + esc(u.username) + '\\')">删除</button></td></tr>';
    }
    h += '</table></div>';
    el.innerHTML = h;
  }).catch(function(e){ el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}
function openUser(userId){
  var body = $('userModalBody');
  body.innerHTML = '<p class="muted">加载中…</p>';
  $('userModal').classList.add('show');
  api('/users/' + encodeURIComponent(userId)).then(function(d){
    var u = d.data || {};
    var h = '<h3><button class="modal-close" onclick="closeModal()">×</button>' + esc(u.username) + '</h3>';
    h += '<p class="muted mono">' + esc(u.user_id) + '</p>';
    h += '<div class="field-row">';
    h += '<div class="card"><div class="num">' + (u.score_count||0) + '</div><div class="label">评分次数</div></div>';
    h += '<div class="card"><div class="num">' + (u.comment_count||0) + '</div><div class="label">评论数</div></div>';
    h += '<div class="card"><div class="num">' + (u.feedback_count||0) + '</div><div class="label">反馈数</div></div>';
    h += '<div class="card"><div class="num">' + (u.banned ? '封' : '正') + '</div><div class="label">账号状态</div></div>';
    h += '</div>';
    if (u.banned_reason) h += '<p class="muted">封禁原因：' + esc(u.banned_reason) + '</p>';
    h += '<div class="card mt"><h3>最近成绩（前 20）</h3>';
    var sc = u.recent_scores || [];
    if (!sc.length) h += '<div class="empty">暂无成绩</div>';
    else { h += '<div class="table-wrap"><table><tr><th>类型</th><th>分数</th><th>时间</th></tr>'; for (var i=0;i<sc.length;i++){ h += '<tr><td class="mono">' + esc(sc[i].subtype) + '</td><td>' + esc(sc[i].score_value) + '</td><td>' + fmtDate(sc[i].created_at) + '</td></tr>'; } h += '</table></div>'; }
    h += '</div>';
    h += '<div class="actions mt">';
    h += (u.banned ? '<button class="btn primary" onclick="setBan(\\'' + esc(u.user_id) + '\\',false)">解除封禁</button>' : '<button class="btn danger" onclick="setBan(\\'' + esc(u.user_id) + '\\',true)">封禁</button>');
    h += '<button class="btn danger" onclick="delUser(\\'' + esc(u.user_id) + '\\',\\'' + esc(u.username) + '\\')">删除账号及全部数据</button>';
    h += '<button class="btn ghost" onclick="closeModal()">关闭</button>';
    h += '</div>';
    body.innerHTML = h;
    $('userModal').classList.add('show');
  }).catch(function(e){ body.innerHTML = '<h3><button class="modal-close" onclick="closeModal()">×</button>加载失败</h3><div class="empty">' + esc(e.message) + '</div><div class="mt"><button class="btn" onclick="closeModal()">关闭</button></div>'; });
}
function setBan(userId, ban){
  var p = '/users/' + encodeURIComponent(userId) + (ban ? '/ban' : '/unban');
  var bodyBody = {};
  if (ban){
    var reason = prompt('封禁原因（可选）') || '管理员封禁';
    bodyBody.reason = String(reason).slice(0,300);
  }
  api(p, { method:'POST', body: bodyBody }).then(function(){
    toast(ban ? '已封禁' : '已解除封禁');
    openUser(userId);
  }).catch(function(e){ toast('操作失败：' + e.message, true); });
}
function delUser(userId, name){
  if (!confirm('确定删除账号 "' + name + '" 及其全部成绩/评论/资料/反馈？此操作不可恢复。')) return;
  api('/users/' + encodeURIComponent(userId), { method:'DELETE' }).then(function(){
    toast('已删除用户');
    $('userModal').classList.remove('show');
    renderUsers();
  }).catch(function(e){ toast('删除失败：' + e.message, true); });
}
function closeModal(){ $('userModal').classList.remove('show'); }

/* ---------- Content ---------- */
var contentType = 'comment';
function renderContent(){
  var el = $('view-content');
  var q = prompt('内容关键词（可留空）：', state.contentQuery || '');
  state.contentQuery = q === null ? state.contentQuery : q.trim();
  var url = '/content?type=' + encodeURIComponent(contentType) + '&limit=200' + (state.contentQuery ? ('&q=' + encodeURIComponent(state.contentQuery)) : '');
  el.innerHTML = '<p class="muted">加载中…</p>';
  api(url).then(function(d){
    var rows = d.data || [];
    var h = '<div class="toolbar"><select onchange="contentType=this.value;renderContent()">';
    var tys = ['comment','feedback','score','profile'];
    for (var i=0;i<tys.length;i++){ h += '<option value="' + tys[i] + '"' + (contentType===tys[i] ? ' selected' : '') + '>' + tys[i] + '</option>'; }
    h += '</select><button class="btn ghost" onclick="renderContent()">搜索</button><span class="muted">' + rows.length + ' 条</span></div>';
    if (!rows.length){ el.innerHTML = h + '<div class="empty">暂无内容</div>'; return; }
    h += '<div class="table-wrap"><table><tr><th>类型</th><th>用户</th><th>内容</th><th>时间</th><th>操作</th></tr>';
    for (var j=0;j<rows.length;j++){
      var r = rows[j];
      var bodyText = r.content || r.message || JSON.stringify(r.payload || {}).slice(0,80);
      h += '<tr><td class="mono">' + esc(r.type || r.subtype || contentType) + '</td>';
      h += '<td class="mono">' + esc(trunc(r.username || r.user_id,20)) + '</td>';
      h += '<td>' + esc(trunc(bodyText,80)) + '</td>';
      h += '<td>' + fmtDate(r.created_at) + '</td>';
      h += '<td class="actions"><button class="btn" onclick="viewContent(\\'' + esc(r.id) + '\\')">查看</button><button class="btn danger" onclick="delContent(\\'' + esc(r.id) + '\\')">删除</button></td></tr>';
    }
    h += '</table></div>';
    el.innerHTML = h;
  }).catch(function(e){ el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}
function viewContent(id){
  var el = $('view-content');
  api('/content/' + encodeURIComponent(id)).then(function(d){
    el.insertAdjacentHTML('afterbegin', '<div class="card mt"><div class="row"><b>记录详情</b><button class="btn ghost" onclick="this.parentElement.parentElement.remove()">收起</button></div><pre>' + esc(JSON.stringify(d.data, null, 2)) + '</pre></div>');
  }).catch(function(){});
}
function delContent(id){
  if (!confirm('确定删除该记录？')) return;
  api('/content/' + encodeURIComponent(id), { method:'DELETE' }).then(function(){
    toast('已删除');
    renderContent();
  }).catch(function(e){ toast('删除失败：' + e.message, true); });
}

/* ---------- Alerts ---------- */
var alertStatus = 'open';
function renderAlerts(){
  var el = $('view-alerts');
  var url = '/alerts?status=' + encodeURIComponent(alertStatus) + '&limit=300';
  el.innerHTML = '<p class="muted">加载中…</p>';
  api(url).then(function(d){
    var rows = d.data || [];
    var h = '<div class="toolbar"><select onchange="alertStatus=this.value;renderAlerts()">';
    var ss = [['open','未解决'],['all','全部'],['resolved','已解决']];
    for (var i=0;i<ss.length;i++){ h += '<option value="' + ss[i][0] + '"' + (alertStatus===ss[i][0]?' selected':'') + '>' + ss[i][1] + '</option>'; }
    h += '</select><button class="btn ghost" onclick="renderAlerts()">刷新</button><span class="muted">' + rows.length + ' 条</span></div>';
    if (!rows.length){ el.innerHTML = h + '<div class="empty">暂无告警</div>'; return; }
    h += '<div class="table-wrap"><table><tr><th>等级</th><th>类型</th><th>消息</th><th>来源</th><th>时间</th><th>操作</th></tr>';
    for (var j=0;j<rows.length;j++){
      var r = rows[j];
      h += '<tr><td>' + badge(r.severity) + '</td><td class="mono">' + esc(r.kind) + '</td>';
      h += '<td>' + esc(trunc(r.message,70)) + '</td><td class="mono">' + esc(r.source_ip || r.target || '-') + '</td>';
      h += '<td>' + fmtDate(r.created_at) + '</td>';
      h += '<td class="actions">' + (r.resolved ? '' : '<button class="btn primary" onclick="resolveAlert(\\'' + esc(r.id) + '\\')">标记解决</button>') + '<button class="btn danger" onclick="delAlert(\\'' + esc(r.id) + '\\')">删除</button></td></tr>';
    }
    h += '</table></div>';
    el.innerHTML = h;
  }).catch(function(e){ el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}
function resolveAlert(id){
  api('/alerts/' + encodeURIComponent(id), { method:'PATCH', body:{ resolved:true } }).then(function(){ toast('已解决'); renderAlerts(); }).catch(function(e){ toast('失败：' + e.message, true); });
}
function delAlert(id){
  if (!confirm('确定删除该告警？')) return;
  api('/alerts/' + encodeURIComponent(id), { method:'DELETE' }).then(function(){ toast('已删除'); renderAlerts(); }).catch(function(e){ toast('失败：' + e.message, true); });
}

/* ---------- Audit ---------- */
function renderAudit(){
  var el = $('view-audit');
  api('/audit?limit=200').then(function(d){
    var rows = d.data || [];
    if (!rows.length){ el.innerHTML = '<div class="empty">暂无审计记录</div>'; return; }
    var h = '<div class="table-wrap"><table><tr><th>管理员</th><th>操作</th><th>目标</th><th>详情</th><th>时间</th></tr>';
    for (var i=0;i<rows.length;i++){
      var r = rows[i];
      h += '<tr><td class="mono">' + esc(r.admin) + '</td><td class="mono">' + esc(r.action) + '</td>';
      h += '<td class="mono">' + esc(trunc(r.target||'-',28)) + '</td><td>' + esc(trunc(r.detail||'-',40)) + '</td><td>' + fmtDate(r.created_at) + '</td></tr>';
    }
    h += '</table></div>';
    el.innerHTML = h;
  }).catch(function(e){ el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}

/* init */
$('tokenInput').addEventListener('keydown', function(e){ if (e.key === 'Enter') doLogin(); });
$('totpInput').addEventListener('keydown', function(e){ if (e.key === 'Enter') doLogin(); });
(function init(){
  if (sessionStorage.getItem(TOKEN_KEY)){ boot(); } else { $('loginView').style.display = 'flex'; }
})();
</script>
</body>
</html>`;
}