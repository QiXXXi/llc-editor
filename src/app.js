/* 应用装配 —— 布局、工具栏、预览、导入导出、撤销、快捷键。
 *
 * 渲染节奏：所有输入都只改 model，然后 rAF 排一次卡片重绘。中间连敲十个字
 * 也只画一次。这条是保证中文输入不掉帧的关键。
 */
var App = (function () {
  'use strict';

  var SEED = { items: [], portraits: {}, generated: '' };
  var current = null;
  /* 当前打开的是不是内置库里的条目。内置条目可以就地改，但**一个字都不许落盘**：
   * 种子对象只是被就地改了，刷新页面时 SEED 会重新从 <script id="seed"> 解析出来，
   * 自然回退到原样。所以凡是可能写 localStorage 的地方（Store.replace、撤销）
   * 都得先看一眼这个开关。 */
  var currentIsSeed = false;
  var rafPending = false;
  var imgCache = {};         // dataURL -> HTMLImageElement
  var pendingImg = {};
  var undoStack = [];
  var undoPushedAt = 0;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- 提示 */

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, kind === 'err' ? 6000 : 2600);
  }

  /* 简易对话框。按钮用 Promise 返回，避免到处写回调。 */
  function ask(title, body, buttons) {
    return new Promise(function (resolve) {
      var host = $('modal');
      var html = '<div class="mbox"><h3>' + title + '</h3><div class="mbody">' + body + '</div><div class="macts">';
      buttons.forEach(function (b, i) {
        html += '<button data-i="' + i + '"' + (b.danger ? ' class="danger"' : '') +
          (b.primary ? ' class="primary"' : '') + '>' + b.label + '</button>';
      });
      html += '</div></div>';
      host.innerHTML = html;
      host.classList.add('show');
      host.onclick = function (e) {
        var i = e.target.getAttribute && e.target.getAttribute('data-i');
        if (i === null || i === undefined) {
          if (e.target === host) { host.classList.remove('show'); resolve(null); }
          return;
        }
        host.classList.remove('show');
        resolve(buttons[Number(i)].value);
      };
    });
  }

  /* ---------------------------------------------------------------- 立绘 */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 立绘解析顺序：用户自己传的 > 内置种子里同编号的 > 没有。
   * 用 basedOn 而不是 code 去找种子 —— 用户改了编号不该换立绘。 */
  function portraitUrl(item) {
    if (!item) return null;
    var a = item.id ? Store.asset(item.id) : null;
    if (a && a.portrait) return a.portrait;
    var key = item.basedOn || item.code;
    if (!key) return null;
    var url = SEED.portraits[item.kind + ':' + key];
    return url || null;
  }

  /* 图片是异步的。加载完再排一次重绘，别让卡片永远停在占位块上。 */
  function imageFor(item) {
    var url = portraitUrl(item);
    if (!url) return null;
    if (imgCache[url]) return imgCache[url].complete ? imgCache[url] : null;
    if (pendingImg[url]) return null;
    pendingImg[url] = true;
    var img = new Image();
    img.onload = function () {
      imgCache[url] = img;
      delete pendingImg[url];
      scheduleRender();
    };
    img.onerror = function () { delete pendingImg[url]; };
    img.src = url;
    return null;
  }

  /* ---------------------------------------------------------------- 游戏素材
   *
   * 卡片上的游戏 UI 素材（技能框、罪孽图标、数值图标、状态图标……）全部以内嵌
   * data URL 的形式躺在种子数据里，这里建成 HTMLImageElement 交给 Card。
   *
   * 时序上有一点必须踩准：**setAssets 要同步调用，等图解码是另一回事**。
   * 卡片的版式只认「这个名字在不在表里」（见 card.js 的注释），所以元素得先
   * 建出来、立刻把表交出去，之后哪张图解码完了都不影响布局 —— 否则首屏会先
   * 按「没有图标」排一遍版，再跳成「有图标」的版式，用户会看到卡片抖一下。 */
  function loadIcons() {
    var src = SEED.icons || {};
    var icons = {};
    var jobs = [];
    Object.keys(src).forEach(function (name) {
      var img = new Image();
      icons[name] = img;                       // 先登记，解码是后面的事
      jobs.push(new Promise(function (res) {
        img.onload = img.onerror = function () { res(); };
        img.src = src[name];
      }));
    });
    Card.setAssets({ icons: icons, status: SEED.statusIcons || {} });
    return Promise.all(jobs);
  }

  /* 用户上传的图统一缩到长边 ≤512 的 webp，约 40–80 KB。原图直塞 localStorage
   * 两张就把 5 MB 配额吃满了。 */
  function shrinkToDataUrl(file, maxSide, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, maxSide / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * s));
        var h = Math.max(1, Math.round(img.height * s));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var out = null;
        try { out = c.toDataURL('image/webp', 0.86); } catch (e) { out = null; }
        // 有些老 Edge 不支持 webp 编码，会静默返回 png 或空串
        if (!out || out.indexOf('data:image/webp') !== 0) {
          out = c.toDataURL('image/jpeg', 0.88);
        }
        cb(out, w, h);
      };
      img.onerror = function () { cb(null); };
      img.src = fr.result;
    };
    fr.onerror = function () { cb(null); };
    fr.readAsDataURL(file);
  }

  /* ---------------------------------------------------------------- 预览 */

  function cardOpts() {
    return {
      width: Number(Store.settings().cardWidth) || Card.W_DEFAULT,
      theme: Store.settings().cardTheme || 'dark',
      // 技能默认只画满级那一阶（人格同步Ⅳ / E.G.O 解析Ⅴ，取各自实际存在的
      // 最高一阶）：四阶全铺出来卡片会变成一眼望过去全是字，满级那阶本来就是
      // 游戏里实际用的那一档。挑阶的规则见 card.js 的 pickStages。
      stage: Store.settings().cardStage || 'iv',
      image: imageFor(current)
    };
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      drawCard();
    });
  }

  function drawCard() {
    var canvas = $('card');
    if (!canvas || !current) return;
    var opts = cardOpts();
    var box = $('pvSize');
    try {
      var r = Card.render(canvas, current, opts);
      if (box) box.textContent = r.width + ' × ' + r.height + ' @' + r.scale + 'x';
    } catch (e) {
      if (box) box.textContent = '渲染失败';
      toast('卡片渲染失败：' + e.message, 'err');
    }
    updateIssues();
  }

  function updateIssues() {
    if (!current) return;
    var issues;
    try { issues = Model.validate(current); } catch (e) { issues = []; }
    Form.showIssues(issues);
    var el = $('pvIssues');
    if (!el) return;
    if (!issues.length) { el.textContent = '没有发现问题'; el.className = 'issues ok'; return; }
    el.className = 'issues warn';
    el.textContent = issues.length + ' 处待补：' + issues.slice(0, 3)
      .map(function (i) { return i.msg; }).join('；') + (issues.length > 3 ? ' …' : '');
  }

  /* ---------------------------------------------------------------- 撤销 */

  /* 粗粒度：改动停下来 700 ms 之后压一个快照，上限 60。做完整的 undo/redo
   * 要引入操作日志，对这个体量的工具不值当。 */
  function maybeSnapshot() {
    var now = Date.now();
    if (now - undoPushedAt < 700) return;
    undoPushedAt = now;
    var s = JSON.stringify(current);
    if (undoStack.length && undoStack[undoStack.length - 1] === s) return;
    undoStack.push(s);
    if (undoStack.length > 60) undoStack.shift();
  }

  /* 就地覆盖：把 src 的字段全搬到 target 上，**引用本身不变**。内置条目必须这么
   * 恢复 —— SEED.items 和表单握着同一个对象，换个新对象等于跟列表脱钩，撤销
   * 之后列表里那条还是旧的。 */
  function assignInPlace(target, src) {
    var k;
    for (k in target) {
      if (Object.prototype.hasOwnProperty.call(target, k)) delete target[k];
    }
    for (k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function undo() {
    if (!current || undoStack.length < 1) { toast('没有可撤销的改动'); return; }
    var s = undoStack.pop();
    if (s === JSON.stringify(current) && undoStack.length) s = undoStack.pop();
    var restored = JSON.parse(s);
    var id = current.id;
    // 撤销之后不再往栈里压 —— 否则按一次 Ctrl+Z 会被自己的快照顶回去
    undoPushedAt = Date.now() + 1e9;
    if (currentIsSeed) {
      assignInPlace(current, restored);
      current.id = id;
      Form.reload(current);
    } else {
      current = Model.normalize(restored);
      current.id = id;
      Form.reload(current);
      Store.replace(current);
    }
    Library.markActive(current.id);
    scheduleRender();
    undoPushedAt = 0;
  }

  /* ---------------------------------------------------------------- 条目 */

  /* opts.seed —— 这条是从内置库打开来改的，改动只活在内存里 */
  function openItem(item, opts) {
    if (opts && opts.snapshot !== false) maybeSnapshot();
    current = item;
    currentIsSeed = !!(opts && opts.seed);
    Form.mount($('formScroll'), item, {
      onChange: function () {
        /* 内置条目直接改的就是 SEED.items 里那个对象。它没有 id 落在 Store 里，
         * Store.replace 找不到会退化成 add()（store.js），于是「随手改一个内置
         * 人格」就变成往「我的」里塞了一条 —— 这正是要避免的。 */
        if (currentIsSeed) Library.touchActive(current);
        else { Store.replace(current); Library.refresh(); }
        scheduleRender();
      },
      onStructure: function () { maybeSnapshot(); }
    });
    Library.markActive(item.id);
    undoStack = [];
    var meta = $('curMeta');
    if (meta) {
      meta.textContent = item.kind === 'identity' ? '人格' : 'E.G.O';
    }
    var based = $('curBased');
    if (based) {
      based.className = 'based';
      if (currentIsSeed) {
        /* 内置条目没有「已保存」这回事，不说清楚的话用户会以为改丢了。 */
        based.className = 'based warn';
        based.textContent = '内置条目 · 改动只在这个页面里有效，刷新即回退。' +
          '想留下来就点右边的 ＋ 复制一份到「我的」。';
      } else if (!item.basedOn) {
        based.textContent = '';
      } else {
        var src = Library.seedByCode(item.kind, item.basedOn);
        based.textContent = '副本源自 ' + (src && src.name ? src.name : item.basedOn) +
          '（副本不会跟着内置数据更新）';
      }
    }
    scheduleRender();
  }

  function newItem(kind) {
    var it = Model.create(kind);
    Store.add(it);
    Library.setTab('custom');
    openItem(it, { snapshot: false });
    toast('已新建' + (kind === 'identity' ? '人格' : ' E.G.O') + '，左侧「我的」里可以找到');
  }

  /* 从内置条目派生副本。id 必须是新的，否则「合并导入」会把两条不相干的
   * 东西当成同一条。 */
  function deriveFrom(seedItem) {
    var copy = Model.derive(seedItem);
    // 种子里的立绘是 128px webp，留着复用，不往 localStorage 抄一份
    Store.add(copy);
    Library.setTab('custom');
    openItem(copy, { snapshot: false });
    toast('已复制为「' + (copy.name || '未命名') + '」，现在可以随便改了');
  }

  function deleteItem(item) {
    ask('删除条目', '<p>确定要删除「' + esc(item.name || '未命名') + '」吗？<br>' +
      '这一步不可撤销。如果还想要，先导出 JSON 备份。</p>',
      [{ label: '取消', value: null }, { label: '删除', value: 'yes', danger: true }]
    ).then(function (v) {
      if (v !== 'yes') return;
      Store.remove(item.id);
      if (current && current.id === item.id) {
        current = null;
        currentIsSeed = false;
        $('formScroll').innerHTML = '<p class="empty-hint">左边选一个条目，或者新建一个。</p>';
        var c = $('card');
        var ctx = c.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        c.width = 1; c.height = 1;
      }
      Library.refresh();
      toast('已删除');
    });
  }

  /* ---------------------------------------------------------------- 导入导出 */

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function safeName(s) {
    return String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  function exportJSON() {
    /* 打开的是内置条目 → 只导出这一条。它不在 Store 里，走不到下面那条路，
     * 而「改完想留个备份」是内置编辑唯一的出口（点 ＋ 复制再导出要两步）。
     * 信封跟批量导出完全一样，所以同一份文件还能原样导回来。 */
    if (currentIsSeed && current) {
      var one = Store.toJSON([current]);
      download(new Blob([one], { type: 'application/json' }),
        safeName(current.name) + '.json');
      toast('已导出内置条目「' + (current.name || '未命名') + '」（只有这一条）');
      return;
    }
    if (!Store.items().length) { toast('「我的」里还没有条目，没什么可导出的', 'err'); return; }
    var txt = Store.toJSON();
    download(new Blob([txt], { type: 'application/json' }), 'llc-自定义条目.json');
    toast('已导出 ' + Store.items().length + ' 条（含立绘）');
  }

  function exportPNG() {
    if (!current) { toast('先选一个条目', 'err'); return; }
    var opts = cardOpts();
    opts.scale = 2;
    Card.toBlob(current, opts).then(function (blob) {
      if (!blob || !blob.size) { toast('导出失败：得到空图片', 'err'); return; }
      download(blob, safeName(current.name) + '.png');
      toast('已导出 PNG（' + Math.round(blob.size / 1024) + ' KB，2 倍分辨率）');
    }).catch(function (e) {
      toast('导出失败：' + e.message + '（立绘可能含有非内嵌图片）', 'err');
    });
  }

  function exportText() {
    if (!current) { toast('先选一个条目', 'err'); return; }
    var fmt = WikiText.format($('textFormat').value);
    var txt = fmt.fn(current);
    var name = safeName(current.name) + (fmt.key === 'huiji' ? '.txt' : '.wiki');
    download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), name);
    toast('已导出' + fmt.cn);
    var pre = $('textPreview');
    if (pre) { pre.textContent = txt; pre.parentNode.classList.add('show'); }
  }

  function importJSON(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var raw = String(fr.result).replace(/^﻿/, '');   // BOM
      var data;
      try { data = JSON.parse(raw); }
      catch (e) { toast('这个文件不是合法的 JSON：' + e.message, 'err'); return; }

      // 三种东西都能吃：完整信封 / 裸数组 / 单条
      var items = null, assets = {};
      if (Array.isArray(data)) items = data;
      else if (data && Array.isArray(data.items)) { items = data.items; assets = data.assets || {}; }
      else if (data && (data.kind === 'identity' || data.kind === 'ego')) items = [data];

      if (!items) { toast('认不出这个文件的结构', 'err'); return; }
      items = items.map(function (it) {
        try { return Model.normalize(Model.migrate(it)); } catch (e) { return null; }
      }).filter(Boolean);
      if (!items.length) { toast('文件里没有能读出来的条目', 'err'); return; }

      ask('导入 ' + items.length + ' 条',
        '<p>选择导入方式：</p><ul class="tips">' +
        '<li><b>追加</b>：全部当成新条目（重新生成 id），不覆盖任何东西</li>' +
        '<li><b>合并</b>：同 id 的按「最后修改时间」取新的</li>' +
        '<li><b>替换</b>：先清空「我的」，再放进去</li></ul>',
        [{ label: '取消', value: null },
         { label: '追加', value: 'append', primary: true },
         { label: '合并', value: 'merge' },
         { label: '替换', value: 'replace', danger: true }]
      ).then(function (mode) {
        if (!mode) return;
        var n = _applyImport(items, assets, mode);
        Library.setTab('custom');
        Library.refresh();
        toast('已导入 ' + n + ' 条');
        if (Store.items().length && !current) openItem(Store.items()[0], { snapshot: false });
      });
    };
    fr.onerror = function () { toast('读取文件失败', 'err'); };
    fr.readAsText(file, 'utf-8');
  }

  function _applyImport(items, assets, mode) {
    var added = 0;
    if (mode === 'replace') {
      Store.items().slice().forEach(function (it) { Store.remove(it.id); });
    }
    items.forEach(function (it) {
      if (mode === 'append') {
        var oldId = it.id;
        it.id = Model.newId();
        if (assets[oldId]) Store.setAsset(it.id, Model.deepCopy(assets[oldId]));
        Store.add(it);
        added++;
        return;
      }
      var exist = Store.get(it.id);
      if (mode === 'merge' && exist) {
        if ((it.updatedAt || 0) > (exist.updatedAt || 0)) {
          Store.replace(it);
          if (assets[it.id]) Store.setAsset(it.id, Model.deepCopy(assets[it.id]));
        }
        return;   // 同 id 且旧的更新 —— 跳过，也算成功
      }
      if (exist) { it.id = Model.newId(); }
      if (assets[it.id]) Store.setAsset(it.id, Model.deepCopy(assets[it.id]));
      Store.add(it);
      added++;
    });
    return added;
  }

  /* ---------------------------------------------------------------- 工具栏 */

  function bindToolbar() {
    document.querySelector('.tb').addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      switch (act) {
        case 'newIdentity': newItem('identity'); break;
        case 'newEgo': newItem('ego'); break;
        case 'import': $('fileJSON').click(); break;
        case 'exportJSON': exportJSON(); break;
        case 'exportPNG': exportPNG(); break;
        case 'exportText': exportText(); break;
        case 'theme': toggleTheme(); break;
        case 'help': showHelp(); break;
      }
    });

    $('fileJSON').addEventListener('change', function () {
      if (this.files && this.files[0]) importJSON(this.files[0]);
      this.value = '';       // 允许连续导入同一个文件
    });
    $('fileImg').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f || !current) return;
      shrinkToDataUrl(f, 512, function (url, w, h) {
        if (!url) { toast('这张图读不出来', 'err'); return; }
        Store.setAsset(current.id, { portrait: url, w: w, h: h });
        scheduleRender();
        Library.refresh();
        toast('立绘已更新（' + Math.round(url.length / 1024) + ' KB）');
      });
    });

    document.querySelector('.pv-toolbar').addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act || !current) return;
      /* 立绘存在 Store 的 assets 里，是按 id 记账的 —— 内置条目写进去会留成一条
       * 孤儿资源，而且下次打开这个内置条目时 portraitUrl 会先命中它，看起来就像
       * 「内置库被改了还没回退」。所以内置条目干脆不给存立绘。 */
      if ((act === 'upImg' || act === 'clearImg') && currentIsSeed) {
        toast('内置条目存不了立绘，先点右边的 ＋ 复制一份到「我的」', 'err');
        return;
      }
      if (act === 'upImg') $('fileImg').click();
      else if (act === 'clearImg') {
        Store.setAsset(current.id, null);
        scheduleRender();
        Library.refresh();
        toast('已清除这张立绘，卡片会退回占位块');
      } else if (act === 'png') exportPNG();
      else if (act === 'exportText') exportText();   // 顶栏也有一个，同一个函数
      else if (act === 'cardTheme') {
        var t = Store.settings().cardTheme === 'light' ? 'dark' : 'light';
        Store.setSetting('cardTheme', t);
        drawCard();
        toast('卡片配色：' + (t === 'light' ? '浅色' : '深色'));
      }
    });

    // 导出文本之后会顺带把结果摊在弹层里（见 exportText），得能关掉
    var pre = $('textPreview');
    if (pre && pre.parentNode) {
      pre.parentNode.addEventListener('click', function (e) {
        var act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (e.target === pre.parentNode || act === 'closeText') {
          pre.parentNode.classList.remove('show');
        }
      });
    }

    var wsel = $('cardWidth');
    wsel.value = String(Store.settings().cardWidth || Card.W_DEFAULT);
    wsel.addEventListener('change', function () {
      Store.setSetting('cardWidth', Number(this.value));
      drawCard();
    });

    var ssel = $('cardStage');
    if (ssel) {
      ssel.value = Store.settings().cardStage || 'iv';
      ssel.addEventListener('change', function () {
        Store.setSetting('cardStage', this.value);
        drawCard();
      });
    }
  }

  function toggleTheme() {
    var root = document.documentElement;
    var t = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', t);
    Store.setSetting('uiTheme', t);
  }

  function showHelp() {
    ask('用法速查', '<ul class="tips">' +
      '<li>左栏「内置库」里点任意条目 = 复制成可编辑的副本</li>' +
      '<li>效果文本里用 <code>**沉沦**</code> 可以把状态名加粗；导出 wikitext 时会自动还原成 <code>{{状态2|沉沦}}</code></li>' +
      '<li>效果行里按 <kbd>Ctrl</kbd>+<kbd>Enter</kbd> 直接加下一行</li>' +
      '<li><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销、<kbd>Ctrl</kbd>+<kbd>S</kbd> 立即保存、<kbd>Ctrl</kbd>+<kbd>P</kbd> 导出 PNG</li>' +
      '<li>存档在本机浏览器的 localStorage 里。「我的」条目多了之后记得导出 JSON 备份</li>' +
      '</ul>', [{ label: '知道了', value: 1, primary: true }]);
  }

  /* ---------------------------------------------------------------- 快捷键 */

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var k = e.key.toLowerCase();
      // 输入框里的 Ctrl+A / C / V 别抢
      var editing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 's') {
        e.preventDefault();
        var r = Store.flush();
        toast(r.ok ? '已保存到本机' : ('保存失败：' + r.msg), r.ok ? '' : 'err');
      } else if (k === 'p' && !editing) { e.preventDefault(); exportPNG(); }
      else if (k === 'e' && !editing) { e.preventDefault(); exportText(); }
    });
    // 关页面前把没落盘的写下去 —— 防抖窗口里关掉标签页会丢最后一次改动
    window.addEventListener('beforeunload', function () { Store.flush(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') Store.flush();
    });
  }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    var el = document.getElementById('seed');
    if (el) {
      try { SEED = JSON.parse(el.textContent); }
      catch (e) { SEED = { items: [], portraits: {} }; toast('内置数据读不出来：' + e.message, 'err'); }
    }
    if (!SEED.items) SEED.items = [];
    if (!SEED.portraits) SEED.portraits = {};

    /* 必须在开画之前同步交出去，解码完成后再排一次重绘补图。 */
    loadIcons().then(function () { scheduleRender(); });

    Library.setSeed(SEED);
    Store.load();

    var theme = Store.settings().uiTheme;
    if (theme) document.documentElement.setAttribute('data-theme', theme);

    Library.mount($('lib'), {
      onOpen: function (it, isSeed) { openItem(it, { seed: isSeed }); },
      onDerive: function (it) { deriveFrom(it); },
      onDuplicate: function (it) { var c = Store.duplicate(it.id); Library.refresh(); if (c) openItem(c, { snapshot: false }); },
      onDelete: function (it) { deleteItem(it); }
    });

    Store.on(function (ev) {
      if (ev.type === 'error') toast(ev.msg, 'err');
      else if (ev.type === 'notice') toast(ev.msg);
    });
    if (!Store.isAvailable() || Store.lastError()) {
      var st = $('storeState');
      if (st) {
        st.textContent = Store.isAvailable() ? '存储：' + Store.backendName() : '⚠ 本地存储不可用，请及时导出 JSON';
        st.className = Store.isAvailable() ? 'state' : 'state bad';
      }
      if (Store.lastError()) setTimeout(function () { toast(Store.lastError(), 'err'); }, 400);
    }

    bindToolbar();
    bindKeys();

    $('formScroll').innerHTML = '<p class="empty-hint">左边选一个条目，或者点上面的「新建人格」。</p>';

    var first = Store.items()[0];
    if (first) openItem(first, { snapshot: false });
    else Library.setTab('seed');

    // #stamp 里本来就有 build.py 戳的构建时间，追加数据日期而不是覆盖掉它
    var f = $('stamp');
    if (f && SEED.generated) f.textContent += ' · 数据 ' + SEED.generated.slice(0, 10);
  }

  return { boot: boot, toast: toast, get current() { return current; } };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { App.boot(); });
} else {
  App.boot();
}
