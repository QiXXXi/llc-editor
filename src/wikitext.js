/* wiki 文本导出 —— 两套格式，都从 item 直接生成，不做语法互转。
 *
 *   1. 灰机 wikitext：复刻 limbuscompany.huijiwiki.com 上真实在用的模板
 *      （{{技能链接}} / {{EGO技能链接}} / {{被动链接}} / {{EGO被动链接}}）。
 *      参数名是照着 _ref/huiji/raw/ 里 273 个真实页面反推的，不是猜的：
 *        · 人格技能  1技能-名称 / 1技能-类型 / 1技能-罪孽 / 1技能-3阶技能威力 …
 *        · 守备技能  普通防御/闪避写 |类型=守备 + |4技能-罪孽2=；
 *                   反击写 |类型=攻击 + |4技能-类型=斩击 + |4技能-罪孽=
 *        · E.G.O     {{EGO技能链接}} 的阶段下标是 3/4/5（对应 tabx 的 value3/4/5）
 *      粘到灰机页面上能直接渲染出技能卡。
 *
 *   2. 通用 MediaWiki 表格：{| class="wikitable"，任何 MediaWiki 站都能贴。
 *
 * 存进模型的效果文本是「纯文本 + `**状态**` token」：种子解析时把
 * {{状态2|沉沦|4=负面}} 转成 `**沉沦|负面**`、{{硬币|2}} 转成硬币序号、
 * {{颜色|命中时}} 转成触发时机、<br> 转成换行。导出就是把这条路径倒着走一遍
 * （见 statusToTemplate）。
 */
var WikiText = (function () {
  'use strict';

  /* ---------------------------------------------------------------- 小工具 */

  /* 只有「本层的」竖线会截断模板参数；嵌在 {{...}} / [[...]] 里的不算。
   * 灰机源数据本身就是靠嵌套的 {{硬币|2}}{{颜色|命中时}} 传递竖线的
   * （模板参数是按花括号配对切的），全都转义反而会输出 {{颜色{{!}}命中时}}
   * 这种既多余又依赖 {{!}} 模板存在的东西。 */
  function escPipes(s) {
    var out = '', depth = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), d = s.charAt(i + 1);
      if ((c === '{' && d === '{') || (c === '[' && d === '[')) {
        depth++; out += c + d; i++; continue;
      }
      if ((c === '}' && d === '}') || (c === ']' && d === ']')) {
        if (depth) depth--;
        out += c + d; i++; continue;
      }
      out += (c === '|' && !depth) ? '{{!}}' : c;
    }
    return out;
  }

  function esc(s) {
    // 参数值里的换行要用 <br>，否则整个模板会被截断在第一行
    return escPipes(String(s === null || s === undefined ? '' : s)
      .replace(/\r\n?/g, '\n')
      .replace(/\n/g, '<br>'));
  }

  /* `**…**` token → 灰机模板。token 的语法见 src/const.js 的 parseStatus()，
   * 这里就是倒着走一遍：
   *     **沉沦**                  → {{状态2|沉沦}}
   *     **沉沦|负面**             → {{状态2|沉沦|4=负面}}
   *     **狂信|正面|狂信（我方）** → {{状态2|狂信（我方）|狂信}}
   *     **3技能|@傲慢**           → {{罪孽颜色|傲慢|3技能}}
   * 参数位对回去要注意：模板里第 1 个位置参数是**图标**、第 2 个才是文字名。 */
  function statusToTemplate(body) {
    var p = String(body).split('|');
    var text = p[0] || '';
    var kind = (p[1] || '').trim();
    var icon = (p[2] || '').trim();
    if (kind.charAt(0) === '@') {
      return '{{罪孽颜色|' + kind.slice(1) + '|' + text + '}}';
    }
    if (!icon || icon === text) {
      return kind && kind !== '正面'
        ? '{{状态2|' + text + '|4=' + kind + '}}'
        : '{{状态2|' + text + '}}';
    }
    return '{{状态2|' + icon + '|' + text
      + (kind && kind !== '正面' ? '|4=' + kind : '') + '}}';
  }

  function boldToStatus(s) {
    // 非贪婪，允许文本里出现单个星号
    return String(s || '').replace(/\*\*([^*\n]+)\*\*/g, function (m, body) {
      return statusToTemplate(body);
    });
  }

  /* 通用 MediaWiki 那边未必有 {{状态2}} 这个模板，所以只留显示文字 ——
   * 它才是页面上真正印出来的东西，把 `|负面` 这种内部编码写出去是错的。 */
  function boldToMw(s) {
    return String(s || '').replace(/\*\*([^*\n]+)\*\*/g, function (m, body) {
      return String(body).split('|')[0];
    });
  }

  function effectToWiki(e) {
    var parts = [];
    var trigger = e.trigger && e.trigger !== 'none' ? Enums.label('triggers', e.trigger) : '';
    if (trigger) parts.push('{{颜色|' + trigger + '}}');
    if (e.coin !== null && e.coin !== undefined && e.coin !== '') {
      parts.push('{{硬币|' + e.coin + '}}');
    }
    // 先转义正文再拼模板：拼好了再转义会把 {{颜色|…}} 自己的竖线也一起转掉
    return parts.join('') + esc(boldToStatus(e.text));
  }

  function triggerWiki(key) {
    if (!key || key === 'none') return '';
    return Enums.label('triggers', key);
  }

  /* ---------------------------------------------------------------- 灰机：人格 */

  /* 反击型守备技能的类型词。防御 / 闪避不带类型。 */
  var DEF_ATK_CN = {
    defend: null, evade: null,
    counter_slash: '斩击', counter_pierce: '突刺', counter_blunt: '打击'
  };

  /* 一个技能 → {{技能链接}} 的参数行。prefix 就是槽位名（`1技能` / `强化2技能`），
   * 和灰机页面上的参数前缀一一对应。 */
  function _skillParams(lines, skill) {
    if (!skill) return;
    var prefix = skill.slot;
    // 槽位名认不出来就不导 —— 硬写会污染整个模板块，还不如少一个技能
    if (!prefix || !Enums.slotOk(prefix)) return;
    var hasAny = skill.name || skill.stages.some(function (s) { return s.on; });
    if (!hasAny) return;

    if (skill.icon) lines.push('|' + prefix + '-图标=' + esc(skill.icon));
    if (skill.name) lines.push('|' + prefix + '-名称=' + esc(skill.name));

    if (skill.kind === 'def') {
      var cnt = DEF_ATK_CN[skill.defType];
      if (cnt) {
        // 反击：页面写的是 |4技能-类型=斩击 + |4技能-罪孽=
        lines.push('|' + prefix + '-类型=' + cnt);
        if (skill.sins.length) lines.push('|' + prefix + '-罪孽=' + Enums.label('sins', skill.sins[0]));
      } else {
        // 防御 / 闪避：罪孽写在 -罪孽2 上（灰机页面就是这个写法）
        if (skill.sins.length) lines.push('|' + prefix + '-罪孽2=' + Enums.label('sins', skill.sins[0]));
      }
    } else {
      if (skill.atk) lines.push('|' + prefix + '-类型=' + Enums.label('atkTypes', skill.atk));
      if (skill.sins.length) {
        lines.push('|' + prefix + '-罪孽=' + skill.sins
          .map(function (k) { return Enums.label('sins', k); }).join('、'));
      }
    }

    if (skill.coins !== null && skill.coins !== undefined) {
      lines.push('|' + prefix + '-硬币数=' + skill.coins);
    }
    if (skill.mod) lines.push('|' + prefix + '-修正值=' + esc(skill.mod));
    if (skill.weight !== null && skill.weight !== undefined && skill.weight !== 1) {
      lines.push('|' + prefix + '-攻击容量=' + skill.weight);
    }
    if (skill.breakthrough) lines.push('|' + prefix + '-突破=1');

    for (var i = 0; i < skill.stages.length; i++) {
      var st = skill.stages[i];
      if (!st.on) continue;
      var n = i + 1;
      if (st.power !== null && st.power !== undefined) {
        lines.push('|' + prefix + '-' + n + '阶技能威力=' + st.power);
      }
      if (st.coinPower !== null && st.coinPower !== undefined) {
        var cp = String(st.coinPower);
        lines.push('|' + prefix + '-' + n + '阶硬币威力=' + (cp[0] === '-' ? cp : '+' + cp));
      }
      var eff = st.effects.filter(function (e) { return e.text; })
        .map(effectToWiki).filter(Boolean);
      if (eff.length || st.power !== null) {
        lines.push('|' + prefix + '-' + n + '阶=' + eff.join('<br>'));
      }
    }
  }

  function _passiveBlock(p, typeCn) {
    if (!p || (!p.name && !p.stages.some(function (s) { return s.text; }))) return '';
    var L = ['{{被动链接|', '|类型=' + typeCn];
    if (p.name) L.push('|名称=' + esc(p.name));
    if (p.cond) L.push('|触发=' + Enums.label('passCond', p.cond));
    // 灰机模板只吃一组罪孽资源；多出来的按 罪孽2/数量2 写，认不得的模板会忽略掉
    var slots = [];
    for (var i = 1; i <= 3; i++) {
      var aff = p.cost['aff' + i], num = p.cost['num' + i];
      if (aff && num !== null && num !== undefined && num !== '') {
        slots.push([Enums.label('sins', aff), num]);
      }
    }
    slots.forEach(function (s, k) {
      var suffix = k === 0 ? '' : String(k + 1);
      L.push('|罪孽' + suffix + '=' + s[0]);
      L.push('|数量' + suffix + '=' + s[1]);
    });
    var texts = [];
    for (var j = 0; j < p.stages.length; j++) {
      if (p.stages[j].on && p.stages[j].text) texts.push(p.stages[j].text);
    }
    if (texts.length) L.push('|效果=' + esc(boldToStatus(texts.join('\n'))));
    L.push('}}');
    return L.join('\n');
  }

  function toHuijiIdentity(it) {
    var out = [];
    out.push('<!-- 由「边狱公司 自定义人格 / E.G.O 编辑器」生成，数据参考灰机 wiki（CC BY-SA 4.0） -->');
    out.push('{{技能链接|');
    var lines = [];
    // |类型= 是模板级的参数，描述的是**守备技能**：反击写「攻击」，防御 /
    // 闪避写「守备」。所以取第一个守备技能来定，和灰机页面上的写法一致。
    var defSkill = null;
    for (var d = 0; d < it.skills.length; d++) {
      if (it.skills[d].kind === 'def') { defSkill = it.skills[d]; break; }
    }
    if (defSkill) lines.push('|类型=' + (DEF_ATK_CN[defSkill.defType] ? '攻击' : '守备'));
    for (var i = 0; i < it.skills.length; i++) {
      _skillParams(lines, it.skills[i]);
    }
    if (!lines.length) lines.push('|（还没有填任何技能）');
    out.push(lines.join('\n'));
    out.push('}}');

    var pb = [];
    for (var p = 0; p < it.passives.length; p++) {
      var b = _passiveBlock(it.passives[p], '战斗');
      if (b) pb.push(b);
    }
    var sb = _passiveBlock(it.support, '支援');
    if (sb) pb.push(sb);
    if (pb.length) {
      out.push('');
      out.push('===被动===');
      out.push(pb.join('\n'));
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- 灰机：E.G.O */

  /* E.G.O 模板的参数下标是 1/3/4/5，不是 1/2/3/4。
   * 灰机的「模板:EGO技能链接」里，异想解析阶段Ⅰ 和 Ⅱ 共用同一组参数（基础值1），
   * Ⅲ/Ⅳ/Ⅴ 才各占一组。我们建模的四级正好对上 1/3/4/5。 */
  var EGO_STAGE_N = [1, 3, 4, 5];

  function _egoSkillParams(lines, skill, kindCn) {
    if (!skill) return;
    if (!skill.name && !skill.stages.some(function (s) { return s.on; })) return;
    lines.push('|类型=' + kindCn);
    if (skill.name) lines.push('|名称=' + esc(skill.name));
    if (skill.coins !== null && skill.coins !== undefined) lines.push('|硬币数=' + skill.coins);
    if (skill.mod) lines.push('|修正值=' + esc(skill.mod));
    if (skill.atk) lines.push('|攻击属性=' + Enums.label('atkTypes', skill.atk));
    if (skill.sins.length) {
      lines.push('|罪孽属性=' + skill.sins.map(function (k) {
        return Enums.label('sins', k);
      }).join('、'));
    }
    for (var i = 0; i < skill.stages.length; i++) {
      var st = skill.stages[i];
      if (!st.on) continue;
      var n = EGO_STAGE_N[i] !== undefined ? EGO_STAGE_N[i] : (i + 1);
      if (st.power !== null && st.power !== undefined) lines.push('|基础值' + n + '=' + st.power);
      if (st.coinPower !== null && st.coinPower !== undefined) {
        var cp = String(st.coinPower);
        lines.push('|变动值' + n + '=' + (cp[0] === '-' ? cp : '+' + cp));
      }
      if (st.weight !== null && st.weight !== undefined) {
        lines.push('|攻击容量' + n + '=' + (st.weight || skill.weight || 1));
      }
      var eff = st.effects.filter(function (e) { return e.text; })
        .map(effectToWiki).filter(Boolean);
      if (eff.length) lines.push('|效果' + n + '=' + eff.join('<br>'));
    }
  }

  function toHuijiEgo(it) {
    var out = [];
    out.push('<!-- 由「边狱公司 自定义人格 / E.G.O 编辑器」生成，数据参考灰机 wiki（CC BY-SA 4.0） -->');
    out.push('==升阶属性==');
    out.push('{{EGO技能链接');
    var lines = [];
    if (it.code) lines.push('|图片=' + esc(it.code));
    // 理智值消耗 / 攻击属性 / 罪孽属性 在觉醒块里给一份，侵蚀块只补差异
    var a = it.awaken;
    if (it.sp !== null && it.sp !== undefined) lines.push('|理智值消耗=' + it.sp);
    _egoSkillParams(lines, a, 'E.G.O觉醒');
    if (!lines.length) lines.push('|（还没有填觉醒技能）');
    out.push(lines.join('\n'));
    out.push('}}');

    var hasCorrode = it.corrode.name || it.corrode.stages.some(function (s) { return s.on; });
    if (hasCorrode) {
      out.push('');
      out.push('{{EGO技能链接');
      var cl = [];
      if (it.spCorrode !== null && it.spCorrode !== undefined) cl.push('|理智值消耗=' + it.spCorrode);
      _egoSkillParams(cl, it.corrode, 'E.G.O侵蚀');
      out.push(cl.join('\n'));
      out.push('}}');
    }

    var p = it.passive;
    if (p && (p.name || p.stages.some(function (s) { return s.text; }))) {
      out.push('');
      out.push('==被动==');
      out.push('{{EGO被动链接|');
      if (p.name) out.push('|名称=' + esc(p.name));
      var texts = p.stages.filter(function (s) { return s.on && s.text; })
        .map(function (s) { return s.text; });
      if (texts.length) out.push('|效果=' + esc(boldToStatus(texts.join('\n'))));
      out.push('}}');
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- 通用表格 */

  /* 任何 MediaWiki 都能贴的版本。字段遍历 schema，新加字段自动出现。 */
  function _row(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return '|-\n! ' + label + '\n| ' + esc(value) + '\n';
  }

  function _skillTable(it, skill, title) {
    if (!skill) return '';
    if (!skill.name && !skill.stages.some(function (s) { return s.on; })) return '';
    var rows = '';
    rows += _row('名称', skill.name);
    if (skill.kind === 'def') rows += _row('守备类型', Enums.label('defTypes', skill.defType));
    else rows += _row('攻击类型', Enums.label('atkTypes', skill.atk));
    rows += _row('罪孽属性', skill.sins.map(function (k) { return Enums.label('sins', k); }).join('、'));
    rows += _row('硬币数', skill.coins);
    rows += _row('修正值', skill.mod);
    rows += _row('攻击容量', skill.weight);
    if (skill.breakthrough) rows += _row('突破', '是');
    var stag = '';
    for (var i = 0; i < skill.stages.length; i++) {
      var st = skill.stages[i];
      if (!st.on) continue;
      var name = (skill.kind === 'awaken' || skill.kind === 'corrode')
        ? Enums.EGO_STAGES[i] : Enums.STAGES[i];
      var bits = [];
      if (st.power !== null && st.power !== undefined) bits.push('威力 ' + st.power);
      if (st.coinPower !== null && st.coinPower !== undefined) bits.push('硬币 ' + st.coinPower);
      var effTxt = st.effects.filter(function (e) { return e.text; }).map(function (e) {
        var t = triggerWiki(e.trigger);
        return (e.coin ? '硬币' + e.coin + ' ' : '') + (t ? '[' + t + '] ' : '') +
          boldToMw(e.text);
      }).join('\n');
      stag += '|-\n! ' + name + '\n| ' + esc(bits.join(' / ')) + '\n' +
        (effTxt ? '| ' + esc(effTxt) + '\n' : '');
    }
    // 阶段行是三列（阶 / 数值 / 效果），表头得跨满三列才对得齐
    if (stag) stag = '|-\n! colspan="3" | 阶段\n' + stag;
    if (!rows && !stag) return '';
    return '=== ' + title + ' ===\n{| class="wikitable" style="width:100%"\n' +
      rows + stag + '|}\n';
  }

  function toMediaWiki(it) {
    var isEgo = it.kind === 'ego';
    var out = [];
    out.push('<!-- 由「边狱公司 自定义人格 / E.G.O 编辑器」生成 -->');
    out.push('== ' + (it.name || '未命名') + ' ==');
    out.push('{| class="wikitable" style="width:100%"');

    var rows = '';
    rows += _row('名称', it.name);
    if (it.nameAlt) rows += _row('副标题', it.nameAlt);
    rows += _row('罪人', Enums.label('sinners', it.sinner));
    rows += _row('编号', it.code);
    if (isEgo) {
      rows += _row('危险等级', Enums.label('egoGrade', it.grade));
      rows += _row('来源', it.origin);
      rows += _row('觉醒理智消耗', it.sp);
      rows += _row('侵蚀理智消耗', it.spCorrode);
      rows += _row('超频理智消耗', it.spOC);
      rows += _row('攻击属性', Enums.label('atkTypes', it.atk));
      rows += _row('罪孽属性', it.sins.map(function (k) { return Enums.label('sins', k); }).join('、'));
    } else {
      var rar = Enums.item('rarity', it.rarity);
      rows += _row('稀有度', rar ? rar.cn : it.rarity);
      rows += _row('所属组织', it.org);
      rows += _row('体力', it.hp);
      rows += _row('体力系数', it.hpRate);
      rows += _row('防御修正', it.defRate);
      rows += _row('同步速度', it.spd.filter(Boolean).join(' / '));
      rows += _row('混乱阈值', it.stagger.filter(function (s) { return s !== ''; }).join(' / '));
      rows += _row('物理抗性', Enums.ATK_TYPES.map(function (a) {
        return a.cn + ' ×' + Enums.resistMult(it.resist[a.key]);
      }).join('  '));
      if (it.egoRes) rows += _row('E.G.O 抗性', it.egoRes);
    }
    rows += _row('特性关键词', it.tag);
    rows += _row('赛季', it.season);
    rows += _row('实装时间', it.released);
    rows += _row('获取方式', it.obtain);
    out.push(rows);

    if (isEgo) {
      var resRow = '|-\n! 罪孽抗性\n|';
      resRow += Enums.SINS.map(function (s) {
        return s.cn + ' ×' + Enums.resistMult(it.sinsRes[s.key]);
      }).join('  ');
      out.push(resRow);
      var costBits = Enums.SINS.filter(function (s) { return it.cost[s.key]; })
        .map(function (s) { return s.cn + ' ×' + it.cost[s.key]; });
      out.push('|-\n! 罪孽消耗\n| ' + (costBits.length ? costBits.join('、') : '无'));
    }
    out.push('|}');

    if (isEgo) {
      out.push('');
      out.push(_skillTable(it, it.awaken, '觉醒技能'));
      out.push(_skillTable(it, it.corrode, '侵蚀技能'));
    } else {
      for (var i = 0; i < it.skills.length; i++) {
        var sk = it.skills[i];
        out.push(_skillTable(it, sk, Enums.slotLabel(sk.slot) +
          (sk.name ? '　' + sk.name : '')));
      }
    }

    var passives = [];
    if (isEgo) passives.push([it.passive, '被动']);
    else {
      for (var p = 0; p < it.passives.length; p++) passives.push([it.passives[p], '战斗被动 ' + (p + 1)]);
      passives.push([it.support, '支援被动']);
    }
    var pt = '';
    passives.forEach(function (pair) {
      var pv = pair[0], title = pair[1];
      if (!pv || (!pv.name && !pv.stages.some(function (s) { return s.text; }))) return;
      pt += '=== ' + title + ' ===\n{| class="wikitable" style="width:100%"\n';
      pt += _row('名称', pv.name);
      pt += _row('触发', Enums.label('passCond', pv.cond));
      var cs = [];
      for (var i = 1; i <= 3; i++) {
        if (pv.cost['aff' + i] && pv.cost['num' + i]) {
          cs.push(Enums.label('sins', pv.cost['aff' + i]) + ' ×' + pv.cost['num' + i]);
        }
      }
      if (cs.length) pt += _row('罪孽资源', cs.join('、'));
      for (var s = 0; s < pv.stages.length; s++) {
        if (pv.stages[s].on && pv.stages[s].text) {
          pt += _row(s === 0 ? '效果' : '效果（同步Ⅳ）', boldToMw(pv.stages[s].text));
        }
      }
      pt += '|}\n';
    });
    if (pt) { out.push(''); out.push(pt.replace(/\n$/, '')); }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- 出口 */

  function toHuiji(it) {
    return it.kind === 'ego' ? toHuijiEgo(it) : toHuijiIdentity(it);
  }

  var FORMATS = [
    { key: 'huiji', cn: '灰机 wikitext', ext: '.txt', fn: toHuiji,
      hint: '粘到灰机（huijiwiki）页面可直接渲染' },
    { key: 'mediawiki', cn: '通用 MediaWiki 表格', ext: '.wiki', fn: toMediaWiki,
      hint: '任何 MediaWiki 站都能贴' }
  ];

  function format(key) {
    for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].key === key) return FORMATS[i];
    return FORMATS[0];
  }

  return {
    toHuiji: toHuiji, toMediaWiki: toMediaWiki,
    toHuijiIdentity: toHuijiIdentity, toHuijiEgo: toHuijiEgo,
    FORMATS: FORMATS, format: format
  };
})();
