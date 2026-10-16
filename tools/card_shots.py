# -*- coding: utf-8 -*-
"""把几张卡片单独导成 PNG，方便人眼核对排版。

    python tools/card_shots.py

整页截图里卡片只占一小块，缩到 1600px 宽之后中文就糊了，看不出折行、留白、
字号层级对不对。这里直接用 Card.toBlob（跟「导出 PNG」同一条代码路径）把
指定的几个条目按 2 倍分辨率写出来，一张一张看。
"""

import base64
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, "index.html")
OUT = os.path.join(ROOT, "_ref", "shots")

# 名字 → 取哪一条。都是界面上真能点出来的东西：种子库里的第一条人格、
# 第一条 E.G.O，以及「新建」出来的空白条目。
CASES = [
    # derive 一遍再画：界面上点开内置条目走的也是这条路（先副本、再 normalize），
    # 直接拿种子里的原始对象画就绕过了 normalize，看不到真实效果
    ("id_seed", """
      Model.derive(Library.seed().items.filter(function (x) {
        return x.kind === 'identity';
      })[0])
    """),
    ("ego_seed", """
      Model.derive(Library.seed().items.filter(function (x) {
        return x.kind === 'ego';
      })[0])
    """),
    # 技能条数最多的那两个人格 —— 用户点名说过「技能不止这么点」的就是这类，
    # 图上要能看到 6 条 / 13 条技能各自成块
    ("id_dq6", """
      Model.derive(Library.seed().items.filter(function (x) {
        return x.kind === 'identity' && x.name.indexOf('品牌经理') >= 0;
      })[0])
    """),
    ("id_sinclair13", """
      Model.derive(Library.seed().items.filter(function (x) {
        return x.kind === 'identity' && x.name.indexOf('赤红之神') >= 0;
      })[0])
    """),
    # 用户点名的两个极值：李箱蜘蛛巢食指父辈的 Furioso-Replica 是内置数据里
    # 硬币最多（9 枚）、攻击容量最大（7 格）的技能，硬币画成横排之后一眼要能数清。
    ("id_furioso9", """
      Model.derive(Library.seed().items.filter(function (x) {
        return x.kind === 'identity' && x.code === '10115';
      })[0])
    """),
    # 被除名的关键词：鸿璐蜘蛛巢环指父辈的「大师」在灰机上是 <s> 划掉的，
    # 解析成 ~~大师~~ 之后卡片上应该是一道压在字上的横线。
    ("id_strike", """
      Model.derive(Library.seed().items.filter(function (x) {
        return x.kind === 'identity' && x.code === '10614';
      })[0])
    """),
    ("id_blank", "Model.createIdentity()"),
    ("ego_blank", "Model.createEgo()"),
    # 长名字 + 长效果文本：折行、缩字号、卡片高度的边界情况
    ("id_long", """
      (function () {
        var it = Model.derive(Library.seed().items.filter(function (x) {
          return x.kind === 'identity';
        })[0]);
        it.name = '鸿璐 Cinq协会东部3科（特别定制·极长名字压力测试）';
        it.nameAlt = 'Hong Lu Cinq Association East Section 3';
        it.skills[0].stages[3].effects.push({
          coin: 3, trigger: '命中时',
          text: '使目标增加8级沉沦强度并对其施加3层沉沦，若目标带有破裂则改为施加5层破裂'
        });
        return it;
      })()
    """),
]

# 卡片自己的深浅配色是独立于界面主题的另一套值，单独截一张确认浅色也对
LIGHT = {"id_seed": True, "ego_seed": True}


def main():
    from playwright.sync_api import sync_playwright

    os.makedirs(OUT, exist_ok=True)
    url = 'file:///' + INDEX.replace('\\', '/')
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        page = browser.new_page(viewport={'width': 1680, 'height': 1000})
        page.goto(url)
        page.wait_for_timeout(1500)

        for name, expr in CASES:
            themes = ['dark', 'light'] if name in LIGHT else ['dark']
            for theme in themes:
                b64 = page.evaluate("""
                  (function () {
                    var it = %s;
                    // 内置条目带上真立绘，走的就是界面上那条 data URL 路径
                    var src = it.code
                      ? Library.seed().portraits[it.kind + ':' + it.code] : null;
                    var imgP = src ? new Promise(function (res) {
                      var im = new Image();
                      im.onload = function () { res(im); };
                      im.onerror = function () { res(null); };
                      im.src = src;
                    }) : Promise.resolve(null);
                    return imgP.then(function (img) {
                      return Card.toBlob(it, {
                      // 用卡片自己的默认宽度（921）——技能块是按灰机的 893px
                      // 内宽量出来的，换宽度就不是「跟网页一致」的对照图了
                      width: Card.W_DEFAULT, theme: '%s', scale: 2, image: img
                    });
                    }).then(function (b) {
                      return new Promise(function (res) {
                        var fr = new FileReader();
                        fr.onload = function () { res(String(fr.result).split(',')[1]); };
                        fr.readAsDataURL(b);
                      });
                    });
                  })()
                """ % (expr, theme))
                if not b64:
                    print("  !! %s/%s 没导出东西" % (name, theme))
                    continue
                raw = base64.b64decode(b64)
                path = os.path.join(OUT, 'card_%s_%s.png' % (name, theme))
                with open(path, 'wb') as f:
                    f.write(raw)
                print("  %-14s %6.1f KB  %s"
                      % ('%s/%s' % (name, theme), len(raw) / 1024, path))

        browser.close()


if __name__ == '__main__':
    main()
