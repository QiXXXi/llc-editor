/* 卡片渲染 —— 预览和导 PNG 共用这一份代码。
 *
 * 为什么只有 Canvas 一套渲染器：
 *   零依赖的前提下，把 DOM 转成 PNG 只能走 SVG foreignObject，一遇到外链图片或
 *   字体就炸。而且写两套（DOM 预览 + Canvas 导出）必然慢慢跑偏，最后变成
 *   「预览挺好看，导出来不对」。改成只有 Canvas：预览按 devicePixelRatio 画，
 *   导出按 2x 画，同一份布局代码，位级一致。
 *
 * 布局用「先量后画」：Surface 带一个 dry 标志，dry 模式下所有绘制调用被跳过，
 * 但 y 游标照样推进，于是跑一遍就能拿到总高度。然后按这个高度建真画布再画一遍。
 *
 * 卡片里的图片一律是 data URL —— 灰机 CDN 的外链图画进 canvas 会污染画布，
 * toBlob 直接抛 SecurityError。种子里的立绘/图标在构建时就已经转成 data URL 了。
 *
 * ---------------------------------------------------------------- 为什么坐标那么怪
 *
 * 技能块那一堆 `SK.*` 常数（35 / 0 / 75 / 80 / 115 / 20 …）**不是调出来的，是
 * 从灰机页面上量出来的**：`{{技能链接}}` 模板把技能渲染成一坨内联样式的绝对定位
 * 元素，用浏览器把每个元素的 getBoundingClientRect() 打出来，就得到这些数字。
 * 量出来的原始表留在 `_ref/huiji/probe/measure.json`（还有同目录下的几个
 * `tpl_*.txt`，那是灰机模板本身的源码）。所以卡片正文宽度定成 893（灰机技能
 * 容器 `.3` 的实测宽度），这些像素值可以原样照抄，不用按卡片宽度缩放。
 *
 * 同理，正文 16px、行高 27.7、状态图标 15px、硬币图标 30px、技能名 17.6px 粗体
 * 带 1.6px 字距 —— 全是灰机上的实测值。用户的要求是「跟网页几乎一致」，那就不该
 * 自己发明一套排版尺寸。
 */
var Card = (function () {
  'use strict';

  var FONT_STACK = '"Microsoft YaHei","微软雅黑","PingFang SC","Noto Sans CJK SC","Source Han Sans SC",sans-serif';
  /* 只用系统字体。CJK 网络字体 5~20 MB，塞进单文件不现实；更要命的是
   * 字体异步加载完成前 canvas 会静默回退到别的字体，直接制造「预览 ≠ 导出」。 */

  var PAD = 14;
  var W_DEFAULT = 921;            // 893（灰机技能容器宽度）+ 左右各 14px 内边距
  var BODY_SIZE = 16;             // 灰机正文就是 16px
  /* 行高 = 16 × 1.8 = 28.8。真站 DragonHide 皮肤写死了 `#content p{line-height:1.8}`
   * （见 _ref/huiji/css/skin.css），页面上实测相邻两行的字顶间距也正是 28.8。
   * 缓存页的 `<link href="/load.php?…">` 是相对路径、file:// 下必然 404，整站样式
   * 加载不上，行高退回 `normal`（21px 上下），以前就是照那个量出差值来的。
   * 量灰机一律走 tools/wiki_page.py。 */
  var LINE_H = 28.8;
  /* 带 30px 硬币图标那行**高出来的部分**：硬币比行盒高，行内图片又坐在基线上、
   * 下面还挂着一截，把下一行多顶下去 1.9px，所以那一行实占总高 28.8 + 1.9 = 30.7
   * （实测：前后两行的字顶间距 30.7，硬币图顶间距 30.6）。
   * 注意**这一行自己的字并不下移** —— 字顶仍旧落在上一行 + 28.8 的位置，
   * 所以画的时候基线用 LINE_H 算，只有推进量换成这个值。 */
  var COIN_LINE_H = 30.7;

  /* 数值一律收敛成 number|null 再排版。存档里的 '  +3' / '' / null 都可能出现，
   * 直接拼字符串会印出 '++3' 或者一个空格。 */
  function _num(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /* 主题。卡片自己管配色，不去读 CSS 变量 —— canvas 拿不到那些值。 */
  var THEMES = {
    dark: {
      bg: '#15181d', panel: '#1d2129', panelAlt: '#22262f',
      line: '#333a45', fg: '#e8eaed', dim: '#98a1ad', faint: '#6b7480',
      accent: '#d8b56a', head: '#11141a',
      chipBg: '#313848', chipText: '#f2f4f7',
      /* 除名词条（被划掉的关键词）的红。灰机页面上写死的就是这个色号：
       * <span style="color:#d40000"><s>大师</s></span>，深浅两套主题共用它 ——
       * 灰机自己就是拿它在白底正文和 #222 的表格里通用的，别自己调。 */
      del: '#d40000',
      /* 技能名横幅没贴图可画时的描边色（底色现在用罪孽色，不再用主题色） */
      bannerEdge: '#6b4c2a',
      tabOnBg: '#352514', tabOnFg: '#fe9232', tabBg: '#090604', tabFg: '#d6ba9a'
    },
    light: {
      bg: '#f7f8fa', panel: '#ffffff', panelAlt: '#eef1f5',
      line: '#d6dbe3', fg: '#1c2026', dim: '#5b636e', faint: '#8b939e',
      accent: '#9a7327', head: '#eceff3',
      chipBg: '#dfe4ec', chipText: '#2a303a',
      del: '#d40000',
      bannerEdge: '#b9a586',
      tabOnBg: '#352514', tabOnFg: '#fe9232', tabBg: '#090604', tabFg: '#d6ba9a'
    }
  };

  /* 彩色底上该配黑字还是白字。罪人配色的明暗差得离谱（堂吉诃德 #ffef23 对
   * 默尔索 #293b95），写死一种必然有一半看不清。按感知亮度阈值切。 */
  function onColor(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return '#fff';
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return '#fff';
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#12151a' : '#ffffff';
  }

  /* 中文禁则：这些标点不能出现在行首 / 行尾。 */
  var NO_LINE_START = '，。、）」』》〉】〕！？：；…—·%’”、,.;:!?)]}';
  var NO_LINE_END = '（「『《〈【〔‘“‘([{';
  /* 成串不拆的 ASCII 字符（数字、字母、以及紧贴数字的符号）。 */
  var WORD_CHAR = /[0-9A-Za-z_+\-.%×/~]/;

  /* ---------------------------------------------------------------- 图标资源
   *
   * 图标不是「画」出来的而是贴上去的：种子里的每一张都在构建时转成了 data URL，
   * 由 app.js 建成 HTMLImageElement 之后交给 setAssets()。
   *
   * 关键约定：**版式只认图标名字在不在表里，不认它加载完没有**。
   * 量高度那一遍（dry）和真画那一遍必须得出同一个结果，否则画布高度就不对了；
   * 图片可能还在解码，所以「有没有这张图」只能看 key 存在与否。
   * 名字查得到但还没解码完的，那几像素就空着，下一帧自然补上。
   */
  var ICONS = {};               // 图标名 → HTMLImageElement
  var STATUS_ICON = {};         // 状态文字名 → 兜底图标名（Data:Buff.tabx 的 image）

  function setAssets(a) {
    a = a || {};
    ICONS = a.icons || {};
    STATUS_ICON = a.status || {};
  }

  function hasIcon(name) { return !!(name && ICONS[name]); }

  function imgOf(name) {
    var im = name ? ICONS[name] : null;
    return (im && im.naturalWidth) ? im : null;
  }

  /* 状态效果用哪张图标：token 里写了就用它，没写就用文字名，再查一遍兜底表。 */
  function statusIconName(st) {
    if (st.plain) return '';
    if (hasIcon(st.icon)) return st.icon;
    var alt = STATUS_ICON[st.text];
    return hasIcon(alt) ? alt : '';
  }

  /* 把图标塞进给定矩形。fit=true 保持比例居中，否则拉伸。 */
  function drawImg(s, name, x, y, w, h, fit) {
    var im = imgOf(name);
    if (!im || s.dry) return;
    var c = s.ctx;
    if (!fit) { c.drawImage(im, x, y, w, h); return; }
    var k = Math.min(w / im.naturalWidth, h / im.naturalHeight);
    var dw = im.naturalWidth * k, dh = im.naturalHeight * k;
    c.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /* 定宽、高度跟着贴图自己的比例走。技能框那两张框类贴图（描边框 / 底色板）
   * 灰机写的都是 `[[file:X.png|75px]]` 这种只给宽度的写法，而八张框图的原始
   * 比例并不一致（80×79 ~ 80×93），按固定高宽画会变形，所以必须走这个。 */
  function drawImgW(s, name, x, y, w) {
    var im = imgOf(name);
    if (!im || s.dry) return;
    s.ctx.drawImage(im, x, y, w, w * im.naturalHeight / im.naturalWidth);
  }

  /* ---------------------------------------------------------------- 折行 */

  function isWordChar(ch) { return WORD_CHAR.test(ch); }

  /* 把文本切成「可断点单元」：ASCII 词成串，其余逐字。 */
  function tokenize(text) {
    var toks = [];
    var buf = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (isWordChar(ch)) { buf += ch; continue; }
      if (buf) { toks.push({ t: buf, w: true }); buf = ''; }
      if (ch === ' ') { toks.push({ t: ' ', w: false, space: true }); continue; }
      toks.push({ t: ch, w: false });
    }
    if (buf) toks.push({ t: buf, w: true });
    return toks;
  }

  /* 按宽度断行，之后跑一遍禁则修正。返回字符串数组。 */
  function wrap(ctx, text, maxW, maxLines) {
    if (text === null || text === undefined) return [];
    var out = [];
    var paras = String(text).split('\n');
    for (var p = 0; p < paras.length; p++) {
      var toks = tokenize(paras[p]);
      var line = '';
      for (var i = 0; i < toks.length; i++) {
        var cand = line + toks[i].t;
        if (line !== '' && ctx.measureText(cand).width > maxW) {
          var carry = '';
          while (line.length > 1 && NO_LINE_END.indexOf(line[line.length - 1]) >= 0) {
            carry = line[line.length - 1] + carry;
            line = line.slice(0, -1);
          }
          out.push(line);
          line = (toks[i].space ? '' : toks[i].t) + carry;
          carry = '';
        } else {
          line = cand;
        }
      }
      out.push(line);
    }
    for (var j = 1; j < out.length; j++) {
      while (out[j].length && NO_LINE_START.indexOf(out[j][0]) >= 0) {
        out[j - 1] += out[j][0];
        out[j] = out[j].slice(1);
      }
    }
    out = out.filter(function (s, k) { return s !== '' || k < out.length - 1; });
    if (maxLines && out.length > maxLines) {
      out = out.slice(0, maxLines);
      out[maxLines - 1] = _ellipsize(ctx, out[maxLines - 1] + '…', maxW);
    }
    return out;
  }

  function _ellipsize(ctx, s, maxW) {
    var t = s;
    while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -1);
    return t;
  }

  /* 旧的 `**粗体**` 折行接口，给 smoke_test 用，卡片内部走下面的原子流。 */
  function richRuns(text) {
    var runs = [];
    var re = /\*\*([^*]+)\*\*/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) runs.push({ t: text.slice(last, m.index), b: false });
      runs.push({ t: m[1], b: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) runs.push({ t: text.slice(last), b: false });
    return runs.length ? runs : [{ t: text, b: false }];
  }

  function wrapRich(ctx, text, maxW, baseFont, boldFont, maxLines) {
    var runs = richRuns(String(text === null || text === undefined ? '' : text));
    var lines = [];
    var line = [];
    var width = 0;

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      ctx.font = run.b ? boldFont : baseFont;
      var toks = tokenize(run.t);
      for (var i = 0; i < toks.length; i++) {
        var tk = toks[i];
        var tw = ctx.measureText(tk.t).width;
        if (width + tw > maxW && line.length) {
          lines.push(line);
          line = [];
          width = 0;
          if (tk.space) continue;
        }
        line.push({ t: tk.t, b: run.b });
        width += tw;
      }
    }
    if (line.length) lines.push(line);
    if (!lines.length) lines = [[]];

    for (var j = 1; j < lines.length; j++) {
      while (lines[j].length && lines[j][0].t.length &&
             NO_LINE_START.indexOf(lines[j][0].t[0]) >= 0) {
        var move = { t: lines[j][0].t[0], b: lines[j][0].b };
        lines[j][0].t = lines[j][0].t.slice(1);
        if (!lines[j][0].t) lines[j].shift();
        lines[j - 1].push(move);
      }
    }
    lines = lines.filter(function (l) { return l.length; });
    if (!lines.length) lines = [[]];
    if (maxLines && lines.length > maxLines) lines = lines.slice(0, maxLines);
    return lines;
  }

  /* ---------------------------------------------------------------- Surface */

  /* 带 y 游标的绘制面。dry=true 时只推进游标不落笔 —— 这就是「先量」。 */
  function Surface(ctx, dry) {
    this.ctx = ctx;
    this.dry = dry;
    this.y = 0;
    this.w = 0;
    this.t = THEMES.dark;
  }

  Surface.prototype.font = function (size, weight) {
    this.ctx.font = (weight ? weight + ' ' : '') + size + 'px ' + FONT_STACK;
  };

  Surface.prototype.measure = function (text) {
    return this.ctx.measureText(String(text === null || text === undefined ? '' : text)).width;
  };

  Surface.prototype.fillRect = function (x, y, w, h, color) {
    if (this.dry) return;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  };

  Surface.prototype.roundRect = function (x, y, w, h, r, color) {
    if (this.dry) return;
    var c = this.ctx;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
    c.fill();
  };

  Surface.prototype.strokeLine = function (x1, y1, x2, y2, color, width) {
    if (this.dry) return;
    var c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = width || 1;
    c.beginPath();
    c.moveTo(x1, y1 + 0.5);
    c.lineTo(x2, y2 + 0.5);
    c.stroke();
  };

  /* 文字。基线统一用 middle —— 灰机那边靠行盒居中，算 ascent 反而容易差几像素。 */
  Surface.prototype.text = function (str, x, y, color, size, weight, align) {
    if (this.dry) return 0;
    var c = this.ctx;
    this.font(size, weight);
    c.fillStyle = color;
    c.textAlign = align || 'left';
    c.textBaseline = 'middle';
    c.fillText(str, x, y);
    return c.measureText(str).width;
  };

  /* 逐字加字距地画。灰机技能名是 `letter-spacing:1.6px`，canvas 的
   * ctx.letterSpacing 老浏览器没有、且不参与 measureText 会导致量画不一致，
   * 所以自己来：量出来的宽度和画出来的宽度天然一致。 */
  Surface.prototype.tracked = function (str, x, y, tracking, color, size, weight, align) {
    var n = str.length;
    if (!n) return 0;
    this.font(size, weight);
    var w = 0, i;
    for (i = 0; i < n; i++) w += this.measure(str[i]) + tracking;
    w -= tracking;
    var sx = x;
    if (align === 'center') sx = x - w / 2;
    if (align === 'right') sx = x - w;
    if (!this.dry) {
      var c = this.ctx;
      c.fillStyle = color;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      var cx = sx;
      for (i = 0; i < n; i++) { c.fillText(str[i], cx, y); cx += this.measure(str[i]) + tracking; }
    }
    return w;
  };

  /* 带黑描边的文字。灰机给技能数值挂的是 8 向 text-shadow（2px 一圈 + 1.4px 对角），
   * 目的就是在任意底色上都读得出来。 */
  Surface.prototype.outlined = function (str, x, y, color, size, weight, align, tracking) {
    if (this.dry) {
      return tracking === undefined
        ? (this.font(size, weight), this.measure(str))
        : (this.font(size, weight), this._trackedW(str, tracking));
    }
    var c = this.ctx;
    var offs = [[2, 0], [-2, 0], [0, 2], [0, -2],
                [1.4, 1.4], [1.4, -1.4], [-1.4, 1.4], [-1.4, -1.4]];
    var w;
    for (var i = 0; i < offs.length; i++) {
      w = this.tracked(str, x + offs[i][0], y + offs[i][1], tracking || 0,
                       '#000000', size, weight, align);
    }
    return this.tracked(str, x, y, tracking || 0, color, size, weight, align);
  };

  /* 只量宽度、不落笔。调用前得自己把 font 设好。 */
  Surface.prototype._trackedW = function (str, tracking) {
    var w = 0;
    for (var i = 0; i < str.length; i++) w += this.measure(str[i]) + tracking;
    return str.length ? w - tracking : 0;
  };

  /* 带字距的宽度，**纯量不画**。要量宽度时别拿 tracked() 顶替 —— 那个是真画，
   * 量宽度的调用点都传 (0,0)，于是每量一次就在卡片左上角糊一层黑字。 */
  Surface.prototype.trackedW = function (str, tracking, size, weight) {
    this.font(size, weight);
    return this._trackedW(String(str), tracking);
  };

  /* 圆角小标签，返回宽度。`opts.strike` 会在文字正中压一道横线。 */
  Surface.prototype.chip = function (text, x, y, opts) {
    opts = opts || {};
    var size = opts.size || 12;
    this.font(size, opts.weight || '');
    var tw = this.measure(text);
    var padX = opts.padX === undefined ? 8 : opts.padX;
    var h = opts.height || 21;
    var w = tw + padX * 2;
    this.roundRect(x, y, w, h, opts.radius === undefined ? 4 : opts.radius,
      opts.bg || this.t.panelAlt);
    this.text(text, x + w / 2, y + h / 2, opts.color || this.t.fg, size,
      opts.weight || '', 'center');
    if (opts.strike) {
      /* 只用 text 的宽度、不含 padX —— 横线压在字上，不该顶到标签边上 */
      this.strokeLine(x + (w - tw) / 2, y + h / 2, x + (w + tw) / 2, y + h / 2,
        opts.color || this.t.fg, 1.4);
    }
    return w;
  };

  /* 画一张图，按 cover 裁进矩形。没有图就画占位块。 */
  function drawCover(s, img, x, y, w, h, radius, placeholder) {
    if (!img || !img.width || !img.height) {
      s.roundRect(x, y, w, h, radius, placeholder.bg || s.t.panelAlt);
      s.text(placeholder.text || '', x + w / 2, y + h / 2,
        placeholder.color || s.t.faint, 14, '', 'center');
      return;
    }
    if (s.dry) return;
    var c = s.ctx;
    c.save();
    s.roundRect(x, y, w, h, radius, s.t.panelAlt);
    c.beginPath();
    var r = Math.min(radius, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
    c.clip();
    var scale = Math.max(w / img.width, h / img.height);
    var dw = img.width * scale, dh = img.height * scale;
    c.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    c.restore();
  }

  /* ---------------------------------------------------------------- 原子流
   *
   * 效果正文在灰机上是一条自由折行的 `<p>`，里面混着三种东西：
   *     普通文字 / `<img 硬币N.png 30px>` / 状态效果的「图标 + 彩字 + 双色下划线」
   * 所以要折行就得先把它们拆成**原子**，一个原子是不可再分的排版单位。
   *
   * 原子的形状：
   *     {k:'t',  s}                      普通文字
   *     {k:'tr', s}                      触发时机标签，画成 `[命中时]`，颜色查 wiki 表
   *     {k:'st', st}                     状态效果，st 是 Enums.parseStatus() 的结果
   *     {k:'cn', n}                      硬币序号，画成 硬币N.png
   */
  var STATUS_ICON_PX = 15;        // 灰机状态图标固定 15px 宽
  var COIN_ICON_PX = 30;          // 灰机硬币图标固定 30px

  function pushTextAtoms(out, str) {
    if (!str) return;
    var toks = tokenize(str);
    for (var i = 0; i < toks.length; i++) {
      out.push({ k: 't', s: toks[i].t, sp: !!toks[i].space });
    }
  }

  /* 一段带 `**状态**` 标记的正文 → 原子序列。 */
  function textAtoms(str) {
    var out = [];
    str = String(str === null || str === undefined ? '' : str);
    var re = /\*\*([^*]+)\*\*/g;
    var last = 0, m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) pushTextAtoms(out, str.slice(last, m.index));
      out.push({ k: 'st', st: Enums.parseStatus(m[1]) });
      last = m.index + m[0].length;
    }
    if (last < str.length) pushTextAtoms(out, str.slice(last));
    return out;
  }

  function atomW(s, a, size) {
    if (a.k === 't') { s.font(size); return s.measure(a.s); }
    if (a.k === 'tr') { s.font(size); return s.measure('[' + a.s + ']'); }
    if (a.k === 'cn') return COIN_ICON_PX * (size / BODY_SIZE);
    if (a.k === 'st') {
      s.font(size);
      var w = s.measure(a.st.text);
      if (a.st.plain) return w;
      if (statusIconName(a.st)) w += STATUS_ICON_PX * (size / BODY_SIZE);
      return w;
    }
    return 0;
  }

  /* 贪心断行。返回二维原子数组。 */
  function flowAtoms(s, atoms, maxW, size) {
    var lines = [], line = [], w = 0;
    for (var i = 0; i < atoms.length; i++) {
      var a = atoms[i];
      var aw = atomW(s, a, size);
      if (w + aw > maxW && line.length) {
        lines.push(line);
        line = []; w = 0;
        if (a.k === 't' && a.sp) continue;      // 行首不留空格
      }
      line.push(a); w += aw;
    }
    lines.push(line);
    return lines;
  }

  /* 画一行原子。返回画到的 x。 */
  function drawAtoms(s, line, x, y, size, color) {
    var cx = x;
    for (var i = 0; i < line.length; i++) {
      var a = line[i];
      if (a.k === 't') {
        cx += s.text(a.s, cx, y, color, size, '');
      } else if (a.k === 'tr') {
        /* 触发时机：灰机渲染成 `<span style="color:C">[命中时]</span>`，
         * 颜色查「模板:颜色」，查不到就退回正文色（不瞎猜一个颜色出来）。 */
        var tc = Enums.triggerColor(a.s) || color;
        cx += s.text('[' + a.s + ']', cx, y, tc, size, '');
      } else if (a.k === 'cn') {
        var w = atomW(s, a, size);
        drawImg(s, '硬币' + a.n, cx, y - w / 2, w, w, true);
        cx += w;
      } else if (a.k === 'st') {
        cx = drawStatus(s, a.st, cx, y, size, color);
      }
    }
    return cx;
  }

  /* 一个状态效果：图标 + 分类色文字 + 「黑线托彩线」的双层下划线。
   * 灰机的模板是内外两层 span 各挂一条 border-bottom，叠起来就是那个观感。 */
  function drawStatus(s, st, x, y, size, fallback) {
    var cx = x;
    if (!st.plain) {
      var ic = statusIconName(st);
      if (ic) {
        var iw = STATUS_ICON_PX * (size / BODY_SIZE);
        var im = imgOf(ic);
        var ih = im ? iw * im.naturalHeight / im.naturalWidth : iw;
        if (im && !s.dry) s.ctx.drawImage(im, cx, y - ih / 2, iw, ih);
        cx += iw;
      }
    }
    var col = st.color || fallback;
    var w = s.text(st.text, cx, y, col, size, '');
    if (!s.dry) {
      var c = s.ctx;
      var y0 = y + size * 0.42;                 // 下划线贴着基线往下一点
      c.fillStyle = col;                        // 内层：分类色 1.5px
      c.fillRect(cx, y0, w, 1.5);
      c.fillStyle = Enums.STATUS_UNDERLINE || '#000000';   // 外层：黑 2.5px
      c.fillRect(cx, y0 + 1.5, w, 2.5);
    }
    return cx + w;
  }

  /* 一段富文本段落，返回占用高度。 */
  function para(s, atoms, x, y, maxW, size, color) {
    var lines = flowAtoms(s, atoms, maxW, size);
    for (var i = 0; i < lines.length; i++) {
      drawAtoms(s, lines[i], x, y + size * 0.62, size, color);
      y += LINE_H;
    }
    return { h: lines.length * LINE_H, y: y };
  }

  /* ---------------------------------------------------------------- 分区标题 */

  function sectionHead(s, title, x, w) {
    s.y += 10;
    s.fillRect(x, s.y, 3, 14, s.t.accent);
    s.text(title, x + 10, s.y + 7, s.t.fg, 14, 'bold');
    s.y += 20;
    s.strokeLine(x, s.y - 4, x + w, s.y - 4, s.t.line);
  }

  /* 一排小标签，放不下自动换行。全部等高，返回占用高度。 */
  /* `~~…~~` 是删除线，跟 Markdown 一个写法。灰机把已除名的词条划掉（鸿璐蜘蛛巢
   * 环指父辈的「大师」、鸿璐鸿园的君主的「贾家」都是这么来的），标记的方式就是
   * `<s>` 标签，由 tools/parse_seed.py 的 html_to_text() 在解析时转成 `~~`。
   * 划掉的同时整块要变成灰机那个红（`t.del`），两边都跟着 wiki 走。
   *
   * 手写 `~~` 和内置数据因此走的是同一条路 —— 卡片这边不认识 HTML，只认这个记号。
   * 返回若干段 `{t, strike}`；没有成对的 `~~` 时就是原样一段（未闭合的 `~~` 当普通
   * 文字，别把用户打了一半的输入吃掉）。 */
  function splitStrike(text) {
    var str = String(text), out = [], last = 0, m;
    var re = /~~([^~]*)~~/g;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) out.push({ t: str.slice(last, m.index), strike: false });
      if (m[1]) out.push({ t: m[1], strike: true });
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push({ t: str.slice(last), strike: false });
    return out.length ? out : [{ t: str, strike: false }];
  }

  function chipFlow(s, x, y, w, items) {
    var H = 19, gap = 6, padX = 7;
    var cy = y, cx = x, rows = 1;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var size = it.size || 11;
      s.font(size, it.weight || '');
      var cw = s.measure(it.t) + padX * 2;
      if (cx > x && cx + cw > x + w) { cx = x; cy += H + gap; rows++; }
      s.chip(it.t, cx, cy, {
        bg: it.bg || s.t.panelAlt, color: it.color || s.t.fg, size: size,
        weight: it.weight || '', height: H, padX: padX, strike: !!it.strike
      });
      cx += cw + gap;
    }
    return rows * (H + gap);
  }

  /* ---------------------------------------------------------------- 技能块
   *
   * 下面这张表就是灰机技能块的**全部几何**，单位 CSS 像素，相对技能块左上角。
   * 每一行的出处都在 `_ref/huiji/probe/measure.json` 里（对活页面量的）。改动前
   * 先去核一遍，别凭眼睛调。
   */
  var SK = {
    /* 六边形框那个 75×80 的 div（`模板:攻击技能text` 里 margin-left:35px）的外框。
     * 框、六边形贴图、底色板三张图各自的摆位**逐罪孽逐等级都不一样**，在
     * const.js 的 SIN_GEOM 里，这里只留块级的那两个数。 */
    frameX: 35, frameY: 0,
    /* 技能名横幅：贴图 9 切片，左端盖 9px、右端盖 55px、中间 repeat-x（最短 160） */
    bannerX: 115, bannerY: 20, bannerH: 32, capL: 9, capR: 55, minMid: 160,
    bannerTextX: 124, bannerTextY: 34, bannerSize: 17.6, bannerTrack: 1.6,
    /* 修正值 / 攻击容量 那一行。这四个 y 是三种不同的对齐线，灰机那行里
     * 「装备图标顶」「修正值字」「攻击容量三个字」「黄方块」各在各的高度上，
     * 不是一个中线能盖住的（实测 58 / 72 / 73 / 75.7），所以分开记。 */
    rowX: 115, rowY: 55,
    rowIconY: 3, rowModMid: 17, rowLabelMid: 18, rowCapMid: 20.7,
    /* 黄方块起排的 x，**相对修正值行左边**（灰机块坐标里的 287.2，行在 115） */
    capStartX: 172.2,
    modIcon: 35, capIcon: 20, modSize: 19.2, capColor: '#F0BC00',
    numColor: '#ECCCA3',
    /* 罪孽×攻击类型 暗色徽章。图 30×28，左边 55、顶 67.7（两块技能量下来一致） */
    badgeX: 55, badgeY: 67.7, badgeW: 30, badgeH: 28,
    /* 技能威力（框左边那个大数字）。灰机那个 div 是 30×51.8，但真正装字的
     * `<b>` 是 y 14~56 —— 字的中线在 35，不是 div 的中线 35.9。
     * 这里存「块顶」和「2×中线距离」，中线 = powerY + powerH/2 = 35。 */
    powerX: 0, powerY: 10, powerW: 30, powerH: 50, powerSize: 28.8,
    /* 硬币威力 / 硬币数。灰机那两个 div 都是 40×34.6 / 50×34.6，字在里面居中，
     * 所以纵坐标记「div 顶」和「半高」，中线 = 顶 + 半高。 */
    coinBoxH: 34.6,
    /* 硬币威力的字中线：div 顶 -25 + 半高 17.3 = -7.7（实测 -8） */
    coinPowX: 55, coinPowY: -25, coinPowW: 40, coinPowSize: 19.2,
    /* 硬币数改成横排硬币之后，垂直方向要对齐的是**硬币图**，不是数字：
     * 灰机那张 20px 的硬币在 y -5.2~14.8、中线 4.8，比 div 的中线（2.3）低 2.5
     * —— 行内图片坐在基线上，本来就不在 div 正中。所以 -15 + 2.5。
     * 数字那套（div 中线 2.3）留着做参考，别照着它摆硬币。 */
    coinCntX: 130, coinCntY: -12.5,
    coinIcon: 20, egoCoinIcon: 14,
    /* 硬币 / 攻击容量改成横排之后每枚（每格）之间的空隙，以及最多画几个：
     * 内置数据里硬币最多 9（Furioso-Replica）、容量最多 7，这个上限只是防止
     * 手滑填个天文数字把循环拖死。 */
    coinGap: 2, capGap: 3, maxPips: 20,
    /* 罪孽色菱形（框后面那坨旋转方块） */
    diaCX: 75, diaCY: 5, diaSize: 40, diaRot: 165,
    /* 帧内留白：上面那些负 y 的元素要地方待 */
    headRoom: 32,
    /* 效果正文那个 `<p>` 的顶（灰机实测 116.3）。第一行的基线落在
     * 116.3 + LINE_H/2 + 半个字高 = 137.2，灰机量出来是 137.3。 */
    bodyTop: 116.3
  };

  /* 技能贴图的六边形，抄灰机那八张图标模板里的 `clip-path`（八张一模一样），
   * 用**比例**存，因为要按裁剪框的宽高分别乘。 */
  var HEX = [[0.73, 0.04], [0.98, 0.40], [0.90, 0.80], [0.50, 1.00],
             [0.10, 0.80], [0.02, 0.40], [0.27, 0.04]];

  function sinCnOf(skill) {
    return (skill.sins && skill.sins.length) ? Enums.label('sins', skill.sins[0]) : '常规';
  }

  function sinColorOf(skill, fallback) {
    return (skill.sins && skill.sins.length) ? Enums.color('sins', skill.sins[0]) : fallback;
  }

  /* 普通防御 / 闪避走灰机的 模板:技能text —— 它跟 攻击技能text 有两处不同：
   * 数值行用「守备」图标，而且**没有**罪孽×攻击类型徽章。反击（counter_*）
   * 走的是攻击技能text，不吃这一套。
   *
   * 技能框**不在这里**退回「常规」：模板默认值确实是中性的无属性框，但守备技能
   * 在同步Ⅳ 本来就有罪孽属性（奥提斯的「防御」是怠惰），卡片只画同步Ⅳ，
   * 所以框照技能自己的罪孽画。见 drawSkillPane 里的 sinCn。 */
  function isPlainGuard(skill) {
    return skill.kind === 'def' &&
      (skill.defType === 'defend' || skill.defType === 'evade');
  }

  /* 灰机 模板:技能text 里那张 #switch 的常规值。 */
  var NEUTRAL_SIN_COLOR = '#a16a3b';

  /* 技能框：等级 1/2 走「{罪孽}-等级N」，等级 3（也就是 3 技能）走通用框。
   * 几何（框多宽、六边形贴图摆哪、底色板摆哪）逐罪孽逐等级都不同，全在
   * const.js 的 SIN_GEOM 里，这里只是取一档出来。 */
  function frameNames(sinCn, level) {
    return Enums.sinSkin(sinCn, level);
  }

  /* 徽章上的那个词是**伤害类型**（斩击/突刺/打击），守备技能也一样 ——
   * 灰机 品牌经理 的「默示」是反击·打击，徽章就是 `怠惰-打击-暗色`，
   * 不是「怠惰-防御-暗色」。防御 / 闪避只是判定方式，不参与徽章。 */
  function atkCnOf(skill) {
    return skill.atk ? Enums.label('atkTypes', skill.atk) : '';
  }

  function skillBadgeName(skill) {
    var sin = sinCnOf(skill), atk = atkCnOf(skill);
    if (!atk) return '';
    if (skill.kind === 'awaken' || skill.kind === 'corrode') return '技能-' + atk + '-' + sin;
    return sin + '-' + atk + '-暗色';
  }

  /* 技能名横幅的底图。
   *
   * 灰机那张 `BattleUI_CoinPopup_skillName.png` 本身是**白色**的，颜色是
   * `MediaWiki:Common.js` 在页面里逐像素乘上去的（`brightness=(R+G+B)/765`
   * 当权重，去乘 `COLOR_MAP[data-color]`）。这里不学它当场算：构建时
   * （parse_seed.py 的 `encode_banner_tints`）就把 8 张染色版内嵌好了，
   * 运行时只是按技能自己的罪孽挑一张 —— 色号和罪孽菱形、技能框是同一个。
   *
   * 底图只有 149×26（灰机自己也是拿它摊到 183.385×32），所以这里的小尺寸取整
   * 不必太讲究。 */
  function bannerAssetName(sinCn) {
    var n = '技能名-' + sinCn;
    if (hasIcon(n)) return n;
    if (hasIcon('技能名-常规')) return '技能名-常规';   // 认不出的罪孽退回中性色
    return 'BattleUI CoinPopup skillName';             // 再不行才是那张白图
  }

  /* 技能名横幅。贴图是 9 切片：左端盖 + repeat-x 的中段 + 右端盖。
   * 灰机把整张图缩到 183.385×32 再切片，所以切片位置要按同样的比例取。 */
  var BANNER_W = 183.385;
  function drawBanner(s, x, y, w, h, name, sinCn) {
    var t = s.t;
    var k = h / 32;
    var capL = SK.capL * k, capR = SK.capR * k;
    /* 只量宽度。这里以前是 `s.tracked(name, 0, 0, …)` —— 那是真画，于是**每一条
     * 技能横幅都在卡片左上角 (0,0) 糊一层黑字**，导出的图顶上那条罪人色横条上
     * 就爬满了半个字形的黑边。量宽度得走 trackedW()。 */
    var textW = s.trackedW(name, SK.bannerTrack, SK.bannerSize, 'bold');
    var midW = Math.max(SK.minMid * k, textW + 20 * k);
    var total = capL + midW + capR;
    var im = imgOf(bannerAssetName(sinCn));
    if (!s.dry) {
      if (im) {
        var c = s.ctx;
        c.drawImage(im, 0, 0, im.naturalWidth * (SK.capL / BANNER_W), im.naturalHeight,
          x, y, capL, h);
        c.drawImage(im, im.naturalWidth * (SK.capR ? (BANNER_W - SK.capR) / BANNER_W : 0.7), 0,
          im.naturalWidth * (SK.capR / BANNER_W), im.naturalHeight,
          x + capL + midW, y, capR, h);
        /* 中段也直接从图里取一条拉伸 —— 贴图本来就是一整条渐变，取样比平铺干净 */
        c.drawImage(im, im.naturalWidth * (SK.capL / BANNER_W), 0,
          im.naturalWidth * ((BANNER_W - SK.capR) / BANNER_W - SK.capL / BANNER_W),
          im.naturalHeight, x + capL, y, midW, h);
      } else {
        /* 底图还没解码完（或者素材缺失）时的垫底色：用罪孽色而不是白，
         * 不然卡片会先白一下再跳成彩色。 */
        s.fillRect(x, y, total, h, Enums.sinColor(sinCn) || NEUTRAL_SIN_COLOR);
        s.strokeLine(x, y, x + total, y, t.bannerEdge);
        s.strokeLine(x, y + h, x + total, y + h, t.bannerEdge);
      }
      /* 名字：灰机是 #FCE6CA + 1.6px 字距 + 三遍 1.6px 黑阴影 */
      s.ctx.save();
      s.ctx.textBaseline = 'middle';
      var tx = x + SK.bannerTextX - SK.bannerX;
      var ty = y + (SK.bannerTextY - SK.bannerY) * k;
      s.tracked(name, tx + 1.6 * k, ty + 1.6 * k, SK.bannerTrack * k, '#000000',
        SK.bannerSize, 'bold');
      s.tracked(name, tx, ty, SK.bannerTrack * k, '#FCE6CA', SK.bannerSize, 'bold');
      s.ctx.restore();
    }
    return total;
  }

  /* 修正值 / 攻击容量 那一行。左起：攻击图标 → 修正值 → 攻击容量 → 数值 → 容量图标。
   * 灰机用的是 `&nbsp;` 撑开（8 个约 29px），这里直接写等效像素间距。 */
  function drawValueRow(s, x, y, skill) {
    var t = s.t;
    drawImg(s, isPlainGuard(skill) ? '数值图标-守备' : '数值图标-攻击',
      x, y + SK.rowIconY, SK.modIcon, SK.modIcon, true);
    var cx = x + SK.modIcon;
    var mod = String(skill.mod === null || skill.mod === undefined ? '' : skill.mod).trim();
    if (mod && mod !== '+0') {
      cx += s.outlined(mod, cx, y + SK.rowModMid, SK.numColor, SK.modSize, 'bold');
    }
    cx += 29;
    var wt = _num(skill.weight);
    if (wt !== null) {
      /* 攻击容量也画成**一横排黄方块**（`数值图标-攻击容量` 就是游戏里那个方块），
       * 不写数字 —— 几个方块就是几点，跟游戏里一个样。
       * 方块起排的位置直接按灰机那张图的 x 摆（`capStartX`），而不是「标签后面
       * 跟几个 px」：灰机在「攻击容量」和第一个方块之间留了 23px，不是 7。 */
      s.font(BODY_SIZE, '');
      cx += s.text('攻击容量', cx, y + SK.rowLabelMid, SK.capColor, BODY_SIZE, '');
      cx = x + SK.capStartX;
      var mid = y + SK.rowCapMid;
      var wn = Math.min(Math.round(wt), SK.maxPips);
      for (var wi = 0; wi < wn; wi++) {
        drawImg(s, '数值图标-攻击容量', cx, mid - SK.capIcon / 2, SK.capIcon, SK.capIcon, true);
        cx += SK.capIcon + SK.capGap;
      }
      cx -= SK.capGap;   // 最后一个方块后面不留尾巴
    }
    return cx - x;
  }

  /* 一个技能块。tabLevel 决定用哪一级技能框（1/2/3，守备用 1）。
   *
   * 画几阶由 opts.stage 决定：默认只画同步Ⅳ 那一阶（一阶 = 一个完整的技能框，
   * 带自己的威力/硬币威力/效果）。要看全部阶段就一阶一框地往下排，每框顶上
   * 挂一个阶段标签 —— 灰机上那是四个页签，这里只能竖着摞。 */
  function drawSkillBlock(s, x, w, skill, tabLevel, opts) {
    opts = opts || {};
    var base = s.y;
    var idx = pickStages(skill, opts);
    if (!idx.length) idx = [null];        // 一阶数据都没有：也要出个空壳，别让技能凭空消失
    for (var i = 0; i < idx.length; i++) {
      if (i) {
        s.y += 8;
        s.strokeLine(x, s.y, x + w, s.y, s.t.line);
        s.y += 10;
      }
      if (idx.length > 1) {
        s.chip(stageLabel(skill, idx[i]), x, s.y, {
          bg: s.t.accent, color: onColor(s.t.accent), size: 11, weight: 'bold',
          height: 19, padX: 8
        });
        s.y += 22;
      }
      drawSkillPane(s, x, w, skill, tabLevel, idx[i], opts);
    }
    return s.y - base;
  }

  /* 一阶技能 = 灰机的一个 `.3` 容器 + 它下面的效果正文。 */
  function drawSkillPane(s, x, w, skill, tabLevel, stageIdx, opts) {
    var t = s.t;
    var base = s.y;                       // 块的顶（含 headRoom）
    var top = base + SK.headRoom;         // 灰机那个 `.3` 容器的顶
    var stage = stageIdx === null ? null : skill.stages[stageIdx];

    var plain = isPlainGuard(skill);
    /* 技能框取**这个技能自己的罪孽**，守备技能也一样。灰机上普通防御印的是中性
     * 的「无属性」框，但那是模板默认值 —— 守备技能在同步Ⅳ 本来就有罪孽属性
     *（奥提斯的「防御」是怠惰），卡片只画同步Ⅳ，所以直接把罪孽画出来。
     * `sinCnOf` 自己会在 sins 为空时退回「常规」。 */
    var sinCn = sinCnOf(skill);
    var frame = frameNames(sinCn, tabLevel);
    var rowX = x + SK.rowX;

    /* --- 1. 罪孽色菱形（z-index 0，最底下） --- */
    if (!s.dry) {
      var c = s.ctx;
      c.save();
      c.translate(x + SK.diaCX, top + SK.diaCY);
      c.rotate(SK.diaRot * Math.PI / 180);
      c.fillStyle = sinColorOf(skill, NEUTRAL_SIN_COLOR);
      c.fillRect(-SK.diaSize / 2, -SK.diaSize / 2, SK.diaSize, SK.diaSize);
      c.restore();
    }

    /* --- 2. 框的「底部」贴图（z-index -1，其实在框底下，先画） --- */
    if (frame) drawImgW(s, frame.bottom, x + frame.bx, top + frame.by, frame.framePx);

    /* --- 3. 修正值行（z-index 2） --- */
    drawValueRow(s, rowX, top + SK.rowY, skill);

    /* --- 4. 技能名横幅（z-index 2） --- */
    var name = skill.name || '（未命名）';
    s.font(SK.bannerSize, 'bold');
    drawBanner(s, x + SK.bannerX, top + SK.bannerY, w, SK.bannerH, name, sinCn);

    /* --- 5. 技能贴图（z-index auto）+ 六边形框（z-index 2）---
     *
     * 顺序不能反：灰机的 HTML 里框是 `position:absolute; z-index:2`、贴图是
     * `z-index:auto`（也就是 0），所以**框压在贴图上面**。两张框图也分工不同：
     * `-底部` 是实心六边形底板（z-index:-1，先画）、`{罪孽}-等级N` 是中间透明的
     * 描边+高光（后画）。贴图夹在中间被框的描边压住边缘，就是灰机那个样子；
     * 反过来画（先框后贴图）贴图会把描边盖掉。 */
    var iconName = skill.icon ? String(skill.icon) : '';
    if (frame && iconName && hasIcon(iconName) && !s.dry) {
      var cc = s.ctx;
      var ix = x + SK.frameX + frame.ml, iy = top + frame.mt;
      /* 六边形的多边形是按 `clip-path` 的百分比给的，解析的参照框是**那个 div 的
       * 边框盒**。div 里只有一个行内 `<img>`，高度就是行盒高 —— 真站 `#content p`
       * 的 `line-height:1.8` 让行盒正好等于图高（20 个裁剪框实测一律 60×60），
       * 所以百分比按**正方形**解析。曾经照缓存页（没有皮肤样式、行高退回 normal）
       * 量成 60×64 并据此把六边形纵向拉开过，那是错的。 */
      var bw = frame.px, bh = frame.px;
      cc.save();
      cc.beginPath();
      for (var i = 0; i < HEX.length; i++) {
        var px = ix + HEX[i][0] * bw;
        var py = iy + HEX[i][1] * bh;
        if (i === 0) cc.moveTo(px, py); else cc.lineTo(px, py);
      }
      cc.closePath();
      cc.clip();
      var im = imgOf(iconName);
      /* 贴图本身是不透明的整张立绘，裁成六边形就是灰机上的样子 */
      cc.drawImage(im, ix, iy, frame.px, frame.px);
      cc.restore();
    }
    if (frame) drawImgW(s, frame.frame, x + SK.frameX, top + SK.frameY, frame.framePx);

    /* --- 6. 罪孽×攻击类型 徽章（z-index 3）。普通防御/闪避没有这一块 --- */
    var badge = plain ? '' : skillBadgeName(skill);
    if (badge) drawImg(s, badge, x + SK.badgeX, top + SK.badgeY, SK.badgeW, SK.badgeH, true);

    /* --- 7. 技能威力 / 硬币威力 / 硬币数（z-index 3） --- */
    var power = stage ? _num(stage.power) : _num(skill.power);
    if (power !== null) {
      s.outlined(String(power), x + SK.powerX + SK.powerW,
        top + SK.powerY + SK.powerH / 2, SK.numColor, SK.powerSize, 'bold', 'right');
    }
    var cp = null;
    if (stage) cp = _num(stage.coinPower);
    if (cp === null) cp = _num(skill.coinPower);
    if (cp !== null) {
      s.outlined((cp >= 0 ? '+' : '') + cp, x + SK.coinPowX + SK.coinPowW / 2,
        top + SK.coinPowY + SK.coinBoxH / 2, SK.numColor, SK.coinPowSize, 'bold', 'center');
    }
    var coins = _num(skill.coins);
    if (coins !== null) {
      /* 硬币数画成**一横排硬币**（游戏里就是一枚一枚排出来的），不再写「硬币×N」
       * ——「×9」数一眼看不出几个，九枚硬币一眼就是九枚。第一枚仍然落在原来那个
       * 硬币的位置（`SK.coinCntX`），往后按 `coinIcon + coinGap` 的间距排。
       * 内置数据里最多 9 枚（李箱蜘蛛巢食指父辈的 Furioso-Replica），上限那个数
       * 只是防止手滑填个天文数字把循环拖死。 */
      var ccy = top + SK.coinCntY + SK.coinBoxH / 2;
      var cx2 = x + SK.coinCntX;
      var cn = Math.min(Math.round(coins), SK.maxPips);
      for (var ci = 0; ci < cn; ci++) {
        drawImg(s, '硬币', cx2, ccy - SK.coinIcon / 2, SK.coinIcon, SK.coinIcon, true);
        cx2 += SK.coinIcon + SK.coinGap;
      }
    }

    /* --- 8. 效果正文 --- */
    var y = top + SK.bodyTop;
    if (stage && stage.effects && stage.effects.length) {
      for (var e = 0; e < stage.effects.length; e++) {
        y = drawEffect(s, x, y, w, stage.effects[e], opts);
      }
    } else {
      y += LINE_H;
    }
    s.y = Math.max(y, top + SK.bodyTop) + 10;
    return s.y - base;
  }

  /* 一条效果。硬币图标 → [触发时机] → 正文，然后自由折行，和灰机的 `<p>` 一样。 */
  function drawEffect(s, x, y, w, eff, opts) {
    var t = s.t;
    var atoms = [];
    var coin = _num(eff.coin);
    if (coin !== null) atoms.push({ k: 'cn', n: coin });
    if (eff.trigger && eff.trigger !== 'none') atoms.push({ k: 'tr', s: eff.trigger });
    var body = textAtoms(eff.text);
    for (var i = 0; i < body.length; i++) atoms.push(body[i]);
    if (!atoms.length) return y;

    var lines = flowAtoms(s, atoms, w, BODY_SIZE);
    for (var L = 0; L < lines.length; L++) {
      var hasCoin = false;
      for (var q = 0; q < lines[L].length; q++) if (lines[L][q].k === 'cn') hasCoin = true;
      /* 基线一律按 LINE_H 算：带硬币那行的字并不比上一行多下移半行，它只是
       * **把下一行挤下去**了（见 COIN_LINE_H 的注释）。 */
      drawAtoms(s, lines[L], x, y + LINE_H / 2, BODY_SIZE, t.fg);
      y += hasCoin ? COIN_LINE_H : LINE_H;
    }
    return y;
  }

  /* ---------------------------------------------------------------- 阶段挑选 */

  /* 要画哪几个阶段。默认只画一个：**最高的那一阶**。
   *
   * 不是「同步Ⅳ / 解析Ⅳ」—— 人格的技能阶是 Ⅰ~Ⅳ，E.G.O 的技能阶是 Ⅰ/Ⅲ/Ⅳ/Ⅴ
   * （见 const.js 的 STAGES / EGO_STAGES，两边数组下标都是 0..3），所以「Ⅳ」
   * 这个下标在两类条目里指的不是同一档：人格的下标 3 是同步Ⅳ，E.G.O 的下标 3
   * 是**解析Ⅴ**。以前这里按 kind 写死下标（E.G.O 给 2 也就是解析Ⅳ），于是带
   * 解析Ⅴ的 E.G.O 全被压回了Ⅳ。现在统一从后往前找第一个有数据的，人格照样落
   * 在同步Ⅳ（下标 3），E.G.O 有Ⅴ就画Ⅴ、没Ⅴ就退到Ⅳ。
   *
   * 有些技能 wiki 上只写了 Ⅲ/Ⅳ，也有只写 Ⅰ/Ⅳ 的，所以是「最高的**已填**阶」
   * 而不是死取最后一格。用户明确说了「技能可以只保留最高解析阶段的样子」。 */
  function pickStages(skill, opts) {
    var stages = skill.stages || [];
    if (opts && opts.stage === 'all') {
      var all = [];
      for (var a = 0; a < stages.length; a++) if (stages[a].on) all.push(a);
      return all;
    }
    for (var i = stages.length - 1; i >= 0; i--) if (stages[i].on) return [i];
    return [];
  }

  function stageLabel(skill, i) {
    var ego = (skill.kind === 'awaken' || skill.kind === 'corrode');
    var names = ego ? Enums.EGO_STAGES : Enums.STAGES;
    return (ego ? '解析' : '同步') + (names[i] === undefined ? (i + 1) : names[i]);
  }

  /* ---------------------------------------------------------------- 技能组 */

  function tabName(i) { return Enums.SKILL_TABS[i - 1].cn; }
  function tabLevel(i) { return Enums.SKILL_TABS[i - 1].level; }

  /* 页签条。灰机上这条是 1技能 / 2技能 / 3技能 / 守备技能，**没有**四技能五技能 ——
   * 变体形态是挂在它自己那个序号底下的（见 const.js 的 slotTab）。
   * 高亮态直接抄灰机：底 #352514、字 #fe9232。 */
  function drawSkillTabs(s, x, y, tabKeys, cur) {
    var t = s.t;
    var H = 26, cx = x;
    for (var i = 0; i < tabKeys.length; i++) {
      var on = tabKeys[i] === cur;
      s.font(BODY_SIZE, 'bold');
      var tw = s.measure(tabName(tabKeys[i])) + 28;
      s.fillRect(cx, y, tw, H, on ? t.tabOnBg : t.tabBg);
      if (on) s.fillRect(cx, y, tw, 2, t.tabOnFg);
      s.text(tabName(tabKeys[i]), cx + tw / 2, y + H / 2 + 1,
        on ? t.tabOnFg : t.tabFg, BODY_SIZE, 'bold', 'center');
      cx += tw + 4;
    }
    return H;
  }

  /* ---------------------------------------------------------------- 被动 */

  /* 被动的效果文本按「取得阶数」分段 —— 灰机上是同步Ⅱ / 同步Ⅳ 两档，
   * 支援被动只有一档。空的那一档不画。 */
  function passiveParas(p, labels) {
    var out = [];
    for (var i = 0; i < p.stages.length; i++) {
      if (!p.stages[i].on || !p.stages[i].text) continue;
      out.push({ tag: labels[i] || ('阶段' + (i + 1)), text: p.stages[i].text });
    }
    return out;
  }

  var P_LABELS = ['同步Ⅰ', '同步Ⅱ', '同步Ⅲ', '同步Ⅳ'];

  /* E.G.O 被动的阶段标签。灰机 `模板:EGO被动链接` 里那一格是**写死的「异想解析阶段Ⅱ」**
   * —— E.G.O 被动在解析Ⅱ 解锁，116 个 E.G.O 页面翻下来全是这一档，不是从数据里取的。
   * 卡片跟着它走；用户自己再加一档的话往后续（解析Ⅲ/Ⅳ/Ⅴ 本来就是 E.G.O 的阶段名）。 */
  var EGO_P_LABELS = ['解析Ⅱ', '解析Ⅲ', '解析Ⅳ', '解析Ⅴ'];

  /* 被动名的颜色。人格那边是正文色；E.G.O 页面上这个名是灰机自己的橙
   * `#DC9012`（跟「【E.G.O觉醒】」那些标签同一个色），照抄。 */
  var EGO_P_NAME = '#DC9012';

  function drawPassive(s, x, w, p, tag, labels, nameColor) {
    if (!p || (!p.name && !p.stages.some(function (st) { return st.text; }))) return;
    var t = s.t;
    var top = s.y + 6;
    var innerX = x + 12;
    var innerW = w - 24;
    var paras = passiveParas(p, labels || P_LABELS);

    /* 先量高度：正文按原子流空跑一遍。 */
    var probe = new Surface(s.ctx, true);
    probe.t = t;
    var bh = 0;
    for (var q = 0; q < paras.length; q++) {
      bh += 19;
      var pl = String(paras[q].text).split('\n');
      for (var pk = 0; pk < pl.length; pk++) {
        bh += para(probe, textAtoms(pl[pk]), 0, 0, innerW, BODY_SIZE, t.fg).h;
      }
      bh += 4;
    }
    var total = 30 + bh + 6;

    s.roundRect(x, top, w, total, 6, t.panel);
    s.fillRect(x, top, 4, total, t.line);
    s.y = top + 8;

    var hx = innerX;
    hx += s.chip(tag || '战斗', hx, s.y, {
      bg: t.accent, color: onColor(t.accent), size: 11, weight: 'bold',
      height: 19, padX: 8
    }) + 6;

    /* 触发条件（共鸣 / 持有 / 常时）是灰机被动名字后面那个小标签。 */
    var cond = Enums.label('passCond', p.cond);
    if (cond) {
      hx += s.chip(cond, hx, s.y, {
        bg: t.panelAlt, color: t.dim, size: 10, height: 19, padX: 7
      }) + 6;
    }
    s.text(p.name || '（未命名被动）', hx, s.y + 9,
      p.name ? (nameColor || t.fg) : t.faint, 15, 'bold');

    /* 三格罪孽资源从右往左排，摆不下就不摆（宁可少了也不挤成一团）。 */
    var rc = x + w - 12;
    for (var i = 3; i >= 1; i--) {
      var aff = p.cost['aff' + i], num = p.cost['num' + i];
      if (!aff || !num) continue;
      var label = Enums.label('sins', aff) + ' ×' + num;
      s.font(10, 'bold');
      var cw = s.measure(label) + 14;
      if (rc - cw < hx + 150) break;
      s.chip(label, rc - cw, s.y, {
        bg: Enums.color('sins', aff), color: onColor(Enums.color('sins', aff)),
        size: 10, weight: 'bold', height: 19, padX: 7
      });
      rc -= cw + 5;
    }

    s.y = top + 30;
    for (var m = 0; m < paras.length; m++) {
      s.chip(paras[m].tag, innerX, s.y, {
        bg: t.chipBg, color: t.chipText, size: 10, weight: 'bold',
        height: 17, padX: 6
      });
      s.y += 19;
      var lines = String(paras[m].text).split('\n');
      for (var k = 0; k < lines.length; k++) {
        s.y = para(s, textAtoms(lines[k]), innerX, s.y, innerW, BODY_SIZE, t.fg).y;
      }
      s.y += 4;
    }
    s.y = top + total + 8;
  }

  /* ---------------------------------------------------------------- E.G.O 技能块
   *
   * E.G.O 页面上技能是**另一套表**（「升阶属性」），和人格技能块完全不像：
   *     一行  [罪孽色粗体名] [硬币×N] [理智消耗：图标 N] [攻击图标 修正值]
   *     一行  [技能立绘 70×70 + 亮色徽章 40]  |  [异想解析阶段Ⅰ…Ⅴ 页签 + 效果]
   * 所以单独一个函数，不去硬套人格那套绝对定位。
   */
  function drawEgoSkill(s, x, w, skill, opts, sp) {
    var t = s.t;
    var top = s.y + 6;
    var innerX = x + 12, innerW = w - 24;
    var sinCol = sinColorOf(skill, t.dim);

    /* 技能徽章（`罪孽-类型-暗色`）在灰机上挂在**立绘下面**那一格，不是标题行里。
     * 早先摆在标题行右边，长一点的技能名（「致智慧与苦难」）就直接压上去了。 */
    var badge = skillBadgeName(skill);

    /* 技能立绘。灰机上侵蚀技能没有单独的立绘文件（`{编号} corrode profile` 在
     * wiki 上不存在），用的还是觉醒那张，所以查不到就退回去。 */
    var iconName = '';
    if (skill.icon) {
      var nm = String(skill.icon);
      var want = nm + (skill.kind === 'corrode' ? ' corrode profile' : ' awaken profile');
      iconName = hasIcon(want) ? want : nm + ' awaken profile';
    }
    /* 立绘栏按**实际会不会画**留高度：新建的空白 E.G.O 没有立绘，留 70px 就是
     * 一片白。判据是 hasIcon（查键），量高度和真画两趟才会一致。 */
    var iconColH = (hasIcon(iconName) ? 70 : 0) + (badge ? 44 : 0);
    /* 立绘栏的宽度：没立绘就把这一栏收掉，别让正文白缩进去 78px。 */
    var colW = hasIcon(iconName) ? 78 : (badge ? 44 : 0);
    var ax = innerX + colW;
    var aw = innerW - colW;
    /* 左边的阶段页签是**竖着排**的（解析Ⅰ/Ⅲ/Ⅳ/Ⅴ），它比立绘高的时候整栏由它
     * 说了算 —— 高度和下面真画的循环必须用同一个 `on` 判据。 */
    var chipColH = 0;
    for (var st0 = 0; st0 < skill.stages.length; st0++) {
      if (skill.stages[st0].on) chipColH += 21;
    }
    var colH = Math.max(iconColH, chipColH);

    var probe = new Surface(s.ctx, true);
    probe.t = t; probe.y = 0;
    /* 量的宽度必须是**正文真实可用的宽度**（aw，扣掉立绘栏），不能拿 innerW
     * 去量 —— 否则折行数会比实际少，量出来的高度撑不住正文。 */
    var h = egoBodyH(probe, aw, skill, opts);
    var total = 30 + colH + 8 + h + 10;

    s.roundRect(x, top, w, total, 6, t.panel);
    s.fillRect(x, top, 4, total, sinCol);
    s.y = top + 8;

    /* 标题行。**先排右边那一串、再排标题**：`硬币×N / 理智消耗 / 修正值` 是右对齐
     * 的固定宽度，标题只能让着它。反过来的话长名字（「致智慧与苦难」之类）会直接
     * 压到数值上面去。 */
    var rc = x + w - 12;
    var mod = String(skill.mod === null || skill.mod === undefined ? '' : skill.mod).trim();
    if (mod) {
      s.font(15, 'bold');
      var mw = s.measure(mod);
      s.outlined(mod, rc, s.y + 9, SK.numColor, 15, 'bold', 'right');
      rc -= mw + 6;
      drawImg(s, '数值图标-攻击', rc - 35, s.y - 8, 35, 35, true);
      rc -= 35 + 10;
    }
    sp = _num(sp);
    if (sp !== null) {
      s.font(12, '');
      var sw = s.measure(String(sp));
      s.text(String(sp), rc, s.y + 9, SK.numColor, 12, '');
      rc -= sw + 4;
      drawImg(s, '理智值消耗', rc - 22, s.y - 2, 22, 21, true);
      rc -= 22 + 4;
      s.text('理智消耗：', rc, s.y + 9, t.dim, 12, '', 'right');
      rc -= s.measure('理智消耗：') + 10;
    }
    var coins = _num(skill.coins);
    if (coins !== null) {
      /* 同上，硬币数画成横排、不写数字。这一串是**从右往左**排的（`rc` 递减），
       * 所以硬币也倒着排：最后一枚贴着 `rc`，往左一枚一枚补。 */
      var cn2 = Math.min(Math.round(coins), SK.maxPips);
      for (var ci2 = 0; ci2 < cn2; ci2++) {
        drawImg(s, '硬币', rc - SK.egoCoinIcon, s.y + 3, SK.egoCoinIcon, SK.egoCoinIcon, true);
        rc -= SK.egoCoinIcon + SK.coinGap;
      }
      rc -= 8 - SK.coinGap;   // 收尾留白，跟改之前一样是 8
    }
    /* 标题：可用宽度 = 右边那串的左边界。摆不下先降字号，再不行才截断加省略号。 */
    var title = String(skill.name || '（未命名）');
    var room = Math.max(48, rc - innerX - 8);
    var tsize = 16;
    while (tsize > 10 && (s.font(tsize, 'bold'), s.measure(title)) > room) tsize--;
    if (s.measure(title) > room) {
      while (title.length > 1 && s.measure(title + '…') > room) title = title.slice(0, -1);
      title += '…';
    }
    s.text(title, innerX, s.y + 9, sinCol, tsize, 'bold');
    s.y += 30;

    drawImg(s, iconName, innerX, s.y, 70, 70, true);
    if (badge) drawImg(s, badge, innerX, s.y + (hasIcon(iconName) ? 74 : 4), 40, 38, true);
    var y = s.y;
    var picked = {};
    pickStages(skill, opts).forEach(function (i) { picked[i] = true; });
    for (var st = 0; st < skill.stages.length; st++) {
      if (!skill.stages[st].on) continue;
      var on = !!picked[st];
      s.chip(stageLabel(skill, st), ax, y, {
        bg: on ? t.accent : t.chipBg,
        color: on ? onColor(t.accent) : t.chipText,
        size: 11, weight: 'bold', height: 19, padX: 8
      });
      y += 21;
    }
    s.y = Math.max(s.y + colH, y);
    egoBody(s, ax, aw, skill, opts);
    s.y = Math.max(s.y, top + total) + 8;
  }

  function _egoParas(skill, opts) {
    var idx = pickStages(skill, opts);
    var out = [];
    for (var k = 0; k < idx.length; k++) {
      var st = skill.stages[idx[k]];
      out.push({ idx: idx[k], tag: stageLabel(skill, idx[k]),
                 stage: st, effects: st.effects || [] });
    }
    return out;
  }

  /* 一个解析阶段那三个数：基础值 / 硬币威力 / 攻击容量。
   *
   * 灰机上它们在页签里是**竖着三行**（`基础值：14<br>硬币威力：+6<br>攻击容量：1`），
   * 卡片压成一行 —— 跟人格技能那条数值行同一个样式，也省下两行高度。
   *
   * 攻击容量跟人格技能一样画成**黄方块横排**、不写数字；标签色用 E.G.O 页面自己的
   * `#ffe71b`（人格页面那条是 `#F0BC00`，两个黄不是同一个，别互相借）。 */
  var EGO_NUM_H = 24;
  var EGO_CAP_COLOR = '#ffe71b';

  function egoNums(st) {
    if (!st) return null;
    var pw = _num(st.power), cp = _num(st.coinPower), wt = _num(st.weight);
    if (pw === null && cp === null && wt === null) return null;
    return { pw: pw, cp: cp, wt: wt };
  }

  function drawEgoNums(s, x, y, st) {
    var n = egoNums(st);
    if (!n) return y;
    var t = s.t;
    var cy = y + EGO_NUM_H / 2;          // Surface.text 的 y 是字面中线
    var cx = x;
    if (n.pw !== null) {
      s.text('基础值：', cx, cy, t.dim, BODY_SIZE, '');
      cx += s.measure('基础值：');
      cx += s.text(String(n.pw), cx, cy, SK.numColor, BODY_SIZE, 'bold') + 14;
    }
    if (n.cp !== null) {
      s.text('硬币威力：', cx, cy, t.dim, BODY_SIZE, '');
      cx += s.measure('硬币威力：');
      cx += s.text((n.cp >= 0 ? '+' : '') + n.cp, cx, cy, SK.numColor,
        BODY_SIZE, 'bold') + 14;
    }
    if (n.wt !== null) {
      s.text('攻击容量', cx, cy, EGO_CAP_COLOR, BODY_SIZE, '');
      cx += s.measure('攻击容量') + 8;
      var wn = Math.min(Math.round(n.wt), SK.maxPips);
      for (var i = 0; i < wn; i++) {
        drawImg(s, '数值图标-攻击容量', cx, cy - SK.capIcon / 2,
          SK.capIcon, SK.capIcon, true);
        cx += SK.capIcon + SK.capGap;
      }
    }
    return y + EGO_NUM_H;
  }

  /* 只挑了一阶的时候正文前面不挂标签（灰机那张表的 RichTab 本来也只显示一页）；
   * 挑多阶才需要标签把每一阶分开。量高度和真画两处必须用同一个判断。 */
  function egoBodyH(s, w, skill, opts) {
    var paras = _egoParas(skill, opts);
    var multi = paras.length > 1;
    var y = 0;
    for (var i = 0; i < paras.length; i++) {
      if (multi) y += 21;
      if (egoNums(paras[i].stage)) y += EGO_NUM_H;
      var effs = paras[i].effects;
      for (var e = 0; e < effs.length; e++) {
        y += fakeEffectH(s, w, effs[e]);
      }
      y += 4;
    }
    return y;
  }

  function egoBody(s, x, w, skill, opts) {
    var t = s.t;
    var paras = _egoParas(skill, opts);
    var multi = paras.length > 1;
    var y = s.y;
    for (var i = 0; i < paras.length; i++) {
      if (multi) {
        s.chip(paras[i].tag, x, y, {
          bg: t.chipBg, color: t.chipText, size: 11, weight: 'bold',
          height: 19, padX: 8
        });
        y += 21;
      }
      y = drawEgoNums(s, x, y, paras[i].stage);
      var effs = paras[i].effects;
      for (var e = 0; e < effs.length; e++) {
        y = drawEffect(s, x, y, w, effs[e], opts);
      }
      y += 4;
    }
    s.y = y;
  }

  /* 量一条效果的高度（dry 跑一遍原子流）。 */
  function fakeEffectH(s, w, eff) {
    var atoms = [];
    var coin = _num(eff.coin);
    if (coin !== null) atoms.push({ k: 'cn', n: coin });
    if (eff.trigger && eff.trigger !== 'none') atoms.push({ k: 'tr', s: eff.trigger });
    var body = textAtoms(eff.text);
    for (var i = 0; i < body.length; i++) atoms.push(body[i]);
    if (!atoms.length) return 0;
    var lines = flowAtoms(s, atoms, w, BODY_SIZE);
    var h = 0;
    for (var L = 0; L < lines.length; L++) {
      var hasCoin = false;
      for (var q = 0; q < lines[L].length; q++) if (lines[L][q].k === 'cn') hasCoin = true;
      h += hasCoin ? COIN_LINE_H : LINE_H;
    }
    return h;
  }

  /* ---------------------------------------------------------------- 主流程 */

  function draw(s, item, opts) {
    opts = opts || {};
    var t = s.t = THEMES[opts.theme === 'light' ? 'light' : 'dark'];
    var W = opts.width || W_DEFAULT;
    s.w = W;

    s.fillRect(0, 0, W, 1e6, t.bg);

    var x = PAD, innerW = W - PAD * 2;

    /* ---- 头部 ---- */
    s.y = PAD;
    var shot = 116;
    var img = opts.image || null;
    drawCover(s, img, x, s.y, shot, shot, 6, {
      bg: t.panelAlt,
      text: item.sinner ? Enums.label('sinners', item.sinner) : '',
      color: item.sinner ? Enums.color('sinners', item.sinner) : t.faint
    });

    var hx = x + shot + 14;
    var hw = innerW - shot - 14;
    var cy = s.y;

    if (item.kind === 'identity') {
      var rar = Enums.item('rarity', item.rarity);
      if (rar) s.text(rar.cn, hx, cy + 10, t.accent, 15, 'bold');
    } else {
      var g = Enums.item('egoGrade', item.grade);
      var gw = s.chip(g ? g.cn : (item.grade || '？'), hx, cy, {
        bg: g ? g.color : t.panelAlt, color: g ? onColor(g.color) : t.fg,
        size: 12, weight: 'bold'
      });
      s.text('E.G.O', hx + gw + 8, cy + 10, t.dim, 13, 'bold');
    }
    s.y = cy + 26;

    var nameSize = 20;
    s.font(nameSize, 'bold');
    while (nameSize > 13 && s.measure(item.name || '') > hw) nameSize--;
    s.y = para(s, textAtoms(item.name || '（未命名）'), hx, s.y, hw, nameSize,
      item.name ? t.fg : t.faint).y;
    var sub = [];
    if (item.nameAlt) sub.push(item.nameAlt);
    if (item.sinner) sub.push(Enums.label('sinners', item.sinner));
    if (item.kind === 'identity' && item.org) sub.push(item.org);
    if (item.kind === 'ego' && item.origin) sub.push('源自 ' + item.origin);
    if (sub.length) {
      s.y = para(s, textAtoms(sub.join(' · ')), hx, s.y, hw, 13, t.dim).y;
    }
    var meta = [];
    if (item.code) meta.push({ t: '编号 ' + item.code });
    if (item.season) meta.push({ t: item.season });
    if (item.released) meta.push({ t: item.released });
    if (item.obtain) meta.push({ t: item.obtain });
    if (meta.length) {
      meta.forEach(function (m) { m.bg = t.panelAlt; m.color = t.faint; m.size = 10; });
      s.y += 4;
      s.y += chipFlow(s, hx, s.y, hw, meta) - 6;
    }
    if (item.sinner) s.fillRect(0, 0, W, 3, Enums.color('sinners', item.sinner));
    s.y = Math.max(s.y, PAD + shot) + 12;

    if (item.kind === 'identity') drawIdentityBody(s, item, x, innerW, opts);
    else drawEgoBody(s, item, x, innerW, opts);

    s.y += PAD - 8;
    return s.y;
  }

  /* 图标 + 数值 的一格：图标当标签用，数值跟在后面。 */
  function statCell(s, x, y, icon, value, color, size, iconW) {
    iconW = iconW || 30;
    drawImg(s, icon, x, y - iconW / 2, iconW, iconW, true);
    var cx = x + iconW + 6;
    if (value !== null && value !== undefined && value !== '') {
      cx += s.text(String(value), cx, y, color || s.t.fg, size || 16, 'bold');
    } else {
      cx += s.text('–', cx, y, s.t.faint, size || 16, 'bold');
    }
    return cx - x;
  }

  function drawIdentityBody(s, item, x, innerW, opts) {
    var t = s.t;

    /* ---- 能力值：能用图标的全用图标 ---- */
    var spd = item.spd || [];
    var stg = item.stagger || [];
    var anySpd = spd.some(function (v) { return v !== '' && v !== null && v !== undefined; });
    var anyStg = stg.some(function (v) { return v !== '' && v !== null && v !== undefined; });
    if (item.hp !== null || item.hpRate !== null || item.defRate !== null ||
        anySpd || anyStg) {
      sectionHead(s, '能力值', x, innerW);
      var y = s.y + 18;
      var cx = x;
      cx += statCell(s, cx, y, '数值图标-生命', item.hp, t.fg, 18) + 26;
      cx += statCell(s, cx, y, '数值图标-防御',
        item.defRate, t.fg, 18) + 26;
      if (anyStg) {
        s.text('混乱阈值', cx, y, t.dim, 14, '');
        cx += s.measure('混乱阈值') + 8;
        var vals = stg.filter(function (v) { return v !== '' && v != null; }).join('  ');
        cx += s.text(vals || '–', cx, y, t.fg, 16, 'bold') + 26;
      }
      if (anySpd) {
        /* 同步Ⅳ 的速度**灰机数据表里根本没填**：`Identitychoose.tabx` 的 u4_spd
         * 190 行里 189 行是空，而那唯一一行有值的也不是这一列的真实数据。灰机页面
         * 自己的办法是第 4 格直接复用第 3 格（同一个 `<span id="sinnerlevel10">`
         * 印两遍，见「品牌经理」页：3~6 / 3~7 / 4~7 / 4~7），卡片跟着它 ——
         * 总比自己印一个「–」强。数据真有值时当然用真值。 */
        var carry = '';
        for (var i = 0; i < 4; i++) {
          var sv = (spd[i] === '' || spd[i] === null || spd[i] === undefined)
            ? carry : spd[i];
          if (sv) carry = sv;
          drawImg(s, '数值图标-速度-' + (i + 1), cx, y - 15, 30, 30, true);
          cx += 30 + 4;
          cx += s.text(sv || '–', cx, y, sv ? t.fg : t.faint, 16, 'bold') + 14;
        }
      }
      s.y = y + 24;
      if (item.hpRate !== null && item.hpRate !== undefined && item.hpRate !== '') {
        s.text('体力系数 ' + item.hpRate, x, s.y, t.dim, 13, '');
        s.y += 20;
      }
    }

    /* ---- 特性关键词 ---- */
    var kws = Model.splitList(item.tag);
    if (kws.length) {
      sectionHead(s, '特性关键词', x, innerW);
      var kchips = [];
      for (var ki = 0; ki < kws.length; ki++) {
        var runs = splitStrike(kws[ki]);
        for (var ri = 0; ri < runs.length; ri++) {
          if (!runs[ri].t) continue;
          /* 被除名的词条整块（字 + 划掉它的横线）用灰机的红，跟 wiki 一致 */
          kchips.push({ t: runs[ri].t, strike: runs[ri].strike,
                        bg: t.chipBg,
                        color: runs[ri].strike ? t.del : t.chipText });
        }
      }
      s.y += chipFlow(s, x, s.y, innerW, kchips);
      s.y += 2;
    }

    /* ---- 物理抗性：图标 + 「[×N]」，颜色就是抗性档位色（灰机原样） ---- */
    sectionHead(s, '物理抗性', x, innerW);
    var cw = Math.floor(innerW / 3);
    for (var a = 0; a < Enums.ATK_TYPES.length; a++) {
      var at = Enums.ATK_TYPES[a];
      var key = item.resist[at.key] || '1';
      var col = Enums.resistColor(key) || t.fg;
      var bx = x + a * cw;
      var iw = at.key === 'pierce' ? 50 : 40;
      drawImg(s, at.cn, bx + cw / 2 - iw / 2, s.y, iw, iw * 0.8, true);
      s.text('[' + Enums.resistTag(key) + ']', bx + cw / 2, s.y + iw * 0.8 + 14,
        col, 17, 'bold', 'center');
    }
    s.y += 40 * 0.8 + 30;

    /* ---- 技能：按页签分组，1 技能 / 2 技能 / 3 技能 / 守备技能 ---- */
    var live = item.skills.filter(function (sk) {
      return sk.name || (sk.stages || []).some(function (st) { return st.on; });
    });
    if (live.length) {
      sectionHead(s, '技能', x, innerW);
      var groups = Enums.groupSkills(live);
      var keys = groups.map(function (gr) { return gr.tab.key; });
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        for (var si = 0; si < grp.skills.length; si++) {
          if (si === 0) {
            s.y += drawSkillTabs(s, x, s.y, keys, grp.tab.key) + 6;
          } else {
            /* 同一个页签里的变体之间，灰机拿这条 2px 白线隔开 */
            s.strokeLine(x, s.y + 6, x + innerW, s.y + 6, '#ffffff', 2);
            s.y += 14;
          }
          drawSkillBlock(s, x, innerW, grp.skills[si], tabLevel(grp.tab.key), opts);
        }
        s.y += 12;
      }
    }

    /* ---- 被动 ---- */
    var hasPassive = item.passives.some(function (p) { return p.name; }) ||
      item.support.name;
    if (hasPassive) {
      sectionHead(s, '被动', x, innerW);
      for (var p = 0; p < item.passives.length; p++) {
        drawPassive(s, x, innerW, item.passives[p], '战斗');
      }
      drawPassive(s, x, innerW, item.support, '支援');
    }
  }

  function drawEgoBody(s, item, x, innerW, opts) {
    var t = s.t;

    sectionHead(s, '能力值', x, innerW);
    var y = s.y + 18;
    var cx = x;
    var sp = _num(item.sp);
    var sc = _num(item.spCorrode);
    var so = _num(item.spOC);
    if (sp !== null) {
      cx += statCell(s, cx, y, '理智值消耗', sp, t.fg, 18, 32) + 26;
    }
    if (sc !== null) cx += statCell(s, cx, y, '理智值消耗', sc, t.fg, 18, 32) + 26;
    if (so !== null) cx += statCell(s, cx, y, '理智值消耗', so, t.fg, 18, 32) + 26;
    if (item.atk) {
      drawImg(s, item.atk === 'pierce' ? '突刺' : (item.atk === 'slash' ? '斩击' : '打击'),
        cx, y - 20, 50, 40, true);
      cx += 54;
    }
    s.y = y + 26;

    /* 罪孽消耗：图标 + `×N`，一行排开 —— 跟下面罪孽抗性同一版式，也跟灰机一致
     *（灰机上就是 `<img 罪孽-怠惰.png>×2`，没有「罪孽名」这层文字）。全 0 不画，
     * 新建的空白 E.G.O 就是全 0。 */
    if (Enums.SINS.some(function (sin) { return item.cost[sin.key]; })) {
      sectionHead(s, '资源消耗', x, innerW);
      var kx = x, ky = s.y + 16;
      for (var ci = 0; ci < Enums.SINS.length; ci++) {
        var csin = Enums.SINS[ci];
        var cnum = item.cost[csin.key];
        if (!cnum) continue;
        drawImg(s, '罪孽-' + csin.cn, kx, ky - 15, 30, 30, true);
        kx += 32;
        kx += s.text('×' + cnum, kx, ky, '#ebcaa2', 16, 'bold') + 18;
      }
      s.y = ky + 22;
    }

    /* 罪孽抗性：灰机只列**不等于 ×1** 的那几个，卡片跟着它，不铺一整张表。 */
    sectionHead(s, '罪孽抗性', x, innerW);
    var rc = x;
    var ry = s.y + 16;
    var shown = 0;
    for (var i = 0; i < Enums.SINS.length; i++) {
      var sin = Enums.SINS[i];
      var key = item.sinsRes[sin.key] || '1';
      if (Enums.resistMult(key) === 1) continue;
      drawImg(s, '罪孽-' + sin.cn, rc, ry - 15, 30, 30, true);
      rc += 32;
      rc += s.text('[' + Enums.resistTag(key) + ']', rc, ry,
        Enums.resistColor(key) || t.fg, 16, 'bold') + 16;
      shown++;
    }
    if (!shown) s.text('全为 ×1', x, ry, t.faint, 13, '');
    s.y = ry + 22;

    sectionHead(s, '觉醒技能', x, innerW);
    drawEgoSkill(s, x, innerW, item.awaken, opts, sp);

    var hasCorrode = item.corrode.name ||
      item.corrode.stages.some(function (st) { return st.on; });
    if (hasCorrode) {
      sectionHead(s, '侵蚀技能', x, innerW);
      drawEgoSkill(s, x, innerW, item.corrode, opts, sc === null ? sp : sc);
    }

    if (item.passive && (item.passive.name ||
        item.passive.stages.some(function (p) { return p.text; }))) {
      sectionHead(s, '被动', x, innerW);
      drawPassive(s, x, innerW, item.passive, 'E.G.O', EGO_P_LABELS, EGO_P_NAME);
    }
  }

  /* ---------------------------------------------------------------- 出口 */

  function _scratch() {
    return document.createElement('canvas').getContext('2d');
  }

  function measure(item, opts) {
    var s = new Surface(_scratch(), true);
    return draw(s, item, opts);
  }

  function render(canvas, item, opts) {
    opts = opts || {};
    var W = opts.width || W_DEFAULT;
    var H = measure(item, opts);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (opts.scale) dpr = opts.scale;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    /* 只写 width。**别在这里写 style.height** —— 容器比卡片窄的时候
     * `max-width:100%` 会把宽度压下来，高度被钉死的话画布就被左右挤扁了。
     * 高度交给 CSS 的 `height:auto`，按 canvas 自己的宽高比缩。 */
    canvas.style.width = W + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    draw(new Surface(ctx, false), item, opts);
    return { width: W, height: H, scale: dpr };
  }

  function toCanvas(item, opts) {
    opts = opts || {};
    var W = opts.width || W_DEFAULT;
    var H = measure(item, opts);
    var scale = opts.scale || 2;
    var MAX_PX = 40e6;   // 超大画布会静默产出空白 PNG，得压回来
    if (W * H * scale * scale > MAX_PX) {
      scale = Math.max(1, Math.floor(Math.sqrt(MAX_PX / (W * H)) * 10) / 10);
    }
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    draw(new Surface(ctx, false), item, opts);
    return canvas;
  }

  function toBlob(item, opts) {
    var canvas = toCanvas(item, opts);
    return new Promise(function (resolve, reject) {
      function fallback() {
        try { resolve(_dataUrlToBlob(canvas.toDataURL('image/png'))); }
        catch (e) { reject(e); }
      }
      if (!canvas.toBlob) return fallback();
      try {
        canvas.toBlob(function (b) { b ? resolve(b) : fallback(); }, 'image/png');
      } catch (e) { fallback(); }
    });
  }

  function _dataUrlToBlob(url) {
    var parts = url.split(',');
    var mime = /:(.*?);/.exec(parts[0])[1];
    var bin = atob(parts[1]);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  return {
    THEMES: THEMES,
    draw: draw, measure: measure, render: render,
    toCanvas: toCanvas, toBlob: toBlob,
    setAssets: setAssets,
    wrap: wrap, wrapRich: wrapRich, tokenize: tokenize,
    Surface: Surface,
    W_DEFAULT: W_DEFAULT
  };
})();
