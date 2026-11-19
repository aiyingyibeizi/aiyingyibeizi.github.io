/**
 * 内容反垃圾：对用户提交的评论/反馈做本地轻量检测（无需外部 API）。
 *
 * 目标：
 *   - block（硬拦截）——广告、外链、联系方式、明显危险/违规内容 → 直接拒绝写入并落告警；
 *   - flag（软标记）——无意义/刷屏噪音（连续重复字符、超高符号占比等）→ 照常保存，
 *     但打上 spam_filtered 标记，客户端可用「过滤无意义内容」开关在展示层隐藏。
 *
 * 设计原则：高精确优先，宁可漏判也不误伤正常中文句子；命中词表统一大小写与数字归一化。
 */

export interface SpamVerdict {
  action: 'block' | 'flag' | 'allow';
  level: 'hard' | 'soft' | 'none';
  reason: string;
}

/** 数字归一化：全角→半角、常见干扰字符替换（广告常用「1」「丨」「l」「壹」混淆） */
function normalize(s: string): string {
  return s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[一二三四五六七八九十]/g, '')
    .replace(/[°º〇●◦·・•:：.。!！]/g, '.')
    .replace(/[lI丨|｜]/g, '1')
    .replace(/[O0Ｏo]/g, '0')
    .toLowerCase();
}

// 高频广告/引流短语（命中即拦）
const ADS_PHRASES = [
  '加微信', '加wei信', '加wx', '加v', '加联系方式', '泡我', '泡un', '咨询请加',
  '代练', '代打', '外挂', '加速器', '开挂', '刷分', '刷榜', '刷单', '售分', '卖分',
  '拉票', '雇拼', '有償', '有偿代', '一律百一', '点击链接', '私我', '私聊我',
  '返利', '兼职', '日结', '垫资', '投资群', '稳赚', '导师带',
];

// 危险/违规内容（尽量高精度，命中才拦；宁可少而精）
const HARD_WORDS = [
  '賄路', '出售人體', '毒品', '買兇', '亂倫', 'self-harm', '自殺方法',
  '炸彈製作', '恐怖襲擊', 'hs大v', '援交', '約炮',
];

// 脏话/辱骂词（语气词、辱骂等，语义歧义低、正常交流用不到才入列；宁可少而精）
const PROFANITY = [
  '傻逼', '傻b', '傻x', '煞笔', '沙币', '操你妈', '去你妈', '他妈', '草泥马',
  '你妈的', '狗日的', '婊子', '贱人', '畜生', '妈逼', 'cnm', 's.b',
  'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', '妈的',
];
// 过滤掉明显片语化的 DNS 干扰后做二次校验，避免“每他X妈都”等误伤
const PROFANITY_RE = new RegExp('(' + PROFANITY.map((w) => w.replace(/[.+}{()|\\^$[\]*?-]/g, '\\$&')).join('|') + ')', 'i');

const URL_RE = /(https?:\/\/[^\s]+|www\.[a-z0-9\-]+(?:\.[a-z]{2,})+)/i;
const PHONE_RE = /1[3-9]\d{9}/;                         // 大陆手机号
const DOMAIN_RE = /\.[a-z]{2,}\b/i;                     // xxx.com/.cn 等
const EMAIL_RE = /[a-z0-9._+\-]+@[a-z0-9\-]+(?:\.[a-z]{2,})+/i;

/** 是否命中广告/外链/危险词（硬拦截） */
export function detectHard(text: string): string | null {
  const tl = text.toLowerCase();
  const n = normalize(text);

  for (const w of HARD_WORDS) if (tl.includes(w)) return `含敏感内容（${w}）`;
  for (const w of ADS_PHRASES) {
    if (n.includes(w) || tl.includes(w)) return `含广告/引流话术（${w}）`;
  }

  // 脏话/辱骂：命中即硬拦。词表短且语义歧义低，正常中文句子几乎不会误伤。
  const profanityHit = tl.match(PROFANITY_RE);
  if (profanityHit) return `含不适当用语（${profanityHit[0]}）`;

  if (URL_RE.test(text) || EMAIL_RE.test(text)) return '含外链或联系方式';
  if (PHONE_RE.test(n)) return '含手机号';
  if (DOMAIN_RE.test(n) && /[a-z]{2,}/i.test(n.replace(/\s/g, ''))) {
    // 纯 ìNGlish 域名串才算可疑：中文句子里的“。com”不属于 .com 域名
    if (/(\bwww\.|\.(com|cn|net|org|top|xyz|vip|cc|me)\b)/i.test(n)) return '含网址';
  }
  return null;
}

/** 是否无意义/刷屏噪音（软标记） */
export function detectNoise(text: string): string | null {
  const noWs = text.replace(/\s+/g, '');
  if (!noWs) return null;
  if (noWs.length >= 4 && /^(.)\1{3,}$/.test(noWs)) return '连续重复字符刷屏';
  if (noWs.length >= 8 && /^(.)\1{7,}$/.test(noWs)) return '连续重复字符刷屏';

  // 巨量特殊符号/表情比例（如 “。。。。。。” “！！！！！”）
  const symRun = noWs.match(/[\.·•。!！？｡#＊*''""\-—~～、,，;； ]{6,}/);
  if (symRun) return '符号堆砌';

  // 纯符号 + 少量字，判定噪声
  const symCount = (noWs.match(/[^\p{Script=Han}\p{L}\p{N}]/gu) || []).length;
  if (noWs.length >= 6 && noWs.length <= 18 && symCount / noWs.length >= 0.5) {
    return '符号占比过高';
  }

  // 单个完整中文标点段落式刷屏（如“哈哈哈哈哈哈哈哈哈”超过 12 字全重复）
  const first = noWs[0];
  if (noWs.length >= 14 && first.charCodeAt(0) >= 0x4e00 && noWs.split(first).length - 1 >= 13) {
    return '重复单字刷屏';
  }

  return null;
}

/** 主入口 */
export function analyzeContent(text: string): SpamVerdict {
  const t = (text || '').trim();
  if (!t) return { action: 'allow', level: 'none', reason: '' };
  const hard = detectHard(t);
  if (hard) return { action: 'block', level: 'hard', reason: hard };
  const noise = detectNoise(t);
  if (noise) return { action: 'flag', level: 'soft', reason: noise };
  return { action: 'allow', level: 'none', reason: '' };
}