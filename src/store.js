/* 本地存储 —— 自定义条目 + 立绘资源。
 *
 * 内置的 190 人格 / 116 E.G.O 永远不进 localStorage。种子在构建时已经嵌进
 * index.html 了，再往 localStorage 抄一份纯属浪费配额：5 MB 塞不下「种子 +
 * 用户自己的立绘」。所以这里只存用户造的东西。
 *
 * file:// 下 localStorage 的行为在各浏览器里并不一致（有的直接抛 SecurityError，
 * 有的给个假的 sessionStorage），所以启动时探一次，探不通就退到内存模式，
 * 并且必须让用户看得见 —— 不然他辛苦编一下午，关掉标签页就没了。
 */
var Store = (function () {
  'use strict';

  var KEY = 'llc_editor_v1';
  var PROBE = 'llc_editor_probe';
  var MAX_BYTES = 4.2 * 1024 * 1024;   // 各家浏览器配额 5 MB，留点余量
  var SAVE_DEBOUNCE = 400;

  var backend = null;      // 真实的 localStorage，或 null（内存模式）
  var memory = null;       // 内存模式下的假存储
  var available = false;
  var lastError = '';
  var listeners = [];

  /* ---------------------------------------------------------------- 探测 */

  function _probe() {
    try {
      var ls = window.localStorage;
      if (!ls) throw new Error('no localStorage');
      ls.setItem(PROBE, '1');
      var ok = ls.getItem(PROBE) === '1';
      ls.removeItem(PROBE);
      if (!ok) throw new Error('read-back failed');
      backend = ls;
      available = true;
    } catch (e) {
      // 隐私模式 / file:// 的某些配置 / 配额已满，都会走到这里
      backend = null;
      available = false;
      lastError = (e && e.message) || String(e);
    }
  }

  function _memStore() {
    if (!memory) {
      memory = {
        _d: {},
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
        setItem: function (k, v) { this._d[k] = String(v); },
        removeItem: function (k) { delete this._d[k]; }
      };
    }
    return memory;
  }

  function _raw() { return backend || _memStore(); }

  /* ---------------------------------------------------------------- 状态 */

  var data = { items: [], assets: {}, settings: {} };
  var dirty = false;
  var timer = null;
  var quotaWarning = false;

  function _blank() { return { items: [], assets: {}, settings: {} }; }

  function _byteLen(s) {
    // Blob.size 是最准的（按 UTF-8 算），没有 Blob 就退回近似
    if (typeof Blob !== 'undefined') {
      try { return new Blob([s]).size; } catch (e) { /* ignore */ }
    }
    return s.length * 2;
  }

  /* ---------------------------------------------------------------- 读写 */

  function load() {
    _probe();
    var txt = null;
    try { txt = _raw().getItem(KEY); } catch (e) { txt = null; }
    if (!txt) { data = _blank(); return data; }
    var parsed;
    try {
      parsed = JSON.parse(txt);
    } catch (e) {
      // 存档坏了不能直接删 —— 先留个副本，让用户还有机会手工捞回来
      try { _raw().setItem(KEY + '_broken', txt); } catch (e2) { /* 存不下就算了 */ }
      lastError = '存档解析失败，已备份到 ' + KEY + '_broken';
      data = _blank();
      return data;
    }
    data = {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      assets: (parsed.assets && typeof parsed.assets === 'object') ? parsed.assets : {},
      settings: (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : {}
    };
    // 条目过一遍 normalize：老存档、手工改坏的文件都能救回来
    var out = [];
    for (var i = 0; i < data.items.length; i++) {
      var it = null;
      try { it = Model.normalize(data.items[i]); } catch (e) { it = null; }
      if (it) out.push(it);
    }
    if (out.length !== data.items.length) {
      lastError = '有 ' + (data.items.length - out.length) + ' 条存档读不出来，已跳过';
    }
    data.items = out;
    return data;
  }

  function _serialize() {
    return JSON.stringify({
      app: 'llc-editor', schemaVersion: Model.SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      items: data.items, assets: data.assets, settings: data.settings
    });
  }

  /* 立刻落盘。配额满了会尝试丢掉立绘再存一次 —— 文字比图重要。 */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return { ok: true };
    var txt;
    try { txt = _serialize(); }
    catch (e) { return { ok: false, msg: '序列化失败：' + e.message }; }

    var size = _byteLen(txt);
    if (size > MAX_BYTES) {
      return { ok: false, msg: '内容约 ' + _mb(size) + ' MB，超过浏览器约 5 MB 的存储上限。' +
        '请删掉几条带立绘的条目，或先导出 JSON 备份。', over: true };
    }
    try {
      _raw().setItem(KEY, txt);
      dirty = false;
      quotaWarning = false;
      return { ok: true, bytes: size };
    } catch (e) {
      var res = _dropAssetsAndRetry();
      if (res.ok) {
        return { ok: true, bytes: res.bytes, msg: '存储空间不足，已丢弃部分立绘（文字内容完好）' };
      }
      quotaWarning = true;
      return { ok: false, msg: '本地存储写入失败：' + ((e && e.message) || e) +
        '。请立即导出 JSON 备份。' };
    }
  }

  function _dropAssetsAndRetry() {
    var kept = {};
    var n = 0;
    for (var k in data.assets) {
      if (!Object.prototype.hasOwnProperty.call(data.assets, k)) continue;
      // 只留还被条目引用的立绘
      var used = data.items.some(function (it) { return it.id === k; });
      if (used && n < 3) { kept[k] = data.assets[k]; n++; }
    }
    data.assets = kept;
    var txt;
    try { txt = _serialize(); } catch (e) { return { ok: false }; }
    try {
      _raw().setItem(KEY, txt);
      dirty = false;
      return { ok: true, bytes: _byteLen(txt) };
    } catch (e2) {
      return { ok: false };
    }
  }

  function _mb(b) { return (b / 1024 / 1024).toFixed(1); }

  /* 防抖保存。输入框每敲一个字就写一次 localStorage 会把主线程堵死。 */
  function save() {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      var res = flush();
      if (!res.ok) _emit('error', res.msg);
      else if (res.msg) _emit('notice', res.msg);
    }, SAVE_DEBOUNCE);
  }

  /* ---------------------------------------------------------------- 事件 */

  function on(fn) { listeners.push(fn); }
  function _emit(type, msg) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i]({ type: type, msg: msg }); } catch (e) { /* 监听器自己炸了不该拖垮存储 */ }
    }
  }

  /* ---------------------------------------------------------------- 条目 */

  function items() { return data.items; }

  function indexOf(id) {
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return i;
    return -1;
  }

  function get(id) {
    var i = indexOf(id);
    return i < 0 ? null : data.items[i];
  }

  function add(item) {
    data.items.unshift(item);
    save();
    return item;
  }

  function replace(item) {
    var i = indexOf(item.id);
    if (i < 0) return add(item);
    item.updatedAt = Date.now();
    item.rev = (item.rev || 1) + 1;
    data.items[i] = item;
    save();
    return item;
  }

  function remove(id) {
    var i = indexOf(id);
    if (i < 0) return false;
    data.items.splice(i, 1);
    delete data.assets[id];
    save();
    return true;
  }

  function duplicate(id) {
    var src = get(id);
    if (!src) return null;
    var copy = Model.derive(src);
    copy.name = (src.name || '未命名') + ' 副本';
    add(copy);
    var a = data.assets[id];
    if (a) data.assets[copy.id] = Model.deepCopy(a);
    save();
    return copy;
  }

  /* ---------------------------------------------------------------- 立绘 */

  function asset(id) { return data.assets[id] || null; }

  function setAsset(id, obj) {
    if (!obj) delete data.assets[id];
    else data.assets[id] = obj;
    save();
  }

  function assetBytes() {
    var n = 0;
    for (var k in data.assets) {
      var a = data.assets[k];
      if (a && a.portrait) n += a.portrait.length;
    }
    return n;
  }

  function usage() {
    var txt;
    try { txt = _serialize(); } catch (e) { txt = ''; }
    return { bytes: _byteLen(txt), limit: MAX_BYTES, assets: assetBytes(), items: data.items.length };
  }

  /* ---------------------------------------------------------------- 信封 */

  /* 导入导出共用同一个信封 —— 导入只有一条代码路径，也就只有一处会出错。 */
  function envelope(selected) {
    var list = (selected && selected.length) ? selected : data.items;
    var assets = {};
    for (var i = 0; i < list.length; i++) {
      var a = data.assets[list[i].id];
      if (a) assets[list[i].id] = a;
    }
    return {
      app: 'llc-editor', schemaVersion: Model.SCHEMA_VERSION,
      kind: 'collection', exportedAt: new Date().toISOString(),
      count: list.length,
      items: Model.deepCopy(list),
      assets: assets
    };
  }

  function toJSON(selected) {
    return JSON.stringify(envelope(selected), null, 2);
  }

  function settings() { return data.settings; }
  function setSetting(k, v) { data.settings[k] = v; save(); }

  return {
    load: load, save: save, flush: flush,
    isAvailable: function () { return available; },
    lastError: function () { return lastError; },
    backendName: function () { return available ? 'localStorage' : '内存（刷新即丢失）'; },
    on: on, items: items, get: get, add: add, replace: replace,
    remove: remove, duplicate: duplicate, indexOf: indexOf,
    asset: asset, setAsset: setAsset, assetBytes: assetBytes, usage: usage,
    envelope: envelope, toJSON: toJSON,
    settings: settings, setSetting: setSetting,
    _data: function () { return data; }
  };
})();
