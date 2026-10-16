# -*- coding: utf-8 -*-
"""用系统已有的 Edge 跑一遍 index.html，把最容易坏的地方都戳一下。

    pip install playwright          # 不下载 Chromium，直接用系统 Edge
    python tools/smoke_test.py
    python tools/smoke_test.py --headed     # 想看着它跑就加这个

为什么值得写：这个应用一没构建系统、二没模块打包，九个文件全是往 <script> 里
一塞。**拼错的 id、顺序错的文件、只在运行时才炸的 undefined，静态看是看不出来的**，
只有真跑一遍才知道。而且 file:// 下 Origin 是 null，localStorage 和 canvas 的规矩
跟 http 不一样 —— 那正好是最容易在真机上翻车的地方。

每一步都走界面上真实的那条路径（点行、点按钮、派发 input 事件），不直接调内部
函数绕过去，否则测的就不是用户会碰到的东西了。
"""

import argparse
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, "index.html")
SHOTS = os.path.join(ROOT, "_ref", "shots")

FAILS = []
STEPS = []


def check(name, ok, detail=""):
    STEPS.append(name)
    if not ok:
        FAILS.append(name)
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name,
                         ("   — " + str(detail)) if detail else ""))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--headed', action='store_true', help='显示浏览器窗口')
    args = ap.parse_args()

    if not os.path.exists(INDEX):
        sys.exit("先跑 tools/build.py 生成 index.html")

    from playwright.sync_api import sync_playwright

    os.makedirs(SHOTS, exist_ok=True)
    url = 'file:///' + INDEX.replace('\\', '/')
    print("打开 %s\n" % url)

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=not args.headed)
        page = browser.new_page(viewport={'width': 1680, 'height': 1000})
        page.on('console', lambda m: errors.append('console.%s: %s' % (m.type, m.text))
                if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
        page.goto(url)
        page.wait_for_timeout(1500)

        print("== 1. 启动 ==")
        check('没有未捕获的异常', not errors, ' / '.join(errors[:3]))
        check('内置种子读进来了（306 条）',
              page.evaluate("Library.seed().items.length") == 306,
              page.evaluate("Library.seed().items.length"))
        check('立绘表 306 张 data URL',
              page.evaluate("Object.keys(Library.seed().portraits).length") == 306)
        check('界面用上了内嵌的可见字号',
              page.evaluate("getComputedStyle(document.body).fontSize") == '14px')

        print("\n== 2. 左栏：内置库 —— 点行 = 就地打开，＋ = 复制一份 ==")
        page.click('.lib-tabs button[data-tab="seed"]')
        page.wait_for_timeout(800)
        n_rows = page.eval_on_selector_all('#lib .row', 'e => e.length')
        check('内置库列出了条目', n_rows > 50, '%d 行' % n_rows)
        check('列表项有真立绘（img 的 src 是 data:）',
              page.evaluate("""
                (function () {
                  var img = document.querySelector('#lib .row .thumb img');
                  return !!img && img.src.indexOf('data:image') === 0;
                })()
              """))

        # 搜出来再点，顺便测搜索框
        page.fill('#libSearch', '李箱 LCB')
        page.wait_for_timeout(400)
        check('搜索「李箱 LCB」能命中',
              page.eval_on_selector_all('#lib .row', 'e => e.length') >= 1,
              page.eval_on_selector_all('#lib .row', 'e => e.length'))

        # 点行（不是 ＋）= 就地打开来改。早先是「点哪儿都复制一份」，
        # 结果随便看看内置库就在「我的」里堆一堆副本。
        page.click('#lib .row .row-name')
        page.wait_for_timeout(900)
        check('点内置条目没有往「我的」里塞副本',
              page.evaluate("Store.items().length") == 0,
              page.evaluate("Store.items().length"))
        check('也没有从「内置库」标签跳走',
              page.evaluate("document.querySelector('.lib-tabs button.on').getAttribute('data-tab')")
              == 'seed')
        check('顶部说明这是会回退的内置条目',
              '内置条目' in page.eval_on_selector('#curBased', 'e => e.textContent'),
              page.eval_on_selector('#curBased', 'e => e.textContent'))
        check('表单渲染出来了（人格 5 个分区）',
              page.eval_on_selector_all('#formScroll .sec', 'e => e.length') == 5,
              page.eval_on_selector_all('#formScroll .sec', 'e => e.length'))
        check('顶部标明这是人格',
              page.eval_on_selector('#curMeta', 'e => e.textContent') == '人格')
        check('技能名从 wiki 正文里解析出来了',
              page.evaluate("App.current.skills[0].name.length") > 0,
              page.evaluate("App.current.skills[0].name"))
        check('技能条数是变长的（不再是写死的 3 + 1）',
              page.evaluate("App.current.skills.length") >= 4,
              page.evaluate("App.current.skills.length"))
        check('技能列表渲染成了可增删的块',
              page.eval_on_selector_all('.skill-item', 'e => e.length')
              == page.evaluate("App.current.skills.length"),
              page.eval_on_selector_all('.skill-item', 'e => e.length'))
        check('槽位名沿用 wiki 的参数前缀（1技能 / 强化2技能 …）',
              page.evaluate(r"""
                App.current.skills.every(function (s) {
                  return /^(强化)?\d+技能/.test(s.slot);
                })
              """))
        check('每个技能都分得清攻击 / 守备，并带上对应的类型和罪孽',
              page.evaluate("""
                App.current.skills.every(function (s) {
                  if (s.kind === 'def') return !!s.defType;
                  return s.kind === 'atk' && !!s.atk && s.sins.length > 0 && s.coins > 0;
                })
              """))
        check('战斗被动条数跟源数据一致（可变长）',
              page.evaluate("App.current.passives.length") >= 1,
              page.evaluate("App.current.passives.length"))
        check('被动列表渲染成了可变长的列表',
              page.eval_on_selector_all('.passive-item', 'e => e.length')
              == page.evaluate("App.current.passives.length"))

        print("\n== 2b. 内置条目改得动，但刷新即回退 ==")
        page.fill('[data-path="name"]', '改过的内置条目')
        page.wait_for_timeout(700)
        check('改内置条目：内存里的种子对象跟着变了',
              page.evaluate("""
                Library.seed().items.some(function (x) { return x.name === '改过的内置条目'; })
              """))
        check('改内置条目：一个字都没落进「我的」',
              page.evaluate("Store.items().length") == 0,
              page.evaluate("Store.items().length"))
        check('改内置条目：localStorage 里也没有它',
              page.evaluate("""
                (function () {
                  var raw = localStorage.getItem('llc_editor_v1') || '';
                  return raw.indexOf('改过的内置条目') < 0;
                })()
              """))
        check('内置条目也能导出 PNG',
              page.evaluate("""
                Card.toBlob(App.current, { width: 460, theme: 'dark', scale: 1 })
                  .then(function (b) { return !!b && b.size > 4096; })
                  .catch(function () { return false; })
              """))

        # 撤销：种子对象是被 SEED.items 和表单**同一个引用**持有的，撤销时只能就地
        # 覆盖字段，换个新对象就跟列表脱钩了。先做个结构性改动把快照压进栈，再改
        # 名字，然后撤销。
        sec = '#formScroll .sec[data-sec="skills"]'
        if not page.eval_on_selector(sec, 'e => e.classList.contains("open")'):
            page.click(sec + ' .sec-h')
            page.wait_for_timeout(200)
        page.click('.mini.add[data-act="addEffect"]')
        page.wait_for_timeout(500)
        page.fill('[data-path="name"]', '撤销前的内置条目')
        page.wait_for_timeout(300)
        page.keyboard.press('Control+z')
        page.wait_for_timeout(600)
        check('内置条目能撤销（名字回到改之前）',
              page.evaluate("App.current.name") == '改过的内置条目',
              page.evaluate("App.current.name"))
        check('撤销后还是种子列表里那一个对象（没有换引用）',
              page.evaluate("""
                (function () {
                  var id = App.current.id;
                  return Library.seed().items.some(function (x) { return x === App.current; })
                    && Library.seed().items.some(function (x) { return x.id === id; });
                })()
              """))
        check('撤销内置条目也没往「我的」里落盘',
              page.evaluate("Store.items().length") == 0,
              page.evaluate("Store.items().length"))
        page.fill('[data-path="name"]', '改过的内置条目')
        page.wait_for_timeout(300)

        page.reload()
        page.wait_for_timeout(1600)
        check('刷新后内置条目回退到原样',
              page.evaluate("""
                !Library.seed().items.some(function (x) { return x.name === '改过的内置条目'; })
              """))
        check('刷新后「我的」依然是空的',
              page.evaluate("Store.items().length") == 0,
              page.evaluate("Store.items().length"))

        print("\n== 2c. 只有 ＋ 才复制一份 ==")
        page.click('.lib-tabs button[data-tab="seed"]')
        page.wait_for_timeout(700)
        page.fill('#libSearch', '李箱 LCB')
        page.wait_for_timeout(400)
        page.click('#lib .row button[data-act="use"]')
        page.wait_for_timeout(900)
        check('点 ＋ 复制了一份到「我的」',
              page.evaluate("Store.items().length") == 1,
              page.evaluate("Store.items().length"))
        check('点 ＋ 后切到了「我的」标签',
              page.evaluate("document.querySelector('.lib-tabs button.on').getAttribute('data-tab')")
              == 'custom')
        check('标出了副本来源',
              '副本源自' in page.eval_on_selector('#curBased', 'e => e.textContent'),
              page.eval_on_selector('#curBased', 'e => e.textContent'))

        print("\n== 3. 预览卡片 ==")
        size0 = page.evaluate("[document.getElementById('card').width,"
                              " document.getElementById('card').height]")
        check('canvas 有实际尺寸', size0[0] > 200 and size0[1] > 200, size0)
        check('预览尺寸标签有内容',
              '×' in page.eval_on_selector('#pvSize', 'e => e.textContent'),
              page.eval_on_selector('#pvSize', 'e => e.textContent'))

        print("\n== 3b. 预览等比缩放（容器窄的时候不能左右挤扁）==")
        # 卡片默认 921px，预览栏比它窄，`max-width:100%` 一定会生效。宽度缩了、
        # 高度不缩就是「挤扁」——成因只有两个：canvas 的 height 属性被当成 CSS
        # 高度用，或者 JS 顺手写了内联 style.height（内联压得过样式表里的
        # height:auto）。这里把宽度手动压到 460px 复现那一刻，再比对宽高比。
        sq = page.evaluate("""
          (function () {
            var card = document.getElementById('card');
            var intrinsic = card.width / card.height;   // canvas 属性天然带比例
            var inline = card.style.height;             // 必须是空串
            var maxW = getComputedStyle(card).maxWidth;
            var oldW = card.style.width;
            card.style.width = '460px';
            var r = card.getBoundingClientRect();
            card.style.width = oldW;
            return { intrinsic: intrinsic, rendered: r.width / r.height,
                     inlineHeight: inline, maxW: maxW, w: r.width, h: r.height };
          })()
        """)
        check('JS 不往画布上写内联 style.height',
              sq['inlineHeight'] == '', repr(sq['inlineHeight']))
        check('#card 的 max-width 是 100%（容器窄时才会被压）',
              sq['maxW'] == '100%', sq['maxW'])
        check('画布被压窄时高度跟着等比缩',
              abs(sq['rendered'] - sq['intrinsic']) < 0.01,
              '固有 %0.4f vs 渲染 %0.4f（%s×%s）'
              % (sq['intrinsic'], sq['rendered'], sq['w'], sq['h']))

        print("\n== 3c. 技能名横幅的染色 ==")
        # 灰机的技能名横幅底图是白的，颜色由 MediaWiki:Common.js 在页面里逐像素
        # 乘上去；我们是在构建时（parse_seed.py）把它染好内嵌。这里把 Common.js
        # 那段循环**原样**在浏览器里跑一遍，跟内嵌的那张逐像素比 —— 比的是「色号
        # 或算法有没有走样」，不是「看着像不像」。
        tint = page.evaluate("""
          (function () {
            var seed = JSON.parse(document.getElementById('seed').textContent);
            var src = seed.icons['BattleUI CoinPopup skillName'];
            var mine = seed.icons['技能名-傲慢'];
            if (!src || !mine) return { err: '缺素材' };
            return new Promise(function (resolve) {
              var a = new Image(), b = new Image(), n = 0;
              function go() {
                if (++n < 2) return;
                var w = a.naturalWidth, h = a.naturalHeight;
                var c1 = document.createElement('canvas');
                c1.width = w; c1.height = h;
                var x1 = c1.getContext('2d');
                x1.drawImage(a, 0, 0);
                var d1 = x1.getImageData(0, 0, w, h), p1 = d1.data;
                /* ↓ 原样照抄 MediaWiki:Common.js 的 applyColor() */
                var r = 0x30, g = 0x5e, bl = 0x87;      // 傲慢 #305E87
                for (var i = 0; i < p1.length; i += 4) {
                  var br = (p1[i] + p1[i+1] + p1[i+2]) / 765;
                  p1[i] = r * br; p1[i+1] = g * br; p1[i+2] = bl * br;
                }
                x1.putImageData(d1, 0, 0);
                var c2 = document.createElement('canvas');
                c2.width = w; c2.height = h;
                var x2 = c2.getContext('2d');
                x2.drawImage(b, 0, 0);
                var d2 = x2.getImageData(0, 0, w, h).data;
                var d3 = x1.getImageData(0, 0, w, h).data;
                /* 比**预乘**后的值：半透明那几个边像素解码时要过一遍
                 * 预乘/反预乘，alpha 低的像素 RGB 本来就没有定义（alpha=0 的
                 * 右下角更是随便填），拿裸 RGB 比会把这种无害误差算进来。
                 * 乘上 alpha 就是眼睛真正看到的那份颜色。 */
                var max = 0, maxOpaque = 0, n = 0;
                for (var i = 0; i < d2.length; i += 4) {
                  for (var k = 0; k < 3; k++) {
                    var a2 = Math.abs(d2[i + k] * d2[i + 3] - d3[i + k] * d3[i + 3]) / 255;
                    if (a2 > max) max = a2;
                    if (d3[i + 3] >= 250 && Math.abs(d2[i + k] - d3[i + k]) > maxOpaque) {
                      maxOpaque = Math.abs(d2[i + k] - d3[i + k]);
                    }
                  }
                  n++;
                }
                resolve({ w: w, h: h, max: max, maxOpaque: maxOpaque, n: n });
              }
              a.onload = go; b.onload = go;
              a.onerror = go; b.onerror = go;
              a.src = src; b.src = mine;
            });
          })()
        """)
        check('横幅底图和染色版都内嵌了（149×26 八张）',
              tint.get('w') == 149 and tint.get('h') == 26, tint)
        check('不透明像素和灰机算出来的**逐位相同**',
              tint.get('maxOpaque', 99) == 0,
              '最大偏差 %s' % tint.get('maxOpaque'))
        check('含半透明边在内的最大偏差 < 2（只差在预乘取整上）',
              tint.get('max', 99) < 2,
              '预乘后最大偏差 %s（%s 个像素）' % (tint.get('max'), tint.get('n')))

        print("\n== 3d. 硬币数和攻击容量都是横排，不是数字 ==")
        # 思路：把同一个人格渲染两遍，只改硬币数（或攻击容量），然后看**差异像素的
        # 外接矩形**。数量画成横排 → 差异必然是一条又扁又宽的横带；要是还写成
        # 「硬币×N」那种文字，差异会是一小块方的（数字换了个字形），宽度撑不开。
        # 李箱蜘蛛巢食指父辈的 Furioso-Replica 正好是内置数据里硬币最多（9）、
        # 攻击容量最大（7）的那一个，前后都是极值。
        coins = page.evaluate("""
          (function () {
            var seed = Library.seed(), src = null;
            for (var i = 0; i < seed.items.length; i++) {
              if (seed.items[i].id === 's_identity_10115') src = seed.items[i];
            }
            if (!src) return { err: '找不到李箱蜘蛛巢食指父辈' };
            function shot(it) {
              var c = document.createElement('canvas');
              Card.render(c, it, { width: 460, theme: 'dark', scale: 1, stage: 'iv' });
              return c.getContext('2d').getImageData(0, 0, c.width, c.height);
            }
            /* 只留 Furioso-Replica 那一条技能：把别的技能全删掉，差异就只可能来自
             * 这一块，不会被别处的重排掺进来。 */
            function only(item) {
              var c = Model.deepCopy(item);
              c.skills = c.skills.filter(function (s) {
                return (s.name || '').indexOf('Furioso') >= 0;
              });
              return c;
            }
            function band(a, b) {
              if (a.width !== b.width || a.height !== b.height) {
                return { err: '两张卡片尺寸不同：' + a.width + 'x' + a.height +
                             ' vs ' + b.width + 'x' + b.height };
              }
              var n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
              for (var y = 0; y < a.height; y++) {
                for (var x = 0; x < a.width; x++) {
                  var i = (y * a.width + x) * 4, d = 0;
                  for (var k = 0; k < 4; k++) {
                    d += Math.abs(a.data[i + k] - b.data[i + k]);
                  }
                  if (d > 12) {
                    n++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                  }
                }
              }
              return { n: n, w: n ? x1 - x0 + 1 : 0, h: n ? y1 - y0 + 1 : 0,
                       y: n ? y0 : -1 };
            }
            var one = only(src), many = only(src);
            many.skills[0].coins = 9;
            one.skills[0].coins = 1;
            var r = { coins: band(shot(one), shot(many)) };
            var w1 = only(src), w7 = only(src);
            w1.skills[0].weight = 1;
            w7.skills[0].weight = 7;
            r.weight = band(shot(w1), shot(w7));
            // 同样的输入渲染两遍必须一模一样，否则上面比的就不是「硬币数的影响」
            var again = only(src);
            again.skills[0].coins = 1;
            r.same = band(shot(one), shot(again));
            return r;
          })()
        """)
        check('拿得到李箱蜘蛛巢食指父辈的技能块', not coins.get('err'), coins.get('err'))
        if not coins.get('err'):
            c1, wt = coins['coins'], coins['weight']
            check('同一份输入渲染两遍逐像素相同（差异分析的前提）',
                  coins['same']['n'] == 0, coins['same'])
            check('硬币 1 → 9 的差异是一条横带（高度 ≤ 40px）',
                  0 < c1['h'] <= 40, c1)
            check('硬币 1 → 9 的差异横向铺开（宽度 ≥ 120px，是 8 枚硬币的宽度）',
                  c1['w'] >= 120, c1)
            check('硬币画出来的像素够多（不是只换了个字形）',
                  c1['n'] >= 800, c1)
            check('攻击容量 1 → 7 的差异也是一条横带（高度 ≤ 40px）',
                  0 < wt['h'] <= 40, wt)
            check('攻击容量的差异横向铺开（宽度 ≥ 60px）', wt['w'] >= 60, wt)

        print("\n== 3e. 特性关键词的除名标记（删除线 + 变红）==")
        # 数据里鸿璐蜘蛛巢环指父辈的「大师」在灰机上是
        # `<span style="color:#d40000"><s>大师</s></span>`（表示除名），解析器要把它
        # 转成 `~~大师~~`。这里直接拿真实条目比：同一张卡，一个把 `~~` 去掉、一个留着
        # —— 差异应该正好是那一个标签，而且标记版上这个标签整块都是灰机那个红。
        strike = page.evaluate("""
          (function () {
            var seed = Library.seed(), src = null;
            for (var i = 0; i < seed.items.length; i++) {
              if (seed.items[i].id === 's_identity_10614') src = seed.items[i];
            }
            if (!src) return { err: '找不到鸿璐蜘蛛巢环指父辈' };
            if (String(src.tag).indexOf('~~') < 0) {
              return { err: '解析后的 tag 里没有 ~~：' + src.tag };
            }
            function shot(it, theme) {
              var c = document.createElement('canvas');
              Card.render(c, it, { width: 460, theme: theme, scale: 1, stage: 'iv' });
              return c.getContext('2d').getImageData(0, 0, c.width, c.height);
            }
            /* 灰机的除名红 #d40000 —— 判「够不够红」而不抠死等于 212/0/0，
             * 抗锯齿边上会掺进底色；色号本身另有一条单独的断言。 */
            function red(p) { return p[0] >= 120 && p[0] - p[1] >= 60 && p[0] - p[2] >= 60; }
            function one(item, theme) {
              var marked = Model.deepCopy(item);
              var plain = Model.deepCopy(item);
              plain.tag = String(item.tag).replace(/~~/g, '');
              var a = shot(marked, theme), b = shot(plain, theme);
              var ys = {};
              for (var y = 0; y < a.height; y++) {
                for (var x = 0; x < a.width; x++) {
                  var i = (y * a.width + x) * 4, d = 0;
                  for (var k = 0; k < 4; k++) d += Math.abs(a.data[i + k] - b.data[i + k]);
                  if (d > 12) ys[y] = (ys[y] || 0) + 1;
                }
              }
              /* 「一行里连着好几个差异像素」的行 = 那个标签所在的行。canvas 是分块
               * 光栅化的，多画了东西之后别处某个抗锯齿边上偶尔会 rounding 差 1，
               * 那种零星像素单独计数，不该让它把「这是不是一个标签」的判断带偏。 */
              var rows = [], stray = 0;
              for (var yy in ys) {
                if (ys[yy] >= 5) rows.push(+yy); else stray += ys[yy];
              }
              rows.sort(function (p, q) { return p - q; });
              var bx0 = 1e9, bx1 = -1, bandN = 0;
              for (var r = 0; r < rows.length; r++) {
                bandN += ys[rows[r]];
                for (var x2 = 0; x2 < a.width; x2++) {
                  var i2 = (rows[r] * a.width + x2) * 4, d2 = 0;
                  for (var k2 = 0; k2 < 4; k2++) d2 += Math.abs(a.data[i2 + k2] - b.data[i2 + k2]);
                  if (d2 > 12) { if (x2 < bx0) bx0 = x2; if (x2 > bx1) bx1 = x2; }
                }
              }
              var redN = 0, becameRed = 0, run = 0, bestRun = 0, closest = 1e9;
              for (var r2 = 0; r2 < rows.length; r2++) {
                run = 0;
                for (var x3 = bx0; x3 <= bx1; x3++) {
                  var i3 = (rows[r2] * a.width + x3) * 4;
                  var pa = [a.data[i3], a.data[i3 + 1], a.data[i3 + 2]];
                  var pb = [b.data[i3], b.data[i3 + 1], b.data[i3 + 2]];
                  if (red(pa)) {
                    redN++; run++;
                    if (run > bestRun) bestRun = run;
                    var dd = Math.abs(pa[0] - 212) + Math.abs(pa[1]) + Math.abs(pa[2]);
                    if (dd < closest) closest = dd;
                    if (!red(pb)) becameRed++;
                  } else run = 0;
                }
              }
              return { w: bx1 - bx0 + 1, h: rows[rows.length - 1] - rows[0] + 1,
                       band: bandN, stray: stray, red: redN, becameRed: becameRed,
                       run: bestRun, closest: closest };
            }
            // 顺带确认整批数据的 tag 里没漏出 HTML 标签或实体，
            // 并把所有带 ~~ 的条目都拉出来查一遍（「二老板」那条开头就是除名词、
            // 而且一条里有两个，是最容易被 splitStrike 漏掉的情况）
            var dirty = [], all = [];
            for (var j = 0; j < seed.items.length; j++) {
              var t = String(seed.items[j].tag || '');
              if (/[<>]|&[a-z]+;/.test(t)) dirty.push(seed.items[j].id + '=' + t);
              if (t.indexOf('~~') >= 0) {
                var d = one(seed.items[j], 'dark'), l = one(seed.items[j], 'light');
                all.push({ id: seed.items[j].id, name: seed.items[j].name, tag: t,
                           dark: { red: d.red, becameRed: d.becameRed },
                           light: { red: l.red, becameRed: l.becameRed } });
              }
            }
            return { tag: src.tag, dark: one(src, 'dark'), light: one(src, 'light'),
                     all: all, dirty: dirty };
          })()
        """)
        check('拿得到鸿璐蜘蛛巢环指父辈', not strike.get('err'), strike.get('err'))
        if not strike.get('err'):
            check('解析后的 tag 是 ~~大师~~ 这一套记号', '~~大师~~' in strike['tag'],
                  strike['tag'])
            for th in ('dark', 'light'):
                cn = '深色' if th == 'dark' else '浅色'
                st = strike[th]
                check('%s主题：除名词条整块变红（≥ 60 个红像素）' % cn, st['red'] >= 60, st)
                check('%s主题：红只长在这个标签上（红像素全是「本来不红」的）' % cn,
                      st['red'] == st['becameRed'] and st['becameRed'] > 0,
                      '红 %s 个 / 其中变来的 %s 个' % (st['red'], st['becameRed']))
                check('%s主题：用的就是灰机那个 #d40000（有像素位级相同）' % cn,
                      st['closest'] == 0, '最接近的差 %s' % st['closest'])
                check('%s主题：删除线还在（一行里 ≥ 10 个连续红像素）' % cn,
                      st['run'] >= 10, '最长红横条 %s px' % st['run'])
                check('%s主题：只动了这一个标签（差异 ≤ 60×30）' % cn,
                      st['h'] <= 30 and st['w'] <= 60, '%s×%s' % (st['w'], st['h']))
                # 上面说过的那种分块光栅化 rounding，实测深浅两套主题各掉 2 / 5 个
                check('%s主题：标签之外只剩零星抗锯齿误差（≤ 8 个像素）' % cn,
                      st['stray'] <= 8, '标签外 %s 个' % st['stray'])
            # 剩下的三条除名词条（含「开头就是除名词」「一条里两个」这两种）
            allst = strike.get('all') or []
            check('内置数据里带 ~~ 的条目都找到了（4 条）', len(allst) == 4,
                  [x['id'] + ' ' + x['tag'] for x in allst])
            for x in allst:
                for th in ('dark', 'light'):
                    cn = '深色' if th == 'dark' else '浅色'
                    s2 = x[th]
                    check('%s %s主题：除名词条也变红了（≥ 60 个红像素、别处不红）'
                          % (x['name'], cn),
                          s2['red'] >= 60 and s2['red'] == s2['becameRed'], s2)
        check('内置数据的 tag 里没有漏出 HTML 标签 / 实体',
              not strike.get('dirty'), strike.get('dirty'))

        print("\n== 3f. 卡片顶上的罪人色横条是干净的 ==")
        # 卡片最顶上那条 3px 横条是罪人色。它以前被一层黑字糊住：drawBanner 量技能名
        # 宽度时误用了会真画的 tracked(name, 0, 0, …)，每画一条横幅就往 (0,0) 落一遍
        # 黑字。所以这里按「导出那条路」（scale 2）逐行查：顶上 6 个设备像素行必须整行
        # 都是同一个罪人色，第 7 行必须整行都是主题底色 —— 多一层字、或者条子长了一
        # 像素，都会被逮到。
        topbar = page.evaluate("""
          (function () {
            var seed = Library.seed(), cases = [];
            ['10115', '10315'].forEach(function (code) {
              for (var i = 0; i < seed.items.length; i++) {
                if (seed.items[i].id === 's_identity_' + code) cases.push(seed.items[i]);
              }
            });
            var egos = seed.items.filter(function (x) { return x.kind === 'ego'; });
            if (egos.length) cases.push(egos[0]);
            cases.push(Model.createIdentity());
            function rgb(h) {
              h = String(h).replace('#', '');
              return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
                      parseInt(h.slice(4, 6), 16)].join(',');
            }
            var out = [];
            cases.forEach(function (it) {
              ['dark', 'light'].forEach(function (theme) {
                var c = document.createElement('canvas');
                Card.render(c, it, { width: 460, theme: theme, scale: 2 });
                var d = c.getContext('2d').getImageData(0, 0, c.width, 16).data;
                function rowKey(y) {
                  var uniq = {};
                  for (var x = 0; x < c.width; x++) {
                    var i = (y * c.width + x) * 4;
                    uniq[d[i] + ',' + d[i + 1] + ',' + d[i + 2]] = 1;
                  }
                  var ks = Object.keys(uniq);
                  return ks.length === 1 ? ks[0] : ('混色(' + ks.length + ')');
                }
                var want = rgb(Enums.color('sinners', it.sinner));
                var bg = rgb(Card.THEMES[theme].bg);
                var run = 0;
                while (run < 16 && rowKey(run) === want) run++;
                out.push({ id: it.id, name: it.name || ('新建 ' + it.id), theme: theme,
                           want: want, bg: bg, run: run, next: rowKey(run) });
              });
            });
            return out;
          })()
        """)
        check('顶部横条的检查跑了 %d 条（2 人格 + 1 EGO + 1 新建，深浅各一次）' % 8,
              len(topbar) == 8, len(topbar))
        for tb in topbar:
            cn = '深色' if tb['theme'] == 'dark' else '浅色'
            check('顶部横条干净：%s %s主题（6px 罪人色 + 一行主题底色）' % (tb['name'], cn),
                  tb['run'] == 6 and tb['next'] == tb['bg'],
                  '罪人色 %s 跑了 %s 行，第 %s 行是 %s（该是 %s）'
                  % (tb['want'], tb['run'], tb['run'], tb['next'], tb['bg']))

        print("\n== 4. 改表单 → 预览跟着重画 ==")
        # 卡片默认只画同步Ⅳ，所以得挑「真的被画出来」的那一阶去改；改别的阶
        # 卡片不动反而是对的（那正是「只保留阶段4」的意思）。
        target = page.evaluate("""
          (function () {
            var cand = ['skills.0.stages.3.effects.0.text',
                        'skills.0.stages.2.effects.0.text'];
            for (var i = 0; i < cand.length; i++) {
              if (document.querySelector('[data-path="' + cand[i] + '"]')) return cand[i];
            }
            return '';
          })()
        """)
        check('找得到卡片正在画的那一阶的效果输入框', bool(target), target)
        before = page.evaluate("JSON.stringify(App.current.skills[0].stages)")
        page.evaluate("""
          (function () {
            var el = document.querySelector('[data-path="%s"]');
            for (var i = 0; i < 6; i++) el.value = el.value + '，再追加一段很长的效果描述文本';
            el.dispatchEvent(new Event('input', {bubbles: true}));
          })()
        """ % target)
        page.wait_for_timeout(900)
        size1 = page.evaluate("[document.getElementById('card').width,"
                              " document.getElementById('card').height]")
        check('效果文本变长后卡片跟着变高',
              size1[1] > size0[1], '%s → %s' % (size0, size1))
        check('改动已经写回 model',
              page.evaluate("JSON.stringify(App.current.skills[0].stages)") != before)

        print("\n== 4b. 技能只画一阶 ==")
        # 下拉里的 'iv' 是历史值名，含义现在是「仅最高阶」：人格取同步Ⅳ、E.G.O 取
        # 各自实际存在的最高一阶（有解析Ⅴ就画Ⅴ）。
        h_iv = page.evaluate("document.getElementById('card').height")
        page.select_option('#cardStage', 'all')
        page.wait_for_timeout(700)
        h_all = page.evaluate("document.getElementById('card').height")
        check('默认只画一阶，「全部阶段」明显更高', h_all > h_iv + 40,
              '%s → %s' % (h_iv, h_all))
        page.select_option('#cardStage', 'iv')
        page.wait_for_timeout(500)
        check('切回「仅最高阶」高度复原',
              page.evaluate("document.getElementById('card').height") == h_iv,
              page.evaluate("document.getElementById('card').height"))

        print("\n== 4c. 画的阶是「最高的那一阶」==")
        # E.G.O 的技能阶是 Ⅰ/Ⅲ/Ⅳ/Ⅴ、人格是 Ⅰ~Ⅳ，但两边阶段数组下标都是 0..3 ——
        # 所以「下标 3」在人格里是同步Ⅳ、在 E.G.O 里是**解析Ⅴ**。以前挑阶的代码按
        # kind 写死下标（E.G.O 取 2 = 解析Ⅳ），于是带解析Ⅴ的 E.G.O 被压回了Ⅳ。
        #
        # 想验的是「哪一阶被画进了技能块」。阶段标签本身画在 canvas 上读不出来，而
        # E.G.O 左侧那列小标签是把**所有开着的阶**都列出来的，拿它当证据等于没验。
        # 这里改成改内容看像素：把某一阶的威力改成一个完全不同的数，重画一遍，若这
        # 一阶真被画出来过，卡片必有像素变化；没被画的阶怎么改都一样。
        stages_probe = page.evaluate("""
          (function () {
            var seed = Library.seed();
            function byId(id) {
              for (var i = 0; i < seed.items.length; i++) {
                if (seed.items[i].id === id) return seed.items[i];
              }
              return null;
            }
            function shot(it) {
              var cv = document.createElement('canvas');
              Card.render(cv, it, { width: 460, theme: 'dark', scale: 1, stage: 'iv' });
              return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
            }
            /* 返回「不一样的像素个数」。尺寸都对不上（-1）也是变了 —— 多出来一行
             * 效果会把卡片撑高，那本来就说明这一阶被画出来了。所以判「变了」用
             * `!= 0`，判「没画」才用 `== 0`。 */
            function diff(a, b) {
              if (a.width !== b.width || a.height !== b.height) return -1;
              var n = 0, d = a.data, e = b.data;
              for (var i = 0; i < d.length; i += 4) {
                if (d[i] !== e[i] || d[i + 1] !== e[i + 1] ||
                    d[i + 2] !== e[i + 2] || d[i + 3] !== e[i + 3]) n++;
              }
              return n;
            }
            /* 只留一条技能，免得别的技能跟着重排把差异搅浑 */
            function onlySkill(item, name) {
              var c = Model.deepCopy(item);
              c.skills = (c.skills || []).filter(function (s) {
                return (s.name || '').indexOf(name) >= 0;
              });
              return c;
            }
            /* E.G.O 的觉醒和侵蚀是两条独立技能，两条一起改。
             *
             * 改的是**效果行**不是威力：E.G.O 的威力/硬币威力只在「全部阶段」那
             * 个模式下才画（见 egoBody 里的 multi 判断），单阶模式正文就只有效果
             * 文本，改威力会一位差都测不出来。往这一阶塞一行效果则必然改版面。 */
            function pokeEgo(item, st) {
              var c = Model.deepCopy(item);
              ['awaken', 'corrode'].forEach(function (k) {
                var g = c[k] && c[k].stages && c[k].stages[st];
                if (g) {
                  g.effects = (g.effects || []).concat([
                    { coin: null, trigger: 'none', text: '阶段探针：只该出现在被画出来的那一阶' }
                  ]);
                }
              });
              return c;
            }
            function pokeSkill(item, st) {
              var c = Model.deepCopy(item);
              var g = c.skills[0] && c.skills[0].stages && c.skills[0].stages[st];
              if (g) { g.power = 99; g.coinPower = -7; }
              return c;
            }
            function offEgo(item, st) {
              var c = Model.deepCopy(item);
              ['awaken', 'corrode'].forEach(function (k) {
                if (c[k] && c[k].stages[st]) c[k].stages[st].on = false;
              });
              return c;
            }
            var out = {}, err = [];
            /* —— 第四根火柴之焰（李箱）：种子数据里第 4 格（解析Ⅴ）是开的 —— */
            var eg = byId('s_ego_20102');
            if (!eg) err.push('找不到 s_ego_20102 第四根火柴之焰');
            else {
              out.v_is3 = diff(shot(eg), shot(pokeEgo(eg, 3)));   // >0 说明画的是解析Ⅴ
              out.v_is2 = diff(shot(eg), shot(pokeEgo(eg, 2)));  // 0 说明解析Ⅳ没画
              /* 把Ⅴ关掉，最高阶退回解析Ⅳ，两条的结论应该整个反过来 */
              var eg4 = offEgo(eg, 3);
              out.back_is2 = diff(shot(eg4), shot(pokeEgo(eg4, 2)));  // >0
              out.back_is3 = diff(shot(eg4), shot(pokeEgo(eg4, 3)));   // 0
            }
            /* —— 人格：最高阶就是同步Ⅳ（下标 3）—— */
            var idn = byId('s_identity_10115');
            if (!idn) err.push('找不到 s_identity_10115 李箱蜘蛛巢食指父辈');
            else {
              var one = onlySkill(idn, 'Furioso');
              if (!one.skills.length) err.push('Furioso 那条技能没筛出来');
              else {
                out.id_is3 = diff(shot(one), shot(pokeSkill(one, 3)));   // >0
                out.id_is2 = diff(shot(one), shot(pokeSkill(one, 2)));  // 0
              }
            }
            /* —— 没有解析Ⅴ数据的普通 E.G.O：仍然是解析Ⅳ —— */
            var eg0 = byId('s_ego_20101');
            if (!eg0) err.push('找不到 s_ego_20101 乌瞰刀');
            else {
              out.plain_is2 = diff(shot(eg0), shot(pokeEgo(eg0, 2)));  // >0
              out.plain_is3 = diff(shot(eg0), shot(pokeEgo(eg0, 3)));   // 0（没有Ⅴ）
            }
            out.err = err.length ? err.join('；') : null;
            return out;
          })()
        """)
        check('4c 的四组样本都能拿到', not stages_probe.get('err'), stages_probe.get('err'))
        check('带解析Ⅴ的 E.G.O 画的是解析Ⅴ',
              stages_probe.get('v_is3', 0) != 0, stages_probe.get('v_is3'))
        check('带解析Ⅴ的 E.G.O **不再**画解析Ⅳ',
              stages_probe.get('v_is2') == 0, stages_probe.get('v_is2'))
        check('把解析Ⅴ关掉后退回解析Ⅳ',
              stages_probe.get('back_is2', 0) != 0, stages_probe.get('back_is2'))
        check('退回之后不画那个空的解析Ⅴ',
              stages_probe.get('back_is3') == 0, stages_probe.get('back_is3'))
        check('人格画的还是同步Ⅳ',
              stages_probe.get('id_is3', 0) > 0 and stages_probe.get('id_is2') == 0,
              '同步Ⅳ=%s 同步Ⅲ=%s' % (stages_probe.get('id_is3'), stages_probe.get('id_is2')))
        check('没有解析Ⅴ的普通 E.G.O 仍然是解析Ⅳ',
              stages_probe.get('plain_is2', 0) != 0 and stages_probe.get('plain_is3') == 0,
              '解析Ⅳ=%s 解析Ⅴ=%s' % (stages_probe.get('plain_is2'),
                                      stages_probe.get('plain_is3')))

        print("\n== 4d. 技能图标的裁剪框和摆位 ==")
        # 灰机技能图标那三张图（描边框 / 六边形贴图 / 底色板）的摆位**逐罪孽逐等级
        # 都不一样**，是 `模板:{罪孽}技能图标` 里一组组写死的 margin（八张模板，
        # 见 const.js 的 SIN_GEOM）。这里不去读那张表，而是把 canvas 的绘制调用录
        # 下来，看卡片**实际画到哪**，再跟灰机页面上量到的数比。下面这些期望值来自
        # tools/probe_icon_geom.py 的实测输出（缓存整页，坐标相对技能块左上角）。
        icon_geom = page.evaluate("""
          (function () {
            var seed = Library.seed();
            /* 贴图对象是拿 data URL 建的，所以能反查到资源名 */
            var srcName = {};
            Object.keys(seed.icons).forEach(function (n) { srcName[seed.icons[n]] = n; });
            function byId(id) {
              for (var i = 0; i < seed.items.length; i++) {
                if (seed.items[i].id === id) return seed.items[i];
              }
              return null;
            }
            var base = byId('s_identity_10315');   // 品牌经理：傲慢/嫉妒/怠惰三种都齐
            if (!base) return { err: '找不到 s_identity_10315' };

            /* 只留一条技能，换个罪孽 / 槽位，就能点到任意一档的几何 */
            function variant(sinKey, slot, icon) {
              var c = Model.deepCopy(base);
              c.skills = c.skills.filter(function (s) { return s.slot === slot; });
              if (!c.skills.length) return null;
              c.skills[0].icon = icon;
              c.skills[0].sins = sinKey ? [sinKey] : [];
              return c;
            }
            function trace(item) {
              var opts = { width: 460, theme: 'dark', stage: 'iv' };
              var H = Card.measure(item, opts);
              var cv = document.createElement('canvas');
              cv.width = 460; cv.height = Math.max(H, 400);
              var ctx = cv.getContext('2d');
              var imgs = [], clips = [], path = [];
              var od = ctx.drawImage, om = ctx.moveTo, ol = ctx.lineTo, oc = ctx.clip;
              var ob = ctx.beginPath;
              ctx.moveTo = function (x, y) { path.push([x, y]); return om.apply(ctx, arguments); };
              ctx.lineTo = function (x, y) { path.push([x, y]); return ol.apply(ctx, arguments); };
              ctx.beginPath = function () { path = []; return ob.apply(ctx); };
              ctx.clip = function () { clips.push(path); path = []; return oc.apply(ctx); };
              ctx.drawImage = function (im) {
                var a = Array.prototype.slice.call(arguments, 1);
                imgs.push({ name: srcName[im.src] || '?', x: a[0], y: a[1], w: a[2], h: a[3] });
                return od.apply(ctx, arguments);
              };
              Card.draw(new Card.Surface(ctx, false), item, opts);
              return { imgs: imgs, clips: clips };
            }
            /* 技能块里的三张图各是谁，靠资源名认；六边形是那个 7 个顶点的裁剪路径 */
            function pick(item, icon, frameName, bottomName) {
              var t = trace(item), out = {};
              for (var i = 0; i < t.imgs.length; i++) {
                var d = t.imgs[i];
                if (d.name === icon) out.icon = d;
                else if (d.name === frameName) out.frame = d;
                else if (d.name === bottomName) out.bottom = d;
              }
              for (var j = 0; j < t.clips.length; j++) {
                if (t.clips[j].length === 7) { out.hex = t.clips[j]; break; }
              }
              if (!out.icon || !out.frame) return { err: '没录到贴图/框的绘制调用：' +
                t.imgs.map(function (d) { return d.name; }).join(',') };
              /* 全部换算成「相对框贴图左上角」，跟灰机那张表同一个原点 */
              var fx = out.frame.x, fy = out.frame.y, rel = function (d) {
                return d ? { x: d.x - fx, y: d.y - fy, w: d.w, h: d.h } : null;
              };
              var r = { frame: rel(out.frame), icon: rel(out.icon), bottom: rel(out.bottom) };
              if (out.hex) {
                r.hex = out.hex.map(function (p) { return [p[0] - fx, p[1] - fy]; });
              }
              return r;
            }
            var out = {}, err = [];
            function add(tag, sinKey, slot, icon, frameName, bottomName, want) {
              var it = variant(sinKey, slot, icon);
              if (!it) { err.push(tag + '：种子里没有 ' + slot); return; }
              var g = pick(it, icon, frameName, bottomName);
              if (g.err) { err.push(tag + '：' + g.err); return; }
              g.want = want;
              out[tag] = g;
            }
            /* 期望值里贴图和底板都**相对框贴图左上角**（灰机那张表是相对技能块左上
             * 角，框在块坐标的 x=35 处，所以底板的 34 在这里是 34-35 = -1）：
             *   [图标 (x,y), 图标边长, 底色板 (x,y), 框宽]
             *
             * 底板的 y 是**带真站样式的实测值**：模板里的 margin-top 再加 7.5px
             * —— 底板那张图独占一行，MediaWiki 套了个 `<p>`，真站 DragonHide 给
             * `#content p` 的上外边距正是 7.5px。暴食和嫉妒那张模板少写了一个换行，
             * 贴图不独行，这两家就是裸 margin（所以嫉妒这里是 -2.5，没加）。 */
            add('pride1',  'pride', '1技能', '1031501', '傲慢-等级1', '傲慢-等级1-底部',
                { icon: [10, 10], px: 60, bottom: [-1, 3.5], framePx: 75 });
            add('envy2',   'envy',  '2技能', '1031502', '嫉妒-等级2', '嫉妒-等级2-底部',
                { icon: [7, 7], px: 60, bottom: [-1, -2.5], framePx: 75 });
            add('sloth3',  'sloth', '3技能', '1031503', 'Icon skillFrame 1 2',
                'Icon skillFrame Invert 9', { icon: [4, 9], px: 60, bottom: [-1, 1.5],
                                              framePx: 75 });
            /* 忧郁的贴图只有 55（跟另外七种都不一样） */
            add('gloom1',  'gloom', '1技能', '1031501', '忧郁-等级1', '忧郁-等级1-底部',
                { icon: [10, 8.5], px: 55, bottom: [-2, -2.5], framePx: 75 });
            /* 认不出的罪孽退回常规框：框只有 70 宽，贴图 55 */
            add('neutral1', null,    '1技能', '1031501', '常规-等级1', '常规-等级1-底部',
                { icon: [9, 7], px: 55, bottom: [-2, 5.5], framePx: 70 });
            /* 常规框那张模板没有按等级分档，3技能也还是同一张 70px 的 `常规-等级1`。
             * 以前这里会去凑「等级 3 的通用框」编号，编出一张根本不在库里的图。 */
            add('neutral3', null,    '3技能', '1031503', '常规-等级1', '常规-等级1-底部',
                { icon: [0, 0], px: 55, bottom: [-2, 5.5], framePx: 70 });
            out.err = err.length ? err.join('；') : null;
            return out;
          })()
        """)
        check('4d 六档几何都量到了', not icon_geom.get('err'), icon_geom.get('err'))
        for _tag, _cn in [('pride1', '傲慢·1技能'), ('envy2', '嫉妒·2技能'),
                          ('sloth3', '怠惰·3技能'), ('gloom1', '忧郁·1技能'),
                          ('neutral1', '常规·1技能'), ('neutral3', '常规·3技能')]:
            _g = icon_geom.get(_tag) or {}
            _w = _g.get('want')
            if not _w:
                check('%s 量到了' % _cn, False, _g.get('err', '没数据'))
                continue
            _i, _b, _f = _g.get('icon'), _g.get('bottom'), _g.get('frame')
            _ok = (_i and _b and abs(_i['x'] - _w['icon'][0]) < 0.01
                   and abs(_i['y'] - _w['icon'][1]) < 0.01
                   and abs(_i['w'] - _w['px']) < 0.01
                   and abs(_b['x'] - _w['bottom'][0]) < 0.01
                   and abs(_b['y'] - _w['bottom'][1]) < 0.01
                   and abs(_f['w'] - _w['framePx']) < 0.01)
            check('%s 的贴图/底板/框宽摆放跟灰机一致' % _cn, _ok,
                  '贴图(%.1f,%.1f)%.0f 底板(%.1f,%.1f) 框宽%.0f，灰机是 贴图(%s,%s)%s 底板(%s,%s) 框宽%s'
                  % (_i['x'], _i['y'], _i['w'], _b['x'], _b['y'], _f['w'],
                     _w['icon'][0], _w['icon'][1], _w['px'],
                     _w['bottom'][0], _w['bottom'][1], _w['framePx']))
        # 六边形：百分比是按**那个 div 的边框盒**解析的，而 div 里只有一个行内
        # `<img>`，高度就是行盒高 —— 真站 `#content p{line-height:1.8}` 下行盒正好
        # 等于图高（20 个裁剪框实测一律 60×60），所以横竖都按图边长解析，高宽比 1.0，
        # 底顶点就落在贴图下边缘上（在图**里面**）。
        # 曾经照缓存页（没皮肤、行高退回 normal）量成 60×64，据此把六边形纵向拉长
        # 了 4px、还让底顶点冒到图外 —— 那是错的。
        _hex_cases = [('pride1', 60, '傲慢·60px 贴图'), ('gloom1', 55, '忧郁·55px 贴图')]
        for _tag, _px, _cn in _hex_cases:
            _g = icon_geom.get(_tag) or {}
            _h = _g.get('hex')
            if not _h:
                check('%s 的六边形被录下来了' % _cn, False, '没有 7 顶点的裁剪路径')
                continue
            _xs = [p[0] for p in _h]
            _ys = [p[1] for p in _h]
            _want_w = 0.96 * _px          # 多边形横向跨 2% ~ 98%
            _got_w = max(_xs) - min(_xs)
            _got_h = max(_ys) - min(_ys)
            _mt = _g['want']['icon'][1]
            check('%s 的六边形宽度 = 0.96×边长' % _cn, abs(_got_w - _want_w) < 0.05,
                  '%.2f，期望 %.2f' % (_got_w, _want_w))
            check('%s 的六边形高宽比 = 1.0（裁剪框是正方形）' % _cn,
                  abs(_got_h / _got_w - 1.0) < 0.005,
                  '%.4f，期望 1.0000' % (_got_h / _got_w))
            check('%s 的六边形底顶点落在贴图下边缘（灰机就在这里）' % _cn,
                  abs(max(_ys) - (_mt + _px)) < 0.01,
                  '底顶点 y=%.2f，贴图下边缘 y=%.2f' % (max(_ys), _mt + _px))

        print("\n== 5. 导出 PNG ==")
        png = page.evaluate("""
          Card.toBlob(App.current, { width: 560, theme: 'dark', scale: 2 })
            .then(function (b) { return { size: b ? b.size : 0, type: b ? b.type : '' }; })
            .catch(function (e) { return { err: String(e) }; })
        """)
        check('toBlob 没抛异常（立绘是 data URL，没污染画布）',
              not png.get('err'), png.get('err'))
        check('导出的是非空 PNG', png.get('size', 0) > 10 * 1024,
              '%d KB / %s' % (png.get('size', 0) // 1024, png.get('type')))
        dims = page.evaluate("""
          Card.toBlob(App.current, { width: 560, theme: 'dark', scale: 2 })
            .then(function (b) {
              return createImageBitmap(b).then(function (bm) {
                return { w: bm.width, h: bm.height };
              });
            })
        """)
        check('导出是 2 倍分辨率（宽 ≥ 1120）', dims.get('w', 0) >= 1120, dims)

        # 真点一次工具栏的导出，确认下载链路也是通的
        with page.expect_download(timeout=15000) as dl:
            page.click('.pv-toolbar button[data-act="png"]')
        d = dl.value
        check('点「导出 PNG」真的触发了下载',
              d.suggested_filename.endswith('.png'), d.suggested_filename)

        print("\n== 6. JSON 导出 / 导入往返 ==")
        rt = page.evaluate("""
          (function () {
            var env = JSON.parse(Store.toJSON());
            var back = env.items.map(function (it) {
              return Model.normalize(Model.migrate(it));
            });
            var a = App.current, b = back[0];
            if (!b) return { n: 0 };
            return {
              n: back.length,
              name: a.name === b.name,
              hp: a.hp === b.hp,
              sinner: a.sinner === b.sinner,
              resist: JSON.stringify(a.resist) === JSON.stringify(b.resist),
              nskill: a.skills.length === b.skills.length,
              effects: JSON.stringify(a.skills[0].stages[0].effects) ===
                       JSON.stringify(b.skills[0].stages[0].effects),
              npassive: a.passives.length === b.passives.length,
              ptext: JSON.stringify(a.passives[0].stages) ===
                     JSON.stringify(b.passives[0].stages),
              spd: JSON.stringify(a.spd) === JSON.stringify(b.spd)
            };
          })()
        """)
        check('往返：导出条数正确', rt.get('n') == 1, rt.get('n'))
        for k in ('name', 'hp', 'sinner', 'resist', 'nskill', 'effects',
                  'npassive', 'ptext', 'spd'):
            check('往返：%s 字段一致' % k, rt.get(k) is True, rt)

        # 再走一遍真实的文件导入（造一个 File 塞给 input）
        imp = page.evaluate("""
          (function () {
            var env = JSON.parse(Store.toJSON());
            env.items[0].id = 'imported_test_id';
            env.items[0].name = '导入回来的条目';
            var f = new File([JSON.stringify(env)], 'x.json', { type: 'application/json' });
            var dt = new DataTransfer();
            dt.items.add(f);
            var input = document.getElementById('fileJSON');
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()
        """)
        check('能把 JSON 塞回文件输入框', imp)
        page.wait_for_timeout(600)
        check('导入时弹出了「选择导入方式」',
              page.eval_on_selector('#modal', 'e => e.classList.contains("show")'))
        page.click('#modal .macts button[data-i="1"]')      # 追加
        page.wait_for_timeout(700)
        check('追加导入后有 2 条自定义条目',
              page.evaluate("Store.items().length") == 2,
              page.evaluate("Store.items().length"))
        check('导入的条目名字对',
              page.evaluate("""
                Store.items().some(function (x) { return x.name === '导入回来的条目'; })
              """))

        print("\n== 7. 导出 wiki 文本 ==")
        wt = page.evaluate("""
          ({ huiji: WikiText.format('huiji').fn(App.current),
             mw: WikiText.format('mediawiki').fn(App.current) })
        """)
        check('灰机文本里有 {{技能链接', '{{技能链接' in wt.get('huiji', ''))
        check('灰机文本里有 1技能-名称', '1技能-名称' in wt.get('huiji', ''))
        check('灰机文本还原了状态模板 {{状态2',
              '{{状态2' in wt.get('huiji', '') or '**' not in wt.get('huiji', ''))
        # 嵌套模板里的竖线是模板参数按花括号配对切的，不该被转义成 {{!}}：
        # 灰机源数据本身就是 {{硬币|2}}{{颜色|命中时}} 这么写的
        check('灰机文本没有把嵌套模板的竖线转义成 {{!}}',
              '{{!' not in wt.get('huiji', ''),
              [l for l in wt.get('huiji', '').split('\n') if '{{!' in l][:1])
        check('灰机文本的输出结构和 wiki 源文一致（{{颜色|…}} 是普通竖线）',
              '{{颜色|' in wt.get('huiji', '') and '{{硬币|' in wt.get('huiji', ''))
        check('MediaWiki 文本没漏出 ** 加粗标记',
              '**' not in wt.get('mw', ''),
              [l for l in wt.get('mw', '').split('\n') if '**' in l][:1])
        check('MediaWiki 文本是 wikitable', 'wikitable' in wt.get('mw', ''))
        check('MediaWiki 文本里有体力', '体力' in wt.get('mw', ''))

        # 多技能人格（6 条，含 强化1技能 和 5技能）的导出 —— 以前这几个槽位
        # 在解析阶段就被整个漏掉了，卡片和 wikitext 两头都是空的
        multi = page.evaluate("""
          (function () {
            var it = Library.seed().items.filter(function (x) {
              return x.kind === 'identity' && x.name.indexOf('品牌经理') >= 0;
            })[0];
            var d = Model.derive(it);
            return { n: d.skills.length, slots: d.skills.map(function (s) {
                       return s.slot; }).join(','),
                     wt: WikiText.format('huiji').fn(d) };
          })()
        """)
        check('多技能人格解析出了 6 条技能', multi.get('n') == 6, multi.get('slots'))
        check('槽位里有 强化1技能 / 5技能',
              '强化1技能' in (multi.get('slots') or '') and
              '5技能' in (multi.get('slots') or ''), multi.get('slots'))
        check('灰机文本带上了强化槽位的参数前缀',
              '|强化1技能-名称=' in multi.get('wt', '') and
              '|5技能-名称=' in multi.get('wt', ''),
              [l for l in multi.get('wt', '').split('\n') if '强化1技能-名称' in l][:1])

        # 上面几项是直接调函数，这里走一遍工具栏：点按钮 → 下载 → 抽屉升起来。
        # 这条路径以前是坏的（按钮读了一个不存在的 #textFormat），直接调函数测不出来
        check('工具栏里有导出文本的按钮和格式选择',
              page.eval_on_selector_all('#textFormat option', 'e => e.length') >= 2)
        with page.expect_download(timeout=15000) as dl2:
            page.click('.pv-toolbar button[data-act="exportText"]')
        check('点「导出文本」真的触发了下载',
              dl2.value.suggested_filename.endswith(('.txt', '.wiki')),
              dl2.value.suggested_filename)
        page.wait_for_timeout(400)
        check('导出文本后抽屉升起来了',
              page.eval_on_selector('.text-preview', 'e => e.classList.contains("show")'))
        check('抽屉里是这次导出的正文（不是上次的残留）',
              '{{技能链接' in page.eval_on_selector('#textPreview', 'e => e.textContent'))
        page.click('.text-preview .tp-h button[data-act="closeText"]')
        page.wait_for_timeout(300)
        check('抽屉能关掉',
              not page.eval_on_selector('.text-preview', 'e => e.classList.contains("show")'))

        print("\n== 8. 结构增删（不重建整表、焦点不丢）==")
        # 技能 / 被动两块默认是折叠的，先展开才点得到里面的按钮
        for key in ('skills', 'passives'):
            sel = '#formScroll .sec[data-sec="%s"]' % key
            if not page.eval_on_selector(sel, 'e => e.classList.contains("open")'):
                page.click(sel + ' .sec-h')
                page.wait_for_timeout(250)
        check('技能分区展开后按钮可见',
              page.eval_on_selector('.mini.add[data-act="addEffect"]',
                                    'e => !!(e.offsetWidth || e.offsetHeight)'))
        n_eff = page.eval_on_selector_all('.eff-row', 'e => e.length')
        page.click('.mini.add[data-act="addEffect"]')
        page.wait_for_timeout(500)
        check('能加一条硬币效果行',
              page.eval_on_selector_all('.eff-row', 'e => e.length') == n_eff + 1,
              '%d → %d' % (n_eff, page.eval_on_selector_all('.eff-row', 'e => e.length')))
        check('加完焦点落在新行的文本框上',
              page.evaluate("""(function(){
                var el = document.activeElement;
                return !!el && el.getAttribute('data-path') &&
                       el.getAttribute('data-path').indexOf('.effects.') >= 0;
              })()"""),
              page.evaluate("document.activeElement.getAttribute('data-path')"))
        page.click('.eff-row .mini.del[data-act="delEffect"]')
        page.wait_for_timeout(500)
        check('能删掉一条效果行',
              page.eval_on_selector_all('.eff-row', 'e => e.length') == n_eff)

        # 技能列表的增删移（和被动一样是结构性变更，重建的只有这一块）
        n_sk = page.eval_on_selector_all('.skill-item', 'e => e.length')
        page.click('.btn-add[data-act="addSkill"]')
        page.wait_for_timeout(500)
        check('能加一个技能槽',
              page.eval_on_selector_all('.skill-item', 'e => e.length') == n_sk + 1,
              '%d → %d' % (n_sk, page.eval_on_selector_all('.skill-item', 'e => e.length')))
        check('新槽位自动取了下一个号（5技能）',
              page.evaluate("App.current.skills[App.current.skills.length - 1].slot")
              == '5技能',
              page.evaluate("App.current.skills[App.current.skills.length - 1].slot"))

        # 把第一个技能从攻击切成守备：这一块要原地重建，字段从「攻击类型」换成
        # 「守备类型」，种类跟着换成 def
        page.evaluate("""
          (function () {
            var sel = document.querySelector('[data-path="skills.0.kind"]');
            sel.value = 'def';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        """)
        page.wait_for_timeout(500)
        check('切技能种类后字段跟着换成守备类型',
              page.evaluate("""(function () {
                return !!document.querySelector('[data-path="skills.0.defType"]') &&
                       !document.querySelector('[data-path="skills.0.atk"]');
              })()"""))
        check('model 里的种类也改成了 def',
              page.evaluate("App.current.skills[0].kind") == 'def',
              page.evaluate("App.current.skills[0].kind"))
        page.evaluate("""
          (function () {
            var sel = document.querySelector('[data-path="skills.0.kind"]');
            sel.value = 'atk';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        """)
        page.wait_for_timeout(400)

        page.locator('.skill-item').last.locator('.mini[data-act="delSkill"]').click()
        page.wait_for_timeout(500)
        check('能删掉那个技能槽',
              page.eval_on_selector_all('.skill-item', 'e => e.length') == n_sk,
              page.eval_on_selector_all('.skill-item', 'e => e.length'))

        n_pas = page.eval_on_selector_all('.passive-item', 'e => e.length')
        page.click('.btn-add[data-act="addPassive"]')
        page.wait_for_timeout(500)
        check('能加一条战斗被动',
              page.eval_on_selector_all('.passive-item', 'e => e.length') == n_pas + 1,
              '%d → %d' % (n_pas, page.eval_on_selector_all('.passive-item', 'e => e.length')))
        page.click('.passive-item .sub-del[data-act="delPassive"]')
        page.wait_for_timeout(500)
        check('能删掉刚加的那条',
              page.eval_on_selector_all('.passive-item', 'e => e.length') == n_pas)

        print("\n== 9. 折叠 / 主题 / 快捷键 ==")
        sec = page.eval_on_selector('#formScroll .sec', 'e => e.getAttribute("data-sec")')
        page.click('#formScroll .sec[data-sec="%s"] .sec-h' % sec)
        page.wait_for_timeout(300)
        check('点分区标题能折叠',
              not page.eval_on_selector('#formScroll .sec[data-sec="%s"]' % sec,
                                        'e => e.classList.contains("open")'))
        page.click('#formScroll .sec[data-sec="%s"] .sec-h' % sec)
        page.wait_for_timeout(300)
        check('再点一次能展开',
              page.eval_on_selector('#formScroll .sec[data-sec="%s"]' % sec,
                                    'e => e.classList.contains("open")'))

        t0 = page.evaluate("document.documentElement.getAttribute('data-theme')")
        page.click('.tb button[data-act="theme"]')
        page.wait_for_timeout(200)
        t1 = page.evaluate("document.documentElement.getAttribute('data-theme')")
        check('主题能切换', t0 != t1, '%s → %s' % (t0, t1))

        page.select_option('#cardWidth', '720')
        page.wait_for_timeout(500)
        check('改卡片宽度后重绘',
              page.eval_on_selector('#pvSize', 'e => e.textContent').startswith('720'),
              page.eval_on_selector('#pvSize', 'e => e.textContent'))
        page.select_option('#cardWidth', '560')
        page.wait_for_timeout(400)

        print("\n== 10. 新建空白条目 ==")
        page.click('.tb button[data-act="newEgo"]')
        page.wait_for_timeout(700)
        check('新建 E.G.O 成功', page.evaluate("App.current.kind") == 'ego')
        check('E.G.O 表单有罪孽抗性网格',
              page.eval_on_selector_all('.resist-grid', 'e => e.length') >= 2)
        check('E.G.O 的解析阶段标签是 Ⅰ/Ⅲ/Ⅳ/Ⅴ',
              page.evaluate("""
                (function () {
                  var t = document.querySelector('.stage-n').textContent;
                  return t.indexOf('Ⅰ') === 0;
                })()
              """))
        check('E.G.O 卡片能渲染',
              page.evaluate("document.getElementById('card').height") > 200)
        # 新建的空白 E.G.O 什么都没填，校验器应该挑出毛病来（名字为空等）
        issue_txt = page.eval_on_selector('#pvIssues', 'e => e.textContent')
        check('空条目的校验提示出现在预览下方',
              page.eval_on_selector('#pvIssues', 'e => e.classList.contains("warn")')
              and len(issue_txt) > 0, issue_txt[:50])

        print("\n== 10b. E.G.O 技能也有数值行（基础值 / 硬币威力 / 攻击容量）==")
        # 灰机 E.G.O 那个「升阶属性」表里，每个解析阶段页签都写着
        # 「基础值：N / 硬币威力：+N / 攻击容量：N」。卡片以前**一个都不画**
        #（只有多阶段时在阶段标签后面挤两个数），所以这三项单独验一遍。
        # 手法跟 3d 一样：改一个数、看两次渲染的差异是不是一条横带。
        egonum = page.evaluate("""
          (function () {
            var seed = Library.seed(), src = null;
            for (var i = 0; i < seed.items.length; i++) {
              if (seed.items[i].id === 's_ego_21101') src = seed.items[i];
            }
            if (!src) return { err: '找不到致智慧与苦难' };
            /* 只留觉醒技能那一条，差异就不会被别处重排掺进来 */
            function only() {
              var c = Model.deepCopy(src);
              c.corrode.stages = c.corrode.stages.map(function (s) {
                return { on: false, power: null, coinPower: null, weight: null,
                         effects: [] };
              });
              c.corrode.name = '';
              return c;
            }
            function shot(it) {
              var c = document.createElement('canvas');
              Card.render(c, it, { width: 921, theme: 'dark', scale: 1, stage: 'iv' });
              return c.getContext('2d').getImageData(0, 0, c.width, c.height);
            }
            function band(a, b) {
              if (a.width !== b.width || a.height !== b.height) {
                return { err: '两张卡片尺寸不同：' + a.width + 'x' + a.height +
                             ' vs ' + b.width + 'x' + b.height };
              }
              var n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
              for (var y = 0; y < a.height; y++) {
                for (var x = 0; x < a.width; x++) {
                  var i = (y * a.width + x) * 4, d = 0;
                  for (var k = 0; k < 4; k++) {
                    d += Math.abs(a.data[i + k] - b.data[i + k]);
                  }
                  if (d > 12) {
                    n++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                  }
                }
              }
              return { n: n, w: n ? x1 - x0 + 1 : 0, h: n ? y1 - y0 + 1 : 0 };
            }
            /* 最高那一阶是解析Ⅳ，也就是下标 2 */
            var a1 = only(), a7 = only();
            a1.awaken.stages[2].weight = 1;
            a7.awaken.stages[2].weight = 7;
            var p1 = only(), p2 = only();
            p1.awaken.stages[2].power = 11;
            p2.awaken.stages[2].power = 22;
            var r = { cap: band(shot(a1), shot(a7)), power: band(shot(p1), shot(p2)) };
            r.same = band(shot(a1), shot(a1));
            return r;
          })()
        """)
        check('拿得到 E.G.O 致智慧与苦难', not egonum.get('err'), egonum.get('err'))
        if not egonum.get('err'):
            check('同一份输入渲染两遍逐像素相同（差异分析的前提）',
                  egonum['same']['n'] == 0, egonum['same'])
            check('E.G.O 攻击容量 1 → 7 的差异是一条横带（高度 ≤ 40px）',
                  0 < egonum['cap']['h'] <= 40, egonum['cap'])
            check('E.G.O 攻击容量的差异横向铺开（宽度 ≥ 60px，是黄方块）',
                  egonum['cap']['w'] >= 60, egonum['cap'])
            check('E.G.O 基础值 11 → 22 的差异是一条横带（高度 ≤ 30px）',
                  0 < egonum['power']['h'] <= 30, egonum['power'])

        print("\n== 11. 截图 ==")
        page.click('.tb button[data-act="theme"]')      # 切回深色再截
        page.wait_for_timeout(200)

        # 按名字搜出来再点，别指望列表第一行恰好是想要的那条 ——
        # 前面几步已经往「我的」里塞了好几条东西了
        for kind, term, name in (('identity', '李箱 LCB', 'identity.png'),
                                 ('ego', '致智慧与苦难', 'ego.png')):
            page.click('.lib-tabs button[data-tab="seed"]')
            page.fill('#libSearch', term)
            page.wait_for_timeout(400)
            page.click('#lib .row')
            page.wait_for_timeout(1000)
            ok = page.evaluate("App.current.kind") == kind
            page.screenshot(path=os.path.join(SHOTS, name))
            check('%s 截图写出的是%s' % (name, '人格' if kind == 'identity' else 'E.G.O'),
                  ok and os.path.exists(os.path.join(SHOTS, name)),
                  page.evaluate("App.current.name"))

        print("\n== 12. 收尾 ==")
        check('全程没有控制台报错', not errors, ' / '.join(errors[:3]))

        browser.close()

    print("\n" + "=" * 60)
    if FAILS:
        print("%d / %d 项没通过：" % (len(FAILS), len(STEPS)))
        for f in FAILS:
            print("  x", f)
        sys.exit(1)
    print("全部 %d 项通过。截图在 %s" % (len(STEPS), SHOTS))


if __name__ == '__main__':
    main()
