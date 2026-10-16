# -*- coding: utf-8 -*-
"""在**缓存下来的 E.G.O 页**上量觉醒 / 侵蚀技能块的真实坐标。

    python tools/probe_ego.py [选择器]

E.G.O 的技能块跟人格的技能块是**两套模板**：人格走 `模板:攻击技能text`（六边形
贴图 + 罪孽色横幅 + 数值行），E.G.O 走 `模板:E.G.O技能`（立绘 + 右上角一串数值）。
卡片这边两条渲染路径也是分开的（drawSkillPane / drawEgoSkill），所以要单独量。

跟 probe_live.py 一样，**必须带真站样式**（走 tools/wiki_page.py）—— 缓存页的
`<link href="/load.php?…">` 是相对路径、file:// 下 404，量出来的几何全是错的。

读的是 _ref/huiji 下的缓存 HTML（下载物，只当数据看）。
"""

import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HUIJI = os.path.join(ROOT, "_ref", "huiji")
PAGE = os.path.join(HUIJI, "page_ego_乌瞰刀.html")

sys.path.insert(0, HERE)
import wiki_page  # noqa: E402

# 先看看页面上有哪些像技能块的东西
JS_FIND = r"""
() => {
  const out = [];
  for (const el of document.querySelectorAll('#content *')) {
    const cls = String(el.className || '');
    if (!cls) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 40) continue;
    out.push({ tag: el.tagName.toLowerCase(), cls: cls,
               w: +r.width.toFixed(1), h: +r.height.toFixed(1),
               txt: (el.textContent || '').trim().slice(0, 24) });
  }
  return out;
}
"""

JS_WALK = r"""
(sel) => {
  const root = document.querySelector(sel);
  if (!root) return { err: '找不到 ' + sel };
  const base = root.getBoundingClientRect();
  const out = [];
  const walk = (el, depth) => {
    for (const ch of el.children) {
      if (['META', 'STYLE', 'SCRIPT', 'TITLE', 'LINK'].includes(ch.tagName)) continue;
      const st = getComputedStyle(ch);
      const r = ch.getBoundingClientRect();
      const img = ch.tagName === 'IMG' ? ch
        : ch.querySelector(':scope > img, :scope > p > img');
      out.push({
        depth, tag: ch.tagName.toLowerCase(),
        cls: String(ch.className || '').slice(0, 18),
        z: st.zIndex,
        x: +(r.left - base.left).toFixed(2), y: +(r.top - base.top).toFixed(2),
        w: +r.width.toFixed(2), h: +r.height.toFixed(2),
        lh: st.lineHeight, mar: st.margin, pad: st.padding,
        fs: st.fontSize, fw: st.fontWeight, color: st.color,
        bg: st.backgroundColor, bgImg: st.backgroundImage.slice(0, 60),
        clip: st.clipPath && st.clipPath !== 'none' ? st.clipPath : '',
        txt: (ch.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30),
        img: img ? { w: img.getAttribute('width'), h: img.getAttribute('height'),
                     src: decodeURIComponent(String(img.src).split('/').pop()),
                     nw: img.naturalWidth, nh: img.naturalHeight } : null
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
    sel = sys.argv[1] if len(sys.argv) > 1 else None
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)
        pg = wiki_page.styled_page(b, PAGE, dsf=2)
        if sel is None:
            print("页面上的候选块（class 非空、≥100×40）：\n")
            for e in pg.evaluate(JS_FIND):
                print("  %-6s %-40s %7.1f %7.1f  %s"
                      % (e["tag"], e["cls"], e["w"], e["h"], e["txt"]))
        else:
            geom = pg.evaluate(JS_WALK, sel)
            b.close()
            if geom.get("err"):
                sys.exit(geom["err"])
            print("块 %.1f×%.1f（坐标相对它左上角，已含站点 CSS）\n"
                  % (geom["root"]["w"], geom["root"]["h"]))
            print("%-3s %-5s %-18s %4s %8s %8s %7s %7s %-8s %-16s %s"
                  % ("lv", "tag", "class", "z", "x", "y", "w", "h", "fs/lh",
                     "color/bg", "图 / clip / 文本"))
            for e in geom["out"]:
                desc = ""
                if e["img"]:
                    desc = "%s gen%sx%s nat%sx%s" % (e["img"]["src"], e["img"]["w"],
                                                     e["img"]["h"], e["img"]["nw"],
                                                     e["img"]["nh"])
                if e["clip"]:
                    desc = (desc + "  " if desc else "") + "clip " + e["clip"]
                if e["txt"]:
                    desc = (desc + "  " if desc else "") + "“" + e["txt"] + "”"
                print("%-3d %-5s %-18s %4s %8.1f %8.1f %7.1f %7.1f %-8s %-16s %s"
                      % (e["depth"], e["tag"], e["cls"], e["z"], e["x"], e["y"],
                         e["w"], e["h"], e["fs"] + "/" + e["lh"],
                         e["color"] + "/" + e["bg"], desc))
            return
        b.close()


if __name__ == "__main__":
    main()
