/**
 * 后台管理面板 —— 单文件自包含页面
 *
 * 由 Worker 在 GET /admin 时内联返回，无需额外静态资源。
 * 鉴权：管理员在页面输入 ADMIN_TOKEN（存 sessionStorage，不写 localStorage/不落盘），
 * 所有 /api/admin/* 调用带 Authorization: Bearer <token>。
 *
 * 说明：此文件内嵌 HTML/JS，字符串一律用单引号与拼接（避免与模板字符串分隔符冲突）。
 */

const API_PREFIX = '/api/admin';

export function renderAdminUI(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>APEXON 管理后台</title>
<style>
:root{
  --bg:#0d1117;--panel:#161b22;--panel2:#1c2330;--border:#2d333b;
  --text:#e6edf3;--muted:#8b949e;--accent:#3fb950;--danger:#f85149;
  --warn:#d29922;--info:#58a6ff;
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
header{display:flex;align-items:center;gap:16px;padding:0 20px;height:56px;background:var(--panel);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
header .logo{font-weight:700;font-size:16px;letter-spacing:.5px}
header .logo span{color:var(--accent)}
header .spacer{flex:1}
main{padding:20px;max-width:1200px;margin:0 auto}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}
.tab{padding:8px 16px;cursor:pointer;border:none;background:transparent;color:var(--muted);font-size:14px;border-bottom:2px solid transparent}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.tab:hover{color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
.card .num{font-size:26px;font-weight:700}
.card .label{color:var(--muted);font-size:12px;margin-top:2px}
.table-wrap{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:auto}
table{width:100%;border-collapse:collapse;min-width:680px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top;font-size:13px}
th{color:var(--muted);font-weight:600;background:var(--panel2);position:sticky;top:0}
tr:hover td{background:rgba(255,255,255,.02)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
input,select,textarea{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px;outline:none}
input:focus,select:focus{border-color:var(--info)}
button{cursor:pointer;border-radius:8px;padding:8px 14px;font-size:13px;border:1px solid var(--border);background:var(--panel2);color:var(--text)}
button:hover{background:var(--border)}
button.primary{background:var(--accent);border-color:var(--accent);color:#0d1117;font-weight:600}
button.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
button.ghost{background:transparent}
button[disabled]{opacity:.5;cursor:not-allowed}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
.badge.critical{background:rgba(248,81,73,.15);color:var(--danger)}
.badge.warning{background:rgba(210,153,34,.15);color:var(--warn)}
.badge.info{background:rgba(88,166,255,.15);color:var(--info)}
.badge.ok{background:rgba(63,185,80,.15);color:var(--accent)}
.badge.off{background:var(--border);color:var(--muted)}
.empty{color:var(--muted);padding:32px;text-align:center}
.bar{background:var(--panel2);border-radius:6px;height:8px;overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent)}
.bar.warn>i{background:var(--warn)}
.bar.danger>i{background:var(--danger)}
.dbinfo{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin:4px 0}
pre{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:50;padding:16px}
.modal.show{display:flex}
.modal-box{background:var(--panel);border:1px solid var(--border);border-radius:12px;max-width:820px;width:100%;max-height:88vh;overflow:auto;padding:20px}
.modal-box h3{margin-top:0}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:8px 0}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.login-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px;width:100%;max-width:420px}
.login-card h1{font-size:18px;margin:0 0 4px}
.login-card p{color:var(--muted);margin:0 0 16px;font-size:13px}
.login-card label{display:block;margin:10px 0 4px;font-size:12px;color:var(--muted)}
.login-card input{width:100%}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 16px;z-index:60;display:none;box-shadow:0 4px 20px rgba(0,0,0,.3)}
.toast.show{display:block}
.toast.err{border-color:var(--danger)}
.row{display:flex;gap:8px;align-items:center}
.muted{color:var(--muted)}
.mt{margin-top:12px}
@media(max-width:640px){.field-row{grid-template-columns:1fr}.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div id="loginView" class="login-wrap" style="display:none">
  <div class="login-card">
    <h1>APEXON 管理后台</h1>
    <p>安全：口令仅保存在当前会话，关闭页面即失效。使用 HTTPS 访问。</p>
    <label>管理员口令（ADMIN_TOKEN）</label>
    <input type="password" id="tokenInput" autocomplete="off" placeholder="请输入管理员口令">
    <div class="row mt">
      <button class="primary" onclick="doLogin()">登录</button>
      <span class="muted" id="loginHint"></span>
    </div>
  </div>
</div>

<div id="appView" style="display:none">
  <header>
    <div class="logo">APEXON <span>管理后台</span></div>
    <div class="spacer"></div>
    <span class="muted" id="whoami"></span>
    <button class="ghost" onclick="logout()">退出</button>
  </header>
  <main>
    <nav class="tabs">
      <button class="tab active" data-view="overview" onclick="show('overview')">仪表盘</button>
      <button class="tab" data-view="users" onclick="show('users')">用户</button>
      <button class="tab" data-view="content" onclick="show('content')">内容审核</button>
      <button class="tab" data-view="alerts" onclick="show('alerts')">安全告警</button>
      <button class="tab" data-view="audit" onclick="show('audit')">审计日志</button>
    </nav>
    <div id="view-overview"></div>
    <div id="view-users" style="display:none"></div>
    <div id="view-content" style="display:none"></div>
    <div id="view-alerts" style="display:none"></div>
    <div id="view-audit" style="display:none"></div>
  </main>
</div>

<div class="modal" id="userModal">
  <div class="modal-box" id="userModalBody"></div>
</div>

<div class="toast" id="toast"></div>

<script>
var TOKEN_KEY = 'apexon_admin_token';
var state = { user: null };

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
  return new Date(s).toLocaleString();
}
function trunc(s, n){ s = String(s||''); return s.length > n ? (s.slice(0,n) + '…') : s; }
function badge(sev){
  var m = { critical:'危险', warning:'警告', info:'信息', ok:'正常' };
  return '<span class="badge ' + esc(sev) + '">' + (m[sev] || esc(sev)) + '</span>';
}

function doLogin(){
  var t = $('tokenInput').value.trim();
  var hint = $('loginHint');
  if (!t) { hint.textContent = '口令不能为空'; return; }
  hint.textContent = '校验中…';
  api('/ping').then(function(){
    sessionStorage.setItem(TOKEN_KEY, t);
    boot();
  }).catch(function(e){
    hint.textContent = '口令错误或管理接口未启用';
  });
}
function logout(){
  sessionStorage.removeItem(TOKEN_KEY);
  $('appView').style.display = 'none';
  $('loginView').style.display = 'flex';
  $('tokenInput').value = '';
}
function boot(){
  $('loginView').style.display = 'none';
  $('appView').style.display = 'block';
  var who = sessionStorage.getItem(TOKEN_KEY);
  state.tokenTip = who;
  $('whoami').textContent = '会话已登录';
  show('overview');
}
function show(view){
  var tabs = document.querySelectorAll('.tab');
  for (var i=0;i<tabs.length;i++){ tabs[i].classList.remove('active'); }
  var views = ['overview','users','content','alerts','audit'];
  for (var j=0;j<views.length;j++){ $('view-' + views[j]).style.display = views[j] === view ? 'block' : 'none'; }
  var t = document.querySelector('.tab[data-view="' + view + '"]');
  if (t) t.classList.add('active');
  if (view === 'overview') renderOverview();
  if (view === 'users') renderUsers();
  if (view === 'content') renderContent();
  if (view === 'alerts') renderAlerts();
  if (view === 'audit') renderAudit();
}

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
    html += '<div class="card"><div class="num">' + online + '</div><div class="label">在线（5分钟内）</div></div>';
    html += '<div class="card"><div class="num">' + users + '</div><div class="label">注册用户</div></div>';
    html += '<div class="card"><div class="num">' + tests + '</div><div class="label">测试成绩</div></div>';
    html += '<div class="card"><div class="num">' + comments + '</div><div class="label">评论</div></div>';
    html += '<div class="card"><div class="num">' + feedback + '</div><div class="label">反馈</div></div>';
    html += '<div class="card"><div class="num" style="color:' + (openAl ? 'var(--danger)' : 'var(--accent)') + '">' + openAl + '</div><div class="label">未解决安全告警</div></div>';
    html += '</div>';
    html += '<h3>存储（分片）</h3>';
    html += '<div class="grid">';
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
    html += '<h3>最近未解决告警</h3>';
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
    var h = '<div class="toolbar"><button class="ghost" onclick="renderUsers()">重新搜索</button><span class="muted">共 ' + rows.length + ' 个账号</span></div>';
    h += '<div class="table-wrap"><table><tr><th>用户名</th><th>user_id</th><th>状态</th><th>注册时间</th><th>操作</th></tr>';
    for (var i=0;i<rows.length;i++){
      var u = rows[i];
      h += '<tr><td>' + esc(u.username) + '</td><td class="mono">' + esc(trunc(u.user_id,28)) + '</td>';
      h += '<td>' + (u.banned ? '<span class="badge danger">已封禁</span>' : '<span class="badge ok">正常</span>') + '</td>';
      h += '<td>' + fmtDate(u.created_at) + '</td>';
      h += '<td class="row"><button onclick="openUser(\'' + esc(u.user_id) + '\')">详情</button>';
      h += '<button class="danger" onclick="delUser(\'' + esc(u.user_id) + '\',\'' + esc(u.username) + '\')">删除</button></td></tr>';
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
    var h = '<div class="row"><h3 style="margin:0">' + esc(u.username) + '</h3></div>';
    h += '<p class="muted mono">' + esc(u.user_id) + '</p>';
    h += '<div class="field-row">';
    h += '<div class="card"><div class="label">评分次数</div><div class="num">' + (u.score_count||0) + '</div></div>';
    h += '<div class="card"><div class="label">评论数</div><div class="num">' + (u.comment_count||0) + '</div></div>';
    h += '<div class="card"><div class="label">反馈数</div><div class="num">' + (u.feedback_count||0) + '</div></div>';
    h += '<div class="card"><div class="label">账号状态</div><div class="num">' + (u.banned ? '已封禁' : '正常') + '</div></div>';
    h += '</div>';
    if (u.banned_reason) h += '<p class="muted">封禁原因：' + esc(u.banned_reason) + '</p>';
    h += '<div class="card mt"><div class="label">最近成绩（前20）</div>';
    var sc = u.recent_scores || [];
    if (!sc.length) h += '<div class="empty">暂无成绩</div>';
    else { h += '<div class="table-wrap"><table><tr><th>类型</th><th>分数</th><th>时间</th></tr>'; for (var i=0;i<sc.length;i++){ h += '<tr><td class="mono">' + esc(sc[i].subtype) + '</td><td>' + esc(sc[i].score_value) + '</td><td>' + fmtDate(sc[i].created_at) + '</td></tr>'; } h += '</table></div>'; }
    h += '</div>';
    h += '<div class="row mt">';
    h += (u.banned ? '<button class="primary" onclick="setBan(\'' + esc(u.user_id) + '\',false)">解除封禁</button>' : '<button class="warnbtn" onclick="setBan(\'' + esc(u.user_id) + '\',true)">封禁</button>');
    h += '<button class="danger" onclick="delUser(\'' + esc(u.user_id) + '\',\'' + esc(u.username) + '\')">删除账号及全部数据</button>';
    h += '<button onclick="closeModal()">关闭</button>';
    h += '</div>';
    body.innerHTML = h;
    $('userModal').classList.add('show');
  }).catch(function(e){ body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div><div class="row mt"><button onclick="closeModal()">关闭</button></div>'; });
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
    h += '</select><button class="ghost" onclick="renderContent()">搜索</button><span class="muted">' + rows.length + ' 条</span></div>';
    if (!rows.length){ el.innerHTML = h + '<div class="empty">暂无内容</div>'; return; }
    h += '<div class="table-wrap"><table><tr><th>类型</th><th>用户</th><th>内容</th><th>时间</th><th>操作</th></tr>';
    for (var j=0;j<rows.length;j++){
      var r = rows[j];
      var bodyText = r.content || r.message || JSON.stringify(r.payload || {}).slice(0,80);
      h += '<tr><td class="mono">' + esc(r.type || r.subtype || contentType) + '</td>';
      h += '<td class="mono">' + esc(trunc(r.username || r.user_id,20)) + '</td>';
      h += '<td>' + esc(trunc(bodyText,80)) + '</td>';
      h += '<td>' + fmtDate(r.created_at) + '</td>';
      h += '<td><button onclick="viewContent(\'' + esc(r.id) + '\')">查看</button><button class="danger" onclick="delContent(\'' + esc(r.id) + '\')">删除</button></td></tr>';
    }
    h += '</table></div>';
    el.innerHTML = h;
  }).catch(function(e){ el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; });
}
function viewContent(id){
  var el = $('view-content');
  api('/content/' + encodeURIComponent(id)).then(function(d){
    el.insertAdjacentHTML('afterbegin', '<div class="card mt"><div class="row"><b>记录详情</b><button onclick="this.parentElement.parentElement.remove()">收起</button></div><pre>' + esc(JSON.stringify(d.data, null, 2)) + '</pre></div>');
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
    h += '</select><button class="ghost" onclick="renderAlerts()">刷新</button><span class="muted">' + rows.length + ' 条</span></div>';
    if (!rows.length){ el.innerHTML = h + '<div class="empty">暂无告警</div>'; return; }
    h += '<div class="table-wrap"><table><tr><th>等级</th><th>类型</th><th>消息</th><th>来源</th><th>时间</th><th>操作</th></tr>';
    for (var j=0;j<rows.length;j++){
      var r = rows[j];
      h += '<tr><td>' + badge(r.severity) + '</td><td class="mono">' + esc(r.kind) + '</td>';
      h += '<td>' + esc(trunc(r.message,70)) + '</td><td class="mono">' + esc(r.source_ip || r.target || '-') + '</td>';
      h += '<td>' + fmtDate(r.created_at) + '</td>';
      h += '<td class="row">' + (r.resolved ? '' : '<button class="primary" onclick="resolveAlert(\'' + esc(r.id) + '\')">标记解决</button>') + '<button class="danger" onclick="delAlert(\'' + esc(r.id) + '\')">删除</button></td></tr>';
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
    var h = '<p class="muted">最近管理操作</p><div class="table-wrap"><table><tr><th>管理员</th><th>操作</th><th>目标</th><th>详情</th><th>时间</th></tr>';
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
(function init(){
  if (sessionStorage.getItem(TOKEN_KEY)){ boot(); } else { $('loginView').style.display = 'flex'; }
})();
</script>
</body>
</html>`;
}