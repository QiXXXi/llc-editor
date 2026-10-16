/* 数据模型 —— 默认值、归一化、版本迁移、校验。
 *
 * 存档里的条目一律是「扁平 + ASCII key」的形状：标量不下沉到子对象里，
 * 枚举存 key 不存中文。理由见 const.js 顶部。
 *
 * 两个容易踩的坑，这里集中处理掉：
 *   1. 编号、稀有度必须当字符串。'0102' 和 '000' 转成数字会把前导零吃掉，
 *      存档一进一出就变形了。
 *   2. 空字符串 ≠ 0。'输入框留空' 要存成 null 再显示成空，不能让
 *      Number('') === 0 把没填的字段悄悄变成 0。
 */
var Model = (function () {
  'use strict';

  /* v2：人格的 skills 从「固定 3 个攻击技能 + 单独的 defense」改成一条变长
   * 列表，每条自带 slot（`1技能` / `强化1技能` / `5技能`…）。v1 的存档靠
   * MIGRATIONS[1] 搬过来。 */
  var SCHEMA_VERSION = 2;

  /* 战斗被动的上限。灰机被动表里最多的是 6 条，留 8 足够，同时挡住
   * 「导入一份畸形 JSON 然后表单里长出 300 个被动」这种事。 */
  var MAX_BATTLE_PASSIVES = 8;

  /* 技能条目的上限。灰机最复杂的人格（辛克莱高级定制::红派 赤红之神）有 13 个，
   * 24 够用且能挡住畸形导入。 */
  var MAX_SKILLS = 24;

  /* 新建人格时的四个默认槽位。4技能 按灰机的约定是守备技能。 */
  var DEFAULT_SLOTS = ['1技能', '2技能', '3技能', '4技能'];

  /* ---------------------------------------------------------------- 基础工具 */

  function deepCopy(v) {
    if (v === null || typeof v !== 'object') return v;
    if (typeof structuredClone === 'function') {
      try { return structuredClone(v); } catch (e) { /* 退回手写深拷贝 */ }
    }
    if (Array.isArray(v)) return v.map(deepCopy);
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = deepCopy(v[k]);
    return out;
  }

  /* crypto.randomUUID 需要安全上下文，file:// 下各浏览器行为不一，不指望它。 */
  function newId(prefix) {
    var t = Date.now().toString(36);
    var r = Math.random().toString(36).slice(2, 8);
    return (prefix || 'c') + '_' + t + r;
  }

  /* 表单里数字框的取值。留空 → null，认不出的输入 → null。 */
  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /* 数值框的显示值。null → ''，别显示 "null"。 */
  function fromNum(v) {
    return (v === null || v === undefined) ? '' : String(v);
  }

  /* 把 "1,2，3、 4" 拆成 ['1','2','3','4']。灰机用中文逗号，用户会用各种分隔符。 */
  function splitList(text) {
    if (!text) return [];
    return String(text).split(/[,，、;；/|]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s !== ''; });
  }

  function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

  /* ---------------------------------------------------------------- 工厂 */

  /* 技能。slot 是灰机人格页上的槽位名（`1技能` / `强化2技能` / `5技能`），
   * kind 是 atk / def / awaken / corrode。
   *
   * slot 的默认守备判定：灰机约定 `4技能` 是守备技能，其余槽位是攻击技能。 */
  function createSkill(slot, kind) {
    slot = slot || '1技能';
    if (!kind) kind = Enums.slotIsDef(slot) ? 'def' : 'atk';
    var stages = [];
    for (var i = 0; i < 4; i++) stages.push({ on: false, power: null, coinPower: null, effects: [] });
    return {
      slot: slot,
      kind: kind,
      name: '',
      icon: '',
      atk: kind === 'def' ? '' : 'slash',
      defType: kind === 'def' ? 'defend' : '',
      sins: [],
      coins: 1,
      mod: '+0',
      weight: 1,
      breakthrough: false,
      stages: stages
    };
  }

  /* E.G.O 技能有四个互不相同的异想解析阶段（Ⅰ / Ⅲ / Ⅳ / Ⅴ，见 Enums.EGO_STAGES）。
   * 比人格技能多的那一格是每阶段的攻击容量 —— E.G.O 的攻击容量会随解析阶段涨。 */
  function createEgoSkill(kind) {
    var s = createSkill('1技能', kind);
    s.stages = [];
    for (var i = 0; i < Enums.EGO_STAGES.length; i++) {
      s.stages.push({ on: false, power: null, coinPower: null, weight: null, effects: [] });
    }
    s.blind = false;      // 是否无差别攻击（[敌我识别不能]）
    return s;
  }

  /* 被动 / 支援被动。cost 是三个罪孽资源格。 */
  function createPassive(where) {
    return {
      name: '',
      where: where || 'battle',
      cond: 'hold',
      cost: { aff1: '', num1: '', aff2: '', num2: '', aff3: '', num3: '' },
      stages: [
        { on: false, text: '' },
        { on: false, text: '' }
      ]
    };
  }

  function _resistMap(keys, def) {
    var m = {};
    for (var i = 0; i < keys.length; i++) m[keys[i]] = def;
    return m;
  }

  function createIdentity() {
    var sk = [];
    for (var i = 0; i < DEFAULT_SLOTS.length; i++) {
      sk.push(createSkill(DEFAULT_SLOTS[i]));
    }
    return {
      id: newId(), kind: 'identity', rev: 1,
      basedOn: null, seedRev: null,
      createdAt: Date.now(), updatedAt: Date.now(),

      name: '', nameAlt: '', sinner: 'yiSang', code: '',
      rarity: '1', season: '', released: '', obtain: '', org: '', tag: '',

      hp: null, hpRate: '', defRate: '',
      spd: ['', '', '', ''],
      stagger: ['', '', ''],
      resist: _resistMap(['slash', 'pierce', 'blunt'], '1'),
      egoRes: '',

      skills: sk,
      passives: [createPassive('battle'), createPassive('battle')],
      support: createPassive('support')
    };
  }

  function createEgo() {
    return {
      id: newId(), kind: 'ego', rev: 1,
      basedOn: null, seedRev: null,
      createdAt: Date.now(), updatedAt: Date.now(),

      name: '', nameAlt: '', sinner: 'yiSang', code: '',
      grade: 'ZAYIN', origin: '', rarity: '0',
      season: '', released: '', obtain: '', tag: '',

      sp: null, spCorrode: null, spOC: null,
      atk: 'slash', sins: [],
      awaken: createEgoSkill('awaken'),
      corrode: createEgoSkill('corrode'),
      sinsRes: _resistMap(
        ['wrath', 'lust', 'sloth', 'glut', 'gloom', 'pride', 'envy'], '1'),
      cost: _resistMap(
        ['wrath', 'lust', 'sloth', 'glut', 'gloom', 'pride', 'envy'], 0),
      passive: createPassive('battle')
    };
  }

  function create(kind) {
    return kind === 'ego' ? createEgo() : createIdentity();
  }

  /* ---------------------------------------------------------------- 归一化 */

  function _str(v, def) {
    if (v === null || v === undefined) return def === undefined ? '' : def;
    if (typeof v === 'object') return def === undefined ? '' : def;
    return String(v);
  }

  function _arr(v, n, fill) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(fill === undefined ? '' : fill);
    if (Array.isArray(v)) {
      for (var j = 0; j < n; j++) {
        if (v[j] !== undefined && v[j] !== null) out[j] = v[j];
      }
    }
    return out;
  }

  function _enum(v, group, def) {
    var s = _str(v, '');
    return Enums.item(group, s) ? s : def;
  }

  /* 抗性值。存的是倍率本身（'0.5' / '1' / '2' …），不是档位名 —— 罪孽抗性会
   * 出现 0.75 这种不落在任何档位上的值，存档位名会把精度丢掉。 */
  function _resistVal(v) {
    var s = _str(v, '');
    if (s === '') return '1';
    return Enums.resistFromMult(s);
  }

  /* 罪孽列表：只留认得出的，去重，最多 n 个。 */
  function _sins(v, max) {
    var out = [];
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) {
        var k = _str(v[i], '');
        if (Enums.item('sins', k) && out.indexOf(k) < 0) out.push(k);
      }
    } else if (typeof v === 'string' && v) {
      var parts = splitList(v);
      for (var j = 0; j < parts.length; j++) {
        var kk = Enums.fromCn('sin', parts[j]) || parts[j];
        if (Enums.item('sins', kk) && out.indexOf(kk) < 0) out.push(kk);
      }
    }
    return max ? out.slice(0, max) : out;
  }

  function _resistMapIn(v, keys, def) {
    var src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out[k] = src[k] === undefined || src[k] === null || src[k] === ''
        ? def : _resistVal(src[k]);
    }
    return out;
  }

  function normalizeEffect(e) {
    // 触发时机存的就是灰机「模板:颜色」里的那个中文 token，不另造 key ——
    // 它同时是 wiki 的输入和卡片的显示文本，中间再插一层对照表纯属自找麻烦。
    var trig = _str(e && e.trigger, '命中时');
    return {
      coin: toNum(e && e.coin),
      trigger: trig === '' ? '命中时' : trig,
      text: _str(e && e.text, '')
    };
  }

  /* kind 没写就按槽位推：4技能 = 守备，其余 = 攻击。E.G.O 技能的 kind 由
   * 调用方写死（awaken / corrode），不走这个推断。 */
  function _skillKind(raw, fallback, slot) {
    var k = _str(raw && raw.kind, '');
    if (Enums.SKILL_KINDS[k]) return k;
    if (fallback) return fallback;
    return Enums.slotIsDef(slot) ? 'def' : 'atk';
  }

  function normalizeSkill(raw, fallbackKind, slot) {
    var rawSlot = _str(raw && raw.slot, slot || '');
    var kind = _skillKind(raw, fallbackKind, rawSlot);
    if (kind !== 'awaken' && kind !== 'corrode' && !Enums.slotOk(rawSlot)) {
      rawSlot = slot || '1技能';               // 认不出的槽位名退回默认，别让导出炸掉
    }
    var def = (kind === 'awaken' || kind === 'corrode')
      ? createEgoSkill(kind) : createSkill(rawSlot, kind);
    if (!raw || typeof raw !== 'object') return def;
    var s = {
      slot: rawSlot,
      kind: kind,
      name: _str(raw.name, ''),
      icon: _str(raw.icon, ''),
      atk: _enum(raw.atk, 'atkTypes', ''),
      defType: kind === 'def' ? _enum(raw.defType, 'defTypes', 'defend') : '',
      sins: _sins(raw.sins, 2),
      coins: toNum(raw.coins),
      mod: _str(raw.mod, '+0'),
      weight: toNum(raw.weight),
      stages: []
    };
    if (kind !== 'awaken' && kind !== 'corrode') s.breakthrough = bool(raw.breakthrough);
    var nStage = def.stages.length;
    for (var i = 0; i < nStage; i++) {
      var rs = (Array.isArray(raw.stages) && raw.stages[i]) ? raw.stages[i] : {};
      var eff = [];
      if (Array.isArray(rs.effects)) {
        for (var j = 0; j < rs.effects.length; j++) eff.push(normalizeEffect(rs.effects[j]));
      }
      var st = {
        // 「有数据就算这一阶开着」。注意判的是 toNum 之后的值：存档里没有的阶
        // 是 power: null 而不是 undefined，写 `!== undefined` 会把每一阶都点亮
        // （wiki 上 3 技能只写了 3/4 阶，导出再导入就会凭空长出 1/2 阶）。
        on: bool(rs.on) || toNum(rs.power) !== null || eff.length > 0,
        power: toNum(rs.power),
        coinPower: toNum(rs.coinPower),
        effects: eff
      };
      // 只有 E.G.O 技能有每阶段的攻击容量
      if (def.stages.length && def.stages[0].hasOwnProperty('weight')) {
        st.weight = toNum(rs.weight);
      }
      s.stages.push(st);
    }
    if (def.stages.length && def.stages[0].hasOwnProperty('blind')) s.blind = bool(raw.blind);
    return s;
  }

  function normalizePassive(raw) {
    var def = createPassive();
    if (!raw || typeof raw !== 'object') return def;
    var cost = (raw.cost && typeof raw.cost === 'object') ? raw.cost : {};
    var out = {
      name: _str(raw.name, ''),
      where: _enum(raw.where, 'passWhere', def.where),
      cond: _enum(raw.cond, 'passCond', 'hold'),
      cost: {},
      stages: []
    };
    for (var i = 1; i <= 3; i++) {
      out.cost['aff' + i] = _enum(cost['aff' + i], 'sins', '');
      out.cost['num' + i] = toNum(cost['num' + i]);
    }
    for (var s = 0; s < 2; s++) {
      var rs = (Array.isArray(raw.stages) && raw.stages[s]) ? raw.stages[s] : {};
      out.stages.push({ on: bool(rs.on), text: _str(rs.text, '') });
    }
    return out;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var kind = raw.kind === 'ego' ? 'ego' : 'identity';
    var item = (kind === 'ego') ? createEgo() : createIdentity();

    // 保留 id：迁移过的条目要还能被「合并导入」认出来
    if (raw.id) item.id = String(raw.id);
    item.rev = toNum(raw.rev) || 1;
    item.basedOn = raw.basedOn ? String(raw.basedOn) : null;
    item.seedRev = raw.seedRev ? String(raw.seedRev) : null;
    item.createdAt = toNum(raw.createdAt) || Date.now();
    item.updatedAt = toNum(raw.updatedAt) || item.createdAt;

    item.name = _str(raw.name, '');
    item.nameAlt = _str(raw.nameAlt, '');
    item.sinner = _enum(raw.sinner, 'sinners', 'yiSang');
    item.code = _str(raw.code, '');
    item.season = _str(raw.season, '');
    item.released = _str(raw.released, '');
    item.obtain = _str(raw.obtain, '');
    item.tag = _str(raw.tag, '');

    if (kind === 'identity') {
      item.rarity = _enum(raw.rarity, 'rarity', '1');
      item.org = _str(raw.org, '');
      item.hp = toNum(raw.hp);
      item.hpRate = _str(raw.hpRate, '');
      item.defRate = _str(raw.defRate, '');
      item.spd = _arr(raw.spd, 4, '').map(function (x) { return _str(x, ''); });
      item.stagger = _arr(raw.stagger, 3, '').map(function (x) { return _str(x, ''); });
      item.resist = _resistMapIn(raw.resist, ['slash', 'pierce', 'blunt'], '1');
      item.egoRes = _str(raw.egoRes, '');
      // 技能条数不固定（灰机 4~13 个都有），所以不能像以前那样强拉成 3 + 1。
      // 只有「一条都没有」才铺上四个默认槽位。
      var rsk = Array.isArray(raw.skills) ? raw.skills : [];
      if (!rsk.length) rsk = DEFAULT_SLOTS.map(function (sl) {
        return { slot: sl };
      });
      item.skills = rsk.slice(0, MAX_SKILLS).map(function (s) {
        return normalizeSkill(s, null, null);
      });
      // 战斗被动的条数不固定（内置数据里 1~6 条都有），所以不能像技能那样
      // 强拉到固定长度 —— 那会把第 3 条以后的被动整个丢掉。
      var rp = Array.isArray(raw.passives) ? raw.passives : [];
      if (!rp.length) rp = [null, null];        // 新建的条目默认给两格
      item.passives = rp.slice(0, MAX_BATTLE_PASSIVES).map(normalizePassive);
      item.passives.forEach(function (p) { p.where = 'battle'; });
      item.support = normalizePassive(raw.support);
      item.support.where = 'support';
    } else {
      item.grade = _enum(raw.grade, 'egoGrade', 'ZAYIN');
      item.origin = _str(raw.origin, '');
      item.rarity = _str(raw.rarity, '0');
      item.sp = toNum(raw.sp);
      item.spCorrode = toNum(raw.spCorrode);
      item.spOC = toNum(raw.spOC);
      item.atk = _enum(raw.atk, 'atkTypes', 'slash');
      item.sins = _sins(raw.sins, 2);
      item.awaken = normalizeSkill(raw.awaken, 'awaken');
      item.corrode = normalizeSkill(raw.corrode, 'corrode');
      item.sinsRes = _resistMapIn(raw.sinsRes,
        ['wrath', 'lust', 'sloth', 'glut', 'gloom', 'pride', 'envy'], '1');
      var keys = ['wrath', 'lust', 'sloth', 'glut', 'gloom', 'pride', 'envy'];
      item.cost = {};
      var rc = (raw.cost && typeof raw.cost === 'object') ? raw.cost : {};
      for (var i = 0; i < keys.length; i++) item.cost[keys[i]] = toNum(rc[keys[i]]) || 0;
      item.passive = normalizePassive(raw.passive);
      item.passive.where = 'battle';
    }
    return item;
  }

  /* ---------------------------------------------------------------- 迁移 */

  /* 老版本存档 → 当前版本。迁移函数作用在「原始对象」上，normalize 在之后跑。 */
  var MIGRATIONS = {
    /* v1 → v2：人格的技能从「skills 数组 3 个 + 单独的 defense」合并成一条
     * 变长列表，每条补上 slot。v1 的技能对象里没有 slot，按老顺序编号：
     * skills[0..2] → 1/2/3技能，defense → 4技能。 */
    1: function (raw) {
      if (raw && raw.kind !== 'ego') {
        var list = [];
        if (Array.isArray(raw.skills)) {
          for (var i = 0; i < raw.skills.length; i++) {
            var s = raw.skills[i];
            if (!s || typeof s !== 'object') continue;
            if (!s.slot) s.slot = (i + 1) + '技能';
            list.push(s);
          }
        }
        if (raw.defense && typeof raw.defense === 'object') {
          if (!raw.defense.slot) raw.defense.slot = '4技能';
          raw.defense.kind = 'def';
          list.push(raw.defense);
        }
        if (list.length) raw.skills = list;
        delete raw.defense;
      }
      raw.schemaVersion = 2;
      return raw;
    }
  };

  function migrate(raw) {
    var v = toNum(raw.schemaVersion) || 1;
    if (v > SCHEMA_VERSION) {
      throw new Error('这个文件来自更新的编辑器版本（v' + v + '），请先更新后再导入。');
    }
    while (v < SCHEMA_VERSION) {
      var fn = MIGRATIONS[v];
      if (!fn) { v = SCHEMA_VERSION; break; }     // 缺迁移函数就跳过，别卡住导入
      raw = fn(raw) || raw;
      v = toNum(raw.schemaVersion) || (v + 1);
    }
    return raw;
  }

  /* ---------------------------------------------------------------- 复制 */

  /* 从任意条目派生一份可编辑的自定义副本。id 一定是新的 —— 复用 id 会让
   * 「合并导入」把两条不相干的条目当成同一条。 */
  function derive(src, asKind) {
    var copy = deepCopy(src);
    var kind = asKind || copy.kind;
    if (kind !== copy.kind) {
      copy = kind === 'ego' ? createEgo() : createIdentity();
      copy.basedOn = src.code || null;
    }
    copy.id = newId();
    copy.kind = kind;
    copy.rev = 1;
    if (!copy.basedOn) copy.basedOn = src.code || null;
    copy.seedRev = src.seedRev || null;
    copy.createdAt = Date.now();
    copy.updatedAt = copy.createdAt;
    return normalize(copy);
  }

  /* ---------------------------------------------------------------- 校验 */

  /* 只提示、不拦截。返回 [{level:'warn'|'info', path, msg}]。
   * 这是个人工具，用户想填个半成品存着是完全合理的。 */
  function validate(item) {
    var out = [];
    function warn(path, msg) { out.push({ level: 'warn', path: path, msg: msg }); }

    if (!item.name) warn('name', '还没填名字');
    if (item.kind === 'identity') {
      if (item.hp === null) warn('hp', '体力没填');
      var any = false;
      for (var i = 0; i < item.skills.length; i++) if (item.skills[i].name) any = true;
      if (!any) warn('skills', '一个技能都还没命名');
      item.skills.forEach(function (s, idx) {
        var who = '「' + (s.name || Enums.slotLabel(s.slot)) + '」';
        if (!Enums.slotOk(s.slot)) {
          warn('skills.' + idx + '.slot', who + '的槽位名 ' + s.slot +
            ' 认不出来，wiki 导出会少一个技能（正确写法形如 1技能 / 强化2技能）');
        }
        if (!s.name) return;
        var pre = '技能' + (idx + 1) + who;
        if (!s.sins.length) warn('skills.' + idx + '.sins', pre + '没选罪孽属性');
        if (s.kind === 'def' ? !s.defType : !s.atk) {
          warn('skills.' + idx + '.' + (s.kind === 'def' ? 'defType' : 'atk'),
            pre + (s.kind === 'def' ? '没选守备类型' : '没选攻击类型'));
        }
        if (s.coins === null || s.coins <= 0) warn('skills.' + idx + '.coins', pre + '硬币数没填');
        if (!s.stages.some(function (st) { return st.on; })) {
          warn('skills.' + idx + '.stages', pre + '没有启用任何一个同步阶段');
        }
      });
    } else {
      if (!item.sp) warn('sp', '觉醒理智值消耗没填');
      if (!item.sins.length) warn('sins', 'E.G.O 没选罪孽属性');
      if (!item.awaken.stages.some(function (s) { return s.on; })) {
        warn('awaken', '觉醒技能没有启用任何解析阶段');
      }
      var total = 0;
      for (var k in item.cost) if (item.cost[k]) total += item.cost[k];
      if (!total) warn('cost', '罪孽消耗全是 0，E.G.O 至少要吃一个资源');
    }
    return out;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_BATTLE_PASSIVES: MAX_BATTLE_PASSIVES,
    MAX_SKILLS: MAX_SKILLS, DEFAULT_SLOTS: DEFAULT_SLOTS,
    deepCopy: deepCopy, newId: newId, toNum: toNum, fromNum: fromNum,
    splitList: splitList, bool: bool,
    create: create, createIdentity: createIdentity, createEgo: createEgo,
    createSkill: createSkill, createEgoSkill: createEgoSkill, createPassive: createPassive,
    normalize: normalize, migrate: migrate, derive: derive, validate: validate,
    normalizeSkill: normalizeSkill, normalizePassive: normalizePassive
  };
})();
