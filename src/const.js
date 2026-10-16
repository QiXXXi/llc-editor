/* 枚举与配色表 —— 全应用唯一存放中文字符串的地方。
 *
 * 规矩：枚举在数据里只存稳定的 token，中文标签、颜色只在这里。这样改文案永远
 * 不会动到用户的存档。(罪孽存 'gloom'，抗性存 '2'，触发时机存 '命中时'。)
 *
 * 配色全部取自灰机的「模板:颜色」和「模板:数字抗性」—— 不是我调出来的，
 * 是照着人家 wiki 抄的，这样导出的图和灰机页面上看到的对得上。
 *
 * 数组顺序有意义：
 *   SINS      —— 七罪孽，抗性 / 消耗 / 被动资源三处都是这个固定顺序
 *   ATK_TYPES —— 斩 / 突 / 打，物理抗性三格用的就是这个顺序
 *   SINNERS   —— 罪人顺序，取自立绘编号（李箱 1 … 格里高尔 12）
 */
var Enums = (function () {
  'use strict';

  /* 七罪孽。灰色取自「模板:颜色」里的罪孽色号。 */
  var SINS = [
    { key: 'wrath', cn: '暴怒', color: '#A0392B' },
    { key: 'lust', cn: '色欲', color: '#BB521F' },
    { key: 'sloth', cn: '怠惰', color: '#C9A424' },
    { key: 'glut', cn: '暴食', color: '#849A30' },
    { key: 'gloom', cn: '忧郁', color: '#40A1B5' },
    { key: 'pride', cn: '傲慢', color: '#305E87' },
    { key: 'envy', cn: '嫉妒', color: '#6E4D7E' }
  ];

  /* 三种攻击类型。顺序 = 物理抗性的显示顺序（斩/突/打）。 */
  var ATK_TYPES = [
    { key: 'slash', cn: '斩击', color: '#C94F4F' },
    { key: 'pierce', cn: '突刺', color: '#D8A33A' },
    { key: 'blunt', cn: '打击', color: '#7E8FA6' }
  ];

  /* 守备技能的种类。取自 Identitychoose.tabx 的 skill4def 字段 ——
   * 实测只有这五种取值，反击按伤害类型细分。 */
  var DEF_TYPES = [
    { key: 'defend', cn: '防御', color: '#9D673A' },
    { key: 'evade', cn: '闪避', color: '#6E9C7A' },
    { key: 'counter_slash', cn: '反击·斩击', color: '#C94F4F' },
    { key: 'counter_pierce', cn: '反击·突刺', color: '#D8A33A' },
    { key: 'counter_blunt', cn: '反击·打击', color: '#7E8FA6' }
  ];

  /* 12 罪人。code 是立绘编号的首段（李箱 10101 → 1，奥提斯 11103 → 11）。 */
  var SINNERS = [
    { key: 'yiSang', cn: '李箱', code: 1, color: '#d4e1e8' },
    { key: 'faust', cn: '浮士德', code: 2, color: '#ffb1b4' },
    { key: 'donQuixote', cn: '堂吉诃德', code: 3, color: '#ffef23' },
    { key: 'ryoshu', cn: '良秀', code: 4, color: '#cf0000' },
    { key: 'meursault', cn: '默尔索', code: 5, color: '#293b95' },
    { key: 'hongLu', cn: '鸿璐', code: 6, color: '#5bffde' },
    { key: 'heathcliff', cn: '希斯克利夫', code: 7, color: '#4e3076' },
    { key: 'ishmael', cn: '以实玛利', code: 8, color: '#ff9500' },
    { key: 'rodion', cn: '罗佳', code: 9, color: '#820000' },
    { key: 'sinclair', cn: '辛克莱', code: 10, color: '#8b9c15' },
    { key: 'outis', cn: '奥提斯', code: 11, color: '#325339' },
    { key: 'gregor', cn: '格里高尔', code: 12, color: '#69350b' }
  ];

  /* 抗性档位。
   *
   * 关键：**存的是倍率本身，不是档位名**。灰机的人格数据表里，物理抗性字段是
   * `0 / 1 / 2`，模板里写的是 `{{#ifexpr: v>=1 | v | 0.5}}` —— 也就是
   * 「数字就是受伤倍率，0 代表 0.5」。罪孽抗性则直接写 0.5 / 0.75 / 2 这种。
   * 所以数字才是真相，档位名只是给下拉框看的标签。
   *
   * 早先想「存档位 key、倍率查表推导」，问题是罪孽抗性会出现 0.75 这类
   * 不落在任何一档上的值，一存一取就把精度丢了。现在存原始数字，
   * 表格里的档位名只负责把下拉框变得好读。
   *
   * 倍率是「受伤倍率」：数字越大越脆。这是 PM 社一贯的反直觉命名。
   *
   * **色号只收灰机「模板:颜色」里真有的那几个**：×0.5 / ×1 / ×2 / ×0.75 / ×1.5 /
   * ×1.1 / ×0.7 / ×0.1。早先还挂过一个 `×3 → #a32020`，那是自己编的 —— 灰机表里
   * 没有 ×3，全库 190 个人格 + 116 个 E.G.O 的实际数据里也从来没出现过 3 倍
   *（物理抗性只有 0.5/1/2，罪孽抗性只有 0.5/0.75/1/2），删掉。
   * 真遇到表外的值，`resistColor()` 会退回正文色而不是编一个色号出来。 */
  var RESIST_TIERS = [
    { mult: 0.5, cn: '抵抗', color: '#828282' },
    { mult: 0.75, cn: '耐性', color: '#b6b8b7' },
    { mult: 1.0, cn: '一般', color: '#e2c090' },
    { mult: 1.5, cn: '脆弱', color: '#ff918a' },
    { mult: 2.0, cn: '致命', color: '#ff0000' }
  ];

  /* 人格稀有度。灰机数据表里是 1/2/3，游戏里显示 0 / 00 / 000。 */
  var RARITY = [
    { key: '1', cn: '★', stars: 1 },
    { key: '2', cn: '★★', stars: 2 },
    { key: '3', cn: '★★★', stars: 3 }
  ];

  /* E.G.O 危险等级。 */
  var EGO_GRADE = [
    { key: 'ZAYIN', cn: 'ZAYIN', color: '#7ED0A0' },
    { key: 'TETH', cn: 'TETH', color: '#54BEE8' },
    { key: 'HE', cn: 'HE', color: '#E8D24A' },
    { key: 'WAW', cn: 'WAW', color: '#B87AE8' },
    { key: 'ALEPH', cn: 'ALEPH', color: '#E85A5A' }
  ];

  /* 同步阶段（人格）。 */
  var STAGES = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'];

  /* 异想解析阶段（E.G.O）。
   *
   * 灰机的模板里 EGO 技能其实有 5 个阶段（Ⅰ~Ⅴ），但**阶段Ⅱ 是把阶段Ⅰ 的原样
   * 复制**（模板里就是硬写的同一组参数），而且数据表 Data:Egochoose 也只提供
   * 3/4/5 三组。所以这里只留真正互不相同的四级：Ⅰ / Ⅲ / Ⅳ / Ⅴ。
   * 多存一级 Ⅱ 只会让编辑器里出现一行永远和Ⅰ相同的重复数据。 */
  var EGO_STAGES = ['Ⅰ', 'Ⅲ', 'Ⅳ', 'Ⅴ'];

  /* 被动/支援被动的触发条件。取自 tabx 的 paskind / supkind 字段。 */
  var PASSIVE_COND = [
    { key: 'always', cn: '常时发动' },
    { key: 'resonance', cn: '共鸣' },
    { key: 'hold', cn: '持有' }
  ];

  var PASSIVE_WHERE = [
    { key: 'battle', cn: '战斗' },
    { key: 'support', cn: '支援' }
  ];

  /* 硬币效果的触发时机。
   *
   * 这一份是从灰机「模板:颜色」的 #switch 分支里整个抠出来的 —— 作者在
   * wiki 上写的 `{{颜色|X}}` 里 X 能取的值就是这些，一共 68 个。所以
   * **触发时机存的就是这个中文 token 本身**（不另造 ASCII key）：它既是
   * wiki 的输入，也是卡片的显示文本，存两份反而要维护一张对照表，
   * 而这张对照表的真相本来就在 wiki 那边。
   *
   * 前一组是实测最常用的，单独拎出来放下拉框顶部。 */
  var TRIGGERS_COMMON = [
    '命中时', '正面命中时', '反面命中时', '使用时', '拼点胜利', '拼点失败',
    '攻击前', '攻击后', '战斗开始', '击杀时', '常驻'
  ];

  var TRIGGERS_ALL = [
    '重复使用 - 命中时', '重复使用时', '重复使用 - 正面命中时', '重复使用-正面命中时',
    '闪避使用时', '闪避成功时', '闪避失败时',
    '使用前', '使用效果', '常驻效果',
    '可拼点反击', '可拼点防御', '可破坏',
    '受到攻击前', '单方面攻击时', '当前硬币攻击后',
    '技能结束时', '群体技能', '无差别攻击', '战斗结束',
    '拼点开始', '拼点失败 - 命中时', '拼点胜利 - 命中时', '拼点胜利 - 攻击后',
    '拼点胜利-命中时', '拼点胜利-正面命中时', '拼点失败-命中时',
    '正面', '反面', '正面命中时', '反面命中时',
    '正面攻击后', '正面攻击结束后', '反面攻击后', '反面攻击结束后',
    '暴击命中时', '暴击正面命中时', '暴击击杀时', '暴击击杀敌方时',
    '暴击发动时', '暴击未击杀敌方时', '暴击结束后', '暴击攻击后',
    '击杀敌方时', '击杀目标时', '击杀友方时',
    '未击杀敌方时', '未击杀目标时', '未击杀友方时',
    '未摧毁 - 命中时', '命中时未被摧毁', '硬币攻击后', '硬币攻击结束时', '硬币开始时',
    '回合开始时', '回合结束时',
    '无法拼点', '无法改变目标', '无法改变拼点目标',
    '队首2人', '队中2人', '队尾2人'
  ];

  /* 下拉框用的合并列表：常用组 + 其余。key 与 cn 相同，所以 label() 退化成功等映射。 */
  var TRIGGERS = TRIGGERS_COMMON.map(function (t) {
    return { key: t, cn: t, group: '常用' };
  }).concat(TRIGGERS_ALL.map(function (t) {
    return { key: t, cn: t, group: '其他' };
  }));
  /* 「没有触发时机」这一项用 ASCII key 'none'，因为渲染和 wikitext 导出都要
   * 把它判掉（卡片上不该印出「（无）」两个字，wiki 上也不该出现 {{颜色|（无）}}）。 */
  TRIGGERS.unshift({ key: 'none', cn: '（无）', group: '常用' });

  /* 技能类型：普通攻击技能 / 守备技能 / E.G.O 觉醒 / E.G.O 侵蚀。 */
  var SKILL_KINDS = {
    atk: { cn: '攻击技能', short: '技能' },
    def: { cn: '守备技能', short: '守备' },
    awaken: { cn: '觉醒技能', short: '觉醒' },
    corrode: { cn: '侵蚀技能', short: '侵蚀' }
  };

  /* 人格技能可以改的那两种。E.G.O 的觉醒/侵蚀是定死的，不给选。 */
  var SKILL_KIND_OPTS = [
    { key: 'atk', cn: '攻击技能' },
    { key: 'def', cn: '守备技能' }
  ];

  /* ---------------------------------------------------------------- 技能槽位
   *
   * 灰机人格页把技能拆成一组组参数：`1技能`~`3技能` 是三个攻击技能，`4技能`
   * 按约定是守备技能，此外还有 `5技能` / `6技能` / `7技能` 和「强化N技能」
   * 家族 —— 同一个技能的强化形态。190 个页面一共 863 个技能条目，最多的一个
   * 人格有 13 个（辛克莱高级定制::红派 赤红之神）。
   *
   * 槽位名（`1技能` / `强化2技能` / `强化3技能2`）**本身就是存档里的 key**，
   * 和触发时机一样不另造 ASCII key：它同时是卡片的显示文本和 wikitext 导出的
   * 参数前缀，中间再插一层对照表纯属自找麻烦。 */
  var SLOT_RE = /^(强化)?(\d+)技能(.*)$/;

  function slotParts(slot) {
    var m = SLOT_RE.exec(String(slot || ''));
    if (!m) return { num: 99, enh: 0, variant: '' };
    return { num: parseInt(m[2], 10), enh: m[1] ? 1 : 0, variant: m[3] || '' };
  }

  /* 4技能 按灰机的约定就是守备技能。 */
  function slotIsDef(slot) { return slot === '4技能'; }

  function slotOk(slot) { return SLOT_RE.test(String(slot || '')); }

  /* 槽位 → 卡片/表单上的短标签。`4技能` 就叫「技能4」，是不是守备由技能
   * 自己的守备类型格说明，标签里不再重复一遍。 */
  function slotLabel(slot) {
    if (!SLOT_RE.test(String(slot || ''))) return String(slot || '');
    var p = slotParts(slot);
    if (!p.enh) return '技能' + p.num;
    return '技能' + p.num + '·强化' + p.variant;
  }

  /* 排序：1技能 < 强化1技能 < 强化1技能2 < 2技能 < … < 4技能 < 强化4技能攻击 < 5技能。
   * 「是否强化」排在序号后面当第二位，强化形态才会紧跟在本体后面。 */
  function slotSort(a, b) {
    var pa = slotParts(a), pb = slotParts(b);
    if (pa.num !== pb.num) return pa.num - pb.num;
    if (pa.enh !== pb.enh) return pa.enh - pb.enh;
    var na = pa.variant === '' || /^\d+$/.test(pa.variant);
    var nb = pb.variant === '' || /^\d+$/.test(pb.variant);
    if (na !== nb) return na ? -1 : 1;
    if (na) {
      var va = pa.variant === '' ? 0 : parseInt(pa.variant, 10);
      var vb = pb.variant === '' ? 0 : parseInt(pb.variant, 10);
      return va - vb;
    }
    return pa.variant < pb.variant ? -1 : (pa.variant > pb.variant ? 1 : 0);
  }

  /* 新建技能时的默认槽位：接着现有槽位的最大序号往后排。 */
  function nextSlot(skills) {
    var max = 0;
    (skills || []).forEach(function (s) {
      var p = slotParts(s.slot);
      if (p.num < 90 && p.num > max) max = p.num;
    });
    return (max + 1) + '技能';
  }

  /* ---------------------------------------------------------------- 灰机配色表
   *
   * 整张抄自灰机「模板:颜色」的 #switch —— 页面正文里的 `{{颜色|X}}` 就是查这张表
   * 染色的，渲染出来是 `<span style="color:X">[X]</span>`。
   *
   * 用户明确要求「特殊标签文字的颜色不许改」，所以这里**一个色号都不许自己调**：
   * 之前那版是我按语义分组拍脑袋配的（命中时=金、使用时=蓝…），跟 wiki 对不上。
   * 例如 `[使用时]` wiki 是亮青 #26cfff，`[攻击容量的标签]` 是 #F0BC00，
   * 技能数值统一 #ECCCA3 —— 这些才是正文里真正出现的颜色。
   *
   * 罪孽色 / 抗性色 / 危险等级色在 SINS、RESIST_TIERS、EGO_GRADE 里已经有一份
   * （值是一样的），这里不再重复。 */
  var WIKI_COLOR = {
    /* 触发时机系。金的 #93F03E 占了绝大多数，「命中时」和「攻击前后」都是它；
     * 只有「使用时」是青、「拼点胜利/可拼点反击」是橙、「正面/反面」是粉紫。 */
    '命中时': '#93F03E', '使用前': '#93F03E', '攻击前': '#93F03E', '攻击后': '#93F03E',
    '受到攻击前': '#93F03E', '单方面攻击时': '#93F03E', '当前硬币攻击后': '#93F03E',
    '击杀时': '#93F03E', '技能结束时': '#93F03E', '战斗开始': '#93F03E',
    '战斗结束': '#93F03E', '闪避成功时': '#93F03E', '闪避失败时': '#93F03E',
    '闪避使用时': '#93F03E', '常驻': '#93F03E', '常驻效果': '#93F03E',
    '使用效果': '#93F03E', '拼点开始': '#93F03E', '硬币开始时': '#93F03E',
    '回合开始时': '#93F03E', '回合结束时': '#93F03E', '可拼点防御': '#93F03E',
    '击杀敌方时': '#93F03E', '击杀目标时': '#93F03E', '击杀友方时': '#93F03E',
    '未击杀敌方时': '#93F03E', '未击杀目标时': '#93F03E', '未击杀友方时': '#93F03E',
    '无法改变目标': '#93F03E', '无法改变拼点目标': '#93F03E',
    '未摧毁 - 命中时': '#93F03E', '命中时未被摧毁': '#93F03E',
    '硬币攻击后': '#93F03E', '硬币攻击结束时': '#93F03E',
    '重复使用时': '#93F03E', '重复使用 - 命中时': '#93F03E',
    '重复使用 - 正面命中时': '#93F03E', '重复使用-正面命中时': '#93F03E',
    '拼点失败 - 命中时': '#93F03E', '拼点胜利 - 命中时': '#93F03E',
    '拼点胜利 - 攻击后': '#93F03E', '拼点胜利-命中时': '#93F03E',
    '拼点胜利-正面命中时': '#93F03E', '拼点失败-命中时': '#93F03E',
    '暴击命中时': '#93F03E', '暴击正面命中时': '#93F03E', '暴击发动时': '#93F03E',
    '暴击击杀时': '#93F03E', '暴击击杀敌方时': '#93F03E',
    '暴击未击杀敌方时': '#93F03E', '反面命中时': '#93F03E',
    '使用时': '#26cfff',
    '拼点胜利': '#ff7e00', '可拼点反击': '#ff7e00',
    '拼点失败': '#e30000',
    '正面': '#ff59c2', '正面命中时': '#c7ff94',
    '正面攻击后': '#ff59c2', '正面攻击结束后': '#ff59c2',
    '反面': '#cb0080', '反面攻击后': '#cb0080', '反面攻击结束后': '#cb0080',
    '暴击攻击后': '#ff59c2', '暴击结束后': '#ff59c2',
    '群体技能': '#ffe71b',
    '无差别攻击': '#ff0000', '无法拼点': '#ff0000', '可破坏': '#ff0000',
    /* 正文里当小标题用的（`{{颜色|攻击容量}}`、`{{颜色|本技能适用以下效果}}`） */
    '队首2人': '#fcf2e5', '队中2人': '#fcf2e5', '队尾2人': '#fcf2e5',
    /* 抗性档位。同一张表里还有 `抵抗 / 耐性 / 一般 / 脆弱 / 致命` 五个别名，
     * 值跟 RESIST_TIERS 完全一致 —— 表格上印的就是这几个色。 */
    '×0.1': '#828282', '×0.5': '#828282', '×0.7': '#b6b8b7', '×0.75': '#b6b8b7',
    '×1': '#e2c090', '×1.1': '#ff918a', '×1.5': '#ff918a', '×2': '#ff0000',
    '抵抗': '#828282', '耐性': '#b6b8b7', '一般': '#e2c090',
    '脆弱': '#ff918a', '致命': '#ff0000',
    /* 罪孽色与危险等级色在这张表里也各有一份，SINS / EGO_GRADE 里那份同值 */
    '疯狂': '#ffffff', '恐惧': '#444444'
  };

  /* 触发时机 → 颜色。查不到返回 null（卡片退回中性灰，不瞎猜）。 */
  function triggerColor(tok) {
    if (!tok || tok === 'none') return null;
    if (WIKI_COLOR[tok]) return WIKI_COLOR[tok];
    if (/^队[首中尾]\d+人$/.test(tok)) return '#fcf2e5';
    return null;
  }

  /* 状态效果的分类色。正正取自「模板:状态2」的 #switch：
   *     {{#switch:{{{4|正面}}}|正面=#daa520|负面=#FF0000|状态=#76BF32|特殊=#815530}}
   * 这五个色号是模板里**写死**的，不是查 Data:Buff.tabx 得来的 —— 所以
   * `{{状态2|深泪}}`（Buff.tabx 里 kind=特殊）在页面上其实是金色的。卡片一律
   * 按正文里那个 `4=` 参数上色，跟页面一模一样。 */
  var STATUS_KIND_COLOR = {
    '正面': '#daa520', '负面': '#FF0000', '状态': '#76BF32', '特殊': '#815530'
  };

  /* 状态名底下那条下划线。模板:状态2 是内外两层：外层 #000000 2.5px、
   * 内层跟着分类色 1.5px，两层叠在一起看就是「黑边托着一条彩线」。 */
  var STATUS_UNDERLINE = '#000000';

  /* ---------------------------------------------------------------- 状态 token
   *
   * 正文里一个状态在页面上是这样：
   *     <img 沉沦.png 15px><span 黑下划线><span 红下划线><a>沉沦</a></span></span>
   * 纯文本存不下这四样东西，所以在效果文本里用一个 `**…**` 的 token 表示，
   * 语法抄的是 模板:状态2 自己的参数顺序：
   *
   *     **沉沦**              图标、文字都叫「沉沦」，默认金色（正面）
   *     **沉沦|负面**         第 4 个参数换色
   *     **狂信|正面|狂信（我方）**  第 3 个参数换了张图标，文字还是「狂信」
   *     **3技能|@傲慢**       罪孽颜色模板：按罪孽色染色，没有图标、没有下划线
   *
   * `|` 不可能出现在状态名里（名字直接当模板参数用），拿它当分隔符是安全的。
   * 同一套语法在 tools/parse_seed.py 的 _status_mark() 和 src/wikitext.js
   * 的逆向导出里各有一份，改动要同步。 */
  function parseStatus(body) {
    var p = String(body == null ? '' : body).split('|');
    var text = p[0] || '';
    var kind = (p[1] || '').trim();
    var icon = (p[2] || '').trim();
    if (kind.charAt(0) === '@') {
      var sin = kind.slice(1);
      return { text: text, plain: true, sin: sin, color: sinColor(sin), icon: '' };
    }
    if (!STATUS_KIND_COLOR[kind]) kind = '正面';
    return {
      text: text, kind: kind, color: STATUS_KIND_COLOR[kind],
      icon: icon || text, plain: false
    };
  }

  function sinColor(cn) {
    for (var i = 0; i < SINS.length; i++) {
      if (SINS[i].cn === cn) return SINS[i].color;
    }
    return WIKI_COLOR[cn] || null;
  }

  /* 技能图标那一整块（描边框 + 六边形贴图 + 底色板）的几何。
   *
   * 灰机每个罪孽一张「{罪孽}技能图标」模板，**罪孽 × 等级各写死一组数**，不是
   * 统一值 —— 下面这张表就是那八张模板的逐字转写，配 tools/probe_icon_geom.py
   * 可以随时回原作对（那个脚本会把模板重抓一遍，再在缓存整页上量一次复核）。
   *
   * 每个罪孽一行，行内三档（等级 1 / 2 / 3），每档六个数：
   *
   *     [框宽, 贴图 ml, 贴图 mt, 贴图边长, 底板 x, 底板 y]
   *
   *   - 框宽：只有常规框是 70，其余 75。**高度按贴图自己的宽高比推**，因为八张
   *     框图的原始比例并不一样（80×79 到 80×93 都有），一律画成 75×81 会把框
   *     压扁或者拉长。
   *   - ml/mt：六边形贴图相对框 div 左上角的位移，就是模板里的 margin-left/top。
   *   - 贴图边长：忧郁和常规只有 55，其余 60。
   *   - 底板 x/y：底色板**贴图**相对**技能块左上角**的位置。模板里写的是 margin
   *     （相对框 div），但灰机渲染时底色板那张图**独占一行**，MediaWiki 会给它套
   *     一个 `<p>`，于是又往下顶一个 `<p>` 的上外边距。这个值**不是** 16px：
   *     真站 DragonHide 皮肤写的是 `#content p{margin:7.5px 0}`（见
   *     `_ref/huiji/css/skin.css`），所以是 mt + 7.5。暴食和嫉妒两张模板少写了一
   *     个换行，贴图不独行、没有 `<p>`，这两家就是裸 mt。
   *     **曾被误记成 16px 并照此改表**——缓存页的 `<link href="/load.php?…">` 是
   *     相对路径，file:// 下 404、整站皮肤样式全丢，`<p>` 才退回 UA 默认的 16px，
   *     凭空多算 8.5px。量灰机一律走 tools/wiki_page.py（把 CSS 注回去再量）。
   *
   * 贴图名不写进表里，因为规律是死的：等级 1/2 用 `{罪孽}-等级N` 和同名 `-底部`，
   * 等级 3（3 技能）换成通用的 Icon skillFrame 系列，编号跟着罪孽下标走
   * —— 暴怒 i=0 是 `1 0` / `Invert 7`，嫉妒 i=6 是 `1 6` / `Invert 13`。 */
  var SIN_GEOM = {
    '暴怒': [[75, 10, 12, 60, 34, -0.5], [75, 8, 17, 60, 34, -0.5], [75, 6, 17, 60, 33, -1.5]],
    '色欲': [[75, 8, 8, 60, 34, 2.5], [75, 7, 8, 60, 34, -0.5], [75, 7, 13, 60, 33, 1.5]],
    '怠惰': [[75, 8, 4, 60, 34, 1.5], [75, 8, 7, 60, 34, 1.5], [75, 4, 9, 60, 34, 1.5]],
    '暴食': [[75, 7, 7, 60, 34, -2], [75, 7, 9, 60, 34, -3], [75, 6, 12, 60, 32, -2]],
    '忧郁': [[75, 10, 8.5, 55, 33, -2.5], [75, 8, 10, 55, 33, -2.5], [75, 7, 15, 55, 33, -0.5]],
    '傲慢': [[75, 10, 10, 60, 34, 3.5], [75, 10, 10, 60, 34, 2.5], [75, 6, 14, 60, 33, 2.5]],
    '嫉妒': [[75, 9, 4, 60, 34, -3], [75, 7, 7, 60, 34, -2.5], [75, 5, 13, 60, 33, -1]],
    /* 常规框没有按等级分档：模板里只有等级 1 写了 margin，2/3 落空等于没位移 */
    '常规': [[70, 9, 7, 55, 33, 5.5], [70, 0, 0, 55, 33, 5.5], [70, 0, 0, 55, 33, 5.5]]
  };

  function skinFor(cn, i) {
    var rows = SIN_GEOM[cn] || SIN_GEOM['常规'];
    var out = {};
    for (var lv = 1; lv <= 3; lv++) {
      var n = rows[lv - 1];
      /* 常规框那张模板压根没写 #switch，三个等级都是同一张 70px 的图，
       * 所以挑图名时按等级 1 走，别给它编出个 `Icon skillFrame 1 -1` 来。 */
      var pick = cn === '常规' ? 1 : lv;
      out[lv] = {
        frame: pick === 3 ? 'Icon skillFrame 1 ' + i : cn + '-等级' + pick,
        bottom: pick === 3 ? 'Icon skillFrame Invert ' + (i + 7) : cn + '-等级' + pick + '-底部',
        framePx: n[0], ml: n[1], mt: n[2], px: n[3], bx: n[4], by: n[5]
      };
    }
    return out;
  }

  var SIN_FRAMES = {};
  SINS.forEach(function (s, i) { SIN_FRAMES[s.cn] = skinFor(s.cn, i); });
  SIN_FRAMES['常规'] = skinFor('常规', -1);

  /* 取某一档的几何。认不出的罪孽退回常规框。 */
  function sinSkin(cn, level) {
    var set = SIN_FRAMES[cn] || SIN_FRAMES['常规'];
    return set[level] || set[1];
  }

  /* 技能页签。灰机的 {{技能链接}} 模板把 1~8 技能参数摊进四个
   * `personalityskillN` 里，页签名就是 1技能 / 2技能 / 3技能 / 守备技能。
   *
   * 参数名跟页签**不是**一一对应的 —— 模板里的注释原话：
   *   `|5技能-图标=<!---给强化3技能用的，对应第四个攻击技能-->`
   * 所以 `5技能` 归 3技能 页签（渲染时按等级 3 取框），`6技能` / `7技能` 归守备。
   * 这就是用户说的「哪几个技能是一技能变种、二技能变种、三技能变种」——
   * 网页上根本没有「四技能」「五技能」这两个页签。 */
  var SKILL_TABS = [
    { key: 1, cn: '1技能', level: 1 },
    { key: 2, cn: '2技能', level: 2 },
    { key: 3, cn: '3技能', level: 3 },
    { key: 4, cn: '守备技能', level: 1 }
  ];

  function slotTab(slot) {
    if (!SLOT_RE.test(String(slot || ''))) return 4;
    var p = slotParts(slot);
    if (p.enh) return p.num <= 3 ? p.num : 4;   // 强化N技能 跟着 N
    if (p.num <= 3) return p.num;
    if (p.num === 5) return 3;                  // 第四个攻击技能 = 3技能 的追加形态
    return 4;                                   // 4 / 6 / 7 / 8 全是守备
  }

  /* 页签内排序。**照抄灰机模板里各 div 的出现次序**（模板:技能链接 的
   * personalitystage4 分支），不是自己推的：
   *   1技能 → 1技能, 强化1技能, 强化1技能2
   *   2技能 → 2技能, 强化2技能, 强化2技能2
   *   3技能 → 3技能, 5技能, 强化3技能2, 强化3技能3
   *   守备  → 4技能, 7技能, 6技能, 强化4技能攻击
   * 注意守备那一档是 **7 在 6 前面**、强化形态在最后 —— 按数字排会排错。
   * 表里没有的槽位（用户自己加的 8技能 之类）排到最后，按序号。 */
  var SLOT_ORDER = {
    '1技能': 1, '强化1技能': 2, '强化1技能2': 3,
    '2技能': 1, '强化2技能': 2, '强化2技能2': 3,
    '3技能': 1, '5技能': 2, '强化3技能2': 3, '强化3技能3': 4,
    '4技能': 1, '7技能': 2, '6技能': 3, '强化4技能攻击': 4
  };

  function slotRank(slot) {
    if (Object.prototype.hasOwnProperty.call(SLOT_ORDER, slot)) return SLOT_ORDER[slot];
    var p = slotParts(slot);
    return 50 + (p.num < 90 ? p.num : 99) + (p.enh ? 0.5 : 0);
  }

  /* 技能列表 → 四个页签（空页签不返回）。 */
  function groupSkills(skills) {
    var buckets = [[], [], [], []];
    (skills || []).forEach(function (sk) {
      var t = slotTab(sk.slot);
      buckets[t >= 1 && t <= 4 ? t - 1 : 3].push(sk);
    });
    var out = [];
    for (var i = 0; i < 4; i++) {
      if (!buckets[i].length) continue;
      buckets[i].sort(function (a, b) { return slotRank(a.slot) - slotRank(b.slot); });
      out.push({ tab: SKILL_TABS[i], skills: buckets[i] });
    }
    return out;
  }

  /* ---------------------------------------------------------------- 查表 */

  function _index(list) {
    var m = {};
    for (var i = 0; i < list.length; i++) m[list[i].key] = list[i];
    return m;
  }

  /* 抗性按倍率索引。'1' / '1.0' / 1 全都得能查到同一条。 */
  function _resistKey(v) { return String(Number(v)); }
  var RESIST_BY_MULT = {};
  RESIST_TIERS.forEach(function (t) { RESIST_BY_MULT[_resistKey(t.mult)] = t; });

  var BY_KEY = {
    sins: _index(SINS),
    atkTypes: _index(ATK_TYPES),
    defTypes: _index(DEF_TYPES),
    sinners: _index(SINNERS),
    rarity: _index(RARITY),
    egoGrade: _index(EGO_GRADE),
    passCond: _index(PASSIVE_COND),
    passWhere: _index(PASSIVE_WHERE),
    skillKinds: _index(SKILL_KIND_OPTS),
    triggers: _index(TRIGGERS)
  };

  /* 取中文标签。查不到就原样返回 key —— 这样将来数据里冒出新的枚举值，
   * 界面上显示的是原始 token 而不是 undefined，不会静默丢信息。 */
  function label(group, key) {
    if (group === 'resist') {
      var t = RESIST_BY_MULT[_resistKey(key)];
      return t ? t.cn : (key === '' || key === null || key === undefined ? '' : '×' + key);
    }
    var item = BY_KEY[group] && BY_KEY[group][key];
    return item ? item.cn : (key || '');
  }

  function item(group, key) {
    if (group === 'resist') return RESIST_BY_MULT[_resistKey(key)] || null;
    return (BY_KEY[group] && BY_KEY[group][key]) || null;
  }

  function color(group, key) {
    var it = item(group, key);
    return (it && it.color) || '#8A8A8A';
  }

  /* 抗性倍率。设置里可以覆盖整张表，所以永远走这个函数取，别内联常数。 */
  var resistOverride = null;
  function setResistOverride(map) { resistOverride = map || null; }

  function resistMult(v) {
    if (v === null || v === undefined || v === '') return 1;
    if (resistOverride && typeof resistOverride[v] === 'number') return resistOverride[v];
    var n = Number(v);
    return isFinite(n) ? n : 1;
  }

  /* 数据里抗性的各种写法（0 / 0.5 / '1.0' / 1）统一成 '0.5' / '1' / '2' 这种。
   * 灰机的物理抗性用 0 表示 0.5，这一步把那层编码拆掉。 */
  function resistFromMult(v) {
    if (v === null || v === undefined || v === '') return '1';
    var n = Number(v);
    if (!isFinite(n)) return '1';
    if (n === 0) return '0.5';          // 灰机的 0 == ×0.5
    return String(n);
  }

  /* 抗性显示成 `[×2]` / `[×0.5]` / `[×1]` —— 是**倍率本身**。
   *
   * 灰机上的物理抗性格子写的就是 `<b><span style="color:#ff0000">[×2]</span></b>`，
   * 不是「致命 / 耐性」这些档位名（那张表里的档位名是给筛选下拉框用的）。 */
  function resistTag(v) {
    if (v === '' || v === null || v === undefined) return '';
    var n = Number(v);
    return isFinite(n) ? '×' + String(n) : '×' + v;
  }

  /* 抗性 `[×N]` 的颜色。**先查灰机「模板:颜色」**（`×1=#e2c090` 这类条目就是
   * 正文染色的出处），查不到才退回档位表；两者也没有就返回空串，让调用方用正文色，
   * 不在这里编一个色号。 */
  function resistColor(v) {
    var wt = WIKI_COLOR['×' + _resistKey(v)];
    if (wt) return wt;
    var t = RESIST_BY_MULT[_resistKey(v)];
    return t ? t.color : '';
  }

  /* 罪人 key ← 立绘编号首段。灰机的 png1 是 <罪人码><人格序号><变体>，
   * 但宽度不固定（李箱 10101 = 1|01|01，奥提斯 11103 = 11|10|3），
   * 所以只能按「前缀匹配、取最长的那个罪人码」来判。 */
  function sinnerFromCode(code) {
    var s = String(code || '');
    var hit = null;
    for (var i = 0; i < SINNERS.length; i++) {
      var p = String(SINNERS[i].code);
      if (s.indexOf(p) === 0 && (!hit || p.length > String(hit.code).length)) hit = SINNERS[i];
    }
    return hit ? hit.key : null;
  }

  function byCn(list, cn) {
    for (var i = 0; i < list.length; i++) if (list[i].cn === cn) return list[i];
    return null;
  }

  /* 中文标签 → key。灰机的 tabx 里存的是中文，种子里要把它们转成 key。 */
  var CN_LOOKUP = { sin: {}, atk: {}, def: {}, cond: {}, where: {}, grade: {}, rarity: {} };
  SINS.forEach(function (x) { CN_LOOKUP.sin[x.cn] = x.key; });
  ATK_TYPES.forEach(function (x) { CN_LOOKUP.atk[x.cn] = x.key; });
  DEF_TYPES.forEach(function (x) { CN_LOOKUP.def[x.cn] = x.key; });
  PASSIVE_COND.forEach(function (x) { CN_LOOKUP.cond[x.cn] = x.key; });
  PASSIVE_WHERE.forEach(function (x) { CN_LOOKUP.where[x.cn] = x.key; });
  EGO_GRADE.forEach(function (x) { CN_LOOKUP.grade[x.cn] = x.key; });

  // 灰机表里实际出现过的异体写法
  CN_LOOKUP.atk['穿刺'] = 'pierce';          // tabx 里 1 条写成「穿刺」
  CN_LOOKUP.def['反击_斩击'] = 'counter_slash';
  CN_LOOKUP.def['反击_突刺'] = 'counter_pierce';
  CN_LOOKUP.def['反击_打击'] = 'counter_blunt';
  CN_LOOKUP.def['反击'] = 'counter_slash';
  CN_LOOKUP.cond['常时'] = 'always';
  CN_LOOKUP.cond['常驻'] = 'always';
  CN_LOOKUP.cond['共鸣'] = 'resonance';
  CN_LOOKUP.cond['持有'] = 'hold';

  function fromCn(group, cn) {
    if (!cn) return null;
    return (CN_LOOKUP[group] && CN_LOOKUP[group][cn]) || null;
  }

  return {
    SINS: SINS, ATK_TYPES: ATK_TYPES, DEF_TYPES: DEF_TYPES, SINNERS: SINNERS,
    RESIST_TIERS: RESIST_TIERS, RARITY: RARITY, EGO_GRADE: EGO_GRADE,
    STAGES: STAGES, EGO_STAGES: EGO_STAGES,
    PASSIVE_COND: PASSIVE_COND, PASSIVE_WHERE: PASSIVE_WHERE,
    TRIGGERS: TRIGGERS, SKILL_KINDS: SKILL_KINDS, SKILL_KIND_OPTS: SKILL_KIND_OPTS,
    slotLabel: slotLabel, slotSort: slotSort, slotParts: slotParts,
    slotIsDef: slotIsDef, slotOk: slotOk, nextSlot: nextSlot,
    WIKI_COLOR: WIKI_COLOR, triggerColor: triggerColor,
    STATUS_KIND_COLOR: STATUS_KIND_COLOR, SIN_FRAMES: SIN_FRAMES, sinSkin: sinSkin,
    STATUS_UNDERLINE: STATUS_UNDERLINE,
    parseStatus: parseStatus, sinColor: sinColor,
    SKILL_TABS: SKILL_TABS, slotTab: slotTab, slotRank: slotRank,
    groupSkills: groupSkills,
    label: label, item: item, color: color,
    resistMult: resistMult, resistTag: resistTag, resistColor: resistColor,
    setResistOverride: setResistOverride,
    resistFromMult: resistFromMult, sinnerFromCode: sinnerFromCode,
    fromCn: fromCn, byCn: byCn
  };
})();
