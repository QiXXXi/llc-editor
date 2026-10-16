# -*- coding: utf-8 -*-
"""把灰机「技能图标」的几何参数抽出来，并在缓存页面上复核。用完删。

灰机的技能图标不是卡片自己摆的：它是 `模板:攻击技能text` 里一句
`{{{{{罪孽}}}技能图标|图标=…|等级=…}}`，而 `模板:XX技能图标` 里写着
**每个等级各自的 margin-left / margin-top**。所以「歪不歪」这件事的答案不在
渲染结果里，在模板源码里 —— 这里就把源码抽出来，再跟页面实测对一遍。

读的是 _ref/huiji 下的下载物（只当数据看）。
"""

import importlib.util
import io
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wiki_page  # noqa: E402

# 底部那张图在模板里独占一行，MediaWiki 会给它套一个 `<p>`，于是**多顶下来一个
# `<p>` 的上外边距**。这个值不是浏览器的默认 16px —— 真站 DragonHide 皮肤写的是
# `#content p{margin:7.5px 0}`（那条规则在 _ref/huiji/css/skin.css 里）。
# 缓存页的 `<link href="/load.php?...">` 是相对路径、file:// 下必然 404，整站样式
# 都加载不上，`<p>` 就退回 UA 默认的 16px —— 差 8.5px，肉眼一眼能看出底色板歪了。
# 所以下面一律按真站的 7.5 算，并且拿页面上实测的坐标复核。
P_MARGIN = 7.5

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROBE = os.path.join(ROOT, "_ref", "huiji", "probe")
PAGE = os.path.join(ROOT, "_ref", "huiji", "page_堂吉诃德高级定制_黑派_品牌经理.425eae6dc2.html")

SINS = ['傲慢', '暴怒', '色欲', '怠惰', '暴食', '忧郁', '嫉妒', '常规']

SWITCH = re.compile(r"\{\{#switch:\{\{\{等级\|1\}\}\}(.*?)\}\}", re.S)

# 三个 div 各管一段：框贴图 / 图标（含 clip-path）/ 底部贴图。底部那段里有**两个**
# #switch（一个管 margin、一个管图名），所以不能按出现次序数块，得按结构切。
# 嫉妒那张写的是 `z-index:2"`（少个分号），所以别把分号写死。
RE_FRAME = re.compile(r'z-index:2;?\s*">(.*?)</div>', re.S)
RE_ICON = re.compile(r'color:#BB521F;(.*?)">(.*?)</div>', re.S)
RE_BOTTOM = re.compile(r'z-index:-1;(.*?)">(.*?)</div>', re.S)


def _entries(block):
    """把 `|1=…|2=…|3=…` 拆成 {1: '…', 2: '…', 3: '…'}。值里本身有 `|`。"""
    out = {}
    for m in re.finditer(r"\|([123])=(.*?)(?=\|[123]=|\Z)", block, re.S):
        out[int(m.group(1))] = m.group(2).strip()
    return out


def _file(entry):
    m = re.search(r"\[\[file:([^|\]]+)\|(\d+(?:\.\d+)?)px", entry, re.I)
    return (m.group(1), float(m.group(2))) if m else (None, None)


def _px(entry):
    """图标那行写的是 `[[file:{{{图标|803102}}}.png|60px|link=]]` —— 图名里带 `|`，
    `_file` 的 `[^|]` 会断在里面，所以宽度单独抓。"""
    m = re.search(r"\|(\d+(?:\.\d+)?)px", entry)
    return float(m.group(1)) if m else None


def _margin(entry):
    ml = re.search(r"margin-left:(-?[\d.]+)px", entry)
    mt = re.search(r"margin-top:(-?[\d.]+)px", entry)
    return (float(ml.group(1)) if ml else None, float(mt.group(1)) if mt else None)


def _icon_name(entry):
    """`[[file:{{{图标|803102}}}.png|60px|link=]]` → `803102`（取参数的默认值）。

    页面上渲染出来的图名就是这个默认值，于是能拿它对上「这行是哪个罪孽哪一级」，
    再去跟实测坐标对账。
    """
    m = re.search(r"file:(.+?)\.png", entry)
    if not m:
        return None
    n = m.group(1)
    d = re.search(r"\|([^|}]+)\}\}", n)          # {{{图标|803102}}}
    return (d.group(1) if d else n).strip()


def _by_level(text):
    """把一段（`{{#switch:…}}` 或干脆就是一张 `[[file:…]]`）摊成 {等级: 片段}。

    常规框只有等级1，没写 #switch，那就当三个等级都是它。
    """
    m = SWITCH.search(text)
    if m:
        d = _entries(m.group(1))
        return {lv: d.get(lv, d.get(1, '')) for lv in (1, 2, 3)}, m.group(1)
    return {lv: text for lv in (1, 2, 3)}, text


def parse_template(body):
    mf, mi, mb = RE_FRAME.search(body), RE_ICON.search(body), RE_BOTTOM.search(body)
    if not (mf and mi and mb):
        raise ValueError("模板结构认不出来（框/图标/底部三段没凑齐）")
    frames, _ = _by_level(mf.group(1))
    # 图标那个 div：`">` 前是样式（margin switch + clip-path），之后才是贴图
    iconSwitch = SWITCH.search(mi.group(1))
    iconEnt = _entries(iconSwitch.group(1)) if iconSwitch else {1: mi.group(1)}
    icons, _ = _by_level(mi.group(2))
    bottoms, _ = _by_level(mb.group(2))
    botMargin, _ = _by_level(mb.group(1))
    clip = re.search(r"clip-path:\s*(polygon\([^)]*\))", body)
    # 底部那张图如果**独占一行**，MediaWiki 会给它套一个 `<p>`，于是顶下来一个
    # `<p>` 的上外边距（P_MARGIN）。嫉妒那张模板少写了一个换行
    # （`}}">{{#switch…`），所以只有它和暴食不吃这一下。
    wrap = mb.group(2).startswith('\n')
    geom = {}
    for lv in (1, 2, 3):
        f = _file(frames[lv])
        ml = _margin(iconEnt.get(lv, ''))
        bo, bm = _file(bottoms[lv]), _margin(botMargin[lv])
        geom[lv] = {
            'frame': f[0], 'framePx': f[1],
            'iconName': _icon_name(icons[lv]),
            'iconPx': _px(icons[lv]), 'iconML': ml[0], 'iconMT': ml[1],
            'clip': clip.group(1) if clip else None,
            'bottom': bo[0], 'bottomPx': bo[1],
            'bottomML': bm[0], 'bottomMT': bm[1],
            'wrap': wrap, 'bx': 35 + bm[0], 'by': bm[1] + (P_MARGIN if wrap else 0),
        }
    return geom


# 页面上量：每个图标包装 div 的 computed margin + 框贴图名 + 各自的盒子尺寸
LIVE = r"""
() => {
  const out = [];
  const rel = (r, o) => [+(r.left - o.left).toFixed(2), +(r.top - o.top).toFixed(2),
                         +r.width.toFixed(2), +r.height.toFixed(2)];
  for (const blk of document.querySelectorAll('[class~="3"]')) {
    const o = blk.getBoundingClientRect();
    /* 一个 .3 里可能有好几条技能（1技能 + 强化1技能…），每条各有一套图标 */
    const seen = new Set();
    for (const im of blk.querySelectorAll('img')) {
      const src = decodeURIComponent(im.src.split('/').pop());
      if (!/\d{7}\.png$/.test(src)) continue;
      const d = im.parentElement;
      if (seen.has(d)) continue;
      seen.add(d);
      const st = getComputedStyle(d), r = d.getBoundingClientRect();
      const wrap = d.parentElement;                 // 那个 75×80 的框 div
      const kids = [...wrap.children];
      const fi = wrap.querySelector(':scope > div > img');   // 框贴图
      const bot = kids[kids.length - 1];                     // 底部贴图 div
      const bi = bot.querySelector('img');
      const wr = wrap.getBoundingClientRect();               // 模板坐标系的原点
      out.push({
        icon: src,
        frame: fi ? decodeURIComponent(fi.src.split('/').pop()) : '',
        ml: st.marginLeft, mt: st.marginTop, box: rel(r, o),
        fbox: fi ? rel(fi.getBoundingClientRect(), o) : null,
        bbox: bi ? rel(bi.getBoundingClientRect(), o) : null,
        bdiv: rel(bot.getBoundingClientRect(), o),
        /* 相对那个框 div —— 跟模板源码推出来的 bx/by 是同一个坐标系 */
        bdivTpl: rel(bot.getBoundingClientRect(), wr),
        iconTpl: rel(r, wr),
      });
    }
  }
  return out;
}
"""


def main():
    spec = importlib.util.spec_from_file_location("fw", os.path.join(HERE, "fetch_wiki.py"))
    fw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fw)

    table = {}
    for sin in SINS:
        body = fw.raw("模板:%s技能图标" % sin)
        if not body:
            print("！ 模板:%s技能图标 没抓到" % sin)
            continue
        table[sin] = parse_template(body)

    # 连同八张模板的源码一起留档：const.js 里那张表就是从这儿来的，日后要核
    # 「这组数是谁定的」得能翻到原文。
    os.makedirs(PROBE, exist_ok=True)
    for sin in SINS:
        if sin in table:
            io.open(os.path.join(PROBE, "tpl_%s技能图标.txt" % sin), "w",
                    encoding="utf-8", newline="\n").write(fw.raw("模板:%s技能图标" % sin))
    with io.open(os.path.join(PROBE, "skill_icon_geom.json"), "w",
                 encoding="utf-8", newline="\n") as fp:
        json.dump(table, fp, ensure_ascii=False, indent=1)

    print("模板源码里的图标几何（相对 75×80 那个框 div）：\n")
    for sin in SINS:
        if sin not in table:
            continue
        for lv in (1, 2, 3):
            g = table[sin][lv]
            if g['iconPx'] is None:
                continue
            print("%-3s 等级%d  框 %-26s %sx  图标 %spx  margin(%s,%s)  底部 (%s,%s)%s"
                  % (sin, lv, g['frame'], g['framePx'], g['iconPx'],
                     g['iconML'], g['iconMT'], g['bx'], g['by'],
                     '' if g['wrap'] else '  ← 没被 <p> 顶下去'))
    print("\nclip-path（各罪孽一致）：", table['傲慢'][1]['clip'])

    if not os.path.exists(PAGE):
        print("\n（没有缓存整页，跳过实测）")
        return
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = wiki_page.styled_page(b, PAGE)      # 必须带真站 CSS，见 wiki_page.py
        rows = pg.evaluate(LIVE)
        b.close()

    print("\n缓存页面上实测（%d 个技能图标，坐标都相对所在 .3 的左上角）：\n" % len(rows))
    import collections
    shapes = collections.Counter(tuple(r['box'][2:]) for r in rows)
    print("  裁剪框尺寸分布：", "  ".join("%.0f×%.0f ×%d" % (k[0], k[1], v)
                                          for k, v in shapes.most_common()))
    print()
    print("  %-14s %-26s %-16s %-18s %-18s" % ("图标", "框贴图", "裁剪框(x,y,w,h)",
                                               "框贴图(x,y,w,h)", "底部贴图(x,y,w,h)"))
    for r in rows:
        f = lambda b: "(%.0f,%.0f,%.0f,%.0f)" % tuple(b) if b else "-"
        print("  %-14s %-26s %-16s %-18s %-18s"
              % (r['icon'], r['frame'],
                 "(%.0f,%.0f,%.0f,%.0f)" % tuple(r['box']), f(r['fbox']), f(r['bbox'])))
    print("\n  底部贴图 div 的位置：", ", ".join("(%.1f,%.1f)" % tuple(r['bdiv'][:2])
                                                 for r in rows[:8]))

    # 对账：模板语法是三个 position:absolute 的子 div（top/left 都是 auto，即都停在
    # 容器左上角），各自被 margin 推开 —— 所以「相对容器」的实测坐标应当**逐像素**
    # 等于模板里写的 margin（底部再加那个 <p> 的 7.5px）。这条对不上就是推导错了。
    print("\n对账（模板写的 margin  vs  页面实测，坐标都相对那个 75×80 容器 div）："
          "\n  %-3s %-4s %-18s %-18s %-20s %-8s" %
          ("罪孽", "等级", "模板 margin(ml,mt)", "实测 图标(x,y)", "模板→底部(bx,by)", "实测 底部(x,y)"))  # noqa: E501
    bad = []
    for r in rows:
        # 认「这是哪个罪孽哪一级」**按框贴图名认，别按图标名** —— 图标那张是
        # `{{{图标|803102}}}` 的模板默认值，页面上渲染出来的是每个技能自己的
        # `60px-1031501.png`，两边永远对不上（这条对账以前就是这么空转的）。
        # 框贴图（`75px-傲慢-等级1.png`、`75px-Icon_skillFrame_1_2.png`）才是唯一的。
        fname = r['frame'].split('/')[-1]
        fname = re.sub(r'^\d+px-', '', fname)
        hit = [(s, lv) for s in SINS if s in table for lv in (1, 2, 3)
               if table[s][lv].get('frame') == fname]
        if not hit:
            continue
        s, lv = hit[0]
        g = table[s][lv]
        ix, iy = r['iconTpl'][0], r['iconTpl'][1]
        bxx, byy = r['bdivTpl'][0], r['bdivTpl'][1]
        ok = (abs(ix - (g['iconML'] or 0)) <= 0.6 and abs(iy - (g['iconMT'] or 0)) <= 0.6
              and abs(bxx - g['bottomML']) <= 0.6 and abs(byy - g['bottomMT']) <= 0.6)
        if not ok:
            bad.append((s, lv))
        print("  %-3s %-4d %-18s %-18s %-20s %-8s %s"
              % (s, lv, "(%g,%g)" % (g['iconML'], g['iconMT']),
                 "(%.1f,%.1f)" % (ix, iy),
                 "(%g,%g)%s" % (g['bottomML'], g['bottomMT'],
                                "+%.1f" % P_MARGIN if g['wrap'] else ""),
                 "(%.1f,%.1f)" % (bxx, byy), "" if ok else "← 对不上"))
    print("\n  %s" % ("对账全部通过 —— const.js 里那张表就是照这个来的"
                      if not bad else "有 %d 条对不上：%s" % (len(bad), bad)))


if __name__ == '__main__':
    main()
