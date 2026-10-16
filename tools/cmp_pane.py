# -*- coding: utf-8 -*-
"""把一个技能块**整块**（图标 + 横幅 + 修正值行 + 徽章 + 威力 + 效果正文）在
「灰机的缓存页」和「卡片」上逐像素比一遍。

    python tools/cmp_pane.py [槽位号]        # 默认 1 技能

tools/cmp_icon.py 只盯六边形那一小块，看不出底板歪了 8.5px、正文行高差了多少
这类「整块错位」。这个工具把两边的技能块对齐之后逐像素相减 —— 差在哪一行、差
几个像素，看 diff 图一眼就明白。

怎么对齐
--------
两边各渲染两次：一次带技能贴图、一次把贴图藏起来，差出来的那块像素就是**被六边形
裁过之后的贴图**，也就是「墨水」的外接矩形。拿它当锚 —— 贴图本身四周可能有几个
透明像素，直接拿 `<img>` 的盒子对齐会带进这份偏差，拿墨水对齐不会。

⚠️ 灰机那边必须**带真站样式**（走 tools/wiki_page.py）。缓存页的
`<link href="/load.php?…">` 是相对路径、file:// 下 404，整站 CSS 全丢：行高退回
`normal`、`<p>` 退回 16px 外边距，量出来的整块几何全是错的。
"""

import base64
import io
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, "index.html")
OUTDIR = os.path.join(ROOT, "_ref", "probe_pane")

sys.path.insert(0, HERE)
import wiki_page  # noqa: E402
from cmp_icon import bbox_of_diff  # noqa: E402

PAGE = wiki_page.PAGE

SLOT = 1
if len(sys.argv) > 1:
    SLOT = int(sys.argv[1])
WIKI_SEL = '.personalitystage4 > .personalityskill%d [class~="3"]' % SLOT

# 灰机：块的矩形 + 第一块的高度（到那根 2px 分隔线为止）
WIKI_BOX = r"""
(sel) => {
  const root = document.querySelector(sel);
  if (!root) return { err: '找不到同步Ⅳ的技能块' };
  const B = root.getBoundingClientRect();
  /* 块里那根 2px 高的分隔线就是两块技能的分界 */
  let h = B.height;
  for (const ch of root.children) {
    const r = ch.getBoundingClientRect();
    if (r.height > 0 && r.height <= 6) { h = r.top - B.top; break; }
  }
  return { bx: B.left, by: B.top, bw: B.width, bh: Math.min(h, B.height),
           vw: innerWidth, vh: innerHeight };
}
"""

# 把块顶滚到视口上方 60px 处。**别用 scrollIntoView**（灰机开了平滑滚动，量早了
# 拿到的还是半路的位置），直接算 scrollTop 一次赋到位。
WIKI_SCROLL = r"""
(sel) => {
  const root = document.querySelector(sel);
  if (!root) return false;
  const se = document.scrollingElement;
  se.scrollTop = se.scrollTop + root.getBoundingClientRect().top - 60;
  return se.scrollTop;
}
"""

# 藏 / 显技能贴图（就是那串七位数编号，页面上是 `60px-1031501.png` 这样的缩略图）
WIKI_HIDE = r"""
([sel, hide]) => {
  const root = document.querySelector(sel);
  if (!root) return { err: '找不到技能块' };
  for (const im of root.querySelectorAll('img')) {
    if (/\d{7}\.png$/.test(decodeURIComponent(im.src))) {
      im.style.visibility = hide ? 'hidden' : '';
    }
  }
  return { ok: true };
}
"""

# 卡片：渲染两次（有 / 无技能贴图），差异的外接矩形 = 裁过之后的六边形
CARD_JS = r"""
(shot) => {
  const seed = Library.seed();
  let item = null;
  for (const it of seed.items) if (it.id === 's_identity_10315') item = it;
  if (!item) return { err: '种子里没有 s_identity_10315' };
  const base = Model.deepCopy(item);
  base.skills = base.skills.filter(s => s.slot === '__SLOT__技能');
  const cv = document.createElement('canvas');
  const opts = { width: 921, theme: 'dark', scale: 2, stage: 'iv' };
  Card.render(cv, Model.deepCopy(base), opts);
  if (!shot) {
    /* 只扫顶上这一条：技能块在卡片顶部，整张图几万像素高，全扫会吃掉几百 MB */
    const SLICE = 1400, W = cv.width, H = Math.min(cv.height, SLICE);
    const ctx = cv.getContext('2d');
    const A = ctx.getImageData(0, 0, W, H).data;
    const b2 = Model.deepCopy(base);
    b2.skills[0].icon = '';
    Card.render(cv, b2, opts);
    const B = ctx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) > 8 || Math.abs(A[i+1] - B[i+1]) > 8 ||
          Math.abs(A[i+2] - B[i+2]) > 8 || Math.abs(A[i+3] - B[i+3]) > 8) {
        const q = i >> 2, x = q % W, y = (q / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { err: '两次渲染没差别，图标没画出来？' };
    return { x0: x0, y0: y0, iw: x1 - x0 + 1, ih: y1 - y0 + 1, dsf: 2 };
  }
  return { png: cv.toDataURL('image/png') };
}
"""


def main():
    from playwright.sync_api import sync_playwright
    from PIL import Image
    import numpy as np

    os.makedirs(OUTDIR, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge", headless=True)

        # --- 灰机：块矩形 + 「墨水」bbox ---
        pg = wiki_page.styled_page(b, PAGE, viewport={"width": 1400, "height": 900},
                                   dsf=2)
        pg.evaluate(WIKI_SCROLL, WIKI_SEL)
        pg.wait_for_timeout(400)
        wb = pg.evaluate(WIKI_BOX, WIKI_SEL)
        if wb.get("err"):
            sys.exit(wb["err"])
        if (wb["bx"] < 0 or wb["by"] < 0 or wb["bx"] + wb["bw"] > wb["vw"] or
                wb["by"] + wb["bh"] > wb["vh"]):
            sys.exit("技能块没落在视口里：%s（视口 %dx%d）" % (wb, wb["vw"], wb["vh"]))
        W = int(round(wb["bw"] * 2))
        H = int(round(wb["bh"] * 2))
        crop = (int(wb["bx"] * 2), int(wb["by"] * 2),
                int(wb["bx"] * 2) + W, int(wb["by"] * 2) + H)
        layers = []
        for hide in (False, True):
            pg.evaluate(WIKI_HIDE, [WIKI_SEL, hide])
            pg.wait_for_timeout(250)
            f = os.path.join(OUTDIR, "wiki%d_%s.png" % (SLOT, "off" if hide else "on"))
            pg.screenshot(path=f)
            layers.append(np.asarray(Image.open(f).convert("RGBA").crop(crop))
                          .astype(int))
        wi = Image.open(os.path.join(OUTDIR, "wiki%d_on.png" % SLOT)).crop(crop)
        wpad = bbox_of_diff(layers[0].reshape(-1), layers[1].reshape(-1), W, H, thresh=2)

        # --- 卡片：同一个锚 + 整块 PNG ---
        app = b.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=1)
        app.goto("file:///" + INDEX.replace(os.sep, "/"))
        app.wait_for_timeout(1500)
        cb = app.evaluate(CARD_JS.replace("__SLOT__", str(SLOT)), False)
        if cb.get("err"):
            sys.exit(cb["err"])
        png = app.evaluate(CARD_JS.replace("__SLOT__", str(SLOT)), True)
        b.close()
    card_canvas = Image.open(io.BytesIO(base64.b64decode(png["png"].split(",", 1)[1])))

    # 两边都按「墨水外接矩形」对齐：卡片原点 = 卡片墨水 - 灰机墨水的块内坐标
    ox, oy = cb["x0"] - wpad[0], cb["y0"] - wpad[1]
    if ox < 0 or oy < 0 or ox + W > card_canvas.width or oy + H > card_canvas.height:
        sys.exit("卡片上的取景区越界了：原点 (%d,%d) 取 %dx%d（卡墨水 %s，灰墨水 %s），"
                 "画布 %dx%d" % (ox, oy, W, H, (cb["x0"], cb["y0"]), wpad[:2],
                                 card_canvas.width, card_canvas.height))
    ca = card_canvas.crop((ox, oy, ox + W, oy + H))

    wa = np.asarray(wi.convert("RGB")).astype(int)
    cd = np.asarray(ca.convert("RGB")).astype(int)
    d = np.abs(wa - cd).sum(axis=2)
    mad = float(d.mean()) / 3.0
    bad = float((d > 30).mean()) * 100.0
    best, bestd = (0, 0), mad
    for dy in range(-6, 7):
        for dx in range(-6, 7):
            a = wa[8:-8, 8:-8]
            c = cd[8 + dy:H - 8 + dy, 8 + dx:W - 8 + dx]
            v = float(np.abs(a - c).mean()) / 3.0
            if v < bestd:
                best, bestd = (dx, dy), v
    rows = d.mean(axis=1) / 3.0
    worst = sorted(range(0, H - 16, 8), key=lambda y: -rows[y:y + 16].mean())[:8]

    side = Image.new("RGB", (W + 16, H * 2 + 24), (20, 20, 20))
    side.paste(wi, (8, 8))
    side.paste(ca, (8, H + 16))
    side.save(os.path.join(OUTDIR, "side_by_side%d.png" % SLOT))
    heat = Image.fromarray(np.clip(d, 0, 255).astype("uint8")).convert("RGB")
    heat.save(os.path.join(OUTDIR, "diff%d.png" % SLOT))

    print("整块比对（%d技能，%d×%d 设备像素 @2x，坐标都是卡片/灰机的逻辑像素）：\n"
          % (SLOT, W, H))
    print("  墨水：灰机 %s %dx%d   卡片 (%d,%d) %dx%d"
          % (wpad[:2], wpad[2], wpad[3], cb["x0"], cb["y0"], cb["iw"], cb["ih"]))
    print("  平均差 %.1f/255    差超 30 的像素占 %.2f%%" % (mad, bad))
    print("  最佳整数偏移 (dx=%+d, dy=%+d) 时残差 %.1f/255" % (best[0], best[1], bestd))
    print("\n  差得最多的 8 个横条（16px 窗口）：")
    for y in worst:
        print("    y=%4d~%4d  平均差 %.1f" % (y // 2, (y + 16) // 2, rows[y:y + 16].mean()))
    print("\n  上下对照图（上灰机 / 下卡片）→ %s\ndiff → %s"
          % (os.path.join(OUTDIR, "side_by_side%d.png" % SLOT),
             os.path.join(OUTDIR, "diff%d.png" % SLOT)))


if __name__ == "__main__":
    main()
