/* 字段描述表 —— 表单、卡片、wikitext 导出三处共用的唯一真相。
 *
 * 加一个字段只改这里：表单会自己长出来，wikitext 会自己带上。少写一处描述，
 * 三处就开始各说各话，这是这类编辑器最容易烂掉的地方。
 *
 * 字段描述符（能省则省，默认值在 _norm 里补）：
 *   p    路径，点号分隔，相对条目根。'spd.0' / 'skills.0.name' 都能走
 *   l    中文标签
 *   t    控件类型，见下面 TYPES
 *   e    枚举组名（Enums 里的 key）
 *   n    数组长度 / 上限
 *   w    'full' | 'half' | 'third'，表单里的栅格宽度
 *   ph   占位提示
 *   hint 输入框下面的小字
 *   wiki wikitext 里的参数名。**没写就是不出现在导出里**，这是有意的：
 *        像 id / createdAt 这种内部字段本来就不该被导出
 *   only 'identity' | 'ego'，限定只在某一类里出现
 */
var Schema = (function () {
  'use strict';

  /* ---------------------------------------------------------------- 路径读写 */

  function get(obj, path) {
    if (!path) return undefined;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function set(obj, path, value) {
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (cur[k] === null || cur[k] === undefined || typeof cur[k] !== 'object') {
        cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }

  /* ---------------------------------------------------------------- 通用片段 */

  /* 罪孽资源三连（被动/支援被动共用）。tabx 里也是 aff1/num1 … aff3/num3。 */
  function sinCostFields(prefix, label) {
    return [{ p: prefix + '.cost', l: label || '罪孽资源', t: 'sinCost', w: 'full' }];
  }

  /* 技能里的效果行。硬币序号 + 触发时机 + 文本，可以增删。 */
  var STAGE_FIELD = { p: 'stages', l: '解析阶段', t: 'stages', w: 'full' };

  var SKILL_FIELDS = [
    /* 槽位名就是 wiki 导出的参数前缀（`|1技能-名称=`），改它等于改导出结构，
     * 所以直接给用户编辑，只做格式校验。 */
    { p: 'slot', l: '槽位', t: 'text', w: 'third', ph: '1技能', keep: 'str',
      only: ['atk', 'def'],
      hint: 'wiki 上的技能组名，形如 1技能 / 4技能 / 强化1技能 / 5技能' },
    // 种类决定显示「攻击类型」还是「守备类型」，改它要重建这一块（见 form.js）
    { p: 'kind', l: '技能种类', t: 'select', e: 'skillKinds', w: 'third',
      only: ['atk', 'def'], blank: false },
    { p: 'name', l: '技能名', t: 'text', w: 'third', ph: '例：偏折' },
    { p: 'icon', l: '图标名', t: 'text', w: 'third', ph: '留空则不显示', hideCard: true },
    { p: 'atk', l: '攻击类型', t: 'select', e: 'atkTypes', w: 'third', only: 'atk' },
    { p: 'defType', l: '守备类型', t: 'select', e: 'defTypes', w: 'third', only: 'def' },
    { p: 'sins', l: '罪孽属性', t: 'sins', n: 2, w: 'third' },
    { p: 'coins', l: '硬币数', t: 'number', w: 'third', min: 0, max: 9 },
    { p: 'mod', l: '修正值', t: 'text', w: 'third', ph: '+0', keep: 'str' },
    { p: 'weight', l: '攻击容量', t: 'number', w: 'third', min: 0, max: 9 },
    { p: 'breakthrough', l: '突破', t: 'check', w: 'third', only: ['atk', 'def'],
      hint: 'wiki 上的 |4技能-突破=1' },
    { p: 'blind', l: '无差别攻击', t: 'check', only: ['awaken', 'corrode'],
      hint: '[敌我识别不能]' },
    STAGE_FIELD
  ];

  var PASSIVE_FIELDS = [
    { p: 'name', l: '被动名', t: 'text', w: 'half' },
    { p: 'cond', l: '发动条件', t: 'select', e: 'passCond', w: 'third' },
    { p: 'where', l: '生效位置', t: 'select', e: 'passWhere', w: 'third' },
    { p: 'cost', l: '罪孽资源', t: 'sinCost', w: 'full' },
    { p: 'stages', l: '效果（同步Ⅱ / 同步Ⅳ）', t: 'passStages', w: 'full' }
  ];

  /* ---------------------------------------------------------------- 分区 */

  var SECTIONS = [
    {
      key: 'basic', label: '基本信息', open: true, when: 'both',
      fields: [
        { p: 'name', l: '名称', t: 'text', w: 'full', ph: '例：李箱LCB罪人',
          wiki: '人格名称' },
        { p: 'nameAlt', l: '副标题', t: 'text', w: 'full', ph: '例：LCB Sinner',
          hint: 'wiki 上没有这一栏，是本编辑器加的，方便写原作 / 译名' },
        { p: 'sinner', l: '罪人', t: 'select', e: 'sinners', w: 'third', wiki: '罪人' },
        { p: 'code', l: '编号', t: 'text', w: 'third', keep: 'str', ph: '10101',
          hint: '留前导零，别当数字' },
        { p: 'rarity', l: '稀有度', t: 'select', e: 'rarity', w: 'third', only: 'identity' },
        { p: 'grade', l: '危险等级', t: 'select', e: 'egoGrade', w: 'third', only: 'ego' },
        { p: 'origin', l: '来源', t: 'text', w: 'half', only: 'ego', ph: '例：致智慧与苦难',
          hint: 'E.G.O 的出处，游戏里写在名字下面' },
        { p: 'org', l: '所属组织', t: 'text', w: 'half', only: 'identity' },
        { p: 'tag', l: '特性关键词', t: 'text', w: 'full', ph: '用逗号分隔，例：破裂, 呼吸',
          hint: '逗号 / 顿号 / 分号都能当分隔符；被除名的词条用 ~~ 括起来，会画成灰机那样的红色删除线，例：~~大师~~' },
        { p: 'season', l: '赛季', t: 'text', w: 'third' },
        { p: 'released', l: '实装时间', t: 'text', w: 'third' },
        { p: 'obtain', l: '获取方式', t: 'text', w: 'third' }
      ]
    },
    {
      key: 'stats', label: '能力值', when: 'identity',
      fields: [
        { p: 'hp', l: '体力', t: 'number', w: 'third', min: 0, wiki: '体力' },
        { p: 'hpRate', l: '体力系数', t: 'text', w: 'third', ph: '1.0', keep: 'str' },
        { p: 'defRate', l: '防御修正', t: 'text', w: 'third', ph: '-2', keep: 'str' },
        { p: 'spd', l: '速度（同步Ⅰ~Ⅳ）', t: 'textList', n: 4, w: 'full',
          ph: '4~6', hint: '每阶一格，形如 4~6；留空则该阶不显示' },
        { p: 'stagger', l: '混乱阈值', t: 'textList', n: 3, w: 'full',
          ph: '0.65',
          hint: '从高到低写三档，都是体力比例；游戏里三档含义相同，没有区别' }
      ]
    },
    {
      key: 'egoStats', label: '能力值', when: 'ego',
      fields: [
        { p: 'sp', l: '觉醒消耗理智', t: 'number', w: 'third', wiki: '理智消耗' },
        { p: 'spCorrode', l: '侵蚀消耗理智', t: 'number', w: 'third' },
        { p: 'spOC', l: '超频(OC)消耗理智', t: 'number', w: 'third' },
        { p: 'atk', l: '攻击属性', t: 'select', e: 'atkTypes', w: 'third' },
        { p: 'sins', l: '罪孽属性', t: 'sins', n: 2, w: 'full' }
      ]
    },
    {
      key: 'resist', label: '抗性', when: 'identity',
      fields: [
        { p: 'resist', l: '物理抗性（斩 / 突 / 打）', t: 'resistGrid',
          keys: ['slash', 'pierce', 'blunt'], w: 'full' },
        { p: 'egoRes', l: 'E.G.O 抗性', t: 'text', w: 'full', ph: '1.0 / 1.5 …',
          keep: 'str', hint: '有些人格带这条；留空就不显示' }
      ]
    },
    {
      key: 'egoRes', label: '罪孽抗性与消耗', when: 'ego',
      fields: [
        { p: 'sinsRes', l: '罪孽抗性', t: 'resistGrid',
          keys: ['wrath', 'lust', 'sloth', 'glut', 'gloom', 'pride', 'envy'], w: 'full' },
        { p: 'cost', l: '罪孽消耗', t: 'numGrid',
          keys: ['wrath', 'lust', 'sloth', 'glut', 'gloom', 'pride', 'envy'], w: 'full',
          hint: '每场战斗开 E.G.O 要吃的罪孽资源，0 表示不需要' }
      ]
    },
    {
      key: 'skills', label: '技能', when: 'identity',
      fields: [
        // 技能条数是变长的：灰机人格页上除了 1~3技能(攻击) 和 4技能(守备)，
        // 还有 5/6/7技能 和「强化N技能」形态，实测 4~13 个都有。所以这里是
        // 一条可增删的列表，默认铺四个槽位。
        { p: 'skills', l: '技能', t: 'skillList', w: 'full' }
      ]
    },
    {
      key: 'egoSkills', label: 'E.G.O 技能', when: 'ego',
      fields: [
        { p: 'awaken', l: '觉醒技能', t: 'skill', kind: 'awaken', w: 'full' },
        { p: 'corrode', l: '侵蚀技能', t: 'skill', kind: 'corrode', w: 'full' }
      ]
    },
    {
      key: 'passives', label: '被动', when: 'identity',
      fields: [
        // 战斗被动的条数不是固定的：老人格 1~2 条，新人格能到 6 条（灰机被动表
        // 里实测最多的是奥提斯蜘蛛巢中指父辈，6 条战斗 + 1 条支援）。所以这里是
        // 一个可增删的列表控件，而不是写死两格。
        { p: 'passives', l: '战斗被动', t: 'passiveList', w: 'full' },
        { p: 'support', l: '支援被动', t: 'passive', w: 'full' }
      ]
    },
    {
      key: 'egoPassive', label: '被动', when: 'ego',
      fields: [
        { p: 'passive', l: 'E.G.O 被动', t: 'passive', w: 'full' }
      ]
    }
  ];

  /* ---------------------------------------------------------------- 查询 */

  function sectionsFor(kind) {
    return SECTIONS.filter(function (s) {
      return s.when === 'both' || s.when === kind;
    }).map(function (s) {
      return {
        key: s.key, label: s.label, open: !!s.open,
        fields: s.fields.filter(function (f) {
          return !f.only || f.only === kind;
        })
      };
    });
  }

  /* 技能字段的 only 比分区字段细一层：这里写的是技能 kind（atk/def/awaken/
   * corrode），不是条目 kind。允许数组，因为「无差别攻击」觉醒和侵蚀都有。 */
  function skillFields(kind) {
    return SKILL_FIELDS.filter(function (f) {
      if (!f.only) return true;
      if (Object.prototype.toString.call(f.only) === '[object Array]') {
        return f.only.indexOf(kind) >= 0;
      }
      return f.only === kind;
    });
  }

  function passiveFields() { return PASSIVE_FIELDS.slice(); }

  /* wikitext 导出用：把所有带 wiki 名的字段按「最浅优先」排一遍。
   * 深度决定键前缀 —— 技能里的 'name' 要变成 '技能1-名称'，根上的 'name'
   * 就是 '人格名称'，所以光看字段本身不够，得看它挂在什么容器下。 */
  function wikiFields(kind) {
    var out = [];
    sectionsFor(kind).forEach(function (sec) {
      var prefix = null;
      if (sec.key === 'skills' || sec.key === 'egoSkills') prefix = '%s';
      sec.fields.forEach(function (f) {
        (f.fields || []).forEach(function (sub) {
          if (sub.wiki) out.push({ field: sub, prefix: prefix, parent: f });
        });
        if (f.wiki) out.push({ field: f, prefix: prefix, parent: null });
      });
    });
    return out;
  }

  return {
    get: get, set: set,
    SECTIONS: SECTIONS,
    SKILL_FIELDS: SKILL_FIELDS, PASSIVE_FIELDS: PASSIVE_FIELDS,
    sectionsFor: sectionsFor, skillFields: skillFields,
    passiveFields: passiveFields, wikiFields: wikiFields
  };
})();
