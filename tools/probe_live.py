# -*- coding: utf-8 -*-
"""在**缓存下来的整张灰机页面**上量技能块的真实坐标。

    python tools/probe_live.py

为什么不能只抠出技能块单独渲染：灰机的站点 CSS（MediaWiki 的 common.css 等）
会影响块里那些 `<p>` / `<b>` 的默认外边距，抠出来单独跑就没这套 CSS 了，
量出来的 y 是错的。所以这里直接开整页，等站点 CSS 和 CDN 图片都到位再量。

**但缓存页自己带不上样式**（`<link href="/load.php?...">` 是相对路径，file:// 下
必然 404），光「开整页」是不够的 —— 见 tools/wiki_page.py。这里统一走
`wiki_page.styled_page()`，把那几份 CSS 按真站内容注回去。

读的是 _ref/huiji 下的缓存 HTML（下载物，只当数据看）。
"""

import io
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HUIJI = os.path.join(ROOT, "_ref", "huiji")
PAGE = os.path.join(HUIJI, "page_堂吉诃德高级定制_黑派_品牌经理.425eae6dc2.html")

sys.path.insert(0, HERE)
import wiki_page  # noqa: E402

JS = r"""
() => {
  /* 第一个技能块。'.3' 不是合法 CSS 选择器，用属性词匹配 */
  const root = document.querySelector('[class~="3"]');
  if (!root) return { err: '页面上找不到 .3 技能块' };
  const base = root.getBoundingClientRect();
  const out = [];
  const walk = (el, depth) => {
    for (const ch of el.children) {
      if (ch.tagName === 'META' || ch.tagName === 'STYLE' ||
          ch.tagName === 'SCRIPT' || ch.tagName === 'TITLE') continue;
      const st = getComputedStyle(ch);
      const r = ch.getBoundingClientRect();
      const img = ch.tagName === 'IMG' ? ch : ch.querySelector(':scope > img, :scope > p > img');
      out.push({
        depth, tag: ch.tagName.toLowerCase(), z: st.zIndex,
        x: +(r.left - base.left).toFixed(2), y: +(r.top - base.top).toFixed(2),
        w: +r.width.toFixed(2), h: +r.height.toFixed(2),
        clip: st.clipPath && st.clipPath !== 'none' ? st.clipPath : '',
        img: img ? { w: img.getAttribute('width'), h: img.getAttribute('height'),
                     src: decodeURIComponent(String(img.src).split('/').pop()) } : null
      });
      walk(ch, depth + 1);
    }
  };
  walk(root, 0);
  return { root: { w: +base.width.toFixed(2), h: +base.height.toFixed(2) }, out };
}
"""


def main():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True)
        pg = wiki_page.styled_page(b, PAGE, dsf=2)
        geom = pg.evaluate(JS)
        b.close()

    if geom.get('err'):
        sys.exit(geom['err'])
    print("第一个 .3 技能块 %.1f×%.1f（坐标相对它左上角，已含站点 CSS）\n"
          % (geom['root']['w'], geom['root']['h']))
    print("%-3s %-5s %-5s %8s %8s %7s %7s  %s"
          % ("lv", "tag", "z", "x", "y", "w", "h", "图 / clip"))
    for e in geom['out']:
        desc = ''
        if e['img']:
            desc = '%s(%sx%s)' % (e['img']['src'], e['img']['w'], e['img']['h'])
        if e['clip']:
            desc = (desc + '  ' if desc else '') + 'clip ' + e['clip']
        print("%-3d %-5s %-5s %8.1f %8.1f %7.1f %7.1f  %s"
              % (e['depth'], e['tag'], e['z'], e['x'], e['y'], e['w'], e['h'], desc))


if __name__ == '__main__':
    main()
