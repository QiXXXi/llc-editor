/* 左栏库列表 —— 我的（可编辑）+ 内置（只读，点一下就是「以此为模板新建副本」）。
 *
 * 内置库 306 条不走 localStorage（见 store.js 顶部），它们直接来自 index.html 里
 * 嵌的种子。所以这个列表只有 306 + 用户自己那几条，不需要虚拟滚动 ——
 * DOM 节点全建出来也就几千个，比引入一个虚拟列表库划算得多。
 */
var Library = (function () {
  'use strict';

  var ROOT = null;
  var SEED = { items: [], portraits: {} };
  var opts = {};
  var tab = 'custom';
  var query = '';
  var filterSinner = '';
  var filterKind = '';
  var listEl = null;
  var countEl = null;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function seed() { return SEED; }

  function setSeed(data) {
    SEED = data || { items: [], portraits: {} };
  }

  /* 内置条目按编号索引 —— 卡片和列表都要按 code 找立绘。 */
  function seedByCode(kind, code) {
    for (var i = 0; i < SEED.items.length; i++) {
      var it = SEED.items[i];
      if (it.kind === kind && it.code === code) return it;
    }
    return null;
  }

  /* ---------------------------------------------------------------- 过滤 */

  function _match(it, q) {
    if (!q) return true;
    var hay = [
      it.name, it.nameAlt, it.code, it.org, it.origin,
      Enums.label('sinners', it.sinner),
      it.kind === 'identity' ? Enums.label('rarity', it.rarity) : Enums.label('egoGrade', it.grade)
    ].join(' ').toLowerCase();
    // 多个关键词全都要命中，方便「李箱 破裂」这样叠着筛
    var parts = q.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) if (hay.indexOf(parts[i]) < 0) return false;
    return true;
  }

  function _filter(items) {
    return items.filter(function (it) {
      if (filterKind && it.kind !== filterKind) return false;
      if (filterSinner && it.sinner !== filterSinner) return false;
      return _match(it, query);
    });
  }

  /* ---------------------------------------------------------------- 单项 */

  function _portrait(it) {
    var key = it.kind + ':' + (it.code || '');
    var url = SEED.portraits[key];
    if (!url && it.id) {
      var a = Store.asset(it.id);
      if (a && a.portrait) url = a.portrait;
    }
    if (url) return '<img src="' + esc(url) + '" alt="" loading="lazy">';
    // 没立绘就退回罪人配色的首字块，别留一个破图图标
    return '<span class="thumb-ph" style="--c:' +
      esc(Enums.color('sinners', it.sinner)) + '">' +
      esc(Enums.label('sinners', it.sinner).slice(0, 1)) + '</span>';
  }

  function _sub(it) {
    return it.kind === 'identity'
      ? Enums.label('sinners', it.sinner) + (it.org ? ' · ' + it.org : '')
      : Enums.label('egoGrade', it.grade) + ' · E.G.O';
  }

  function _row(it, source) {
    var sub = _sub(it);
    var badge = it.kind === 'identity'
      ? '<span class="badge r' + esc(it.rarity) + '">' + esc(Enums.label('rarity', it.rarity)) + '</span>'
      : '<span class="badge g" style="--c:' + esc(Enums.color('egoGrade', it.grade)) + '">' +
        esc(it.grade) + '</span>';
    var name = it.name || (it.nameAlt || '') || '未命名';
    return '<li class="row" data-id="' + esc(it.id || '') + '" data-code="' + esc(it.code || '') +
      '" data-kind="' + esc(it.kind) + '" data-src="' + source + '" tabindex="0">' +
      '<span class="thumb">' + _portrait(it) + '</span>' +
      '<span class="row-body"><span class="row-name">' + esc(name) + '</span>' +
      '<span class="row-sub">' + esc(sub) + '</span></span>' + badge +
      '<span class="row-acts">' +
      (source === 'custom'
        ? '<button class="mini" data-act="dup" title="复制一份">⧉</button>' +
          '<button class="mini del" data-act="del" title="删除">×</button>'
        : '<button class="mini" data-act="use" title="复制一份到「我的」">＋</button>') +
      '</span></li>';
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render() {
    if (!listEl) return;
    var items, source;
    if (tab === 'custom') {
      items = _filter(Store.items());
      source = 'custom';
    } else {
      items = _filter(SEED.items);
      source = 'seed';
    }
    var html = '';
    if (!items.length) {
      html = '<li class="empty">' + (tab === 'custom'
        ? '还没有自定义条目。<br>到「内置库」里挑一个人格，点 ＋ 复制成可编辑的副本。'
        : '没有符合条件的条目。') + '</li>';
    } else {
      // 我的：最近改的排前面；内置：按编号排，和游戏里的顺序一致
      if (source === 'custom') {
        items = items.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      } else {
        items = items.slice().sort(function (a, b) {
          return String(a.code || '').localeCompare(String(b.code || ''));
        });
      }
      for (var i = 0; i < items.length; i++) html += _row(items[i], source);
    }
    listEl.innerHTML = html;
    if (countEl) {
      countEl.textContent = tab === 'custom'
        ? Store.items().length + ' 条'
        : SEED.items.length + ' 条';
    }
  }

  /* 只改当前高亮那一行的名字和副标题，不重建列表。
   *
   * 内置库有 306 行、每行一个 <img> 立绘，编辑时每敲一个字就 listEl.innerHTML
   * 重来一遍会明显卡顿。名字和组织是编辑内置条目时最常动的两栏，就地改这两个
   * 就够了；稀有度徽章这类要改就得切一次列表，不值当为它重建。 */
  function touchActive(item) {
    if (!listEl || !item) return;
    var row = listEl.querySelector('.row.active');
    if (!row) return;
    var n = row.querySelector('.row-name');
    if (n) n.textContent = item.name || item.nameAlt || '未命名';
    var s = row.querySelector('.row-sub');
    if (s) s.textContent = _sub(item);
  }

  function markActive(id) {
    if (!listEl) return;
    var rows = listEl.querySelectorAll('.row.active');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('active');
    if (!id) return;
    var hit = listEl.querySelector('.row[data-id="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
    if (hit) {
      hit.classList.add('active');
      if (hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------------------------------------------------------------- 事件 */

  function _findRow(el) {
    while (el && el !== ROOT) {
      if (el.classList && el.classList.contains('row')) return el;
      el = el.parentNode;
    }
    return null;
  }

  function _resolve(row) {
    var src = row.getAttribute('data-src');
    if (src === 'custom') return Store.get(row.getAttribute('data-id'));
    var kind = row.getAttribute('data-kind');
    var code = row.getAttribute('data-code');
    // 同 code 的极端情况（内置库里不该有）——退回名字
    var items = SEED.items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === kind && items[i].code === code) return items[i];
    }
    return null;
  }

  function _onClick(e) {
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    var row = _findRow(e.target);
    if (!row) return;
    var item = _resolve(row);
    if (!item) return;
    var src = row.getAttribute('data-src');

    if (act === 'del') {
      e.stopPropagation();
      if (opts.onDelete) opts.onDelete(item);
      return;
    }
    if (act === 'dup') {
      e.stopPropagation();
      if (opts.onDuplicate) opts.onDuplicate(item);
      return;
    }
    if (act === 'use') {
      /* 只有右边的 ＋ 才复制。点行本身是「打开来改」，见下面 —— 早先两个动作
       * 是同一条路，结果随便点一下内置条目，「我的」里就多一份，列表越用越脏。 */
      e.stopPropagation();
      if (opts.onDerive) opts.onDerive(item);
      return;
    }
    if (opts.onOpen) opts.onOpen(item, src === 'seed');
  }

  function _onKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = _findRow(e.target);
    if (!row) return;
    e.preventDefault();
    var item = _resolve(row);
    if (!item) return;
    /* 回车跟鼠标点行一样，是「打开」。想复制就按 Tab 走到 ＋ 上再回车。 */
    if (opts.onOpen) opts.onOpen(item, row.getAttribute('data-src') === 'seed');
  }

  /* ---------------------------------------------------------------- 装配 */

  function mount(root, options) {
    ROOT = root;
    opts = options || {};

    var sinnerOpts = '<option value="">全部罪人</option>';
    Enums.SINNERS.forEach(function (s) {
      sinnerOpts += '<option value="' + esc(s.key) + '">' + esc(s.cn) + '</option>';
    });

    ROOT.innerHTML =
      '<div class="lib-top">' +
      '<input type="search" id="libSearch" class="lib-search" placeholder="搜索名称 / 编号 / 罪人…">' +
      '<div class="lib-filters">' +
      '<select id="libSinner">' + sinnerOpts + '</select>' +
      '<select id="libKind">' +
      '<option value="">全部类型</option><option value="identity">人格</option>' +
      '<option value="ego">E.G.O</option></select>' +
      '</div>' +
      '<div class="lib-tabs">' +
      '<button data-tab="custom" class="on">我的</button>' +
      '<button data-tab="seed">内置库</button>' +
      '<span class="lib-count" id="libCount"></span>' +
      '</div></div>' +
      '<ul class="lib-list" id="libList"></ul>';

    listEl = ROOT.querySelector('#libList');
    countEl = ROOT.querySelector('#libCount');

    var search = ROOT.querySelector('#libSearch');
    var deb = null;
    search.addEventListener('input', function () {
      if (deb) clearTimeout(deb);
      deb = setTimeout(function () {
        query = search.value.trim();
        render();
      }, 120);
    });
    ROOT.querySelector('#libSinner').addEventListener('change', function () {
      filterSinner = this.value; render();
    });
    ROOT.querySelector('#libKind').addEventListener('change', function () {
      filterKind = this.value; render();
    });
    ROOT.querySelector('.lib-tabs').addEventListener('click', function (e) {
      var b = e.target;
      if (!b.getAttribute || !b.getAttribute('data-tab')) return;
      tab = b.getAttribute('data-tab');
      var all = ROOT.querySelectorAll('.lib-tabs button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      render();
    });

    listEl.addEventListener('click', _onClick);
    listEl.addEventListener('keydown', _onKey);
    render();
    return ROOT;
  }

  function setTab(t) {
    tab = t;
    if (!ROOT) return;
    var all = ROOT.querySelectorAll('.lib-tabs button');
    for (var i = 0; i < all.length; i++) {
      all[i].classList.toggle('on', all[i].getAttribute('data-tab') === t);
    }
    render();
  }

  function refresh() { render(); }

  return {
    mount: mount, render: render, refresh: refresh, setTab: setTab,
    setSeed: setSeed, seed: seed, seedByCode: seedByCode, markActive: markActive,
    touchActive: touchActive
  };
})();
