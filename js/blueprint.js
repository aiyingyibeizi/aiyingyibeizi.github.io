/**
 * APEXON Weather · 蓝图功能层（v2.7.4）
 *
 * 这里承接 big-ideas-blueprint.md 中「不靠大模型、不联网也能成立」的部分：
 * 晨间三件事、屋檐、通勤、周末、身体感知、睡眠、节气、一天形状、
 * 天气色卡、写给未来、约定、气候小结、单向牵挂、双向牵手、天空窗口。
 *
 * 设计约束：
 *  - 全部文案走本地三语表（简中 / 繁中 / 英），其余语言回退英文，绝不出键名；
 *  - 不新建 CSS 变量，样式全部落在 styles/blueprint.css；
 *  - 动效只用 opacity / transform，时长 ≤ 240ms；视口外的动画不启动；
 *  - 所有网络失败静默降级，界面保留上一次成功的数据并标注时间。
 */

import { $, $$, storage, formatDate } from './common.js';
import { cityStore, settingsStore } from './cache.js';
import { getLanguage, t, onLanguageChange } from './i18n.js';
import * as FAM from './family.js';
import * as LIFE from './life.js';
import * as MEM from './memory.js';
import * as BOND from './bond.js';
import { initBondNotify, syncBondWatch, requestBondNotificationPermission } from './bond-notify.js';
import * as ALBUM from './album.js';
import { getRealtimeWeather } from './api.js';

/* ---------------------------------------------------------- 三语表 */

/** [简体中文, 繁體中文, English]，其余语言回退英文 */
const BT = {
  'morning.leaving': ['现在出门', '現在出門', 'Leaving now'],
  'care.title': ['牵挂的人', '牽掛的人', 'People you follow'],
  'care.add': ['添加一个牵挂的人', '新增一個牽掛的人', 'Add someone'],
  'care.empty': ['只看天气，TA 不会知道', 'Weather only — they are never notified', 'Weather only — they are never notified'],
  'care.updated': ['更新于', '更新於', 'Updated'],
  'care.noCity': ['先在城市页添加一个城市', '先在城市頁新增一個城市', 'Add a city first'],
  'care.send': ['递一句话', '遞一句話', 'Write a line'],
  'care.bond': ['发消息', '傳訊息', 'Message'],
  'care.edit': ['编辑', '編輯', 'Edit'],
  'care.delete': ['删除', '刪除', 'Delete'],
  'care.notes': ['只给自己看的便签', '只給自己看的便籤', 'Private notes'],
  'care.noteAdd': ['加一条便签', '加一條便籤', 'Add a note'],
  'care.name': ['称呼', '稱呼', 'Name'],
  'care.city': ['城市', '城市', 'City'],
  'care.color': ['颜色', '顏色', 'Colour'],
  'care.relation': ['关系', '關係', 'Relation'],
  'care.rel.elder': ['长辈', '長輩', 'Elder'],
  'care.rel.child': ['孩子', '孩子', 'Child'],
  'care.rel.peer': ['同辈', '同輩', 'Friend'],
  'care.alerts': ['提醒范围', '提醒範圍', 'Alerts'],
  'care.alert.rain': ['降水', '降水', 'Rain'],
  'care.alert.extreme': ['极端天气', '極端天氣', 'Severe'],
  'care.alert.cold': ['低温', '低溫', 'Cold'],
  'care.alert.hot': ['高温', '高溫', 'Heat'],
  'care.save': ['保存', '儲存', 'Save'],
  'care.saved': ['已保存', '已儲存', 'Saved'],
  'care.limit': ['最多 20 个人', '最多 20 個人', 'Up to 20 people'],
  'care.noPeople': ['还没有牵挂的人', '還沒有牽掛的人', 'Nobody yet'],
  'care.privacy': ['默认只对可见天气，不读取对方位置，也不通知对方', '預設只看公開天氣，不讀取對方位置，也不通知對方', 'Public weather only — no location access, no notifications'],
  'shape.peak': ['一天形状', '一天形狀', 'Shape of the day'],
  'term.today': ['今日', '今日', 'Today'],
  'term.soon': ['还有', '還有', 'In'],
  'term.days': ['天', '天', 'days'],
  'setting.title': ['阅读与可访问性', '閱讀與可存取性', 'Reading'],
  'setting.clarity': ['清晰模式', '清晰模式', 'Clear mode'],
  'setting.clarityHint': ['去掉毛玻璃与阴影，文字更硬朗', '去掉毛玻璃與陰影，文字更硬朗', 'No blur or shadows, harder edges'],
  'setting.colorblind': ['色觉友好', '色覺友善', 'Colour-blind friendly'],
  'setting.colorblindHint': ['预警与空气等级加形状标记', '預警與空氣等級加形狀標記', 'Adds shape markers to alerts'],
  'setting.largeText': ['大字模式', '大字模式', 'Larger text'],
  'setting.largeTextHint': ['正文与关键数字放大一档', '正文與關鍵數字放大一檔', 'Bumps body and key numbers'],
  'setting.mood': ['字体情绪', '字體情緒', 'Type mood'],
  'setting.moodHint': ['晴天更松、雨天更紧（极轻微）', '晴天更鬆、雨天更緊（極輕微）', 'Slightly looser in sun, tighter in rain'],
  'tool.people': ['牵挂的人', '牽掛的人', 'People'],
  'tool.peopleDesc': ['只看天气、不打扰的单向牵挂', 'One-way care, no notifications', 'One-way care, no notifications'],
  'tool.bond': ['牵手', '牽手', 'Hand in hand'],
  'tool.bondDesc': ['双方同意后互递一句话', 'Both agree, then exchange a line', 'Both agree, then exchange a line'],
  'tool.letters': ['写给未来', '寫給未來', 'Letters to later'],
  'tool.lettersDesc': ['此刻的天气与一句话，留给以后的自己', '此刻的天氣與一句話，留給以後的自己', 'This weather and a line, for later'],
  'tool.colors': ['天气色卡', '天氣色卡', 'Weather palette'],
  'tool.colorsDesc': ['由今天的天空生成一组颜色', '由今天的天空生成一組顏色', 'Colours generated from today'],
  'tool.promises': ['约定', '約定', 'Promises'],
  'tool.promisesDesc': ['一件很小、但会去做的事', '一件很小、但會去做的事', 'One small thing you will do'],
  'tool.climate': ['气候小结', '氣候小結', 'Climate recap'],
  'tool.climateDesc': ['这一段时间的雨、晴与温差', '這段時間的雨、晴與溫差', 'Rain, sun and swings so far'],
  'tool.sky': ['天空窗口', '天空窗口', 'Sky window'],
  'tool.skyDesc': ['只留下温度与一天光', '只留下溫度與一天光', 'Just temperature and light'],
  'letter.placeholder': ['写一句给以后的话…', '寫一句給以後的話…', 'One line for later…'],
  'letter.seal': ['封存', '封存', 'Seal'],
  'letter.month': ['一个月后', '一個月後', 'In a month'],
  'letter.year': ['一年后', '一年後', 'In a year'],
  'letter.sealed': ['封存中，还要等', '封存中，還要等', 'Sealed for'],
  'letter.empty': ['还没有写给未来的信', '還沒有寫給未來的信', 'No letters yet'],
  'letter.today': ['今天的天气', '今天的天氣', "Today's weather"],
  'promise.add': ['写一件小事', '寫一件小事', 'Write something small'],
  'promise.empty': ['还没有约定', '還沒有約定', 'No promises yet'],
  'promise.done': ['做到了', '做到了', 'Done'],
  'climate.empty': ['记录满三天后，这里会有一段小结', '記錄滿三天後，這裡會有一段小結', 'A recap appears after three days'],
  'climate.rain': ['雨天', '雨天', 'rainy days'],
  'climate.sun': ['晴天', '晴天', 'sunny days'],
  'climate.range': ['温度跨度', '溫度跨度', 'range'],
  'climate.gdd': ['积温', '積溫', 'Growing degree days'],
  'climate.gddHint': ['按 5°C 基准从 2 月 1 日累计，只是物候估算', '按 5°C 基準從 2 月 1 日累計，只是物候估算', 'Accumulated from 5°C since Feb 1 — a rough phenology estimate'],
  'climate.days': ['天记录', '天記錄', 'day records'],
  'climate.heirloom': ['把这份记录交给以后', '把這份記錄交給以後', 'Keep this for later'],
  'bond.create': ['生成邀请码', '產生邀請碼', 'Create invite'],
  'bond.join': ['输入邀请码', '輸入邀請碼', 'Enter code'],
  'bond.codeHint': ['把这 6 位给对面的人，24 小时内有效', '把這 6 位給對面的人，24 小時內有效', 'Give these 6 to them, valid for 24h'],
  'bond.copy': ['复制', '複製', 'Copy'],
  'bond.copied': ['已复制', '已複製', 'Copied'],
  'bond.waiting': ['等对方输入', '等對方輸入', 'Waiting for them'],
  'bond.pending': ['有人想和你牵手', '有人想和你牽手', 'Someone wants to connect'],
  'bond.approve': ['同意', '同意', 'Approve'],
  'bond.reject': ['拒绝', '拒絕', 'Decline'],
  'bond.active': ['已连接', '已連接', 'Connected'],
  'bond.revoke': ['断开连接', '斷開連接', 'Disconnect'],
  'bond.revokeHint': ['断开后双方记录立即删除，不可恢复', '斷開後雙方記錄立即刪除，不可復原', 'Both sides are deleted immediately'],
  'bond.say': ['说一句', '說一句', 'Say a line'],
  'bond.fine': ['我挺好', '我挺好', 'I’m fine'],
  'bond.remaining': ['今天还能说', '今天還能說', 'Left today'],
  'bond.lines': ['句', '句', ''],
  'bond.limit': ['今天已经说过三句了，明天再聊', '今天已經說過三句了，明天再聊', 'Three lines today already'],
  'bond.tpl.weather': ['天气', '天氣', 'Weather'],
  'bond.tpl.care': ['关照', '關照', 'Care'],
  'bond.tpl.warm': ['想你', '想你', 'Warm'],
  'bond.empty': ['还没有连接', '還沒有連接', 'Not connected yet'],
  'bond.sendOk': ['已经送到', '已經送到', 'Sent'],
  'bond.sendFail': ['网络没通，这句话没发出去', '網路沒通，這句話沒發出去', 'It did not send'],
  'bond.pendingGuest': ['想与你牵手', '想與你牽手', 'wants to connect'],
  'bond.waitConfirm': ['等对方确认', '等對方確認', 'Waiting for confirmation'],
  'bond.thread': ['消息', '訊息', 'Messages'],
  'bond.noMsg': ['还没有消息', '還沒有訊息', 'No messages yet'],
  'bond.codeFail': ['邀请码不正确或已失效', '邀請碼不正確或已失效', 'Code invalid or expired'],
  'bond.joined': ['已发送请求，等对方确认', '已送出請求，等對方確認', 'Request sent — awaiting approval'],
  'bond.created': ['邀请码已生成', '邀請碼已產生', 'Invite created'],
  'bond.copyFail': ['复制没成功，长按上面的码手动复制', '複製沒成功，長按上面的碼手動複製', 'Copy failed — long-press the code to copy it'],
  'bond.needCity': ['等定位或天气加载完成再试', '等定位或天氣載入完成再試', 'Wait for your city to load first'],
  'bond.needName': ['先写一个称呼', '先寫一個稱呼', 'Give yourself a name first'],
  'bond.revoked': ['对方已经断开了连接', '對方已經斷開了連接', 'They disconnected'],
  'common.close': ['关闭', '關閉', 'Close'],
  'common.off': ['已关闭', '已關閉', 'Off'],
  'common.refreshed': ['已刷新', '已重新整理', 'Refreshed'],
  'common.confirm': ['确定', '確定', 'OK'],
  'common.cancel': ['取消', '取消', 'Cancel'],
  'common.copy': ['复制', '複製', 'Copy'],
  'common.copied': ['已复制', '已複製', 'Copied'],
  'common.unitSwitched': ['已切换为华氏度', '已切換為華氏度', 'Switched to °F'],
  'common.unitSwitchedC': ['已切换为摄氏度', '已切換為攝氏度', 'Switched to °C'],
  'common.needWeather': ['天气还在加载', '天氣還在載入', 'Weather is still loading'],
  'common.today': ['今天', '今天', 'today'],
  'common.now': ['现在', '現在', 'now'],
  'sky.hint': ['轻触任意处退出', '輕觸任意處退出', 'Tap anywhere to leave'],
  'care.talk': ['递话', '遞話', 'Message to copy'],
  'care.talkHint': ['生成一段可以直接复制发出去的话', '產生一段可以直接複製送出的話', 'Generates a line you can copy'],
  'life.title': ['今天的几个判断', '今天的幾個判斷', 'Notes for today'],
  'life.commute': ['通勤', '通勤', 'Commute'],
  'life.weekend': ['周末', '週末', 'Weekend'],
  'life.body': ['身体', '身體', 'Body'],
  'life.sleep': ['今晚', '今晚', 'Tonight'],
  'life.eaves': ['躲雨', '躲雨', 'Rain'],
  'life.pet': ['遛弯', '遛彎', 'Pet'],
  'tool.board': ['家庭天气板', '家庭天氣板', 'Family board'],
  'tool.boardDesc': ['所有人、所有城市，一屏看完', '所有人、所有城市，一屏看完', 'Everyone and every city, one screen'],
  'board.hint': ['这里只显示你牵挂的人，对方不会收到任何通知', '這裡只顯示你牽掛的人，對方不會收到任何通知', 'Only people you follow — they are never notified'],
  'note.title': ['写一句', '寫一句', 'One line'],
  'note.hint': ['只有你能看到，永远不会上传', '只有你能看到，永遠不會上傳', 'Only you can see it, never uploaded'],
  'note.save': ['保存', '儲存', 'Save'],
  'inherit.title': ['配置传承', '設定傳承', 'Set-up for someone'],
  'inherit.hint': ['把城市和牵挂的人做成一段码，在新手机上粘贴即可，不用再一个个加。', '把城市和牽掛的人做成一段碼，在新手機上貼上即可，不用再一個個加。', 'A code with your cities and people — paste it on a new phone.'],
  'inherit.export': ['导出配置码', '匯出設定碼', 'Export code'],
  'inherit.import': ['导入配置码', '匯入設定碼', 'Import code'],
  'inherit.done': ['已导入', '已匯入', 'Imported'],
  'inherit.bad': ['这段码不完整或已损坏', '這段碼不完整或已損壞', 'That code is incomplete'],
  'setting.oneHand': ['单手模式', '單手模式', 'One-hand mode'],
  'setting.oneHandHint': ['场景收窄，三个按钮移到底部', '場景收窄，三個按鈕移到底部', 'Shorter scene, controls move to the bottom'],
  'setting.shake': ['摇一摇刷新', '搖一搖重新整理', 'Shake to refresh'],
  'setting.shakeHint': ['容易误触，默认关闭', '容易誤觸，預設關閉', 'Easy to trigger by accident — off by default'],
  'setting.privacy': ['隐私模式', '隱私模式', 'Privacy mode'],
  'setting.privacyHint': ['隐藏称呼与未读点，只显示城市', '隱藏稱呼與未讀點，只顯示城市', 'Hide names and unread dots — cities only'],
  'setting.autoCheck': ['自动天气提醒', '自動天氣提醒', 'Automatic weather alerts'],
  'setting.autoCheckHint': ['每种每天最多一条，夜里不打扰', '每種每天最多一條，夜裡不打擾', 'Once per rule per day, never at night'],
  'setting.breathe': ['气压提示', '氣壓提示', 'Pressure note'],
  'setting.breatheHint': ['气压异常时，在详情里给一句解释', '氣壓異常時，在詳情裡給一句解釋', 'A short note when pressure is unusual'],
  'breathe.title': ['气压与呼吸', '氣壓與呼吸', 'Pressure and breath'],
  'breathe.hint': ['吸气 4 秒、屏住 7 秒、呼气 8 秒。点一下开始，随时可停。', '吸氣 4 秒、屏住 7 秒、呼氣 8 秒。點一下開始，隨時可停。', 'Inhale 4s, hold 7s, exhale 8s. Tap to start, stop anytime.'],
  'breathe.in': ['吸气', '吸氣', 'Inhale'],
  'breathe.hold': ['屏住', '屏住', 'Hold'],
  'breathe.out': ['呼气', '呼氣', 'Exhale'],
  'breathe.start': ['开始', '開始', 'Start'],
  'breathe.stop': ['停下', '停下', 'Stop'],
  'uv.title': ['紫外线 · 未来 7 天', '紫外線 · 未來 7 天', 'UV · next 7 days'],
  'uv.label': ['紫外线', '紫外線', 'UV'],
  'uv.peak': ['峰值', '峰值', 'Peak'],
  'uv.empty': ['这段时间没有紫外线数据', '這段時間沒有紫外線資料', 'No UV data right now'],
  'tool.wrapped': ['年度天气报告', '年度天氣報告', 'Year in weather'],
  'tool.wrappedDesc': ['只用真实记录，不满 90 天不生成', '只用真實記錄，不滿 90 天不生成', 'Only from real records — under 90 days, nothing'],
  'wrap.days': ['天记录', '天記錄', 'days recorded'],
  'wrap.sun': ['晴天', '晴天', 'sunny'],
  'wrap.rain': ['雨天', '雨天', 'rainy'],
  'wrap.snow': ['雪天', '雪天', 'snowy'],
  'wrap.cities': ['座城市', '座城市', 'cities'],
  'wrap.hot': ['最热的一天', '最熱的一天', 'Hottest day'],
  'wrap.cold': ['最冷的一天', '最冷的一天', 'Coldest day'],
  'wrap.avg': ['全年均温', '全年均溫', 'Year average'],
  'wrap.empty': ['记录还不满 90 天，等一年再来看', '記錄還不滿 90 天，等一年再來看', 'Fewer than 90 days recorded — come back later'],
  'tool.warnings': ['预警年表', '預警年表', 'Alert log'],
  'tool.warningsDesc': ['过去发生过的极端天气，按时间排好', '過去發生過的極端天氣，按時間排好', 'Past severe weather, in order'],
  'warnlog.title': ['今年预警', '今年預警', 'Alerts this year'],
  'warnlog.empty': ['还没有记录到预警，这是好事', '還沒有記錄到預警，這是好事', 'No alerts recorded — that is good'],
  'warnlog.total': ['条', '條', 'records'],
  'warnlog.cities': ['座城市', '座城市', 'cities'],
  'care.dupCity': ['这个城市已经有人了，确定要再加一个？', '這個城市已經有人了，確定要再加一個？', 'Someone is already on this city. Add another?'],
  'care.dupAdd': ['仍然添加', '仍然新增', 'Add anyway'],
  'care.undo': ['已删除', '已刪除', 'Deleted'],
  'care.undoBtn': ['撤销', '撤銷', 'Undo'],
  'care.undoDone': ['已恢复', '已恢復', 'Restored'],
  'bond.keep': ['对话只保留 30 天', '對話只保留 30 天', 'Messages are kept for 30 days'],
  'bond.autoSent': ['提醒已送到', '提醒已送到', 'Alert sent'],
  'bond.autoFail': ['提醒暂时发不出去，天气照常', '提醒暫時送不出去，天氣照常', 'Alerts are offline — weather is unaffected'],
  'bond.autoPrefix': ['提醒你：', '提醒你：', 'reminds you: '],

  /* ---------------- 2.7.6 · 天气相册（G1 类型的替代物） ---------------- */
  'tool.album': ['天气相册', '天氣相冊', 'Weather album'],
  'tool.albumDesc': ['拍下此刻的天空，只留在这台手机', '拍下此刻的天空，只留在這台手機', 'Snap this sky — kept on this phone only'],
  'album.take': ['拍照', '拍照', 'Take a photo'],
  'album.pick': ['从相册选择', '從相簿選擇', 'Choose from library'],
  'album.empty': ['还没有照片。拍下今天的天，它会记住城市与温度。', '還沒有照片。拍下今天的天，它會記住城市與溫度。', 'No photos yet. One shot remembers the city and the temperature.'],
  'album.filterAll': ['全部', '全部', 'All'],
  'album.filterDay': ['按日期', '按日期', 'By date'],
  'album.filterWeather': ['按天气', '按天氣', 'By weather'],
  'album.filterKind.sun': ['晴', '晴', 'Sunny'],
  'album.filterKind.rain': ['雨', '雨', 'Rain'],
  'album.filterKind.snow': ['雪', '雪', 'Snow'],
  'album.filterKind.cloud': ['云', '雲', 'Cloud'],
  'album.count': ['张', '張', 'photos'],
  'album.delete': ['删除', '刪除', 'Delete'],
  'album.deleteHint': ['删除后无法恢复，只影响这台手机', '刪除後無法復原，只影響這台手機', 'Deleted for good — this phone only'],
  'album.save': ['保存到手机相册', '儲存到手機相簿', 'Save to photos'],
  'album.saving': ['正在处理照片…', '正在處理照片…', 'Processing photo…'],
  'album.added': ['已加入相册', '已加入相冊', 'Added to album'],
  'album.failed': ['这张照片读不出来', '這張照片讀不出來', 'That photo could not be read'],
  'album.unsupported': ['这台设备不支持本地相册存储', '這台裝置不支援本機相簿儲存', 'This device cannot store a local album'],
  'album.noWeather': ['未记录天气', '未記錄天氣', 'No weather recorded'],
  'album.saveHint': ['会打开系统分享，可直接存进相册', '會開啟系統分享，可直接存進相簿', 'Opens the system share sheet — save straight to photos'],
  'album.local': ['只存本机 · 不上传 · 不联网', '只存本機 · 不上傳 · 不聯網', 'On this phone only · never uploaded'],

  /* ---------------- 2.7.6 · 一起看（I5） ---------------- */
  'tool.watch': ['一起看', '一起看', 'Watch together'],
  'tool.watchDesc': ['两座城市，同一时刻的天空', '兩座城市，同一時刻的天空', 'Two cities, the same moment'],
  'watch.pick': ['选择城市', '選擇城市', 'Choose a city'],
  'watch.needTwo': ['至少需要两座城市，先在城市页添加', '至少需要兩座城市，先在城市頁新增', 'Add at least two cities first'],
  'watch.same': ['同一时刻', '同一時刻', 'Same moment'],
  'watch.loading': ['正在对齐两地的天空…', '正在對齊兩地的天空…', 'Lining up both skies…'],
  'watch.fail': ['有一边的天空暂时取不到', '有一邊的天空暫時取不到', 'One of the skies is unavailable'],
  'watch.save': ['保存这张并排图', '儲存這張並排圖', 'Save this side-by-side'],
  'watch.saved': ['已生成', '已產生', 'Created'],

  /* ---------------- 2.7.6 · 发现页分区 ---------------- */
  'discover.hero': ['今天最适合', '今天最適合', 'Best for today'],
  'discover.group.relations': ['关系', '關係', 'Relationships'],
  'discover.group.memory': ['记忆', '記憶', 'Memory'],
  'discover.group.climate': ['气候', '氣候', 'Climate'],
  'discover.group.tools': ['工具', '工具', 'Tools'],
  'discover.heroHint': ['点开看看', '點開看看', 'Open it'],
};

const LANG_INDEX = { 'zh-CN': 0, 'zh-TW': 1 };

/** 取一段本地化文案：没有的键返回空串，界面上宁可少一行也不出键名 */
export function bt(key) {
  const row = BT[key];
  if (!row) return '';
  const i = LANG_INDEX[getLanguage()];
  return row[i === undefined ? 2 : i] || row[2];
}

/* --------------------------------------------------------------- 工具 */

const PREF_KEY = 'apexon_bp_prefs';

function prefs() {
  return storage.get(PREF_KEY, {}) || {};
}

function setPrefs(patch) {
  storage.set(PREF_KEY, { ...prefs(), ...patch });
  applyPreferences();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tempText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const unit = settingsStore.get().unit === 'f' ? 'f' : 'c';
  const value = unit === 'f' ? Math.round((n * 9) / 5 + 32) : Math.round(n);
  return `${value}°`;
}

let api = null; // { getState, toast, reload }

/* --------------------------------------------------------- 首页挂载 */

function mountHome() {
  const home = $('#page-home');
  if (!home) return;

  if (!$('#bp-morning')) {
    const el = document.createElement('div');
    el.id = 'bp-morning';
    el.className = 'bp-morning';
    el.hidden = true;
    const anchor = $('#alert-bar');
    if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }

  // 2.11 自动提醒条：挂在预警条下面，一天最多提一次，可手动收起
  if (!$('#bp-auto')) {
    const el = document.createElement('div');
    el.id = 'bp-auto';
    el.className = 'bp-auto';
    el.hidden = true;
    const anchor = $('#alert-bar');
    if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }

  if (!$('#bp-care')) {
    const el = document.createElement('section');
    el.id = 'bp-care';
    el.className = 'bp-care';
    el.hidden = true;
    const current = $('#current-section');
    if (current?.parentNode) current.parentNode.insertBefore(el, current.nextSibling);
  }

  if (!$('#bp-life')) {
    const el = document.createElement('div');
    el.id = 'bp-life';
    el.className = 'bp-block';
    el.hidden = true;
    const care = $('#bp-care');
    if (care?.parentNode) care.parentNode.insertBefore(el, care.nextSibling);
  }

  if (!$('#bp-shape')) {
    const el = document.createElement('div');
    el.id = 'bp-shape';
    el.className = 'bp-shape';
    el.hidden = true;
    $('#daily-section')?.appendChild(el);
  }

  if (!$('#bp-term')) {
    const el = document.createElement('div');
    el.id = 'bp-term';
    el.className = 'bp-term';
    $('#sun-section')?.appendChild(el);
  }

  if (!$('.bp-warm-layer')) {
    const el = document.createElement('div');
    el.className = 'bp-warm-layer';
    document.body.appendChild(el);
  }

  // A3 气压提示：挂在天气详情卡片内部末尾，随详情一起滚动
  if (!$('#bp-breathe')) {
    const el = document.createElement('div');
    el.id = 'bp-breathe';
    el.className = 'bp-breathe';
    el.hidden = true;
    $('#details-section')?.appendChild(el);
  }
}

/* ------------------------------------------------ 自动提醒（2.11） */

const AUTO_DISMISS_KEY = 'apexon_auto_dismiss';

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 只对「牵挂的人」做一次判断：预警优先，其次明日骤降/大雨。
 * 一天只提示一条，关掉后当天不再出现；点击可跳到牵挂工具页。
 */
function renderAutoAlerts(weather) {
  const box = $('#bp-auto');
  if (!box) return;
  if (prefs().autoCheck === false) {
    box.hidden = true;
    return;
  }
  if (storage.get(AUTO_DISMISS_KEY, '') === todayStamp()) {
    box.hidden = true;
    return;
  }
  const people = FAM.getPeople();
  if (!people.length) {
    box.hidden = true;
    return;
  }
  const wx = FAM.getPeopleWeather();
  let picked = null;
  people.forEach((p) => {
    if (picked) return;
    const sub = FAM.buildSubtitle(p, wx[p.id], weather, null);
    if (sub.tone === 'alert') picked = { text: sub.text, name: p.label || p.city?.name || '' };
  });
  if (!picked) {
    people.forEach((p) => {
      if (picked) return;
      const sub = FAM.buildSubtitle(p, wx[p.id], weather, null);
      if (sub.text) picked = { text: sub.text, name: p.label || p.city?.name || '' };
    });
  }
  if (!picked) {
    box.hidden = true;
    return;
  }
  box.innerHTML = `
    <div class="bp-auto__row" data-bp="care-go" role="button" tabindex="0">
      <span class="bp-auto__bell" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"></path>
          <path d="M10.3 20a2 2 0 0 0 3.4 0"></path>
        </svg>
      </span>
      <span class="bp-auto__text">${esc(picked.text)}</span>
      <span class="bp-auto__close" data-bp="auto-close" role="button" aria-label="${esc(bt('common.close'))}">×</span>
    </div>
  `;
  box.hidden = false;
}

/* ------------------------------------------------------ 气压与呼吸（A3） */

/**
 * 只在气压异常时出现，且默认关闭时整块消失。
 * 不做「可能导致偏头痛」这类伪医学，只把气压数字翻译成一句人话。
 */
function renderBreathe(weather) {
  const box = $('#bp-breathe');
  if (!box) return;
  if (prefs().breathe === false || !weather?.realtime) {
    box.hidden = true;
    return;
  }
  const note = LIFE.pressureNote(weather);
  if (!note) {
    box.hidden = true;
    return;
  }
  box.innerHTML = `
    <button type="button" class="bp-breathe__row" data-breathe-open>
      <span class="bp-breathe__text">${esc(note.text)}</span>
      <span class="bp-breathe__more">${esc(bt('breathe.title'))} ›</span>
    </button>
  `;
  box.hidden = false;
}

let breathTimers = [];

function stopBreath(overlay) {
  breathTimers.forEach((t) => clearInterval(t));
  breathTimers = [];
  overlay?.querySelector('.bp-breathe-stage')?.classList.remove('bp-breathe-stage--run');
}

/** 4-7-8 呼吸环：纯 CSS transform + opacity，点一下才开始，随时可停 */
function openBreathSheet() {
  const overlay = openSheet({
    title: bt('breathe.title'),
    html: `
      <div class="bp-breathe-stage">
        <div class="bp-ring" aria-hidden="true"></div>
        <div class="bp-ring__label" data-breath-label>${esc(bt('breathe.start'))}</div>
      </div>
      <p class="bp-line--dim" style="text-align:center">${esc(bt('breathe.hint'))}</p>
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-breath-toggle>${esc(bt('breathe.start'))}</button>
      </div>
    `,
  });
  if (!overlay) return;
  const stage = overlay.querySelector('.bp-breathe-stage');
  const label = overlay.querySelector('[data-breath-label]');
  const toggle = overlay.querySelector('[data-breath-toggle]');
  let running = false;

  const phases = [
    [0, 4000, 'breathe.in'],
    [4000, 7000, 'breathe.hold'],
    [11000, 8000, 'breathe.out'],
  ];

  const paint = () => {
    const t = (Date.now() - started) % 19000;
    const phase = phases.find(([from, dur]) => t >= from && t < from + dur) || phases[0];
    if (label) label.textContent = bt(phase[2]);
  };
  let started = 0;

  toggle?.addEventListener('click', () => {
    running = !running;
    if (!running) {
      stopBreath(overlay);
      if (label) label.textContent = bt('breathe.start');
      toggle.textContent = bt('breathe.start');
      return;
    }
    started = Date.now();
    stage?.classList.add('bp-breathe-stage--run');
    toggle.textContent = bt('breathe.stop');
    paint();
    breathTimers.push(setInterval(paint, 250));
  });
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-sheet-close]')) stopBreath(overlay);
  });
}

/* ------------------------------------------------ 紫外线（D3） */

function openUvSheet(daily) {
  const uv = LIFE.uvWindow(daily || api?.getState?.().weather?.daily);
  if (!uv) {
    api?.toast?.(bt('uv.empty'), 1600);
    return;
  }
  const bars = uv.days.map((d) => {
    const h = Math.max(6, Math.round((d.uv / 12) * 100));
    const hot = d.uv >= 6;
    return `
      <div class="bp-uv__col">
        <div class="bp-uv__track"><i class="bp-uv__bar ${hot ? 'bp-uv__bar--hot' : ''}" style="height:${h}%"></i></div>
        <span class="bp-uv__num">${d.uv}</span>
        <span class="bp-uv__day">${esc(String(d.date).slice(5))}</span>
      </div>`;
  }).join('');
  openSheet({
    title: bt('uv.title'),
    html: `
      <p class="bp-line">${esc(uv.advice)}</p>
      <div class="bp-uv">${bars}</div>
      <p class="bp-line--dim">${esc(bt('uv.peak'))} ${uv.max} · ${esc(bt('uv.label'))}</p>
    `,
  });
}

/* ------------------------------------------------ A3/A4：摇一摇刷新（X4） */

/**
 * 默认关闭。开启后加速度阈值 18，2 秒冷却，避免走路时误触。
 */
let shakeBound = false;
function setupShakeRefresh() {
  if (shakeBound || prefs().shake !== true) return;
  if (typeof window.DeviceMotionEvent === 'undefined') return;
  let last = 0;
  const onMotion = (e) => {
    if (prefs().shake !== true) return;
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0);
    const now = Date.now();
    if (mag < 30 || now - last < 2000) return;
    last = now;
    if (navigator.vibrate) navigator.vibrate(12);
    api?.refresh?.();
    api?.toast?.(bt('common.refreshed'), 1200);
  };
  window.addEventListener('devicemotion', onMotion, { passive: true });
  shakeBound = true;
}

/* ------------------------------------------------ 双指捏合（X2） */

let pinchStart = 0;
function setupPinch() {
  const home = $('#page-home');
  if (!home) return;
  home.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { pinchStart = 0; return; }
    const [a, b] = e.touches;
    pinchStart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }, { passive: true });
  home.addEventListener('touchend', () => {
    pinchStart = 0;
  }, { passive: true });
  home.addEventListener('touchmove', (e) => {
    if (!pinchStart || e.touches.length !== 2) return;
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (dist < pinchStart * 0.82) {
      pinchStart = 0;
      if (navigator.vibrate) navigator.vibrate(10);
      openSky();
    }
  }, { passive: true });
}

/* ------------------------------------------------------ 晨间三件事 */

function renderMorning(weather) {
  const box = $('#bp-morning');
  if (!box) return;
  const now = new Date();
  const hour = now.getHours();
  if (!weather?.realtime || hour < 4 || hour > 11) {
    box.hidden = true;
    return;
  }
  const facts = LIFE.buildMorningFacts(weather, now);
  if (!facts.length) {
    box.hidden = true;
    return;
  }
  box.innerHTML = facts.map((f) => `
    <div class="bp-morning__row">
      <span class="bp-morning__time">${esc(f.time)}</span>
      <span class="bp-morning__text">${esc(f.text)}</span>
      <span class="bp-morning__detail">${esc(f.detail)}</span>
    </div>
  `).join('');
  box.hidden = false;
}

/* --------------------------------------------------------- 牵挂卡片 */

function personCard(person, entry, local, unread) {
  const sub = FAM.buildSubtitle(person, entry, local, unread);
  const rt = entry?.rt;
  const color = person.color || 'var(--brand-primary)';
  const soft = `${color}22`;
  const weatherText = rt ? `${rt.text || ''}` : (entry ? '' : '');
  // C31 隐私模式：称呼、emoji、未读点、真人原话全部收起，只留城市与天气
  const hide = !!prefs().privacy;
  const label = hide ? (person.city?.name || '') : (person.label || person.city?.name || '');
  const avatar = hide ? '·' : (person.emoji || '·');
  return `
    <button type="button" class="bp-person" data-person="${esc(person.id)}"
            style="--bp-person-color:${esc(color)};--bp-person-soft:${esc(soft)}">
      <span class="bp-person__avatar">${esc(avatar)}</span>
      <span class="bp-person__main">
        <span class="bp-person__top">
          <span class="bp-person__name">${esc(label)}</span>
          <span class="bp-person__temp">${tempText(rt?.temp)}</span>
        </span>
        <span class="bp-person__weather">${esc(person.city?.name || '')}${weatherText ? ` · ${esc(weatherText)}` : ''}</span>
        ${!hide && sub.text ? `<span class="bp-person__sub ${sub.tone === 'alert' ? 'bp-person__sub--alert' : ''}">${esc(sub.text)}</span>` : ''}
        ${entry?.stale ? `<span class="bp-person__stale">${esc(FAM.weatherAgeText(entry))}</span>` : ''}
      </span>
      ${!hide && sub.unread ? '<span class="bp-person__unread" aria-hidden="true"></span>' : ''}
    </button>
  `;
}

async function renderCare() {
  const box = $('#bp-care');
  if (!box) return;
  const people = FAM.getPeople();
  const state = api?.getState?.() || {};
  const local = state.weather;
  // C15：牵挂区可整体折叠 —— 公共场合不想让别人看到自己在看谁
  const collapsed = !!prefs().careCollapsed;

  const head = `
    <div class="bp-care__head">
      <span class="bp-care__title">${esc(bt('care.title'))}</span>
      ${people.length ? `<span class="bp-care__count">${people.length}</span>` : ''}
      <button type="button" class="bp-care__fold" data-bp="care-fold"
              aria-expanded="${collapsed ? 'false' : 'true'}"
              aria-label="${esc(bt('care.title'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
    </div>`;

  if (!people.length) {
    box.innerHTML = `${head}
      <div class="bp-care__grid">
        <button type="button" class="bp-person bp-person--ghost" data-bp="care-add">
          <span>＋ ${esc(bt('care.add'))}</span>
        </button>
      </div>`;
    box.hidden = false;
    box.classList.remove('bp-care--collapsed');
    return;
  }

  const shown = people.slice(0, FAM.HOME_PEOPLE_LIMIT);
  const wx = FAM.getPeopleWeather();

  box.innerHTML = `${head}
    <div class="bp-care__grid bp-fade-in">
      ${shown.map((p) => personCard(p, wx[p.id], local, BOND.unreadFor(p.bondId))).join('')}
      ${people.length < 4 ? `<button type="button" class="bp-person bp-person--ghost" data-bp="care-add"><span>＋ ${esc(bt('care.add'))}</span></button>` : ''}
    </div>`;
  box.hidden = false;
  box.classList.toggle('bp-care--collapsed', collapsed);
  // 折叠状态下不去拉天气，省流量也省额度
  if (collapsed) return;

  // 先出结构，再补天气；失败的保持上一份数据
  const before = JSON.stringify(shown.map((p) => wx[p.id]?.t || 0));
  await FAM.fetchPeopleWeather(shown);
  const after = FAM.getPeopleWeather();
  const changed = JSON.stringify(shown.map((p) => after[p.id]?.t || 0)) !== before;
  if (changed) {
    box.querySelector('.bp-care__grid')?.replaceChildren(...shown.map((p) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = personCard(p, after[p.id], local, BOND.unreadFor(p.bondId));
      return wrap.firstElementChild;
    }));
  }
}

/* ------------------------------------------------ 今天的几个判断 */

/**
 * 首页第二块：最多三行，每行一个判断。
 * 只在真的有时说——没有就整块消失，不做「暂无内容」占位。
 */
function renderLifeBlock(weather) {
  const box = $('#bp-life');
  if (!box || !weather?.realtime) {
    if (box) box.hidden = true;
    return;
  }
  const now = new Date();
  const hour = now.getHours();
  const dow = now.getDay();
  const rows = [];

  const text = String(weather.realtime.text || '');
  const wet = text.includes('雨') || text.toLowerCase().includes('rain');

  if (wet) {
    const eaves = LIFE.eavesAdvice(weather.minutely, weather.hourly, now);
    if (eaves) rows.push({ tag: bt('life.eaves'), text: eaves.text });
  }
  if (hour >= 5 && hour <= 10) {
    const commute = LIFE.commuteAdvice(weather, now);
    if (commute) rows.push({ tag: bt('life.commute'), text: commute.text });
  }
  if (dow >= 4 || dow === 0) {
    const plan = LIFE.weekendPlan(weather, now);
    if (plan) rows.push({ tag: bt('life.weekend'), text: `${plan.text} · ${plan.suggestion}` });
  }
  const body = LIFE.bodySense(weather);
  if (body) rows.push({ tag: bt('life.body'), text: body.text });
  const pet = LIFE.petAdvice(weather, now);
  if (pet) rows.push({ tag: bt('life.pet'), text: pet.text });
  if (hour >= 18 || hour <= 2) {
    const sleep = LIFE.sleepTip(weather);
    if (sleep) rows.push({ tag: bt('life.sleep'), text: sleep.text });
  }

  if (!rows.length) {
    box.hidden = true;
    return;
  }

  box.innerHTML = `
    <div class="bp-block__title">${esc(bt('life.title'))}</div>
    ${rows.slice(0, 3).map((r) => `
      <div class="bp-life__row">
        <span class="bp-life__tag">${esc(r.tag)}</span>
        <span class="bp-life__text">${esc(r.text)}</span>
      </div>
    `).join('')}
  `;
  box.hidden = false;
}

/* --------------------------------------------------------- 一天形状 */

function renderShape(weather) {
  const box = $('#bp-shape');
  if (!box) return;
  const shape = MEM.dayShape(weather);
  if (!shape) {
    box.hidden = true;
    return;
  }
  box.innerHTML = `
    ${shape.bars.map((h, i) => `<span class="bp-shape__bar ${i === shape.bars.indexOf(Math.max(...shape.bars)) ? 'bp-shape__bar--peak' : ''} ${i < 6 || i > 21 ? 'bp-shape__bar--night' : ''}" style="height:${h}%"></span>`).join('')}
    <span class="bp-shape__label">${esc(shape.label)}</span>
  `;
  box.hidden = false;
}

/* ------------------------------------------------------ 节气小字 */

function renderTerm() {
  const box = $('#bp-term');
  if (!box) return;
  const now = new Date();
  const festival = LIFE.festivalOf(now);
  const term = LIFE.solarTermOf(now);

  if (festival) {
    box.innerHTML = `<span class="bp-term__dot"></span><span>${esc(festival.name)}</span>`;
    return;
  }
  if (term && term.name && term.inDays === undefined) {
    box.innerHTML = `<span class="bp-term__dot"></span><span>${esc(bt('term.today'))} ${esc(term.name)}</span>`;
    return;
  }
  if (term?.inDays) {
    box.innerHTML = `<span class="bp-term__dot"></span><span>${esc(term.name)} · ${esc(bt('term.soon'))} ${term.inDays} ${esc(bt('term.days'))}</span>`;
    return;
  }
  box.innerHTML = '';
}

/* --------------------------------------------------- 偏好 / 可访问性 */

export function applyPreferences() {
  const p = prefs();
  const root = document.documentElement;
  root.dataset.clarity = p.clarity ? '1' : '0';
  root.dataset.colorblind = p.colorblind ? '1' : '0';
  root.dataset.textsize = p.largeText ? 'large' : 'normal';
  root.dataset.hand = p.oneHand ? '1' : '0';
  root.dataset.privacy = p.privacy ? '1' : '0';
  root.dataset.shake = p.shake ? '1' : '0';
}

/** 暖光 + 字体情绪：每次天气更新后调用 */
function applyAtmosphere(weather) {
  const root = document.documentElement;
  const factor = LIFE.warmLightFactor(weather, new Date());
  root.style.setProperty('--bp-warm', factor.toFixed(3));
  root.dataset.warm = factor > 0.12 ? '1' : '0';

  if (prefs().mood === false) {
    root.style.removeProperty('--bp-mood-weight');
    root.style.removeProperty('--bp-mood-spacing');
    return;
  }
  const mood = LIFE.typographyMood(weather);
  root.style.setProperty('--bp-mood-weight', String(mood.weight));
  root.style.setProperty('--bp-mood-spacing', mood.spacing);
}

/* --------------------------------------------------------- 总入口 */

export function updateBlueprint(state) {
  const weather = state?.weather;
  if (!weather) return;
  renderMorning(weather);
  renderLifeBlock(weather);
  renderShape(weather);
  renderTerm();
  applyAtmosphere(weather);
  renderBreathe(weather);
  if (state.currentCity) MEM.recordDayCapsule(state.currentCity, weather);
  void renderCare();
  renderAutoAlerts(weather);
  renderDiscoverHero(weather);
  if (state.currentPage === 'tool' && ['people', 'climate', 'colors', 'wrapped', 'warnings'].includes(state.currentTool)) {
    renderBlueprintTool(state.currentTool);
  }
}

/* --------------------------------------------------------- 设置项 */

function buildSettingsGroup() {
  const body = $('#settings-sheet .sheet__body');
  if (!body || $('#bp-settings')) return;
  const p = prefs();
  const group = document.createElement('div');
  group.className = 'sheet__group';
  group.id = 'bp-settings';
  group.innerHTML = `
    <div class="sheet__group-title">${esc(bt('setting.title'))}</div>
    <div class="sheet__row"><span>${esc(bt('setting.clarity'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.clarity ? 'true' : 'false'}" data-bp-toggle="clarity" aria-label="${esc(bt('setting.clarity'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.colorblind'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.colorblind ? 'true' : 'false'}" data-bp-toggle="colorblind" aria-label="${esc(bt('setting.colorblind'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.largeText'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.largeText ? 'true' : 'false'}" data-bp-toggle="largeText" aria-label="${esc(bt('setting.largeText'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.mood'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.mood === false ? 'false' : 'true'}" data-bp-toggle="mood" aria-label="${esc(bt('setting.mood'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.oneHand'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.oneHand ? 'true' : 'false'}" data-bp-toggle="oneHand" aria-label="${esc(bt('setting.oneHand'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.shake'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.shake ? 'true' : 'false'}" data-bp-toggle="shake" aria-label="${esc(bt('setting.shake'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.privacy'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.privacy ? 'true' : 'false'}" data-bp-toggle="privacy" aria-label="${esc(bt('setting.privacy'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.autoCheck'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.autoCheck === false ? 'false' : 'true'}" data-bp-toggle="autoCheck" aria-label="${esc(bt('setting.autoCheck'))}"></button>
    </div>
    <div class="sheet__row"><span>${esc(bt('setting.breathe'))}</span>
      <button type="button" class="bp-switch__track" role="switch" aria-checked="${p.breathe === false ? 'false' : 'true'}" data-bp-toggle="breathe" aria-label="${esc(bt('setting.breathe'))}"></button>
    </div>
  `;
  const about = body.querySelector('#app-group');
  if (about?.parentNode) about.parentNode.insertBefore(group, about);
  else body.appendChild(group);

  $$('[data-bp-toggle]', group).forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.bpToggle;
      const current = key === 'mood' ? prefs().mood !== false : !!prefs()[key];
      const next = !current;
      setPrefs({ [key]: next });
      btn.setAttribute('aria-checked', next ? 'true' : 'false');
      if (key === 'privacy') {
        void renderCare();
        api?.toast?.(next ? bt('setting.privacy') : bt('common.off'), 1200);
      } else if (key === 'oneHand') {
        api?.toast?.(next ? bt('setting.oneHand') : bt('common.off'), 1200);
      } else if (key === 'autoCheck') {
        if (next) renderAutoAlerts(api?.getState?.()?.weather);
      } else if (key === 'shake') {
        if (next) setupShakeRefresh();
        api?.toast?.(next ? bt('setting.shake') : bt('common.off'), 1200);
      } else if (key === 'breathe') {
        renderBreathe(api?.getState?.()?.weather);
      } else {
        api?.toast?.(bt('care.saved'), 1200);
      }
    });
  });
}

/* --------------------------------------------------------- 长按切单位 */

function setupLongPressUnit() {
  const hero = $('#current-section');
  if (!hero) return;
  let timer = 0;
  let fired = false;

  const clear = () => {
    clearTimeout(timer);
    timer = 0;
  };

  hero.addEventListener('pointerdown', (e) => {
    // 只在温度区域生效，避免长按整卡误触
    if (!e.target.closest('.current__temp, #temp-roll')) return;
    fired = false;
    clear();
    timer = setTimeout(() => {
      fired = true;
      const unit = settingsStore.get().unit === 'f' ? 'c' : 'f';
      const opt = $(`#unit-select .segmented__opt[data-value="${unit}"]`);
      if (opt) opt.click();
      if (navigator.vibrate) navigator.vibrate(12);
      api?.toast?.(unit === 'f' ? bt('common.unitSwitched') : bt('common.unitSwitchedC'), 1400);
    }, 600);
  }, { passive: true });

  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach((type) => {
    hero.addEventListener(type, clear, { passive: true });
  });

  // 长按触发后吞掉紧随其后的 click，避免同时触发刷新等操作
  hero.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/* ------------------------------------------------------------ 初始化 */

export function initBlueprint(devApi) {
  api = devApi;
  mountHome();
  applyPreferences();
  buildSettingsGroup();
  setupLongPressUnit();
  setupPinch();
  if (prefs().shake === true) setupShakeRefresh();
  mountSkyPage();
  mountDiscoverCards();
  setupDelegates();
  // 发现页由 JS 生成，切语言后需要整页重排（卡片文案不在 data-i18n 体系内）
  onLanguageChange(() => renderDiscoverPage());
  void renderCare();
  // 牵手消息：前台轮询 + 原生后台检查 + 通知权限
  initBondNotify();
}

/* ------------------------------------------------------- 通用弹窗 */

let activeSheet = null;
let sheetKeyHandler = null;

function closeSheet() {
  if (!activeSheet) return;
  const el = activeSheet;
  activeSheet = null;
  stopBreath(el);
  el.classList.remove('sheet-overlay--visible');
  if (sheetKeyHandler) {
    document.removeEventListener('keydown', sheetKeyHandler);
    sheetKeyHandler = null;
  }
  setTimeout(() => el.remove(), 260);
}

function openSheet({ title, html, onMount }) {
  closeSheet();
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__handle"></div>
      <div class="sheet__header">
        <h2 class="sheet__title">${esc(title)}</h2>
        <button type="button" class="icon-btn" data-sheet-close aria-label="${esc(bt('common.close'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1.25rem;height:1.25rem"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="sheet__body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeSheet = overlay;
  requestAnimationFrame(() => overlay.classList.add('sheet-overlay--visible'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-sheet-close]')) closeSheet();
  });
  document.addEventListener('keydown', sheetKeyHandler = function onKey(e) {
    if (e.key !== 'Escape' || !activeSheet) return;
    closeSheet();
  });
  onMount?.(overlay);
  setupSheetDrag(overlay);
  return overlay;
}

/**
 * X9：底部弹窗下拉关闭。
 * 只跟手到 45% 高度内（再往下阻尼递减），松手时超过 60% 直接关，
 * 否则回弹。全程只写 transform，不触发排版。
 */
function setupSheetDrag(overlay) {
  const sheet = overlay.querySelector('.sheet');
  const handle = overlay.querySelector('.sheet__handle');
  if (!sheet || !handle) return;

  let startY = 0;
  let dy = 0;
  let dragging = false;

  const setY = (value, animate) => {
    sheet.style.transition = animate ? 'transform 240ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    sheet.style.transform = value > 0 ? `translate3d(0, ${value.toFixed(1)}px, 0)` : '';
  };

  const end = () => {
    dragging = false;
    const limit = sheet.offsetHeight * 0.6;
    if (dy > limit) {
      setY(sheet.offsetHeight, true);
      closeSheet();
    } else {
      setY(0, true);
    }
    dy = 0;
  };

  const begin = (y) => {
    startY = y;
    dy = 0;
    dragging = true;
    sheet.style.transition = 'none';
  };

  const applyDiff = (diff) => {
    if (diff <= 0) {
      dy = 0;
      setY(0, false);
      return;
    }
    // 越往下越沉，避免一拉就把弹窗甩到底
    dy = diff * (1 - Math.min(0.55, diff / (sheet.offsetHeight * 3)));
    setY(dy, false);
  };

  handle.addEventListener('touchstart', (e) => {
    begin(e.touches[0].clientY);
  }, { passive: true });

  handle.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    applyDiff(e.touches[0].clientY - startY);
  }, { passive: false });

  handle.addEventListener('touchend', end, { passive: true });
  handle.addEventListener('touchcancel', end, { passive: true });

  // 桌面端 / 触控板：同一套回弹逻辑，只接管鼠标指针，避免与上面的触摸事件重复处理
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    begin(e.clientY);
    handle.setPointerCapture?.(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !dragging) return;
    applyDiff(e.clientY - startY);
  });

  handle.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') end();
  });

  handle.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'mouse') end();
  });
}

async function copyText(text, toastKey = 'common.copied') {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    // WebView / 非安全上下文里 Clipboard API 可能不存在或被拒绝，退回 execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
      ta.remove();
    } catch (_) {
      ok = false;
    }
  }
  // 成功与失败都必须有反馈：原来失败时完全静默，用户会以为按钮坏了
  api?.toast?.(bt(ok ? toastKey : 'bond.copyFail'), ok ? 1400 : 2600);
  return ok;
}

/* ------------------------------------------------------- 天空窗口 */

function mountSkyPage() {
  if ($('#bp-sky-page')) return;
  const el = document.createElement('div');
  el.id = 'bp-sky-page';
  el.className = 'page--sky';
  el.hidden = true;
  el.innerHTML = `
    <div class="bp-sky">
      <button type="button" class="bp-sky__close" data-bp="sky-close" aria-label="${esc(bt('common.close'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1.1rem;height:1.1rem"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
      <div class="bp-sky__temp"></div>
      <div class="bp-sky__line"></div>
      <div class="bp-sky__meta"></div>
    </div>
  `;
  document.body.appendChild(el);
  el.addEventListener('click', () => closeSky());

  // X2：天空窗口里张开手指退出，与首页捏合进入对称
  let start = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) { start = 0; return; }
    const [a, b] = e.touches;
    start = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 2) return;
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (dist > start * 1.22) {
      start = 0;
      closeSky();
    }
  }, { passive: true });
  el.addEventListener('touchend', () => { start = 0; }, { passive: true });
}

function openSky() {
  const el = $('#bp-sky-page');
  const state = api?.getState?.() || {};
  const w = state.weather;
  if (!el || !w?.realtime) {
    api?.toast?.(bt('common.needWeather'), 1600);
    return;
  }
  const pal = LIFE.skyPalette(w, !document.documentElement.dataset.theme?.includes('dark'));
  el.querySelector('.bp-sky__temp').textContent = tempText(w.realtime.temp);
  el.querySelector('.bp-sky__line').textContent = LIFE.greetingFor(new Date(), w);
  el.querySelector('.bp-sky__meta').textContent = `${state.currentCity?.name || ''} · ${w.realtime.text || ''} · ${bt('sky.hint')}`;
  el.style.background = `linear-gradient(180deg, ${pal[0]}, ${pal[1]} 34%, ${pal[2]} 68%, ${pal[3]})`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('page--active'));
  document.body.style.overflow = 'hidden';
}

function closeSky() {
  const el = $('#bp-sky-page');
  if (!el) return;
  el.classList.remove('page--active');
  document.body.style.overflow = '';
  setTimeout(() => { el.hidden = true; }, 220);
}

/* -------------------------------------------------- 牵挂：人物面板 */

function cityOptionsHTML(selectedId) {
  const cities = cityStore.getAll();
  if (!cities.length) return `<p class="bp-line--dim">${esc(bt('care.noCity'))}</p>`;
  return `<div class="bp-chips">${cities.map((c) => `
    <button type="button" class="bp-btn ${String(c.id) === String(selectedId) ? 'bp-btn--primary' : ''}" data-city="${esc(c.id)}">${esc(c.name)}</button>
  `).join('')}</div>`;
}

/** C16：一次性撤销条，5 秒后自动消失，不阻塞界面 */
function showUndo(text, onUndo) {
  document.querySelectorAll('.bp-undo').forEach((n) => n.remove());
  const el = document.createElement('div');
  el.className = 'bp-undo';
  el.innerHTML = `<span>${esc(text)}</span><button type="button" class="bp-btn">${esc(bt('care.undoBtn'))}</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('bp-undo--in'));
  const timer = setTimeout(() => {
    el.classList.remove('bp-undo--in');
    setTimeout(() => el.remove(), 240);
  }, 5000);
  el.querySelector('button')?.addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
    onUndo?.();
  });
}

function openPersonSheet(personId) {
  const person = personId ? FAM.getPeople().find((p) => p.id === personId) : null;
  const draft = person || { label: '', emoji: FAM.EMOJI_PRESETS[0], color: FAM.COLOR_PRESETS[0], relation: 'peer', city: null, alerts: { ...FAM.DEFAULT_ALERTS }, note: '' };
  const notes = person ? FAM.getNotes(person.id) : [];

  const html = `
    <div class="bp-field">
      <label class="bp-field__label" for="bp-p-name">${esc(bt('care.name'))}</label>
      <input id="bp-p-name" class="bp-input" maxlength="8" value="${esc(draft.label)}" placeholder="${esc(bt('care.name'))}">
    </div>
    <div class="bp-field">
      <span class="bp-field__label">${esc(bt('care.city'))}</span>
      <div id="bp-p-city">${cityOptionsHTML(draft.city?.id)}</div>
    </div>
    <div class="bp-field">
      <span class="bp-field__label">${esc(bt('care.color'))}</span>
      <div class="bp-chips" id="bp-p-emoji" style="margin-bottom:0.5rem">
        ${FAM.EMOJI_PRESETS.map((e) => `<button type="button" class="bp-chip ${e === draft.emoji ? 'bp-chip--on' : ''}" data-emoji="${esc(e)}">${esc(e)}</button>`).join('')}
      </div>
      <div class="bp-chips" id="bp-p-color">
        ${FAM.COLOR_PRESETS.map((c) => `<button type="button" class="bp-chip bp-chip--color ${c === draft.color ? 'bp-chip--on' : ''}" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="${esc(c)}"></button>`).join('')}
      </div>
    </div>
    <div class="bp-field">
      <span class="bp-field__label">${esc(bt('care.relation'))}</span>
      <div class="bp-chips" id="bp-p-rel">
        ${['elder', 'child', 'peer'].map((r) => `<button type="button" class="bp-btn ${draft.relation === r ? 'bp-btn--primary' : ''}" data-rel="${r}">${esc(bt(`care.rel.${r}`))}</button>`).join('')}
      </div>
    </div>
    <div class="bp-field">
      <span class="bp-field__label">${esc(bt('care.alerts'))}</span>
      ${['rain', 'extreme', 'cold', 'hot'].map((k) => `
        <div class="bp-switch">
          <span>${esc(bt(`care.alert.${k}`))}</span>
          <button type="button" class="bp-switch__track" role="switch" aria-checked="${draft.alerts?.[k] ? 'true' : 'false'}" data-alert="${k}"></button>
        </div>
      `).join('')}
    </div>
    ${person ? `
      <div class="bp-field">
        <span class="bp-field__label">${esc(bt('care.notes'))}</span>
        <div id="bp-p-notes">
          ${notes.map((n) => `<div class="bp-letter"><div class="bp-letter__text">${esc(n.text)}</div><div class="bp-letter__meta"><button type="button" class="bp-btn bp-btn--ghost" data-note-del="${esc(n.id)}">${esc(bt('care.delete'))}</button></div></div>`).join('')}
          ${notes.length >= FAM.NOTE_LIMIT ? '' : `
            <div class="bp-chips" style="margin-top:0.5rem">
              <input id="bp-note-input" class="bp-input" maxlength="${FAM.NOTE_LEN}" placeholder="${esc(bt('care.noteAdd'))}" style="flex:1 1 auto">
              <button type="button" class="bp-btn" data-note-add>${esc(bt('care.noteAdd'))}</button>
            </div>`}
        </div>
      </div>
    ` : ''}
    <p class="bp-line--dim">${esc(bt('care.privacy'))}</p>
    <div class="bp-actions">
      <button type="button" class="bp-btn bp-btn--primary" data-p-save>${esc(bt('care.save'))}</button>
      ${person ? `<button type="button" class="bp-btn" data-p-talk>${esc(bt('care.send'))}</button>` : ''}
      ${person ? `<button type="button" class="bp-btn bp-btn--danger" data-p-del>${esc(bt('care.delete'))}</button>` : ''}
    </div>
  `;

  const overlay = openSheet({ title: bt('care.title'), html });
  const bodyEl = overlay.querySelector('.sheet__body');

  const picker = {
    emoji: draft.emoji,
    color: draft.color,
    relation: draft.relation,
    city: draft.city,
    alerts: { ...FAM.DEFAULT_ALERTS, ...(draft.alerts || {}) },
  };

  bodyEl.addEventListener('click', (e) => {
    const emojiBtn = e.target.closest('[data-emoji]');
    if (emojiBtn) {
      picker.emoji = emojiBtn.dataset.emoji;
      $$('[data-emoji]', bodyEl).forEach((b) => b.classList.toggle('bp-chip--on', b === emojiBtn));
      return;
    }
    const colorBtn = e.target.closest('[data-color]');
    if (colorBtn) {
      picker.color = colorBtn.dataset.color;
      $$('[data-color]', bodyEl).forEach((b) => b.classList.toggle('bp-chip--on', b === colorBtn));
      return;
    }
    const relBtn = e.target.closest('[data-rel]');
    if (relBtn) {
      picker.relation = relBtn.dataset.rel;
      $$('[data-rel]', bodyEl).forEach((b) => b.classList.toggle('bp-btn--primary', b === relBtn));
      return;
    }
    const cityBtn = e.target.closest('[data-city]');
    if (cityBtn) {
      picker.city = cityStore.getAll().find((c) => String(c.id) === String(cityBtn.dataset.city)) || null;
      $$('[data-city]', bodyEl).forEach((b) => b.classList.toggle('bp-btn--primary', b === cityBtn));
      return;
    }
    const alertBtn = e.target.closest('[data-alert]');
    if (alertBtn) {
      const k = alertBtn.dataset.alert;
      picker.alerts[k] = !picker.alerts[k];
      alertBtn.setAttribute('aria-checked', picker.alerts[k] ? 'true' : 'false');
      return;
    }
    const noteAdd = e.target.closest('[data-note-add]');
    if (noteAdd && person) {
      const input = $('#bp-note-input', bodyEl);
      FAM.addNote(person.id, input?.value || '');
      openPersonSheet(person.id);
      return;
    }
    const noteDel = e.target.closest('[data-note-del]');
    if (noteDel && person) {
      FAM.removeNote(person.id, noteDel.dataset.noteDel);
      openPersonSheet(person.id);
      return;
    }
    if (e.target.closest('[data-p-save]')) {
      const label = String($('#bp-p-name', bodyEl)?.value || '').trim().slice(0, 8);
      if (!label || !picker.city) {
        api?.toast?.(bt('care.noCity'), 1800);
        return;
      }
      if (!person && FAM.getPeople().length >= FAM.PEOPLE_LIMIT) {
        api?.toast?.(bt('care.limit'), 1800);
        return;
      }
      const doSave = () => {
        if (person) {
          FAM.upsertPerson({ ...person, label, emoji: picker.emoji, color: picker.color, relation: picker.relation, city: picker.city, alerts: picker.alerts });
        } else {
          FAM.savePeople([{ ...FAM.makePerson({ label, emoji: picker.emoji, color: picker.color, relation: picker.relation, city: picker.city, alerts: picker.alerts }) }, ...FAM.getPeople()]);
        }
        closeSheet();
        api?.toast?.(bt('care.saved'), 1400);
        void renderCare();
      };
      // C18：同一个城市已经有人的，先说清楚再决定
      const dup = !person && FAM.getPeople().some((p) => String(p.city?.id) === String(picker.city?.id));
      if (dup) {
        const confirm = openSheet({
          title: bt('care.dupCity'),
          html: `
            <p class="bp-line">${esc(picker.city.name || '')}</p>
            <div class="bp-actions">
              <button type="button" class="bp-btn bp-btn--primary" data-dup-ok>${esc(bt('care.dupAdd'))}</button>
              <button type="button" class="bp-btn" data-sheet-close>${esc(bt('common.cancel'))}</button>
            </div>`,
        });
        confirm.addEventListener('click', (ev) => {
          if (!ev.target.closest('[data-dup-ok]')) return;
          closeSheet();
          doSave();
        });
        return;
      }
      doSave();
      return;
    }
    if (e.target.closest('[data-p-talk]') && person) {
      openSendSheet(person.id);
      return;
    }
    if (e.target.closest('[data-p-del]') && person) {
      FAM.removePerson(person.id);
      closeSheet();
      void renderCare();
      // C16：删除给 5 秒反悔窗口，不做二次确认弹窗
      showUndo(bt('care.undo'), () => {
        FAM.upsertPerson(person);
        void renderCare();
        api?.toast?.(bt('care.undoDone'), 1200);
      });
    }
  });
}

/* ------------------------------------------------ 牵挂：递话面板 */

function openSendSheet(personId) {
  const person = FAM.getPeople().find((p) => p.id === personId);
  if (!person) return;
  const entry = FAM.getPeopleWeather()[personId];
  const text = FAM.composeMessage(person, entry, 'chat');
  const sms = FAM.composeMessage(person, entry, 'sms');

  const overlay = openSheet({
    title: bt('care.send'),
    html: `
      <p class="bp-line">${esc(text || bt('common.needWeather'))}</p>
      <p class="bp-line--dim" style="margin-top:0.5rem">${esc(sms)}</p>
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-copy>${esc(bt('common.copy'))}</button>
        <button type="button" class="bp-btn" data-bp="share-msg">↗</button>
      </div>
    `,
  });

  overlay.addEventListener('click', async (e) => {
    if (e.target.closest('[data-copy]')) await copyText(text);
    if (e.target.closest('[data-bp="share-msg"]')) {
      if (navigator.share) {
        try { await navigator.share({ text }); } catch (_) { /* 用户取消 */ }
      } else {
        await copyText(text);
      }
    }
  });
}

/* --------------------------------------------------- 双向牵手（UI） */

function bondRowHTML(bond) {
  const unread = BOND.unreadCount(bond.id);
  const stateText = bond.status === 'active'
    ? bt('bond.active')
    : bond.status === 'pending'
      ? bt('bond.waitConfirm')
      : bt('bond.waiting');
  return `
    <button type="button" class="bp-bond" data-bond="${esc(bond.id)}">
      <span class="bp-bond__avatar">${bond.status === 'active' ? '🤝' : '⋯'}</span>
      <span class="bp-bond__main">
        <span class="bp-bond__name">${esc(bond.peerName || bond.code || '')}</span>
        <span class="bp-bond__state">${esc(stateText)}${unread ? ` · ${unread}` : ''}</span>
      </span>
    </button>
  `;
}

function renderBondTool() {
  const body = $('#tool-body');
  if (!body) return;
  const bonds = BOND.getBonds();
  const active = bonds.filter((b) => b.status === 'active');
  const others = bonds.filter((b) => b.status !== 'active');

  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.bond'))}</div>
      ${bonds.length ? bonds.map(bondRowHTML).join('') : `<p class="bp-line--dim">${esc(bt('bond.empty'))}</p>`}
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-bp="bond-create">${esc(bt('bond.create'))}</button>
        <button type="button" class="bp-btn" data-bp="bond-join">${esc(bt('bond.join'))}</button>
      </div>
      <p class="bp-line--dim" style="margin-top:0.75rem">${esc(bt('bond.limit'))} · ${BOND.remainingToday()}</p>
    </div>
    ${active.length ? `
      <div class="card">
        <div class="card__title">${esc(bt('bond.thread'))}</div>
        ${active.map((b) => `
          <div class="bp-actions">
            <button type="button" class="bp-btn" data-bond-thread="${esc(b.id)}">${esc(b.peerName || bt('bond.thread'))}</button>
            <button type="button" class="bp-btn" data-bond-fine="${esc(b.id)}">${esc(bt('bond.fine'))}</button>
            <button type="button" class="bp-btn bp-btn--danger" data-bond-revoke="${esc(b.id)}">${esc(bt('bond.revoke'))}</button>
          </div>
        `).join('')}
      </div>` : ''}
    ${others.length ? `<div class="card">${others.map(bondRowHTML).join('')}</div>` : ''}
  `;
}

function openBondCreate() {
  const state = api?.getState?.() || {};
  const overlay = openSheet({
    title: bt('bond.create'),
    html: `
      <div class="bp-field">
        <label class="bp-field__label" for="bp-bond-name">${esc(bt('care.name'))}</label>
        <input id="bp-bond-name" class="bp-input" maxlength="8" value="">
      </div>
      <p class="bp-line--dim">${esc(state.currentCity?.name || '')}</p>
      <div class="bp-actions"><button type="button" class="bp-btn bp-btn--primary" data-do-create>${esc(bt('bond.create'))}</button></div>
    `,
  });
  overlay.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-do-create]')) return;
    const name = String($('#bp-bond-name', overlay)?.value || '').trim().slice(0, 8);
    const city = state.currentCity;
    if (!name) { api?.toast?.(bt('bond.needName'), 1600); return; }
    if (!city?.id) { api?.toast?.(bt('bond.needCity'), 1800); return; }
    try {
      const data = await BOND.createInvite(name, { id: city.id, name: city.name });
      const code = String(data.code || '');
      const codeHtml = `<div class="bp-code">${Array.from(code).map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;
      const wrap = openSheet({
        title: bt('bond.create'),
        html: `
          ${codeHtml}
          <p class="bp-line--dim" style="text-align:center">${esc(bt('bond.codeHint'))}</p>
          <div class="bp-actions" style="justify-content:center">
            <button type="button" class="bp-btn bp-btn--primary" data-copy-code>${esc(bt('bond.copy'))}</button>
          </div>
        `,
      });
      wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-copy-code]')) void copyText(code);
      });
      api?.toast?.(bt('bond.created'), 1400);
      requestBondNotificationPermission();
      syncBondWatch();
      if (state.currentPage === 'tool') renderBondTool();
    } catch (err) {
      api?.toast?.(BOND.describeBondError(err), 2200);
    }
  });
}

function openBondJoin() {
  const state = api?.getState?.() || {};
  const overlay = openSheet({
    title: bt('bond.join'),
    html: `
      <div class="bp-field">
        <label class="bp-field__label" for="bp-join-code">${esc(bt('bond.join'))}</label>
        <input id="bp-join-code" class="bp-input bp-input--code" maxlength="6" autocomplete="off" spellcheck="false">
      </div>
      <div class="bp-field">
        <label class="bp-field__label" for="bp-join-name">${esc(bt('care.name'))}</label>
        <input id="bp-join-name" class="bp-input" maxlength="8">
      </div>
      <div class="bp-actions"><button type="button" class="bp-btn bp-btn--primary" data-do-join>${esc(bt('bond.join'))}</button></div>
    `,
  });
  overlay.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-do-join]')) return;
    const code = String($('#bp-join-code', overlay)?.value || '').trim().toUpperCase();
    const name = String($('#bp-join-name', overlay)?.value || '').trim().slice(0, 8);
    const city = state.currentCity;
    if (!code) { api?.toast?.(bt('bond.codeFail'), 1600); return; }
    if (!name) { api?.toast?.(bt('bond.needName'), 1600); return; }
    if (!city?.id) { api?.toast?.(bt('bond.needCity'), 1800); return; }
    try {
      await BOND.joinInvite(code, name, { id: city.id, name: city.name });
      closeSheet();
      api?.toast?.(bt('bond.joined'), 1800);
      requestBondNotificationPermission();
      syncBondWatch();
      if (state.currentPage === 'tool') renderBondTool();
    } catch (err) {
      api?.toast?.(BOND.describeBondError(err), 2200);
    }
  });
}

/**
 * 配对成功的一刻（X20）：两个小点从两侧滑到一起，重合时轻震一次。
 * 全程 520ms，只播一次，不循环；系统开了「减少动态效果」则只震动。
 */
function playPairingMoment() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    navigator.vibrate?.(20);
    return;
  }
  const layer = document.createElement('div');
  layer.className = 'bp-pair';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = `
    <span class="bp-pair__dot bp-pair__dot--l"></span>
    <span class="bp-pair__dot bp-pair__dot--r"></span>
    <span class="bp-pair__ring"></span>
  `;
  document.body.appendChild(layer);
  requestAnimationFrame(() => layer.classList.add('bp-pair--run'));
  setTimeout(() => navigator.vibrate?.(15), 480);
  setTimeout(() => layer.remove(), 620);
}

async function openBondDetail(bondId) {
  const bond = BOND.getBonds().find((b) => b.id === bondId);
  if (!bond) return;
  const fresh = await BOND.refreshBond(bondId);
  const cur = fresh || bond;
  // 刷新可能把状态推进到 active（或发现对方已断开），同步给原生后台检查
  syncBondWatch();

  if (cur.status === 'revoked') {
    api?.toast?.(bt('bond.revoked'), 2000);
    if (api?.getState?.().currentPage === 'tool') renderBondTool();
    void renderCare();
    return;
  }

  if (cur.status === 'pending' && cur.role === 'host') {
    const guest = cur.pendingGuest || {};
    const overlay = openSheet({
      title: bt('bond.pending'),
      html: `
        <p class="bp-line">${esc(guest.name || '')} · ${esc(guest.city?.name || '')}</p>
        <p class="bp-line--dim">${esc(bt('bond.pendingGuest'))}</p>
        <div class="bp-actions">
          <button type="button" class="bp-btn bp-btn--primary" data-approve>${esc(bt('bond.approve'))}</button>
          <button type="button" class="bp-btn bp-btn--danger" data-reject>${esc(bt('bond.reject'))}</button>
        </div>
      `,
    });
    overlay.addEventListener('click', async (e) => {
      if (e.target.closest('[data-approve]')) {
        try {
          await BOND.approveInvite(bondId, true);
          closeSheet();
          playPairingMoment();
          api?.toast?.(bt('bond.active'), 1400);
          syncBondWatch();
          if (api?.getState?.().currentPage === 'tool') renderBondTool();
        } catch (err) { api?.toast?.(BOND.describeBondError(err), 2200); }
      }
      if (e.target.closest('[data-reject]')) {
        await BOND.approveInvite(bondId, false);
        closeSheet();
        if (api?.getState?.().currentPage === 'tool') renderBondTool();
      }
    });
    return;
  }

  if (cur.status === 'active') {
    openThreadSheet(bondId);
    return;
  }

  // waiting / pending（接受方）
  openSheet({
    title: bt('tool.bond'),
    html: `
      <div class="bp-code">${Array.from(String(cur.code || '')).map((c) => `<span>${esc(c)}</span>`).join('')}</div>
      <p class="bp-line--dim" style="text-align:center">${esc(bt('bond.waitConfirm'))}</p>
      <div class="bp-actions" style="justify-content:center">
        <button type="button" class="bp-btn" data-refresh>${esc(bt('bond.active'))} ⟳</button>
      </div>
    `,
  }).addEventListener('click', async (e) => {
    if (!e.target.closest('[data-refresh]')) return;
    const fresh = await BOND.refreshBond(bondId);
    closeSheet();
    if (fresh?.status === 'active' && bond.status !== 'active') playPairingMoment();
    syncBondWatch();
    void openBondDetail(bondId);
  });
}

function openThreadSheet(bondId) {
  const bond = BOND.getBonds().find((b) => b.id === bondId);
  if (!bond) return;
  void BOND.markRead(bondId);

  const build = () => {
    const list = BOND.getMessages(bondId);
    const thread = list.length
      ? list.map((m) => `
        <div class="bp-msg ${m.from === 'me' ? 'bp-msg--me' : ''}">
          <span>${esc(m.body)}</span>
          <span class="bp-msg__time">${esc(new Date(m.at).toTimeString().slice(0, 5))}</span>
        </div>`).join('')
      : `<p class="bp-line--dim">${esc(bt('bond.noMsg'))}</p>`;
    const tpls = [
      ['weather', 'msg.tpl.umbrella'],
      ['care', 'msg.tpl.sleep'],
      ['warm', 'msg.tpl.miss'],
    ];
    return `
      <div class="bp-thread">${thread}</div>
      <div class="bp-chips" style="margin:0.75rem 0">
        ${tpls.map(([kind, key]) => `<button type="button" class="bp-btn" data-tpl="${kind}" data-tpl-text="${esc(t(key))}">${esc(bt(`bond.tpl.${kind}`))}</button>`).join('')}
      </div>
      <div class="bp-chips">
        <input id="bp-msg-input" class="bp-input" maxlength="40" placeholder="${esc(bt('bond.say'))}" style="flex:1 1 auto">
        <button type="button" class="bp-btn bp-btn--primary" data-send>${esc(bt('bond.say'))}</button>
      </div>
      <p class="bp-line--dim" style="margin-top:0.5rem">${esc(bt('bond.remaining'))} ${BOND.remainingToday()} ${esc(bt('bond.lines'))}</p>
      <p class="bp-line--dim" style="margin-top:0.25rem">${esc(bt('bond.keep'))}</p>
    `;
  };

  const overlay = openSheet({ title: bond.peerName || bt('bond.thread'), html: build() });
  overlay.addEventListener('click', async (e) => {
    const tpl = e.target.closest('[data-tpl]');
    if (tpl) {
      const input = $('#bp-msg-input', overlay);
      if (input) {
        input.value = tpl.dataset.tplText;
        input.focus();
      }
      return;
    }
    if (e.target.closest('[data-send]')) {
      const input = $('#bp-msg-input', overlay);
      const text = String(input?.value || '').trim();
      if (!text) return;
      const res = await BOND.sendMessage(bondId, 'warm', text);
      if (res.ok) {
        if (input) input.value = '';
        overlay.querySelector('.sheet__body').innerHTML = build();
        api?.toast?.(bt('bond.sendOk'), 1200);
      } else {
        api?.toast?.(res.text || bt('bond.sendFail'), 1800);
      }
    }
  });
}

/* -------------------------------------------------------- 工具页面 */

function renderLettersTool() {
  const body = $('#tool-body');
  if (!body) return;
  const letters = MEM.getLetters();
  const now = Date.now();
  const rows = letters.map((l) => {
    const sealed = l.openAt > now;
    const days = sealed ? Math.ceil((l.openAt - now) / 86400000) : 0;
    return `
      <div class="bp-letter ${sealed ? 'bp-letter--sealed' : ''}">
        <div class="bp-letter__meta">
          <span>${esc(formatDate(new Date(l.at).toISOString(), { weekday: false }))}</span>
          <span>${esc(l.weather?.text || '')}</span>
          ${sealed ? `<span>${esc(bt('letter.sealed'))} ${days} ${esc(bt('term.days'))}</span>` : ''}
        </div>
        <div class="bp-letter__text">${sealed ? '••••••' : esc(l.text)}</div>
        ${sealed ? '' : `<div class="bp-letter__meta"><button type="button" class="bp-btn bp-btn--ghost" data-letter-del="${esc(l.id)}">${esc(bt('care.delete'))}</button></div>`}
      </div>
    `;
  }).join('');

  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.letters'))}</div>
      <p class="bp-line--dim">${esc(bt('letter.today'))}：${esc(api?.getState?.().weather?.realtime?.text || '—')}</p>
      <div class="bp-field" style="margin-top:0.75rem">
        <textarea id="bp-letter-input" class="bp-input" rows="3" maxlength="200" placeholder="${esc(bt('letter.placeholder'))}"></textarea>
      </div>
      <div class="bp-chips">
        <select id="bp-letter-when" class="bp-input" style="flex:1 1 auto">
          <option value="30">${esc(bt('letter.month'))}</option>
          <option value="365">${esc(bt('letter.year'))}</option>
        </select>
        <button type="button" class="bp-btn bp-btn--primary" data-letter-add>${esc(bt('letter.seal'))}</button>
      </div>
    </div>
    <div class="card">${rows || `<p class="bp-line--dim">${esc(bt('letter.empty'))}</p>`}</div>
  `;

  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-letter-add]')) {
      const text = String($('#bp-letter-input', body)?.value || '').trim();
      const days = Number($('#bp-letter-when', body)?.value || 30);
      if (!text) return;
      MEM.addLetter(text, Date.now() + days * 86400000, {
        ...(api?.getState?.().weather || {}),
        cityName: api?.getState?.().currentCity?.name || '',
      });
      renderLettersTool();
      api?.toast?.(bt('letter.seal'), 1200);
    }
    const del = e.target.closest('[data-letter-del]');
    if (del) {
      MEM.removeLetter(del.dataset.letterDel);
      renderLettersTool();
    }
  });
}

function renderColorsTool() {
  const body = $('#tool-body');
  if (!body) return;
  const state = api?.getState?.() || {};
  const w = state.weather;
  const isDay = !String(document.documentElement.dataset.theme || '').includes('dark');
  const pal = LIFE.skyPalette(w, isDay);
  const shape = MEM.dayShape(w);

  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.colors'))}</div>
      <div class="bp-palette">
        ${pal.map((c) => `<div class="bp-palette__step" style="background:${esc(c)}"><span class="bp-palette__code">${esc(c)}</span></div>`).join('')}
      </div>
      <p class="bp-line--dim">${esc(w?.realtime?.text || '')} · ${tempText(w?.realtime?.temp)}</p>
      <div class="bp-actions">
        <button type="button" class="bp-btn" data-copy-palette>${esc(bt('common.copy'))}</button>
      </div>
    </div>
    ${shape ? `
      <div class="card">
        <div class="card__title">${esc(bt('shape.peak'))}</div>
        <div class="bp-shape" style="border-top:0;margin-top:0">
          ${shape.bars.map((h) => `<span class="bp-shape__bar" style="height:${h}%"></span>`).join('')}
        </div>
        <p class="bp-line--dim">${esc(shape.label)}</p>
      </div>` : ''}
  `;

  body.querySelector('[data-copy-palette]')?.addEventListener('click', () => {
    const css = pal.map((c, i) => `--sky-${i + 1}: ${c};`).join('\n');
    void copyText(css);
  });
}

function renderPromisesTool() {
  const body = $('#tool-body');
  if (!body) return;
  const state = api?.getState?.() || {};
  const list = LIFE.getPromises();
  const suggestions = LIFE.promiseSuggestions(state.weather || {});

  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.promises'))}</div>
      <div class="bp-chips" style="margin-bottom:0.75rem">
        ${suggestions.map((s) => `<button type="button" class="bp-btn" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
      <div class="bp-chips">
        <input id="bp-promise-input" class="bp-input" maxlength="40" placeholder="${esc(bt('promise.add'))}" style="flex:1 1 auto">
        <button type="button" class="bp-btn bp-btn--primary" data-promise-add>${esc(bt('care.save'))}</button>
      </div>
    </div>
    <div class="card">
      ${list.length ? list.map((p) => `
        <div class="bp-promise ${p.done ? 'bp-promise--done' : ''}" data-promise="${esc(p.id)}">
          <button type="button" class="bp-promise__check" data-promise-toggle="${esc(p.id)}" aria-label="${esc(bt('promise.done'))}"></button>
          <span class="bp-promise__text">${esc(p.text)}</span>
        </div>`).join('') : `<p class="bp-line--dim">${esc(bt('promise.empty'))}</p>`}
    </div>
  `;

  body.addEventListener('click', (e) => {
    const sug = e.target.closest('[data-suggest]');
    if (sug) {
      const input = $('#bp-promise-input', body);
      if (input) input.value = sug.dataset.suggest;
      return;
    }
    if (e.target.closest('[data-promise-add]')) {
      const input = $('#bp-promise-input', body);
      LIFE.addPromise(input?.value || '');
      renderPromisesTool();
      return;
    }
    const toggle = e.target.closest('[data-promise-toggle]');
    if (toggle) {
      LIFE.togglePromise(toggle.dataset.promiseToggle);
      renderPromisesTool();
    }
  });
}

function renderClimateTool() {
  const body = $('#tool-body');
  if (!body) return;
  const summary = MEM.climateSummary(30);
  if (!summary) {
    body.innerHTML = `<div class="card"><div class="card__title">${esc(bt('tool.climate'))}</div><p class="bp-line--dim">${esc(bt('climate.empty'))}</p></div>`;
    return;
  }
  const capsules = MEM.getCapsules();
  const gdd = LIFE.gddSummary(capsules);
  const anom = LIFE.tempAnomaly(capsules);
  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.climate'))}</div>
      <p class="bp-line">${summary.days} ${esc(bt('climate.days'))} · ${summary.rain} ${esc(bt('climate.rain'))} · ${summary.sun} ${esc(bt('climate.sun'))}</p>
      <p class="bp-line--dim" style="margin-top:0.5rem">${esc(bt('climate.range'))} ${summary.min}–${summary.max}° · ${bt('common.today')} ${summary.avg}°</p>
      ${gdd ? `<p class="bp-line--dim" style="margin-top:0.5rem">${esc(bt('climate.gdd'))} ${gdd.gdd}° · ${esc(gdd.stage)}<br><span class="bp-line--dim">${esc(bt('climate.gddHint'))}</span></p>` : ''}
      ${anom ? `<p class="bp-line" style="margin-top:0.5rem">${esc(anom.text)}</p>` : ''}
      <div class="bp-actions">
        <button type="button" class="bp-btn" data-heirloom>${esc(bt('climate.heirloom'))}</button>
      </div>
    </div>
    <div class="card">
      <div class="card__title">${esc(bt('climate.days'))}</div>
      ${MEM.getCapsules().slice(0, 14).map((c) => `
        <button type="button" class="bp-capsule" data-capsule="${esc(c.date)}">
          <span class="bp-morning__time">${esc(String(c.date).slice(5))}</span>
          <span class="bp-capsule__body">
            <span class="bp-promise__text">${esc(c.text || '')} ${esc(tempText(c.temp))}</span>
            ${c.note ? `<span class="bp-note-hand">${esc(c.note)}</span>` : ''}
          </span>
          ${c.note ? '<span class="bp-capsule__dot" aria-hidden="true"></span>' : ''}
        </button>`).join('')}
      <p class="bp-line--dim" style="margin-top:var(--space-3)">${esc(bt('note.hint'))}</p>
    </div>
  `;

  body.querySelector('[data-heirloom]')?.addEventListener('click', () => {
    MEM.setHeirloom({ at: Date.now(), summary });
    api?.toast?.(bt('care.saved'), 1400);
  });
  body.querySelectorAll('[data-capsule]').forEach((el) => {
    el.addEventListener('click', () => openNoteSheet(el.dataset.capsule));
  });
}

/** F2：写一句手写体备注，只存本地 */
function openNoteSheet(dateKey) {
  const capsule = MEM.getCapsule(dateKey);
  if (!capsule) return;
  openSheet({
    title: bt('note.title'),
    html: `
      <p class="bp-line--dim">${esc(capsule.date)} · ${esc(capsule.text || '')} ${esc(tempText(capsule.temp))}</p>
      <textarea class="bp-input bp-note-hand" rows="4" maxlength="100" style="margin-top:var(--space-3)" placeholder="${esc(bt('note.title'))}">${esc(capsule.note || '')}</textarea>
      <p class="bp-line--dim" style="margin-top:var(--space-2)">${esc(bt('note.hint'))}</p>
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-note-save>${esc(bt('note.save'))}</button>
      </div>
    `,
    onMount: (overlay) => {
      overlay.querySelector('[data-note-save]')?.addEventListener('click', () => {
        MEM.setCapsuleNote(dateKey, overlay.querySelector('textarea')?.value || '');
        closeSheet();
        renderClimateTool();
      });
    },
  });
}

/* ------------------------------------------------ 家庭天气板（B11） */

/**
 * 把「牵挂的人」摊开成一屏：谁在哪、几度、什么天气。
 * 只复用首页那份缓存，打开时补一次刷新，不额外提高请求频率。
 */
function renderBoardTool() {
  const body = $('#tool-body');
  if (!body) return;
  const people = FAM.getPeople();
  const local = api?.getState?.().weather;

  if (!people.length) {
    body.innerHTML = `
      <div class="card">
        <div class="card__title">${esc(bt('tool.board'))}</div>
        <p class="bp-line--dim">${esc(bt('care.noPeople'))}</p>
        <div class="bp-actions">
          <button type="button" class="bp-btn bp-btn--primary" data-bp="care-add">＋ ${esc(bt('care.add'))}</button>
        </div>
      </div>`;
    return;
  }

  const paint = () => {
    const wx = FAM.getPeopleWeather();
    body.innerHTML = `
      <div class="card">
        <div class="card__title">${esc(bt('tool.board'))}</div>
        <div class="bp-board">
          ${people.map((p) => personCard(p, wx[p.id], local, BOND.unreadFor(p.bondId))).join('')}
        </div>
      </div>
      <p class="tool__hint">${esc(bt('board.hint'))}</p>`;
    body.querySelectorAll('[data-person]').forEach((el) => {
      el.addEventListener('click', () => openPersonSheet(el.dataset.person));
    });
  };

  paint();
  void FAM.fetchPeopleWeather(people).then(() => {
    if ($('#tool-body') === body && api?.getState?.().currentPage === 'tool') paint();
  });
}

function renderPeopleTool() {
  const body = $('#tool-body');
  if (!body) return;
  const people = FAM.getPeople();
  const wx = FAM.getPeopleWeather();
  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.people'))}</div>
      ${people.length ? people.map((p) => `
        <button type="button" class="bp-bond" data-person="${esc(p.id)}" style="width:100%;text-align:left">
          <span class="bp-bond__avatar" style="background:${esc(p.color)}22">${esc(p.emoji || '·')}</span>
          <span class="bp-bond__main">
            <span class="bp-bond__name">${esc(p.label)}</span>
            <span class="bp-bond__state">${esc(p.city?.name || '')} · ${esc(wx[p.id]?.rt?.text || '')} ${tempText(wx[p.id]?.rt?.temp)}</span>
          </span>
        </button>`).join('') : `<p class="bp-line--dim">${esc(bt('care.noPeople'))}</p>`}
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-bp="care-add">＋ ${esc(bt('care.add'))}</button>
      </div>
    </div>
    <div class="card">
      <div class="card__title">${esc(bt('tool.bond'))}</div>
      <div class="bp-actions">
        <button type="button" class="bp-btn" data-bp="bond-create">${esc(bt('bond.create'))}</button>
        <button type="button" class="bp-btn" data-bp="bond-join">${esc(bt('bond.join'))}</button>
      </div>
    </div>
    <div class="card">
      <div class="card__title">${esc(bt('inherit.title'))}</div>
      <p class="bp-line--dim">${esc(bt('inherit.hint'))}</p>
      <div class="bp-actions">
        <button type="button" class="bp-btn" data-bp="cfg-export">${esc(bt('inherit.export'))}</button>
        <button type="button" class="bp-btn" data-bp="cfg-import">${esc(bt('inherit.import'))}</button>
      </div>
    </div>
  `;
  body.querySelectorAll('[data-person]').forEach((el) => {
    el.addEventListener('click', () => openPersonSheet(el.dataset.person));
  });
  body.querySelector('[data-bp="cfg-export"]')?.addEventListener('click', openConfigExport);
  body.querySelector('[data-bp="cfg-import"]')?.addEventListener('click', openConfigImport);
}

/* ------------------------------------------------------ 配置传承（B5） */

/** 把城市 + 牵挂的人 + 单位压成一段码，方便换机时整段粘贴 */
function openConfigExport() {
  const code = FAM.encodeConfig(FAM.getPeople(), cityStore.getAll(), settingsStore.get().unit);
  openSheet({
    title: bt('inherit.export'),
    html: `
      <p class="bp-line--dim">${esc(bt('inherit.hint'))}</p>
      <textarea class="bp-input" rows="5" readonly style="margin-top:var(--space-3);font-family:var(--font-mono);font-size:var(--text-xs);line-height:1.5;word-break:break-all">${esc(code)}</textarea>
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-bp="cfg-copy">${esc(bt('common.copy'))}</button>
      </div>
    `,
    onMount: (overlay) => {
      const ta = overlay.querySelector('textarea');
      overlay.querySelector('[data-bp="cfg-copy"]')?.addEventListener('click', () => {
        ta?.select();
        copyText(code);
      });
    },
  });
}

/** 导入时同城同名的人不重复添加，避免越导越多 */
function openConfigImport() {
  openSheet({
    title: bt('inherit.import'),
    html: `
      <p class="bp-line--dim">${esc(bt('inherit.hint'))}</p>
      <textarea class="bp-input" rows="5" style="margin-top:var(--space-3);font-family:var(--font-mono);font-size:var(--text-xs);line-height:1.5;word-break:break-all"></textarea>
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-bp="cfg-apply">${esc(bt('inherit.import'))}</button>
      </div>
    `,
    onMount: (overlay) => {
      const ta = overlay.querySelector('textarea');
      overlay.querySelector('[data-bp="cfg-apply"]')?.addEventListener('click', () => {
        const data = FAM.decodeConfig((ta?.value || '').trim());
        if (!data) {
          api?.toast?.(bt('inherit.bad'), 1800);
          return;
        }
        data.cities.forEach((c) => cityStore.add(c));
        const list = FAM.getPeople();
        data.people.forEach((p) => {
          const dup = list.some((x) => x.label === p.label && String(x.city?.id) === String(p.city?.id));
          if (!dup) list.unshift(FAM.makePerson(p));
        });
        FAM.savePeople(list);
        if (data.unit && data.unit !== settingsStore.get().unit) {
          settingsStore.set({ unit: data.unit });
          api?.rerender?.();
        }
        api?.toast?.(bt('inherit.done'), 1600);
        closeSheet();
        renderPeopleTool();
      });
    },
  });
}

/* ------------------------------------------------ 年度报告（E2） */

/**
 * 数据不足 90 天不生成，避免把两三个月的记录包装成「一年」。
 * 全部指标来自每日胶囊，不补插值。
 */
function renderWrappedTool() {
  const body = $('#tool-body');
  if (!body) return;
  const stats = MEM.yearStats();
  if (!stats) {
    const days = MEM.getCapsules().filter((c) => String(c.date).startsWith(String(new Date().getFullYear()))).length;
    body.innerHTML = `
      <div class="card">
        <div class="card__title">${esc(bt('tool.wrapped'))}</div>
        <p class="bp-line">${days} ${esc(bt('wrap.days'))}</p>
        <p class="bp-line--dim">${esc(bt('wrap.empty'))}</p>
      </div>`;
    return;
  }
  const months = stats.monthly.map((v, i) => {
    const h = Number.isFinite(v) ? Math.max(8, Math.min(100, Math.round(((v + 10) / 50) * 100))) : 6;
    return `<div class="bp-wrap__col"><i class="bp-wrap__bar" style="height:${h}%"></i><span class="bp-wrap__mon">${i + 1}</span></div>`;
  }).join('');
  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('tool.wrapped'))}</div>
      <p class="bp-wrap__big">${stats.days}<span>${esc(bt('wrap.days'))}</span></p>
      <div class="bp-wrap__pills">
        <span class="bp-chip">${esc(bt('wrap.sun'))} ${stats.sun}</span>
        <span class="bp-chip">${esc(bt('wrap.rain'))} ${stats.rain}</span>
        <span class="bp-chip">${esc(bt('wrap.snow'))} ${stats.snow}</span>
        <span class="bp-chip">${stats.cities} ${esc(bt('wrap.cities'))}</span>
      </div>
      <p class="bp-line--dim" style="margin-top:var(--space-3)">${esc(bt('wrap.avg'))} ${stats.avg}°</p>
      <div class="bp-wrap">${months}</div>
    </div>
    <div class="card">
      <p class="bp-line">${esc(bt('wrap.hot'))} · ${esc(stats.hottest.date.slice(5))} · ${stats.hottest.temp}° ${esc(stats.hottest.text)}</p>
      <p class="bp-line" style="margin-top:0.4rem">${esc(bt('wrap.cold'))} · ${esc(stats.coldest.date.slice(5))} · ${stats.coldest.temp}° ${esc(stats.coldest.text)}</p>
    </div>
  `;
}

/* ------------------------------------------------ 预警年表（G2） */

function renderWarningLogTool() {
  const body = $('#tool-body');
  if (!body) return;
  const stats = MEM.warningStats();
  const rows = MEM.getWarningLog().slice(0, 30);
  body.innerHTML = `
    <div class="card">
      <div class="card__title">${esc(bt('warnlog.title'))}</div>
      ${stats.total
        ? `<p class="bp-line">${stats.total} ${esc(bt('warnlog.total'))} · ${stats.cities} ${esc(bt('warnlog.cities'))}</p>`
        : `<p class="bp-line--dim">${esc(bt('warnlog.empty'))}</p>`}
    </div>
    ${rows.length ? `
      <div class="card">
        ${rows.map((w) => `
          <div class="bp-warnlog__row">
            <span class="bp-morning__time">${esc(String(w.day).slice(5))}</span>
            <span class="bp-warnlog__body">
              <span class="bp-promise__text">${esc(w.title)}</span>
              <span class="bp-line--dim">${esc(w.cityName || '')}</span>
            </span>
          </div>`).join('')}
      </div>` : ''}
  `;
}

/* ------------------------------------------------ 天气相册（本地 · 2.7.6） */

let albumFilter = { kind: 'all', days: 0 };
let albumThumbURLs = new Map();

function albumDayLabel(day) {
  const today = todayStamp();
  if (day === today) return bt('common.today');
  return String(day).slice(5).replace('-', '/');
}

function albumMetaLine(rec) {
  const bits = [];
  if (rec.cityName) bits.push(rec.cityName);
  if (Number.isFinite(rec.temp)) bits.push(`${Math.round(rec.temp)}°`);
  if (rec.text) bits.push(rec.text);
  return bits.join(' · ') || bt('album.noWeather');
}

function albumFiltered(rows) {
  const cutoff = albumFilter.days ? Date.now() - albumFilter.days * 86400000 : 0;
  return rows.filter((r) => {
    if (cutoff && r.ts < cutoff) return false;
    if (albumFilter.kind !== 'all' && ALBUM.kindOf(r) !== albumFilter.kind) return false;
    return true;
  });
}

function paintAlbumGrid(host, rows) {
  const grid = host.querySelector('#album-grid');
  if (!grid) return;
  albumThumbURLs.forEach((url) => URL.revokeObjectURL(url));
  albumThumbURLs = new Map();

  const list = albumFiltered(rows);
  if (!list.length) {
    grid.innerHTML = `
      <div class="album__empty">
        <div class="album__empty-art" aria-hidden="true">
          <svg viewBox="0 0 96 64" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <rect x="6" y="12" width="84" height="48" rx="10"></rect>
            <circle cx="48" cy="38" r="13"></circle>
            <path d="M22 12l6-8h14l6 8"></path>
          </svg>
        </div>
        <p class="bp-line--dim">${esc(bt('album.empty'))}</p>
      </div>`;
    const count = host.querySelector('#album-count');
    if (count) count.textContent = `0 ${bt('album.count')}`;
    return;
  }

  let lastDay = '';
  const cells = list.map((rec) => {
    const url = URL.createObjectURL(rec.thumb || rec.full);
    albumThumbURLs.set(rec.id, url);
    const head = rec.day !== lastDay
      ? `<div class="album__day">${esc(albumDayLabel(rec.day))}</div>`
      : '';
    lastDay = rec.day;
    return `${head}
      <button type="button" class="album__item" data-album-open="${rec.id}" aria-label="${esc(albumMetaLine(rec))}">
        <img src="${url}" alt="" loading="lazy" decoding="async">
        <span class="album__item-meta">${esc(albumMetaLine(rec))}</span>
      </button>`;
  }).join('');
  grid.innerHTML = cells;
  const count = host.querySelector('#album-count');
  if (count) count.textContent = `${list.length} ${bt('album.count')}`;
}

async function renderAlbumTool() {
  const body = $('#tool-body');
  if (!body) return;
  if (!ALBUM.isSupported()) {
    body.innerHTML = `<div class="card"><p class="bp-line--dim">${esc(bt('album.unsupported'))}</p></div>`;
    return;
  }
  body.innerHTML = `
    <div class="card album__top">
      <div class="bp-actions">
        <button type="button" class="bp-btn bp-btn--primary" data-album-act="take">${esc(bt('album.take'))}</button>
        <button type="button" class="bp-btn" data-album-act="pick">${esc(bt('album.pick'))}</button>
      </div>
      <p class="bp-line--dim">${esc(bt('album.local'))}</p>
      <input type="file" accept="image/*" capture="environment" hidden data-album-file="take">
      <input type="file" accept="image/*" multiple hidden data-album-file="pick">
    </div>
    <div class="album__bar" role="group">
      <button type="button" class="bp-chip bp-chip--on" data-album-kind="all">${esc(bt('album.filterAll'))}</button>
      <button type="button" class="bp-chip" data-album-kind="sun">${esc(bt('album.filterKind.sun'))}</button>
      <button type="button" class="bp-chip" data-album-kind="rain">${esc(bt('album.filterKind.rain'))}</button>
      <button type="button" class="bp-chip" data-album-kind="snow">${esc(bt('album.filterKind.snow'))}</button>
      <button type="button" class="bp-chip" data-album-kind="cloud">${esc(bt('album.filterKind.cloud'))}</button>
      <span class="album__sep" aria-hidden="true"></span>
      <button type="button" class="bp-chip" data-album-days="0">${esc(bt('album.filterDay'))}</button>
      <span class="album__count" id="album-count"></span>
    </div>
    <div class="album__grid" id="album-grid"></div>
  `;

  const rows = await ALBUM.listPhotos();

  body.querySelectorAll('[data-album-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.albumAct;
      body.querySelector(`[data-album-file="${mode}"]`)?.click();
    });
  });

  body.querySelectorAll('[data-album-file]').forEach((input) => {
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      api?.toast?.(bt('album.saving'), 1400);
      const state = api?.getState?.() || {};
      const city = state.currentCity || {};
      const rt = state.weather?.realtime || {};
      let added = 0;
      for (const file of files) {
        try {
          const rec = await ALBUM.addPhoto(file, {
            cityId: city.id || '',
            cityName: city.name || '',
            text: rt.text || '',
            temp: rt.temp,
            icon: rt.icon || '',
            day: todayStamp(),
          });
          if (rec) added += 1;
        } catch (_) {
          /* 单张失败不阻断其它 */
        }
      }
      api?.toast?.(added ? bt('album.added') : bt('album.failed'), 1600);
      if (added) await renderAlbumTool();
    });
  });

  body.querySelectorAll('[data-album-kind]').forEach((chip) => {
    chip.addEventListener('click', () => {
      albumFilter.kind = chip.dataset.albumKind;
      body.querySelectorAll('[data-album-kind]').forEach((c) => c.classList.toggle('bp-chip--on', c === chip));
      paintAlbumGrid(body, rows);
    });
  });

  body.querySelector('[data-album-days]')?.addEventListener('click', (e) => {
    albumFilter.days = albumFilter.days ? 0 : 30;
    e.currentTarget.classList.toggle('bp-chip--on', albumFilter.days > 0);
    paintAlbumGrid(body, rows);
  });

  paintAlbumGrid(body, rows);
}

function openAlbumViewer(id) {
  void ALBUM.getPhoto(id).then((rec) => {
    if (!rec) return;
    const url = URL.createObjectURL(rec.full || rec.thumb);
    const overlay = openSheet({
      title: albumMetaLine(rec) || bt('tool.album'),
      html: `
        <div class="album__viewer"><img src="${url}" alt=""></div>
        <p class="bp-line--dim" style="margin-top:var(--space-3)">${esc(bt('album.saveHint'))}</p>
        <div class="bp-actions">
          <button type="button" class="bp-btn bp-btn--primary" data-album-save="${rec.id}">${esc(bt('album.save'))}</button>
          <button type="button" class="bp-btn bp-btn--danger" data-album-del="${rec.id}">${esc(bt('album.delete'))}</button>
        </div>`,
    });
    const revoke = () => URL.revokeObjectURL(url);
    overlay.addEventListener('click', async (e) => {
      const save = e.target.closest('[data-album-save]');
      if (save) {
        const ok = await ALBUM.saveToDevice(rec);
        api?.toast?.(ok ? bt('watch.saved') : bt('album.failed'), 1600);
        return;
      }
      const del = e.target.closest('[data-album-del]');
      if (del) {
        await ALBUM.removePhoto(rec.id);
        closeSheet();
        void renderAlbumTool();
      }
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(overlay)) {
        revoke();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

/* ------------------------------------------------ 一起看（I5 · 2.7.6） */

let watchIds = null;
let watchLoading = false;

function watchCities() {
  return cityStore.getAll().filter((c) => c && c.id);
}

async function renderWatchTool() {
  const body = $('#tool-body');
  if (!body) return;
  const cities = watchCities();
  if (cities.length < 2) {
    body.innerHTML = `
      <div class="card">
        <div class="card__title">${esc(bt('tool.watch'))}</div>
        <p class="bp-line--dim">${esc(bt('watch.needTwo'))}</p>
      </div>`;
    return;
  }

  const p = prefs();
  const valid = (id) => cities.some((c) => String(c.id) === String(id));
  if (!watchIds) {
    watchIds = [valid(p.watchA) ? p.watchA : cities[0].id, valid(p.watchB) ? p.watchB : cities[1].id];
  }
  if (!valid(watchIds[0])) watchIds[0] = cities[0].id;
  if (!valid(watchIds[1])) watchIds[1] = cities[1].id;

  const place = (i) => cities.find((c) => String(c.id) === String(watchIds[i])) || cities[i];
  const a = place(0);
  const b = place(1);

  body.innerHTML = `
    <div class="watch">
      <button type="button" class="watch__side" data-watch-pick="0">
        <span class="watch__city">${esc(a.name)}</span>
        <span class="watch__temp" data-watch-temp="0">--</span>
        <span class="watch__text" data-watch-text="0">${esc(bt('watch.loading'))}</span>
      </button>
      <div class="watch__mid" aria-hidden="true"><span>${esc(bt('watch.same'))}</span></div>
      <button type="button" class="watch__side" data-watch-pick="1">
        <span class="watch__city">${esc(b.name)}</span>
        <span class="watch__temp" data-watch-temp="1">--</span>
        <span class="watch__text" data-watch-text="1">${esc(bt('watch.loading'))}</span>
      </button>
    </div>
    <p class="tool__hint" data-watch-clock></p>
    <div class="bp-actions">
      <button type="button" class="bp-btn" data-watch-save>${esc(bt('watch.save'))}</button>
    </div>
  `;

  body.querySelectorAll('[data-watch-pick]').forEach((btn) => {
    btn.addEventListener('click', () => openWatchPicker(Number(btn.dataset.watchPick)));
  });

  body.querySelector('[data-watch-save]')?.addEventListener('click', () => {
    const rts = body.__watchRt || [];
    exportWatchCard(a, b, rts);
  });

  if (watchLoading) return;
  watchLoading = true;
  const results = await Promise.allSettled([getRealtimeWeather(a.id), getRealtimeWeather(b.id)]);
  watchLoading = false;
  if (!document.body.contains(body)) return;
  const rts = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
  body.__watchRt = rts;
  rts.forEach((rt, i) => {
    const tempEl = body.querySelector(`[data-watch-temp="${i}"]`);
    const textEl = body.querySelector(`[data-watch-text="${i}"]`);
    if (tempEl) tempEl.textContent = rt ? tempText(rt.temp) : '--';
    if (textEl) textEl.textContent = rt ? (rt.text || '') : bt('watch.fail');
  });
  const clock = body.querySelector('[data-watch-clock]');
  if (clock) {
    const obsTime = rts.find(Boolean)?.obsTime;
    clock.textContent = obsTime ? `${bt('watch.same')} · ${String(obsTime).slice(11, 16)}` : '';
  }
}

function openWatchPicker(side) {
  const cities = watchCities();
  const overlay = openSheet({
    title: bt('watch.pick'),
    html: `<div class="bp-chips">${cities.map((c) => `
      <button type="button" class="bp-chip${String(c.id) === String(watchIds[side]) ? ' bp-chip--on' : ''}" data-watch-city="${esc(c.id)}">${esc(c.name)}</button>
    `).join('')}</div>`,
  });
  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch-city]');
    if (!btn) return;
    watchIds[side] = btn.dataset.watchCity;
    setPrefs({ watchA: watchIds[0], watchB: watchIds[1] });
    closeSheet();
    void renderWatchTool();
  });
}

function exportWatchCard(a, b, rts) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0b1229');
  grad.addColorStop(0.55, '#101a35');
  grad.addColorStop(1, '#1a2240');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '500 30px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('APEXON', W / 2, 96);
  ctx.font = '600 44px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(bt('watch.same'), W / 2, 156);

  const sides = [a, b];
  sides.forEach((city, i) => {
    const x = i === 0 ? W * 0.27 : W * 0.73;
    const rt = rts?.[i];
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '500 32px system-ui, -apple-system, sans-serif';
    ctx.fillText(city.name || '', x, 330);

    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.font = '200 168px system-ui, -apple-system, sans-serif';
    ctx.fillText(rt ? tempText(rt.temp) : '--', x, 540);

    ctx.fillStyle = 'rgba(210,225,255,0.82)';
    ctx.font = '400 36px system-ui, -apple-system, sans-serif';
    ctx.fillText(rt?.text || '', x, 606);
  });

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.moveTo(W / 2, 250);
  ctx.lineTo(W / 2, 640);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.font = '400 26px system-ui, -apple-system, sans-serif';
  const stamp = new Date();
  ctx.fillText(`${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`, W / 2, H - 120);

  canvas.toBlob((blob) => {
    if (!blob) return;
    void ALBUM.saveToDevice({ full: blob, day: todayStamp(), ts: Date.now(), cityName: 'watch' });
    api?.toast?.(bt('watch.saved'), 1600);
  }, 'image/jpeg', 0.92);
}

/* ------------------------------------------------ 工具页入口 */

export function renderBlueprintTool(id) {
  const body = $('#tool-body');
  if (!body) return false;
  switch (id) {
    case 'album': $('#tool-title').textContent = bt('tool.album'); void renderAlbumTool(); return true;
    case 'watch': $('#tool-title').textContent = bt('tool.watch'); void renderWatchTool(); return true;
    case 'board': $('#tool-title').textContent = bt('tool.board'); renderBoardTool(); return true;
    case 'people': $('#tool-title').textContent = bt('tool.people'); renderPeopleTool(); return true;
    case 'bond': $('#tool-title').textContent = bt('tool.bond'); renderBondTool(); return true;
    case 'letters': $('#tool-title').textContent = bt('tool.letters'); renderLettersTool(); return true;
    case 'colors': $('#tool-title').textContent = bt('tool.colors'); renderColorsTool(); return true;
    case 'promises': $('#tool-title').textContent = bt('tool.promises'); renderPromisesTool(); return true;
    case 'climate': $('#tool-title').textContent = bt('tool.climate'); renderClimateTool(); return true;
    case 'wrapped': $('#tool-title').textContent = bt('tool.wrapped'); renderWrappedTool(); return true;
    case 'warnings': $('#tool-title').textContent = bt('tool.warnings'); renderWarningLogTool(); return true;
    default: return false;
  }
}

/* ------------------------------------------------ 发现页（2.7.6 重构）

   旧版是 18 张同规格卡片平铺，看起来像「功能很多的工具箱」。
   现在按 iOS 的分区思路重排：
     · 顶部一张「今日主推」大卡，按当前天气/时段动态挑选最相关的一个工具；
     · 下方四个分区（关系 / 记忆 / 气候 / 工具），每区一条横向卡组；
     · 卡片只留图标 + 主标题 + 一句副文案 + 一个轻箭头，靠留白与字号分层。
   全部 20 个入口一个不少。
*/

const BP_TOOLS = new Set([
  'people', 'bond', 'board', 'letters', 'colors', 'promises',
  'climate', 'wrapped', 'warnings', 'sky', 'album', 'watch',
]);

const TOOL_EMOJI = {
  people: '👤',
  bond: '🤝',
  board: '🏡',
  letters: '✉️',
  colors: '🎨',
  promises: '🤞',
  climate: '📈',
  wrapped: '📅',
  warnings: '⚠️',
  sky: '🌌',
  album: '📷',
  watch: '🧭',
};

const TOOL_SVG = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2.5"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><line x1="8" y1="15" x2="10" y2="15"></line><line x1="14" y1="15" x2="16" y2="15"></line>',
  sunmoon: '<circle cx="8" cy="9" r="3.4"></circle><path d="M8 1.7v1.4M8 14.9v1.4M1.7 9h1.4M13.4 9h1.4M3.6 4.6l1 1M11.4 12.4l1 1M12.4 4.6l-1 1"></path><path d="M17 21a4.5 4.5 0 0 0 0-9 5.6 5.6 0 0 0-5.2 3.4A3.6 3.6 0 0 0 12.4 21z"></path>',
  aqimap: '<line x1="4" y1="20" x2="20" y2="20"></line><rect x="5" y="12" width="3" height="6" rx="1"></rect><rect x="10.5" y="8" width="3" height="10" rx="1"></rect><rect x="16" y="4" width="3" height="14" rx="1"></rect>',
  compare: '<path d="M7 4v16M7 4l-3 3M7 4l3 3"></path><path d="M17 20V4M17 20l-3-3M17 20l3-3"></path>',
  life: '<path d="M20.8 6.6a5 5 0 0 0-8.8-1.5A5 5 0 0 0 3.2 6.6c0 4.6 8.8 11.4 8.8 11.4s8.8-6.8 8.8-11.4z"></path>',
  widget: '<rect x="3" y="3" width="8" height="8" rx="2.2"></rect><rect x="13" y="3" width="8" height="8" rx="2.2"></rect><rect x="3" y="13" width="8" height="8" rx="2.2"></rect><rect x="13" y="13" width="8" height="8" rx="2.2"></rect>',
  citycompare: '<rect x="2.5" y="4" width="8" height="16" rx="2"></rect><rect x="13.5" y="4" width="8" height="16" rx="2"></rect><path d="M10.5 12h3"></path>',
  diary: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 1 4 17.5z"></path><path d="M8 7h8M8 11h6"></path>',
  sharecard: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><circle cx="8.5" cy="9.5" r="1.6"></circle><path d="M21 15l-4.5-4.5L7 20"></path>',
};

const DISCOVER_GROUPS = [
  ['discover.group.relations', ['people', 'bond', 'board', 'letters']],
  ['discover.group.memory', ['diary', 'album', 'wrapped', 'warnings', 'colors', 'promises']],
  ['discover.group.climate', ['calendar', 'climate', 'compare', 'citycompare', 'watch', 'aqimap', 'sunmoon']],
  ['discover.group.tools', ['life', 'widget', 'sharecard', 'sky']],
];

function toolTitle(id) {
  return BP_TOOLS.has(id) ? bt(`tool.${id}`) : t(`discover.${id}`);
}

function toolDesc(id) {
  return BP_TOOLS.has(id) ? bt(`tool.${id}Desc`) : t(`discover.${id}Desc`);
}

function toolIconMarkup(id) {
  if (TOOL_SVG[id]) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TOOL_SVG[id]}</svg>`;
  }
  return `<span class="disc-card__emoji" aria-hidden="true">${TOOL_EMOJI[id] || '·'}</span>`;
}

function toolCardHTML(id) {
  const title = toolTitle(id);
  const desc = toolDesc(id);
  const bpAttr = id === 'sky' ? ' data-bp-tool="sky"' : '';
  return `
    <button type="button" class="disc-card" data-tool="${id}"${bpAttr} aria-label="${esc(title)}">
      <span class="disc-card__icon">${toolIconMarkup(id)}</span>
      <span class="disc-card__title">${esc(title)}</span>
      <span class="disc-card__desc">${esc(desc)}</span>
      <span class="disc-card__go" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      </span>
    </button>`;
}

/**
 * 今日主推：不追求「聪明」，只追求不重复、不误导。
 * 预警 > 降雨 > 夜色 > 晴天 > 记录。
 */
function pickHeroTool(weather) {
  const w = weather || {};
  const hourly = w.hourly || [];
  const hour = new Date().getHours();
  const night = hour >= 20 || hour < 6;
  const rainSoon = hourly.slice(0, 6).some((h) => (parseFloat(h.pop) || 0) >= 50);
  if (Array.isArray(w.warnings) && w.warnings.length) return 'warnings';
  if (rainSoon) return 'life';
  if (night) return 'sky';
  if (FAM.weatherKind(w.realtime?.text) === 'sun') return 'album';
  return 'diary';
}

function renderDiscoverHero(weather) {
  const host = $('#disc-hero');
  if (!host) return;
  const id = pickHeroTool(weather);
  host.innerHTML = `
    <button type="button" class="disc-hero__card" data-tool="${id}"${id === 'sky' ? ' data-bp-tool="sky"' : ''}>
      <span class="disc-hero__kicker">${esc(bt('discover.hero'))}</span>
      <span class="disc-hero__row">
        <span class="disc-hero__icon">${toolIconMarkup(id)}</span>
        <span class="disc-hero__main">
          <span class="disc-hero__title">${esc(toolTitle(id))}</span>
          <span class="disc-hero__desc">${esc(toolDesc(id))}</span>
        </span>
        <span class="disc-hero__go" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </span>
      </span>
    </button>`;
}

function renderDiscoverPage() {
  const host = $('#discover-body');
  if (!host) return;
  host.innerHTML = DISCOVER_GROUPS.map(([key, ids]) => `
    <section class="disc-sec">
      <div class="disc-sec__head">
        <h2 class="disc-sec__title">${esc(bt(key))}</h2>
        <span class="disc-sec__count">${ids.length}</span>
      </div>
      <div class="disc-row">${ids.map(toolCardHTML).join('')}</div>
    </section>`).join('');
  renderDiscoverHero(api?.getState?.()?.weather);
}

function mountDiscoverCards() {
  if (!$('#discover-body')) return;
  renderDiscoverPage();
}

/* --------------------------------------------------------- 事件委托 */

function setupDelegates() {
  // 「天空窗口」不是工具子页，需在 app.js 的 discovery 路由之前截下这次点击
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-bp-tool="sky"]')) return;
    e.preventDefault();
    e.stopPropagation();
    openSky();
  }, true);

  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-bp]');
    if (action) {
      const kind = action.dataset.bp;
      if (kind === 'auto-close') {
        e.stopPropagation();
        storage.set(AUTO_DISMISS_KEY, todayStamp());
        const box = $('#bp-auto');
        if (box) box.hidden = true;
        return;
      }
      if (kind === 'care-go') {
        $('#bp-care')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (kind === 'care-add') openPersonSheet(null);
      if (kind === 'care-fold') {
        const next = !prefs().careCollapsed;
        setPrefs({ careCollapsed: next });
        $('#bp-care')?.classList.toggle('bp-care--collapsed', next);
        const btn = $('#bp-care')?.querySelector('[data-bp="care-fold"]');
        if (btn) btn.setAttribute('aria-expanded', next ? 'false' : 'true');
        if (!next) void renderCare();
        return;
      }
      if (kind === 'bond-create') openBondCreate();
      if (kind === 'bond-join') openBondJoin();
      if (kind === 'sky-close') closeSky();
      return;
    }

    if (e.target.closest('[data-breathe-open]')) {
      openBreathSheet();
      return;
    }

    const albumOpen = e.target.closest('[data-album-open]');
    if (albumOpen) {
      openAlbumViewer(albumOpen.dataset.albumOpen);
      return;
    }

    if (e.target.closest('[data-uv-open]')) {
      openUvSheet();
      return;
    }

    const person = e.target.closest('[data-person]');
    if (person) {
      openPersonSheet(person.dataset.person);
      return;
    }

    const bond = e.target.closest('[data-bond]');
    if (bond) {
      void openBondDetail(bond.dataset.bond);
      return;
    }

    const thread = e.target.closest('[data-bond-thread]');
    if (thread) {
      openThreadSheet(thread.dataset.bondThread);
      return;
    }

    const fine = e.target.closest('[data-bond-fine]');
    if (fine) {
      const id = fine.dataset.bondFine;
      void BOND.sendMessage(id, 'care', bt('bond.fine')).then((res) => {
        api?.toast?.(res.ok ? bt('bond.sendOk') : (res.text || bt('bond.sendFail')), 1600);
      });
      return;
    }

    const revoke = e.target.closest('[data-bond-revoke]');
    if (revoke) {
      const id = revoke.dataset.bondRevoke;
      const overlay = openSheet({
        title: bt('bond.revoke'),
        html: `
          <p class="bp-line">${esc(bt('bond.revokeHint'))}</p>
          <div class="bp-actions">
            <button type="button" class="bp-btn bp-btn--danger" data-revoke-ok>${esc(bt('bond.revoke'))}</button>
            <button type="button" class="bp-btn" data-sheet-close>${esc(bt('common.cancel'))}</button>
          </div>`,
      });
      overlay.addEventListener('click', async (ev) => {
        if (!ev.target.closest('[data-revoke-ok]')) return;
        await BOND.revokeBond(id);
        closeSheet();
        syncBondWatch();
        if (api?.getState?.().currentPage === 'tool') renderBondTool();
        void renderCare();
      });
      return;
    }

    const sky = e.target.closest('[data-tool="sky"]');
    if (sky) openSky();
  });

  // 消息轮询统一由 bond-notify.js 负责（45 秒一次 + 回到前台补拉 + 原生通知）
}

