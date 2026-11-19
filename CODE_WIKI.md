# APEXON · Code Wiki

> 全能能力测试系统（APEXON）—— 一个纯前端的能力测评 Web 应用
> 仓库源代码索引、架构说明与运行手册

---

## 目录

1. [项目概览](#1-项目概览)
2. [项目结构](#2-项目结构)
3. [整体架构](#3-整体架构)
4. [核心模块职责](#4-核心模块职责)
5. [关键类与函数说明](#5-关键类与函数说明)
6. [页面与测试引擎](#6-页面与测试引擎)
7. [数据模型与依赖服务](#7-数据模型与依赖服务)
8. [样式与设计系统](#8-样式与设计系统)
9. [安全机制](#9-安全机制)
10. [项目运行方式](#10-项目运行方式)
11. [部署流程](#11-部署流程)
12. [开发约定与注意事项](#12-开发约定与注意事项)

---

## 1. 项目概览

**APEXON** 是一套面向个人能力测评的纯前端 Web 应用，提供三类小游戏化测试，并通过 Clerk + Supabase 实现用户体系与云端数据持久化。

| 项目 | 说明 |
| --- | --- |
| 项目名 | APEXON（全能能力测试系统） |
| 类型 | 静态前端站点（无构建步骤、无后端代码） |
| 技术栈 | 原生 HTML / CSS / JavaScript（ES2020+） |
| 认证服务 | [Clerk](https://clerk.com) v5（`@clerk/clerk-js`） |
| 数据服务 | [Supabase](https://supabase.com)（PostgREST + Storage） |
| 部署平台 | GitHub Pages（通过 GitHub Actions 自动部署） |
| 自定义域名 | `apexon.qzz.io`（见 [CNAME](file:///workspace/CNAME)） |
| 站点邮箱 | `luoyangmengjin2025@163.com` |
| 视觉风格 | 科技暗色 + 赛博青紫 + 毛玻璃，可切换明亮主题 |

**核心功能：**

- 三种能力测试：反应时间、打字训练、持续注意力
- 全局排行榜（按测试分类）
- 个人成绩历史与个人资料
- 玩家讨论区（评论）
- 用户反馈表单（邮件兜底）
- Clerk 官方 UserButton 集成（登录、账号管理）
- 深色 / 明亮主题切换
- 粒子背景动效、音效、振动反馈
- 移动端优先响应式布局（断点 320 / 375 / 768 / 1024 / 1440 / 1920 / 2560 / 4K）

---

## 2. 项目结构

```
workspace/
├── .github/
│   └── workflows/
│       └── static.yml            # GitHub Pages 部署工作流
├── cesi/                         # 站点根目录（部署根）
│   ├── index.html                # 首页（排行榜 / 讨论 / 反馈 / 个人资料）
│   ├── reaction.html             # 反应时间测试页
│   ├── type.html                 # 打字训练测试页
│   ├── stick.html                # 持续注意力测试页（含内联游戏逻辑）
│   ├── js/
│   │   └── common.js             # APEXON 核心模块（v4.1，~1081 行）
│   ├── styles/
│   │   ├── variables.css         # 设计令牌 + 主题（暗 / 明 / 响应式）
│   │   └── main.css              # 主样式表（BEM，~3373 行）
│   ├── css/
│   │   └── style.css             # 旧版样式（疑似历史遗留，未在新页面引用）
│   └── assets/
│       ├── favicon.png           # 站点图标 / Logo
│       └── Loge.base64           # Base64 编码的 Logo 资源
└── CNAME                         # GitHub Pages 自定义域名：apexon.qzz.io
```

> 部署根为 `./cesi`（见 [static.yml](file:///workspace/.github/workflows/static.yml#L33)），仓库根目录的 `CNAME` 文件由 GitHub Pages 用于绑定自定义域名。

---

## 3. 整体架构

APEXON 采用 **纯静态多页面（MPA）+ 全局命名空间** 架构，每个页面通过 `<script src="js/common.js">` 共享同一份核心模块，再以页面内联 `<script>` 完成页面级初始化。

```
┌─────────────────────────────────────────────────────────────┐
│                       浏览器（前端运行时）                      │
│                                                              │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│   │ index    │  │ reaction │  │  type    │  │  stick   │    │
│   │  .html   │  │  .html   │  │  .html   │  │  .html   │    │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│        │             │            │             │            │
│        └─────────────┴────────────┴─────────────┘            │
│                      │ 共享                                  │
│              ┌───────▼────────┐                              │
│              │  js/common.js  │  → 全局对象 window.APEXON     │
│              │  (v4.1 模块)    │                              │
│              └───────┬────────┘                              │
│                      │                                       │
│   ┌─────────┬────────┼────────┬─────────┬──────────┐         │
│   │Security │  DB    │  Auth  │  Audio  │ UI/Utils │  Tests  │
│   └────┬────┴───┬────┴───┬────┴────┬────┴────┬─────┴────┐    │
│        │        │        │         │         │           │    │
└────────┼────────┼────────┼─────────┼─────────┼───────────┼────┘
         │        │        │         │         │           │
         │        ▼        ▼         │         │           │
         │  ┌──────────┐ ┌────────┐  │         │           │
         │  │ Supabase │ │ Clerk  │  │         │           │
         │  │  REST +  │ │  Auth  │  │         │           │
         │  │ Storage  │ │   JS   │  │         │           │
         │  └──────────┘ └────────┘  │         │           │
         │                           │         │           │
         ▼                           ▼         ▼           ▼
   HTML 转义 / 过滤            Web Audio   DOM 操作     测试状态机
```

**关键设计原则：**

- **无构建步骤**：所有 JS/CSS 直接由浏览器加载，源码即产物。
- **单一核心模块**：[common.js](file:///workspace/cesi/js/common.js) 通过 IIFE 暴露 `window.APEXON` 命名空间，所有页面共享。
- **显式初始化**：`boot()` 仅启动 `VisibilityManager` 与主题；Clerk UserButton 与测试引擎由各页面显式调用，避免重复绑定（见 [common.js L1075](file:///workspace/cesi/js/common.js#L1075)）。
- **数据全部走云端**：除主题偏好（`localStorage`）外，所有用户数据均通过 Supabase REST API 持久化。
- **认证与数据解耦**：Clerk 负责身份认证，Supabase 负责业务数据；登录后通过 `DB.syncUser` 将 Clerk 用户同步至 `users` 表，建立两侧的关联。

---

## 4. 核心模块职责

[common.js](file:///workspace/cesi/js/common.js) 顶部声明：

```js
/**
 * APEXON 核心模块 v4.1
 * 职责：安全、Clerk 认证、Supabase 数据、音频、主题、UserButton、测试引擎
 */
```

整个文件以 IIFE 包装，向 `window.APEXON` 暴露以下子模块：

| 命名空间 | 模块对象 | 职责 |
| --- | --- | --- |
| `APEXON.Security` | `Security` | HTML 转义、危险内容过滤、成绩记录校验 |
| `APEXON.DB` | `DB` | Supabase REST API 封装（增删查改 + 头像上传） |
| `APEXON.Auth` | `ClerkAuth` | Clerk 生命周期管理、用户信息读取、账号操作 |
| `APEXON.Audio` | `AudioManager` | 基于 Web Audio API 的音效合成 |
| `APEXON.Visibility` | `VisibilityManager` | 页面可见性监听（暂停测试用） |
| `APEXON.Utils` | `Utils` | 通用工具：防抖、节流、振动、惩罚值、评级 |
| `APEXON.UI` | `UI` | Toast、主题初始化、Clerk UserButton 挂载、用户态 UI 同步 |
| `APEXON.Tests` | `Tests` | 测试引擎：`Tests.Type`、`Tests.Reaction`（stick 内联于页面） |

此外，模块向 `window` 暴露若干全局函数供 HTML 内联调用：

- `window.backHome` → `UI.backHome`
- `window.APEXON.logout` → `ClerkAuth.logout`
- `window.APEXON.deleteAccount` → `ClerkAuth.deleteAccount`
- `window.restartTest`（由各测试引擎在初始化时定义）
- `window.toggleMenu` / `window.showLb` / `window.postComment` / `window.submitFeedback`（首页内联脚本定义）

---

## 5. 关键类与函数说明

### 5.1 `Security`（安全层，[L15–L68](file:///workspace/cesi/js/common.js#L15)）

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `escapeHtml(text)` | `(text: any) => string` | 转义 `& < > " ' `` 六个字符，避免 XSS。null/undefined 返回空串。 |
| `filterDangerous(input)` | `(input: string) => string\|'[内容已过滤]'` | 检测危险标签（script/iframe/...）、`javascript:` 等协议、`onXxx=` 事件、SQL 注入关键字；命中则整体替换为占位串，否则剥离所有 HTML 标签。 |
| `validateRecord(type, data)` | `(type, data) => boolean` | 按测试类型校验成绩数据合法性（范围、数组结构）。 |

`validateRecord` 的校验规则：

- `reaction`：`avg` ∈ [0, 5000]；`times` 数组每项 ∈ [0, 5000] 或为 `null`/`'skip'`
- `type`：`avg` ∈ [0, 600]，`accuracy` ∈ [0, 100]
- `stick`：`score` ∈ [0, 100000]

### 5.2 `DB`（Supabase 数据层，[L72–L273](file:///workspace/cesi/js/common.js#L72)）

底层数据访问统一通过 `DB.request(table, method, body, query)`（[L73](file:///workspace/cesi/js/common.js#L73)）发起 `fetch`，请求头携带 `apikey` 与 `Authorization: Bearer <key>`，POST 时附 `Prefer: return=representation,resolution=merge-duplicates` 实现 upsert。

| 方法 | 用途 | 目标表 |
| --- | --- | --- |
| `request(table, method, body, query)` | 通用 REST 请求 | 任意 |
| `syncUser(userId, username, email)` | 登录后同步用户（upsert） | `users` |
| `saveScore(userId, username, testType, data)` | 写入成绩（前置 `validateRecord`） | `scores` |
| `getLeaderboard(testType, limit=10)` | 读取排行榜（stick 降序，其他升序） | `scores` |
| `getHistoryByUserAndType(userId, type, limit=20)` | 读取某用户某类测试历史 | `scores` |
| `addComment(userId, username, content)` | 发布讨论评论（前置过滤 + 500 字限制） | `comments` |
| `getComments(limit=50)` | 拉取最新评论 | `comments` |
| `addFeedback(name, email, content)` | 提交反馈（含邮箱正则校验） | `feedback` |
| `getProfile(userId)` | 读取个人资料 | `profiles` |
| `saveProfile(userId, username, payload)` | 写入个人资料（bio/location/website/social，均做长度截断） | `profiles` |
| `uploadAvatarToSupabase(userId, file)` | 上传头像至 Storage bucket `avatars` | Storage |

> 配置常量：`SUPABASE_URL = 'https://kpmsljgonualekjyrkzs.supabase.co'`，`SUPABASE_KEY` 为 publishable key（见 [L11–L12](file:///workspace/cesi/js/common.js#L11)）。

### 5.3 `ClerkAuth`（认证层，[L277–L405](file:///workspace/cesi/js/common.js#L277)）

| 方法 | 说明 |
| --- | --- |
| `init()` | 等待 `window.Clerk` 就绪并显式 `Clerk.load()`；登录态下自动调用 `DB.syncUser` 同步至 `users` 表。带 8s 超时兜底。 |
| `isLoggedIn()` | 返回 `!!this.user` |
| `getUser()` | 返回用户显示名（优先级：username > fullName > firstName+lastName > email > '用户'） |
| `getUserId()` | 返回 Clerk user id |
| `getAvatarUrl()` | 返回头像 URL（`imageUrl` / `profileImageUrl`） |
| `getCreatedAt()` | 返回本地化注册日期 |
| `logout()` | 调用 `Clerk.signOut()` 并刷新页面 |
| `deleteAccount()` | 二次确认后调用 `logout()`（仅清本地，未调用 Clerk 删除 API） |
| `updateUser(updates)` | 兼容多版本 Clerk API 更新用户名 / 姓名 |
| `uploadAvatar(file)` | 兼容 `setProfileImage` / `createProfileImage` 两套 API |

登录态变化通过 `window.Clerk.addListener` 监听，并经 `UI.updateUserDisplay()` 派发自定义事件 `apexon:userchange`（`detail: { loggedIn, user }`），首页据此刷新资料卡。

### 5.4 `AudioManager`（音效，[L409–L448](file:///workspace/cesi/js/common.js#L409)）

基于 `AudioContext` 的合成器，无需音频文件：

| 方法 | 说明 |
| --- | --- |
| `play(freq, dur, type)` | 播放指定频率/时长/波形单音 |
| `playClick()` | 800Hz 短音 |
| `playSuccess()` | 三连音 C5-E5-G5（523/659/784 Hz） |
| `playFail()` | 锯齿波 300→150 Hz 下滑，模拟失败音 |
| `playTick()` | 1000Hz 方波短促 tick |

### 5.5 `VisibilityManager`（[L452–L462](file:///workspace/cesi/js/common.js#L452)）

监听 `document.visibilitychange`，回调列表模式；各测试引擎通过 `onChange(cb)` 注册「页面隐藏时暂停」逻辑。

### 5.6 `Utils`（[L466–L500](file:///workspace/cesi/js/common.js#L466)）

| 函数 | 说明 |
| --- | --- |
| `debounce(fn, ms)` | 防抖 |
| `throttle(fn, ms)` | 节流 |
| `vibrate(ms)` | 包装 `navigator.vibrate`，不可用时静默 |
| `reactionPenalty()` | 返回设备固有延迟补偿：触屏 30ms，鼠标 10ms |
| `getGrade(val, type)` | 按成绩返回 `{ grade, color }`（S/A/B/C/D，仅 reaction 与 type） |

评级阈值：

| 等级 | reaction (ms) | type (s) | 颜色 |
| --- | --- | --- | --- |
| S | < 180 | < 20 | `#FFD700` 金 |
| A | < 230 | < 30 | `#FF6B6B` 红 |
| B | < 280 | < 40 | `#4ECDC4` 青 |
| C | < 350 | < 50 | `#95E1D3` 浅青 |
| D | ≥ 350 | ≥ 50 | `#aaa` 灰 |

### 5.7 `UI`（[L504–L637](file:///workspace/cesi/js/common.js#L504)）

| 方法 | 说明 |
| --- | --- |
| `toast(msg, duration=2500)` | 创建/复用 `#apex-toast` 元素显示提示 |
| `initTheme()` | 读取 `localStorage['apex-theme']` 与 `apex-bw-mode`，绑定主题切换按钮 |
| `mountUserButton(containerId)` | 挂载 Clerk 官方 UserButton，注入品牌 appearance 变量，并绑定 `Clerk.addListener` 同步登录态 |
| `updateUserDisplay()` | 根据登录态切换右上角胶囊样式、讨论区可见性，并派发 `apexon:userchange` |
| `backHome()` | 淡出动画后跳转 `index.html` |

### 5.8 `Tests`（测试引擎，[L641–L1062](file:///workspace/cesi/js/common.js#L641)）

#### `Tests.Type`（打字测试，[L643–L865](file:///workspace/cesi/js/common.js#L643)）

| 成员 | 说明 |
| --- | --- |
| 常量 | `TOTAL_ROUNDS=5`、`ROUND_DELAY_MS=800`、`MS_PER_SECOND=1000` |
| `sentences` | 24 条中文励志句库（无标点，便于逐字比对） |
| `getRandomText()` | 随机抽句 |
| `isChineseChar(str)` | 判定单个中文字符（`\u4E00-\u9FA5`） |
| `getValidChineseCount(str)` | 统计有效中文字符数（用于 WPM/CPM 计算） |
| `calcAvg(arr)` | 求平均并保留 1 位小数 |
| `init()` | 绑定输入框 input/keydown/paste/contextmenu 事件，启动 5 轮测试循环 |

打字测试逻辑要点：

- 输入即时高亮：正确字 `<span class="right">`，错误字 `<span class="wrong">`，未输入 `<span class="pending">`
- 实时统计 WPM / CPM / 正确率 / 用时
- 完成中文字数达标即结算本轮，自动进入下一轮（间隔 800ms）
- 5 轮结束展示综合卡片并保存成绩
- 禁止 Ctrl+C / Ctrl+V / 粘贴 / 右键菜单，防作弊
- Esc 返回首页，R 键重新开始

#### `Tests.Reaction`（反应测试，[L868–L1061](file:///workspace/cesi/js/common.js#L868)）

| 成员 | 说明 |
| --- | --- |
| 状态机 | `STATE_IDLE=0` / `STATE_WAITING=1` / `STATE_CLICK=2` |
| 常量 | `TOTAL_ROUNDS=5`、`MIN_WAIT_MS=2000`、`MAX_WAIT_MS=5000` |
| `init()` | 绑定 pointerdown/mousedown/touchstart，键盘空格/回车触发 |

反应测试状态机：

```
STATE_IDLE ──点击──▶ STATE_WAITING ──随机 2-5s 后变绿──▶ STATE_CLICK
                          │                                   │
                       提前点击                              点击
                          │                                   │
                          ▼                                   ▼
                     foul +1, 跳过本轮              记录 ms（扣 penalty），进入下一轮
```

测量要点：

- 使用 `performance.now()` 高精度计时
- 双重 `requestAnimationFrame` 等待画面实际变绿后再记录 `frameStartTime`，减少误差
- 扣除 `Utils.reactionPenalty()` 设备固有延迟
- 50ms 内重复点击防抖
- 5 轮结束后取有效轮次平均值，违规轮以 `null` 记录并展示

---

## 6. 页面与测试引擎

### 6.1 [index.html](file:///workspace/cesi/index.html)（首页）

页面区块（自上而下）：

1. **Header**：Logo、导航、主题切换、Clerk UserButton 容器
2. **Hero**：APEXON 主标题 + 标语 + 实时统计（玩家数 / 测试次数 / 在线）
3. **Search Box**：Bing 搜索跳转
4. **Cards Grid**：三张测试入口卡片
5. **Profile**：个人资料卡（依赖登录态）
6. **Leaderboard**：分类排行榜（reaction / type / stick，可切换）
7. **Personal Stats**：我的成绩（每类最佳 + 次数）
8. **Forum**：讨论区（登录后可发帖，500 字上限）
9. **Feedback**：反馈表单 + 邮箱兜底（mailto）

首页内联脚本完成：

- Canvas 粒子背景动画（自动适配移动端数量）
- `initApp()`：拉取排行榜、个人成绩、评论、统计
- `loadLeaderboard(type)` / `loadPersonal()` / `loadComments()` / `updateStats()` / `loadProfile()`
- 全局函数：`showLb` / `postComment` / `submitFeedback` / `toggleMenu`
- 监听 `apexon:userchange` 刷新资料与右上角名字

### 6.2 [reaction.html](file:///workspace/cesi/reaction.html)

仅引入 `common.js`，调用 `APEXON.UI.mountUserButton` 与 `APEXON.Tests.Reaction.init()`。包含「测量原理」说明卡，向用户解释 `performance.now` 与设备延迟补偿。

### 6.3 [type.html](file:///workspace/cesi/type.html)

调用 `APEXON.Tests.Type.init()`。页面含实时统计面板（WPM/CPM/正确率/用时）与提示条。

### 6.4 [stick.html](file:///workspace/cesi/stick.html)

**注意**：注意力测试的逻辑全部内联在页面 `<script>` 中，**未抽离到 `common.js`**。

游戏机制：

- 60 秒倒计时
- 一颗绿色小球在 Canvas 内随机弹跳，初始 HP=100
- 鼠标悬停在球上每 100ms +5 分（`HOVER_BONUS`）
- 点击球 HP -1.2（`CLICK_DAMAGE`），HP 归零则球重置并 +1 分
- 速度随时间线性提升 50%（`boost = 1 + (GAME_DURATION - timeLeft) / GAME_DURATION * 0.5`）
- 3% 概率每帧随机变向（`CHANGE_RATE`）
- 球被击败时生成 12 颗粒子爆裂效果（`Particle` 类）
- 倒计时 ≤10s 红色显示并播放 tick 音
- 评级阈值：S≥200 / A≥150 / B≥100 / C≥50 / D<50

关键常量（[stick.html L124-L127](file:///workspace/cesi/stick.html#L124)）：

```js
const BALL_RADIUS = 35, MIN_SPEED = 2, MAX_SPEED_BASE = 5, CHANGE_RATE = 0.03;
const INITIAL_HP = 100, CLICK_DAMAGE = 1.2, HOVER_BONUS = 5;
const HOVER_INTERVAL_MS = 100, HOVER_DISTANCE_OFFSET = 10;
const GAME_DURATION = 60, TICK_INTERVAL_MS = 1000;
```

内联类：`Ball`、`Particle`。

---

## 7. 数据模型与依赖服务

### 7.1 Supabase 数据表

依据 [common.js](file:///workspace/cesi/js/common.js) 中的 REST 调用反推的表结构：

#### `users`（用户同步表）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | text | 主键，Clerk user id（`on_conflict=user_id`） |
| `username` | text | 显示名 |
| `email` | text | 邮箱 |
| `updated_at` | timestamptz | 同步时间 |

#### `scores`（成绩表）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | serial | 主键 |
| `user_id` | text | 关联用户 |
| `username` | text | 冗余存储 |
| `test_type` | text | `reaction` / `type` / `stick` |
| `score_value` | numeric | reaction→ms（升序优）、type→s（升序优）、stick→分（降序优） |
| `accuracy` | numeric | 正确率（type）或违规次数（reaction） |
| `wpm` | numeric | 打字 WPM |
| `cpm` | numeric | 打字 CPM |
| `created_at` | timestamptz | 创建时间 |

#### `comments`（讨论区评论）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | text | 评论者 |
| `username` | text | 冗余显示名 |
| `content` | text | 评论内容（≤500 字，已过滤） |
| `created_at` | timestamptz | 创建时间 |

#### `feedback`（用户反馈）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | text | 提交者姓名 |
| `email` | text | 提交者邮箱 |
| `content` | text | 反馈内容 |

#### `profiles`（个人资料）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | text | 主键（`on_conflict=user_id`） |
| `username` | text | 冗余显示名 |
| `bio` | text | 简介（≤200 字） |
| `location` | text | 位置（≤80 字） |
| `website` | text | 网站（≤200 字） |
| `social_links` | text | 社交链接（≤200 字） |
| `avatar_url` | text | 头像 URL（Storage 公共路径） |
| `updated_at` | timestamptz | 更新时间 |

#### Storage Bucket：`avatars`
路径规则：`avatars/{userId}/{timestamp}.{ext}`，使用 `x-upsert: true` 覆盖上传。

### 7.2 Clerk（身份认证）

- **Publishable Key**：`pk_test_c3Rhci1zdG9yay00LmNsZXJrLmFjY291bnRzLmRldiQ`（test 环境，见各 HTML `<head>`）
- **Clerk Frontend API**：`star-stork-4.clerk.accounts.dev`
- **SDK**：`@clerk/clerk-js@5`，`clerk.browser.js`，`async` 加载
- **使用方式**：纯 JS API（`window.Clerk.load()`、`mountUserButton`、`signOut`、`addListener`、`user.update`、`user.setProfileImage`），未使用 Clerk React 组件
- **UserButton appearance**：注入品牌色 `#6d5dfc`、圆角 12px、自定义元素类名前缀 `apex-clerk-*`

### 7.3 浏览器 API 依赖

| API | 用途 |
| --- | --- |
| `fetch` | 所有 Supabase REST 调用 |
| `performance.now()` | 反应测试高精度计时 |
| `requestAnimationFrame` | 双帧等待 + Canvas 动画 |
| `AudioContext` | 合成音效 |
| `navigator.vibrate` | 振动反馈（移动端） |
| `localStorage` | 主题偏好（`apex-theme`、`apex-bw-mode`） |
| `document.visibilitychange` | 页面可见性 |
| `PointerEvent` / `Touch` / `Mouse` | 多端输入兼容 |
| `Canvas 2D` | 粒子背景 + 注意力测试游戏 |

---

## 8. 样式与设计系统

### 8.1 设计令牌（[styles/variables.css](file:///workspace/cesi/styles/variables.css)）

- **默认主题**：Tech Dark（深邃靛黑 `#05070d` + 冷淡科技紫 `#8b7efc` + 青色光晕 `#22d3ee`）
- **明亮主题**：通过 `html[data-bw="true"]` 触发（浅蓝白 `#eef6ff` + 紫罗兰 `#7c6bc4`）
- **暗色主题**：`[data-theme="dark"]` 显式声明（与默认一致）
- **系统偏好兜底**：`@media (prefers-color-scheme: dark)` 为无 JS 时的 `:root` 提供暗色
- **令牌分类**：品牌色 / 功能强调色 / 语义色 / 背景表面 / 文字 / 边框 / 发光阴影 / 圆角 / 动效 / 布局 / Hero / 字体 / 聚焦环 / 游戏卡片 / Clerk
- **响应式断点**：1024 / 1440 / 1920 / 2560，逐级放大 `--container-max`、`--hero-title`、`--font-base` 等
- **无障碍**：`@media (prefers-reduced-motion: reduce)` 将动效时长压缩到 0.01ms

### 8.2 主样式表（[styles/main.css](file:///workspace/cesi/styles/main.css)）

- 约 3373 行，BEM 命名（`block__element--modifier`）
- Mobile First，覆盖 320 / 375 / 768 / 1024 / 1440 / 1920 / 2560 / 4K
- 顶部声明「白色明亮主题由 variables.css 提供变量覆盖，不再使用 grayscale」
- 主要 Block：`apexon-header`、`hero-apexon`、`item-card`、`leaderboard`、`personal-stats`、`forum-section`、`feedback-section`、`score-card`、`reaction-click-area`、`type-test-area`、`history-list`、`apex-bw-toggle`、`header-user-wrap`、`profile-card` 等

### 8.3 主题切换机制

两套独立切换：

1. **明暗主题**：`html[data-theme="dark"|"light"]`，由 `localStorage['apex-theme']` 或系统偏好决定（`UI.initTheme`）
2. **科技/明亮模式**：`html[data-bw="true"|"false"]`，由 `#bwToggleInput` 复选框控制（首页 header 中的 🌈 切换器）

> 注意：实际页面中 `data-bw="true"` 才会切换到明亮主题，`data-theme` 主要用作暗色标识。

### 8.4 旧版样式

[css/style.css](file:///workspace/cesi/css/style.css)（1709 行）未被任何当前页面引用，疑似历史遗留，可在确认无外部依赖后清理。

---

## 9. 安全机制

APEXON 是纯前端应用，所有「安全」措施均为**纵深防御**而非真正的安全边界（真实边界由 Supabase RLS 与 Clerk 服务端负责）。

### 9.1 输出侧 XSS 防护

- 所有动态字符串插入 HTML 前均调用 `Security.escapeHtml`（如排行榜、评论、个人资料）
- 评级卡内的成绩数据虽经 `escapeHtml`，但模板字符串拼接较多，需注意后续维护

### 9.2 输入侧内容过滤

`Security.filterDangerous` 检测：

- 危险标签：`<script>` `<iframe>` `<object>` `<embed>` `<applet>` `<form>` `<input>` `<textarea>` `<button>` `<link>` `<style>` `<meta>` `<base>` `<svg>` `<math>` `<audio>` `<video>` `<source>` `<track>` `<canvas>` `<map>` `<area>` `<frame>` `<frameset>` `<param>` `<xml>` `<xss>`
- 危险协议：`javascript:` `data:` `vbscript:` `file:` `about:` `blob:`
- 事件处理器：`on\w+\s*=`
- SQL 注入关键字：`SELECT` `INSERT` `UPDATE` `DELETE` `DROP` `UNION` `EXEC` `SCRIPT` `ALTER` `CREATE` `TRUNCATE`、`--`、`;`、`/* */`
- 命中即整体替换为 `[内容已过滤]`，否则剥离所有 HTML 标签

### 9.3 业务数据校验

`Security.validateRecord` 在 `DB.saveScore` 入口强制校验，防篡改成绩写入数据库（数值范围、数组结构）。

### 9.4 测试防作弊

- 打字测试禁用复制、粘贴、右键菜单、Ctrl+C/V
- 反应测试「提前点击」判定为 foul，本轮计 null
- 反应测试 50ms 防抖避免连点
- 页面隐藏时自动暂停（`VisibilityManager`）

### 9.5 待办 / 风险提示

- `SUPABASE_KEY` 为 publishable key，硬编码在前端，**必须配合 Supabase RLS 策略**才能保证数据安全
- `ClerkAuth.deleteAccount` 仅清本地态，未调用 Clerk Delete User API，账号在 Clerk 侧仍存在
- 反馈表单提交后通过 `mailto:` 兜底，依赖用户邮件客户端
- 首页 `index.html` 设了 `<meta name="robots" content="noindex, nofollow">`，但其他页面未设

---

## 10. 项目运行方式

### 10.1 本地预览

由于使用 Clerk 与 Supabase 的远程服务，且 Clerk JS 需通过浏览器加载，**必须以 HTTP 方式访问**（不能直接 `file://` 打开）。

**方式 A：Python 内置服务器**

```bash
cd /workspace/cesi
python3 -m http.server 8080
# 浏览器访问 http://localhost:8080/
```

**方式 B：Node 静态服务器**

```bash
cd /workspace/cesi
npx serve -l 8080 .
# 或
npx http-server -p 8080
```

**方式 C：VS Code Live Server 插件**

右键 `cesi/index.html` → `Open with Live Server`。

### 10.2 运行依赖

- 现代浏览器（支持 ES2020、`fetch`、`AudioContext`、`performance.now`、PointerEvent）
- 网络可访问以下域名：
  - `star-stork-4.clerk.accounts.dev`（Clerk）
  - `kpmsljgonualekjyrkzs.supabase.co`（Supabase）
  - `www.bing.com`（首页搜索框，可选）

### 10.3 配置项

如需切换到自己的 Clerk / Supabase 实例，需修改：

| 位置 | 内容 |
| --- | --- |
| 各 `.html` 的 `<head>` | `data-clerk-publishable-key` 与 Clerk JS `src` |
| [common.js L11-L12](file:///workspace/cesi/js/common.js#L11) | `SUPABASE_URL` 与 `SUPABASE_KEY` |

并在 Supabase 中创建对应表与 RLS 策略、Storage bucket `avatars`。

### 10.4 无需构建

仓库没有 `package.json`、没有 `node_modules`、没有打包步骤。源码即产物，可直接部署。

---

## 11. 部署流程

部署通过 GitHub Actions 自动化，配置见 [.github/workflows/static.yml](file:///workspace/.github/workflows/static.yml)。

**触发条件：**

- `push` 到 `main` 分支
- 手动 `workflow_dispatch`

**执行步骤：**

1. `actions/checkout@v4` 检出代码
2. `actions/configure-pages@v5` 配置 GitHub Pages
3. `actions/upload-pages-artifact@v3` 上传 `./cesi` 目录作为站点 artifact
4. `actions/deploy-pages@v4` 部署到 GitHub Pages

**权限：**

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
```

**并发控制：** `group: "pages"`，`cancel-in-progress: false`（不取消进行中的部署）。

**自定义域名：** 仓库根 [CNAME](file:///workspace/CNAME) 文件内容为 `apexon.qzz.io`，GitHub Pages 自动应用。

---

## 12. 开发约定与注意事项

### 12.1 命名约定

- **CSS**：BEM（`block__element--modifier`），自定义属性以 `--apex-` 前缀
- **JS**：模块对象采用 PascalCase（`Security`、`AudioManager`），挂载到 `APEXON` 后以同名暴露；常量全大写下划线（`TOTAL_ROUNDS`、`STATE_IDLE`）
- **HTML**：`lang="zh-CN"`，`data-theme` / `data-bw` 控制主题

### 12.2 修改建议

- **新增测试类型**：在 `Tests` 下新增子模块，参照 `Tests.Reaction` 实现 `init()` 与状态机；同时扩展 `Security.validateRecord`、`Utils.getGrade`、首页排行榜 tab、`scores` 表的 `test_type` 取值
- **新增数据表**：在 `DB` 中新增对应方法，遵循 `request(table, method, body, query)` 模式；在 Supabase Dashboard 配套建表与 RLS
- **修改主题色**：仅改 [variables.css](file:///workspace/cesi/styles/variables.css) 中的 `--apex-*` 令牌，[main.css](file:///workspace/cesi/styles/main.css) 通过 `var()` 引用

### 12.3 易错点

1. **Clerk 必须显式 `load()`**：`ClerkAuth.init()` 中通过 `setInterval` 轮询 `window.Clerk` 后调用 `Clerk.load()`，否则 user 始终为 null（[L306](file:///workspace/cesi/js/common.js#L306)）
2. **测试引擎不要在 `boot()` 中初始化**：避免重复绑定事件，各页面显式调用 `Tests.X.init()`
3. **`Tests.X.init()` 有重复初始化保护**：通过 `box.dataset.apexInitialized` 标记，同一 DOM 只绑定一次
4. **反应测试的双 `requestAnimationFrame`**：必须等待画面真正变绿后再记录起始时间，否则测得的反应时间会偏小
5. **打字测试的「完成」判定**：以「输入的有效中文字数 ≥ 目标中文字数」为准，不是字符串完全相等
6. **stick 测试逻辑未抽离**：如需复用或维护，注意 [stick.html](file:///workspace/cesi/stick.html) 内联脚本独立于 `common.js`
7. **`APEXON.Auth.user` 是 Clerk user 对象**：直接读取其 `id`、`username`、`imageUrl` 等字段，不要与 `users` 表混淆
8. **排行榜排序方向**：`stick` 降序（分数高优先），`reaction` / `type` 升序（用时短优先），见 [DB.getLeaderboard L131](file:///workspace/cesi/js/common.js#L131)

### 12.4 待优化项

- 抽离 [stick.html](file:///workspace/cesi/stick.html) 内联脚本至 `js/common.js` 的 `Tests.Stick`，统一测试引擎结构
- 清理未引用的 [css/style.css](file:///workspace/cesi/css/style.css) 与 [assets/Loge.base64](file:///workspace/cesi/assets/Loge.base64)
- `ClerkAuth.deleteAccount` 接入 Clerk 删除用户 API
- 为 `reaction.html` / `type.html` / `stick.html` 补充 `<meta name="robots">`
- 将 `SUPABASE_KEY` 与 Clerk publishable key 抽到统一配置文件，便于环境切换
- 考虑引入轻量构建步骤（如 Vite）做代码分割与压缩，提升首屏性能

---

## 附录：模块依赖关系图

```
                     window.APEXON
                          │
        ┌─────────┬───────┼────────┬─────────┬──────────┐
        │         │       │        │         │          │
     Security    DB    ClerkAuth  Audio  Visibility   Utils
        │         │       │        │         │          │
        │         │       │ ┌──────┘         │          │
        │         │       │ │ (init→syncUser)│          │
        │         │       │ ▼                │          │
        │         │       │ DB.syncUser      │          │
        │         │       │                  │          │
        │         │       │  Clerk.addListener             │
        │         │       │       │           │          │
        │         │       │       ▼           │          │
        │         │       │  UI.updateUserDisplay         │
        │         │       │                  │          │
        │         │       ▼                  │          │
        │         │   UI.mountUserButton     │          │
        │         │       │                  │          │
        │         │       ▼                  │          │
        │         │   ClerkAuth.init         │          │
        │         │                          │          │
        │         ▼                          ▼          │
        │   validateRecord ◀──────── saveScore          │
        │                                                │
        ▼                                                │
   escapeHtml ◀────── 各页面渲染（排行榜/评论/资料/成绩卡）
                                                        │
                                                        ▼
                                              Tests.Type / Tests.Reaction
                                                        │
                                              依赖 Auth / DB / Audio /
                                              Visibility / Utils / Security
```

**调用方向总结：**

- `Tests.*` → `Auth` / `DB` / `Audio` / `Visibility` / `Utils` / `Security` / `UI`
- `DB.saveScore` / `DB.addComment` / `DB.addFeedback` / `DB.saveProfile` → `Security`（过滤 + 校验）
- `ClerkAuth.init` / `UI.mountUserButton` → `DB.syncUser`（登录态同步）
- `UI.updateUserDisplay` → `ClerkAuth`（读取登录态）+ `document.dispatchEvent('apexon:userchange')`
- 各页面内联脚本 → `APEXON.*` 全部子模块

---

*文档生成日期：2026-07-04 · 基于 APEXON 核心模块 v4.1*
