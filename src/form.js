/* 表单 —— 从 Schema 生成，不手写 HTML。
 *
 * 三条规矩，都是为了中文输入法不炸：
 *   1. 输入时只改 model，然后 rAF 排一次卡片重绘。**绝不重建 DOM**。
 *      contenteditable/input 被替换掉的那一瞬间，输入法的候选窗就没了。
 *   2. 只有结构性变更（增删硬币效果行、切换条目）才重建，重建前记住
 *      document.activeElement 的 data-path 和选区，重建后还原。
 *   3. compositionstart/end 期间到来的 input 事件一律丢弃
 *      （e.isComposing 在现代浏览器上够用，但老 Edge 会漏，所以自己也记个标志）。
 */
var Form = (function () {
  'use strict';

  var ROOT = null;
  var ITEM = null;
  var KIND = 'identity';
  var onChange = null;
  var onStructure = null;

  var composing = false;
  var rebuilding = false;      // 正在换掉 DOM，这期间的事件一律不认
  var pendingPath = null;      // 重建后要还原焦点的路径
  var openState = {};          // 分区折叠状态，跨条目保留

  /* ---------------------------------------------------------------- 转义 */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function attr(s) { return esc(s); }

  /* ---------------------------------------------------------------- 控件 */

  /* 枚举组 → 选项列表。抗性特殊：它的「值」是倍率数字，标签才是档位名，
   * 所以不能走通用的 key/cn 那套。 */
  var GROUPS = {
    sins: function () { return Enums.SINS; },
    atkTypes: function () { return Enums.ATK_TYPES; },
    defTypes: function () { return Enums.DEF_TYPES; },
    sinners: function () { return Enums.SINNERS; },
    rarity: function () { return Enums.RARITY; },
    egoGrade: function () { return Enums.EGO_GRADE; },
    passCond: function () { return Enums.PASSIVE_COND; },
    passWhere: function () { return Enums.PASSIVE_WHERE; },
    skillKinds: function () { return Enums.SKILL_KIND_OPTS; },
    triggers: function () { return Enums.TRIGGERS; },
    resist: function () {
      return Enums.RESIST_TIERS.map(function (t) {
        return { key: String(t.mult), cn: t.cn + '（×' + t.mult + '）' };
      });
    }
  };

  function _options(group) { return (GROUPS[group] || function () { return []; })(); }

  function _opts(group, value, blank) {
    var list = _options(group);
    // blank=false 表示「不给空选项」。不特判的话会印出一个写着 false 的选项
    // （'技能种类' 就是这么干的，那一格的种类必须选，空值没法渲染）。
    var html = (blank === null || blank === undefined || blank === false)
      ? '' : '<option value="">' + esc(blank) + '</option>';
    var cur = value === null || value === undefined ? '' : String(value);
    var openGroup = null;
    list.forEach(function (o) {
      // 触发时机有 68 个，按「常用 / 其他」分组，不然一屏全是选项
      if (o.group && o.group !== openGroup) {
        if (openGroup !== null) html += '</optgroup>';
        html += '<optgroup label="' + attr(o.group) + '">';
        openGroup = o.group;
      } else if (!o.group && openGroup !== null) {
        html += '</optgroup>';
        openGroup = null;
      }
      html += '<option value="' + attr(o.key) + '"' +
        (String(o.key) === cur ? ' selected' : '') + '>' + esc(o.cn) + '</option>';
    });
    if (openGroup !== null) html += '</optgroup>';
    return html;
  }

  function _wrap(f, inner) {
    var w = f.w || 'half';
    return '<div class="field w-' + w + '" data-field="' + attr(f.p) + '">' +
      '<label>' + esc(f.l) + '</label>' + inner +
      (f.hint ? '<p class="hint">' + esc(f.hint) + '</p>' : '') +
      '</div>';
  }

  function _control(f, path, value, kind) {
    var d = 'data-path="' + attr(path) + '"';
    switch (f.t) {
      case 'text':
        return _wrap(f, '<input type="text" ' + d + ' data-type="text" value="' +
          attr(value === null || value === undefined ? '' : value) + '"' +
          (f.ph ? ' placeholder="' + attr(f.ph) + '"' : '') + '>');

      case 'number':
        return _wrap(f, '<input type="number" ' + d + ' data-type="number" value="' +
          attr(Model.fromNum(value)) + '"' +
          (f.min !== undefined ? ' min="' + f.min + '"' : '') +
          (f.max !== undefined ? ' max="' + f.max + '"' : '') + '>');

      case 'check':
        return _wrap(f, '<label class="chk"><input type="checkbox" ' + d +
          ' data-type="check"' + (value ? ' checked' : '') + '><span>' +
          esc(f.hint || '启用') + '</span></label>');

      case 'select':
        return _wrap(f, '<select ' + d + ' data-type="select">' +
          _opts(f.e, value, f.blank === undefined ? '（未设定）' : f.blank) + '</select>');

      case 'textarea':
        return _wrap(f, '<textarea ' + d + ' data-type="text" rows="' +
          (f.rows || 3) + '"' + (f.ph ? ' placeholder="' + attr(f.ph) + '"' : '') +
          '>' + esc(value) + '</textarea>');

      case 'sins':
        return _wrap(f, _sinToggles(path, value || [], f.n || 2));

      case 'textList': {
        var arr = Array.isArray(value) ? value : [];
        var inner = '<div class="inline-list">';
        for (var i = 0; i < (f.n || 4); i++) {
          inner += '<input type="text" data-path="' + attr(path + '.' + i) +
            '" data-type="text" value="' + attr(arr[i] === undefined ? '' : arr[i]) + '"' +
            (f.ph ? ' placeholder="' + attr(f.ph) + '"' : '') + '>';
        }
        return _wrap(f, inner + '</div>');
      }

      case 'resistGrid':
        return _wrap(f, _resistGrid(path, value || {}, f.keys));

      case 'numGrid':
        return _wrap(f, _numGrid(path, value || {}, f.keys));

      case 'sinCost':
        return _wrap(f, _sinCost(path, value || {}));

      case 'stages':
        return '<div class="field w-full" data-field="' + attr(path) + '">' +
          '<label>' + esc(f.l) + '</label>' + _stages(path, value || [], kind) + '</div>';

      case 'passStages':
        return '<div class="field w-full" data-field="' + attr(path) + '">' +
          '<label>' + esc(f.l) + '</label>' + _passStages(path, value || []) + '</div>';

      case 'skill':
        return '<div class="field w-full sub" data-field="' + attr(path) + '">' +
          _skillBlock(path, value, f.kind) + '</div>';

      case 'skillList':
        return '<div class="field w-full sub" data-field="' + attr(path) + '">' +
          _skillList(path, value || []) + '</div>';

      case 'passive':
        return '<div class="field w-full sub" data-field="' + attr(path) + '">' +
          _passiveBlock(path, value, f.l) + '</div>';

      case 'passiveList':
        return '<div class="field w-full sub" data-field="' + attr(path) + '">' +
          _passiveList(path, value || [], f.l) + '</div>';

      default:
        return _wrap(f, '<em class="bad">未知控件 ' + esc(f.t) + '</em>');
    }
  }

  /* 罪孽多选：7 个按钮，点一下开/关，最多 n 个。 */
  function _sinToggles(path, cur, max) {
    var html = '<div class="sin-toggles" data-max="' + max + '">';
    Enums.SINS.forEach(function (s) {
      var on = cur.indexOf(s.key) >= 0;
      html += '<button type="button" data-path="' + attr(path) + '" data-type="sins" ' +
        'data-value="' + attr(s.key) + '" class="sin-t' + (on ? ' on' : '') +
        '" style="--sin:' + attr(s.color) + '">' + esc(s.cn) + '</button>';
    });
    html += '</div><p class="hint">最多 ' + max + ' 个</p>';
    return html;
  }

  function _resistGrid(path, cur, keys) {
    var html = '<div class="resist-grid">';
    keys.forEach(function (k) {
      var info = Enums.item('sins', k) || Enums.item('atkTypes', k);
      var cn = info ? info.cn : k;
      var val = cur[k] === undefined || cur[k] === null || cur[k] === '' ? '1' : cur[k];
      html += '<div class="rg-cell">' +
        '<span class="rg-label"' + (info && info.color ? ' style="--c:' + attr(info.color) + '"' : '') +
        '>' + esc(cn) + '</span>' +
        '<select data-path="' + attr(path + '.' + k) + '" data-type="select">' +
        _opts('resist', val) + '</select></div>';
    });
    return html + '</div>';
  }

  function _numGrid(path, cur, keys) {
    var html = '<div class="resist-grid">';
    keys.forEach(function (k) {
      var info = Enums.item('sins', k);
      var v = cur[k];
      html += '<div class="rg-cell">' +
        '<span class="rg-label" style="--c:' + attr(info ? info.color : '#888') + '">' +
        esc(info ? info.cn : k) + '</span>' +
        '<input type="number" min="0" data-path="' + attr(path + '.' + k) +
        '" data-type="number" value="' + attr(Model.fromNum(v)) + '">' +
        '</div>';
    });
    return html + '</div>';
  }

  function _sinCost(path, cost) {
    var html = '<div class="sin-cost">';
    for (var i = 1; i <= 3; i++) {
      html += '<div class="sc-row">' +
        '<select data-path="' + attr(path + '.aff' + i) + '" data-type="select">' +
        _opts('sins', cost['aff' + i], '（无）') + '</select>' +
        '<input type="number" min="0" data-path="' + attr(path + '.num' + i) +
        '" data-type="number" value="' + attr(Model.fromNum(cost['num' + i])) + '">' +
        '</div>';
    }
    return html + '<p class="hint">开 E.G.O / 触发被动要吃的罪孽资源，没有就留空</p></div>';
  }

  /* 阶段编辑器：启用 + 威力 + 硬币威力 + 效果行（硬币序号 / 触发 / 文本）。
   * startIdx 让「只重建一个阶段」也能算对下标（否则路径会退化成 .0）。 */
  function _stages(path, stages, kind, startIdx) {
    var html = '<div class="stages">';
    var labels = (kind === 'awaken' || kind === 'corrode')
      ? Enums.EGO_STAGES : Enums.STAGES;
    var base = startIdx || 0;
    for (var i = 0; i < stages.length; i++) {
      var st = stages[i];
      var n = base + i;
      var sp = path + '.' + n;
      html += '<div class="stage' + (st.on ? ' on' : '') + '" data-stage="' + sp + '">' +
        '<div class="stage-h">' +
        '<label class="chk"><input type="checkbox" data-path="' + attr(sp + '.on') +
        '" data-type="check"' + (st.on ? ' checked' : '') + '><span class="stage-n">' +
        esc(labels[n] || String(n + 1)) + ' 阶</span></label>' +
        '<span class="stage-nums">' +
        '<label>威力<input type="number" data-path="' + attr(sp + '.power') +
        '" data-type="number" value="' + attr(Model.fromNum(st.power)) + '"></label>' +
        '<label>硬币威力<input type="number" data-path="' + attr(sp + '.coinPower') +
        '" data-type="number" value="' + attr(Model.fromNum(st.coinPower)) + '"></label>' +
        (kind === 'awaken' || kind === 'corrode'
          ? '<label>攻击容量<input type="number" min="0" data-path="' + attr(sp + '.weight') +
            '" data-type="number" value="' + attr(Model.fromNum(st.weight)) + '"></label>'
          : '') +
        '</span></div>' +
        '<div class="effects">';
      for (var j = 0; j < st.effects.length; j++) {
        html += _effectRow(sp, j, st.effects[j], st.effects.length);
      }
      html += '</div>' +
        '<button type="button" class="mini add" data-act="addEffect" data-path="' +
        attr(sp) + '">+ 效果行</button>' +
        '</div>';
    }
    return html + '</div>';
  }

  /* 效果行的路径由「阶段路径 + 效果下标」两段拼出来，不存完整路径 ——
   * 存了完整路径的话，删掉一行之后所有后续行的 data-path 全得重算。 */
  function _effectRow(stagePath, idx, eff, total) {
    var ep = stagePath + '.effects.' + idx;
    return '<div class="eff-row" data-eff="' + attr(ep) + '">' +
      '<select data-path="' + attr(ep + '.coin') + '" data-type="number" title="硬币序号">' +
      '<option value="">—</option>' + _coinOpts(eff.coin) + '</select>' +
      '<select data-path="' + attr(ep + '.trigger') + '" data-type="select" title="触发时机">' +
      _opts('triggers', eff.trigger) + '</select>' +
      '<input type="text" data-path="' + attr(ep + '.text') + '" data-type="text" ' +
      'value="' + attr(eff.text) + '" placeholder="效果文本，可以用 **加粗** 标出状态名">' +
      '<button type="button" class="mini del" data-act="delEffect" data-path="' +
      attr(stagePath) + '" data-idx="' + idx + '" title="删除这一行"' +
      (total <= 1 ? ' disabled' : '') + '>×</button>' +
      '</div>';
  }

  function _coinOpts(cur) {
    var html = '';
    for (var i = 1; i <= 9; i++) {
      html += '<option value="' + i + '"' + (Number(cur) === i ? ' selected' : '') + '>' + i + '</option>';
    }
    return html;
  }

  function _passStages(path, stages) {
    var labels = ['同步Ⅱ 效果（可留空）', '同步Ⅳ 效果'];
    var html = '<div class="stages">';
    for (var i = 0; i < stages.length; i++) {
      var sp = path + '.' + i;
      html += '<div class="stage' + (stages[i].on ? ' on' : '') + '">' +
        '<div class="stage-h"><label class="chk">' +
        '<input type="checkbox" data-path="' + attr(sp + '.on') + '" data-type="check"' +
        (stages[i].on ? ' checked' : '') + '><span class="stage-n">' + esc(labels[i]) + '</span>' +
        '</label></div>' +
        '<textarea rows="3" data-path="' + attr(sp + '.text') + '" data-type="text" ' +
        'placeholder="效果文本，换行会保留">' + esc(stages[i].text) + '</textarea>' +
        '</div>';
    }
    return html + '</div>';
  }

  function _skillBlock(path, skill, kind) {
    if (!skill) return '';
    var fields = Schema.skillFields(kind);
    var label = Enums.SKILL_KINDS[kind] ? Enums.SKILL_KINDS[kind].cn : kind;
    // 人格技能多带一个槽位名（`强化1技能`），那是导出时的参数前缀，比「技能 3」
    // 这种按位置编的号靠谱得多，所以摆在标题上。
    if (skill.kind !== 'awaken' && skill.kind !== 'corrode') label = Enums.slotLabel(skill.slot);
    var head = '<div class="sub-h">' + esc(label) +
      '：<strong>' + esc(skill.name || '（未命名）') + '</strong></div>';
    var html = head + '<div class="grid">';
    fields.forEach(function (f) {
      html += _control(f, path + '.' + f.p, Schema.get(skill, f.p), kind);
    });
    return html + '</div>';
  }

  /* ---------------------------------------------------------- 技能列表
   *
   * 技能条数是变长的，所以和战斗被动一样做成可增删的列表：每块自己包一层
   * .skill-item，增删时只重建这一块，不碰整张表单（否则输入焦点和展开状态
   * 全得重来）。 */
  function _skillList(listPath, list) {
    var html = '<label>技能（' + list.length + ' 个）</label>';
    for (var i = 0; i < list.length; i++) {
      var sk = list[i];
      html += '<div class="skill-item" data-skill="' + attr(listPath + '.' + i) + '">' +
        _skillOps(listPath, i, list.length) +
        _skillBlock(listPath + '.' + i, sk, sk.kind || 'atk') +
        '</div>';
    }
    if (list.length < Model.MAX_SKILLS) {
      html += '<button type="button" class="btn-add" data-act="addSkill" ' +
        'data-path="' + attr(listPath) + '">＋ 添加技能</button>';
    }
    return html;
  }

  /* 技能块右上角那三个小按钮：上移 / 下移 / 删除。 */
  function _skillOps(listPath, i, total) {
    function btn(act, glyph, title, disabled) {
      return '<button type="button" class="mini" data-act="' + act + '" data-path="' +
        attr(listPath) + '" data-idx="' + i + '" title="' + attr(title) + '"' +
        (disabled ? ' disabled' : '') + '>' + glyph + '</button>';
    }
    return '<div class="skill-ops">' +
      btn('moveSkillUp', '↑', '上移', i === 0) +
      btn('moveSkillDown', '↓', '下移', i === total - 1) +
      btn('delSkill', '✕', '删除这个技能', total <= 1) +
      '</div>';
  }

  /* 技能增删移 —— 结构性变更，只重建技能列表这一块。 */
  function _skillStruct(listPath, act, idx) {
    if (!ITEM || !listPath) return;
    var list = Schema.get(ITEM, listPath);
    if (!Array.isArray(list)) return;

    if (act === 'addSkill') {
      if (list.length >= Model.MAX_SKILLS) return;
      var slot = Enums.nextSlot(list);
      list.push(Model.createSkill(slot));
      pendingPath = listPath + '.' + (list.length - 1) + '.name';
    } else if (act === 'delSkill') {
      if (list.length <= 1) return;
      list.splice(idx, 1);
      pendingPath = listPath + '.' + Math.min(idx, list.length - 1) + '.name';
    } else {
      var to = idx + (act === 'moveSkillUp' ? -1 : 1);
      if (to < 0 || to >= list.length) return;
      var tmp = list[idx];
      list[idx] = list[to];
      list[to] = tmp;
      pendingPath = listPath + '.' + to + '.name';
    }

    var host = ROOT && ROOT.querySelector('.field[data-field="' + _cssEsc(listPath) + '"]');
    if (host) {
      var holder = document.createElement('div');
      holder.innerHTML = '<div class="field w-full sub" data-field="' + attr(listPath) + '">' +
        _skillList(listPath, list) + '</div>';
      host.replaceWith(holder.firstChild);
    }
    _restoreFocus();
    if (onStructure) onStructure();
  }

  function _passiveBlock(path, p, label, del) {
    if (!p) return '';
    var head = '<div class="sub-h">' + esc(label) + '：<strong>' +
      esc(p.name || '（未命名）') + '</strong>';
    if (del) {
      head += '<button type="button" class="sub-del" title="删除这条被动" ' +
        'data-act="delPassive" data-path="' + attr(del.list) + '" ' +
        'data-idx="' + del.idx + '">✕</button>';
    }
    head += '</div>';
    var html = head + '<div class="grid">';
    Schema.passiveFields().forEach(function (f) {
      html += _control(f, path + '.' + f.p, Schema.get(p, f.p), 'passive');
    });
    return html + '</div>';
  }

  /* 战斗被动的列表：条数按 model 里的实际长度走，可以增删。
   * 每一块自己包一层 .passive-item，增删时只重建这一块，不碰整张表单。 */
  function _passiveList(listPath, list, label) {
    var html = '<label>' + esc(label) + '（' + list.length + ' 条）</label>';
    for (var i = 0; i < list.length; i++) {
      html += '<div class="passive-item" data-passive="' + attr(listPath + '.' + i) + '">' +
        _passiveBlock(listPath + '.' + i, list[i], label + ' ' + (i + 1),
          list.length > 1 ? { list: listPath, idx: i } : null) +
        '</div>';
    }
    if (list.length < Model.MAX_BATTLE_PASSIVES) {
      html += '<button type="button" class="btn-add" data-act="addPassive" ' +
        'data-path="' + attr(listPath) + '">＋ 添加战斗被动</button>';
    }
    return html;
  }

  /* 被动增删 —— 结构性变更，重建整个列表块并还原焦点。 */
  function _passiveStruct(listPath, act, idx) {
    if (!ITEM || !listPath) return;
    var list = Schema.get(ITEM, listPath);
    if (!Array.isArray(list)) return;

    if (act === 'addPassive') {
      if (list.length >= Model.MAX_BATTLE_PASSIVES) return;
      list.push(Model.createPassive('battle'));
      pendingPath = listPath + '.' + (list.length - 1) + '.name';
    } else {
      if (list.length <= 1) return;              // 至少留一条
      list.splice(idx, 1);
      pendingPath = listPath + '.' + Math.min(idx, list.length - 1) + '.name';
    }

    var host = ROOT && ROOT.querySelector('.field[data-field="' + _cssEsc(listPath) + '"]');
    if (host) {
      // 整块（包括 .field 外壳）一起重建 —— 只还内层内容的话，replaceWith 会把
      // 外壳一起吃掉，下一次就找不到 .field[data-field] 了
      var holder = document.createElement('div');
      holder.innerHTML = '<div class="field w-full sub" data-field="' + attr(listPath) + '">' +
        _passiveList(listPath, list, '战斗被动') + '</div>';
      host.replaceWith(holder.firstChild);
    }
    _restoreFocus();
    if (onStructure) onStructure();
  }

  /* ---------------------------------------------------------------- 组装 */

  function html(item) {
    KIND = item.kind;
    var secs = Schema.sectionsFor(KIND);
    var out = '<div class="sections">';
    secs.forEach(function (sec, idx) {
      var open = openState[sec.key];
      if (open === undefined) open = !!sec.open || idx === 0;
      out += '<section class="sec' + (open ? ' open' : '') + '" data-sec="' + attr(sec.key) + '">';
      out += '<header class="sec-h" data-act="toggleSec" data-sec="' + attr(sec.key) + '">' +
        '<span class="caret">▸</span><h3>' + esc(sec.label) + '</h3></header>';
      out += '<div class="sec-b"><div class="grid">';
      sec.fields.forEach(function (f) {
        out += _control(f, f.p, Schema.get(item, f.p), KIND);
      });
      out += '</div></div></section>';
    });
    out += '</div>';
    return out;
  }

  /* ---------------------------------------------------------------- 取值 */

  function _readInto(item, el) {
    var path = el.getAttribute('data-path');
    var type = el.getAttribute('data-type');
    if (!path) return false;

    if (type === 'check') {
      Schema.set(item, path, el.checked);
      return true;
    }
    if (type === 'number') {
      Schema.set(item, path, Model.toNum(el.value));
      return true;
    }
    if (type === 'select') {
      // 罪孽 / 触发时机这类枚举一律按字符串存，中文标签只在 const.js 里
      Schema.set(item, path, el.value);
      return true;
    }
    // 一律当字符串。编号 / 修正值 / 体力系数都要保住前导零和 "+" 号。
    Schema.set(item, path, el.value);
    return true;
  }

  /* 罪孽多选：改完后要重画那一排按钮（因为它有选中态） */
  function _toggleSin(el) {
    if (!ITEM) return;
    var path = el.getAttribute('data-path');
    var val = el.getAttribute('data-value');
    var cur = Schema.get(ITEM, path) || [];
    cur = Array.isArray(cur) ? cur.slice() : [];
    var i = cur.indexOf(val);
    if (i >= 0) cur.splice(i, 1);
    else {
      var max = Number(el.parentNode.getAttribute('data-max')) || 2;
      if (cur.length >= max) cur.shift();     // 满了就把最早的顶掉，比弹提示顺手
      cur.push(val);
    }
    Schema.set(ITEM, path, cur);
    // 只重画这一组按钮，不碰别的 DOM
    var host = el.parentNode;
    var holder = document.createElement('div');
    holder.innerHTML = _sinToggles(path, cur, Number(host.getAttribute('data-max')) || 2);
    host.replaceWith(holder.firstChild);
  }

  /* 效果行增删 —— 结构性变更，只重建这一个阶段块，然后还原焦点。
   * stagePath 形如 skills.0.stages.1；效果下标单独用 data-idx 传。 */
  function _effectStruct(stagePath, act, idx) {
    if (!ITEM || !stagePath) return;
    var stage = Schema.get(ITEM, stagePath);
    if (!stage || !Array.isArray(stage.effects)) return;

    if (act === 'addEffect') {
      stage.effects.push({ coin: null, trigger: '命中时', text: '' });
      pendingPath = stagePath + '.effects.' + (stage.effects.length - 1) + '.text';
    } else {
      if (stage.effects.length <= 1) return;
      stage.effects.splice(idx, 1);
      pendingPath = stagePath + '.effects.' +
        Math.min(idx, stage.effects.length - 1) + '.text';
    }
    _rebuildStage(stagePath);
    if (onStructure) onStructure();
  }

  function _rebuildStage(stagePath) {
    if (!ROOT) return;
    var host = ROOT.querySelector('.stage[data-stage="' + _cssEsc(stagePath) + '"]');
    if (!host) return;
    var stage = Schema.get(ITEM, stagePath);
    var parts = String(stagePath).split('.');
    var si = Number(parts.pop());              // 阶段序号
    var listPath = parts.join('.');            // 形如 skills.0.stages
    var parentPath = listPath.replace(/\.stages$/, '');
    var kind = _kindOfPath(parentPath);
    var holder = document.createElement('div');
    holder.innerHTML = '<div class="stages">' +
      _stages(listPath, [stage], kind, si) + '</div>';
    var fresh = holder.querySelector('.stage');
    if (fresh) host.replaceWith(fresh);
    _restoreFocus();
  }

  /* 阶段属于哪个技能 —— 决定要不要显示「攻击容量」那一格。 */
  function _kindOfPath(parentPath) {
    var skill = Schema.get(ITEM, parentPath);
    if (skill && skill.kind) return skill.kind;
    var seg = String(parentPath).split('.')[0];
    return (seg === 'awaken' || seg === 'corrode') ? seg : 'atk';
  }

  /* 技能种类从攻击换成守备（或反过来）时，要显示的字段整组都不一样
   * （攻击类型 ↔ 守备类型），所以必须重建这一个技能块。只重建这一块，
   * 不动整张表单 —— 不然别的技能上正在输入的光标也会被踢掉。 */
  function _rebuildSkillBlock(path) {
    var item = path.replace(/\.kind$/, '');
    var host = ROOT && ROOT.querySelector('[data-skill="' + _cssEsc(item) + '"]');
    if (!host) return;
    var skill = Schema.get(ITEM, item);
    if (!skill) return;
    // 两边的字段是互斥的，换种类时把另一边的残值清掉，别让「守备技能」
    // 背着一个斩击属性导出到 wiki 上
    if (skill.kind === 'def') {
      skill.defType = skill.defType || 'defend';
      skill.atk = '';
    } else {
      skill.atk = skill.atk || 'slash';
      skill.defType = '';
    }
    var idx = Number(String(item).split('.').pop());
    var listPath = String(item).replace(/\.\d+$/, '');
    var holder = document.createElement('div');
    holder.innerHTML = '<div class="skill-item" data-skill="' + attr(item) + '">' +
      _skillOps(listPath, idx, Schema.get(ITEM, listPath).length) +
      _skillBlock(item, skill, skill.kind || 'atk') + '</div>';
    rebuilding = true;
    try { host.replaceWith(holder.firstChild); }
    finally { rebuilding = false; }
    if (onStructure) onStructure();
  }

  function _cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function _restoreFocus() {
    if (!pendingPath || !ROOT) return;
    var el = ROOT.querySelector('[data-path="' + _cssEsc(pendingPath) + '"]');
    pendingPath = null;
    if (el && el.focus) {
      el.focus();
      try { if (el.setSelectionRange && el.value !== undefined) el.setSelectionRange(el.value.length, el.value.length); }
      catch (e) { /* number 输入框不支持 setSelectionRange，忽略 */ }
    }
  }

  /* ---------------------------------------------------------------- 事件 */

  /* 换 DOM 的时候，正在被摘掉的那个输入框会补发一次 change/blur（浏览器就
   * 这么干的），它怀里揣的还是换之前那份值。要是照单全收，`_readInto` 就会
   * 拿旧值把刚恢复好的模型又盖回去 —— 撤销内置条目的改动时模型被顶回改前
   * 的值，就是这么来的。所以重建期间、以及事件来自已经不在表单里的元素时，
   * 一律不读。 */
  function _staleEvent(el) {
    if (rebuilding) return true;
    return !ROOT || !el || !ROOT.contains(el);
  }

  function _handleInput(e) {
    if (composing || e.isComposing) return;
    var el = e.target;
    if (!el || !el.getAttribute) return;
    if (_staleEvent(el)) return;
    var path = el.getAttribute('data-path') || '';
    if (_readInto(ITEM, el)) {
      if (onChange) onChange(path);
    }
    if (e.type === 'change' && el.tagName === 'SELECT') {
      if (/\.kind$/.test(path)) {
        // 攻击 ↔ 守备：要显示的字段整组都变了，得重建这一个技能块
        _rebuildSkillBlock(path);
        return;
      }
      // 其余下拉变化只影响外观（比如守备类型），不需要重建
      _syncLabels();
    }
  }

  /* 标题行上的「（未命名）」跟着输入走 —— 不重建 DOM，只改文本节点 */
  function _syncLabels() {
    if (!ROOT || !ITEM) return;
    var heads = ROOT.querySelectorAll('.sub-h strong');
    var names = [];
    if (ITEM.kind === 'identity') {
      ITEM.skills.forEach(function (s) { names.push(s.name || '（未命名）'); });
      ITEM.passives.forEach(function (p) { names.push(p.name || '（未命名）'); });
      names.push(ITEM.support.name || '（未命名）');
    } else {
      names.push(ITEM.awaken.name || '（未命名）');
      names.push(ITEM.corrode.name || '（未命名）');
      names.push(ITEM.passive.name || '（未命名）');
    }
    for (var i = 0; i < heads.length && i < names.length; i++) {
      if (heads[i].textContent !== names[i]) heads[i].textContent = names[i];
    }
  }

  function _handleClick(e) {
    var t = e.target;
    if (_staleEvent(t)) return;
    var act = t.getAttribute && t.getAttribute('data-act');
    if (!act) {
      // 点 section header 才折叠，点里面的控件不算
      return;
    }
    if (act === 'toggleSec') {
      var sec = t.getAttribute('data-sec');
      var host = t.parentNode;
      var open = host.classList.toggle('open');
      openState[sec] = open;
      return;
    }
    if (act === 'addEffect' || act === 'delEffect') {
      _effectStruct(t.getAttribute('data-path'), act,
        t.getAttribute('data-idx') === null ? 0 : Number(t.getAttribute('data-idx')));
      return;
    }
    if (act === 'addPassive' || act === 'delPassive') {
      _passiveStruct(t.getAttribute('data-path'), act,
        t.getAttribute('data-idx') === null ? 0 : Number(t.getAttribute('data-idx')));
      return;
    }
    if (act === 'addSkill' || act === 'delSkill' ||
        act === 'moveSkillUp' || act === 'moveSkillDown') {
      _skillStruct(t.getAttribute('data-path'), act,
        t.getAttribute('data-idx') === null ? 0 : Number(t.getAttribute('data-idx')));
      return;
    }
  }

  function _handleSinClick(e) {
    var t = e.target;
    if (_staleEvent(t)) return;
    if (!t.classList || !t.classList.contains('sin-t')) return;
    e.preventDefault();
    _toggleSin(t);
    if (onChange) onChange(t.getAttribute('data-path'));
  }

  function _handleKey(e) {
    if (_staleEvent(e.target)) return;
    // 效果行里按 Ctrl+Enter 直接加下一行，比去够那个 + 按钮快
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      var el = e.target;
      var p = el && el.getAttribute && el.getAttribute('data-path');
      if (p && p.indexOf('.effects.') >= 0) {
        e.preventDefault();
        _effectStruct(p.replace(/\.effects\.\d+\.text$/, ''), 'addEffect');
      }
    }
  }

  /* ---------------------------------------------------------------- 出口 */

  function mount(root, item, opts) {
    ROOT = root;
    ITEM = item;
    KIND = item.kind;
    onChange = (opts && opts.onChange) || null;
    onStructure = (opts && opts.onStructure) || null;

    rebuilding = true;
    try { ROOT.innerHTML = html(item); }
    finally { rebuilding = false; }

    if (!ROOT._bound) {
      ROOT._bound = true;
      ROOT.addEventListener('input', _handleInput);
      ROOT.addEventListener('change', _handleInput);
      ROOT.addEventListener('click', _handleClick);
      ROOT.addEventListener('click', _handleSinClick);
      ROOT.addEventListener('keydown', _handleKey);
      ROOT.addEventListener('compositionstart', function () { composing = true; }, true);
      ROOT.addEventListener('compositionend', function () {
        composing = false;
        // 组合结束后补一次：有些输入法在 compositionend 之后才更新 value
        var el = document.activeElement;
        if (el && el.getAttribute && el.getAttribute('data-path')) {
          if (_readInto(ITEM, el) && onChange) onChange(el.getAttribute('data-path'));
        }
      }, true);
    }
    return ROOT;
  }

  /* 整表重建，但保住焦点和展开状态。切条目 / 换 kind 时用。 */
  function reload(item) {
    var el = document.activeElement;
    pendingPath = (el && el.getAttribute && el.getAttribute('data-path')) || null;
    ITEM = item;
    rebuilding = true;
    try { ROOT.innerHTML = html(item); }
    finally { rebuilding = false; }
    _restoreFocus();
  }

  /* 校验结果标到字段上。只在结构上打 class，不动 DOM 结构。 */
  function showIssues(issues) {
    if (!ROOT) return;
    var marked = ROOT.querySelectorAll('.field.warn');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('warn');
    (issues || []).forEach(function (is) {
      var f = ROOT.querySelector('[data-field="' + _cssEsc(is.path) + '"]');
      if (f) f.classList.add('warn');
    });
  }

  function current() { return ITEM; }

  return {
    mount: mount, reload: reload, showIssues: showIssues, current: current
  };
})();
