# -*- coding: utf-8 -*-
"""把「灰机页面上的技能图标」和「卡片画的技能图标」量到同一个尺度上比。

    python tools/cmp_icon.py

做法：两边各渲染两次 —— 一次带图标贴图、一次把贴图藏起来 —— 差出来的那块像素
就是**被六边形裁过之后的图标**。量它的外接矩形，比宽高。

用途是回答「图标裁得对不对」。灰机那个六边形的裁剪框是**正方形**：`clip-path` 挂在
一个 `<div>` 上，里面只有一个行内 `<img>`，div 的高度就是行盒高 —— 真站样式
`#content p{line-height:1.8}` 下正好等于图高（20 个框实测一律 60×60）。

⚠️ 这里必须**带真站样式**量（走 tools/wiki_page.py）。缓存页的 `<link href="/load.php?…">`
是相对路径、file:// 下 404，整站 CSS 全丢，行高退回 `normal`、`<p>` 退回 16px 外边距，
量出来就是 60×64 和「底板偏下 8.5px」——早期版本正是这么量错的。
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
PAGE = os.path.join(ROOT, "_ref", "huiji", "page_堂吉诃德高级定制_黑派_品牌经理.425eae6dc2.html")
OUTDIR = os.path.join(ROOT, "_ref", "probe_icon")

# 页面上第 4 个同步阶段（personalitystage4）里的某个技能块，跟卡片画的「最高阶」对得上。
# 第 3 个位置（3技能）在灰机上走的是**通用框**（`Icon skillFrame 1 2` /
# `Icon skillFrame Invert 9`），跟 1/2 技能那两张 `{罪孽}-等级N` 不是一套图，
# 所以「几层摆得对不对」两处都得看。跑 `python tools/cmp_icon.py 3` 看 3技能。
SLOT = 1
if len(sys.argv) > 1:
    SLOT = int(sys.argv[1])
WIKI_SEL = '.personalitystage4 > .personalityskill%d [class~="3"]' % SLOT

# 把目标块滚到视口正中间。**不再用 `screenshot(clip=…)`**：那个 clip 到底按页面坐标
# 还是视口坐标算，各版本行为不一致，页面滚过之后很容易裁到一块空白 —— 而「裁到空白」
# 表现为两张截图一模一样，报出来的却是「图标没差异」，特别能骗人。改成截整屏再用 PIL
# 裁，视口坐标就是唯一真相。
WIKI_CENTER = r"""
(sel) => {
  const root = document.querySelector(sel);
  if (!root) return false;
  /* 要居中的是**图标那张图**，不是整个 `.3` 块 —— 一个块里可能摞着两条技能，
   * 块高能到 1000px，比视口还高，按它居中反而把图标顶到屏幕外面去。 */
  let im = null;
  for (const d of root.querySelectorAll('div')) {
    for (const x of d.querySelectorAll(':scope > img')) {
      if (/\d{7}\.png$/.test(decodeURIComponent(x.src.split('/').pop()))) { im = x; break; }
    }
    if (im) break;
  }
  if (!im) return false;
  /* 用 `scrollIntoView` 会踩到 smooth 滚动（滚 8000 多像素得动画一会儿，量早了
   * 拿到的还是半路的位置），直接算好 scrollTop 一次赋值。 */
  const se = document.scrollingElement;
  const r = im.getBoundingClientRect();
  se.scrollTop = se.scrollTop + r.top + r.height / 2 - innerHeight / 2;
  return se.scrollTop;
}
"""

WIKI_ICON_BOX = r"""
(sel) => {
  const root = document.querySelector(sel);
  if (!root) return { err: '找不到同步Ⅳ的技能块' };
  let img = null;
  for (const d of root.querySelectorAll('div')) {
    for (const im of d.querySelectorAll(':scope > img')) {
      if (/\d{7}\.png$/.test(decodeURIComponent(im.src))) { img = { im, d }; break; }
    }
    if (img) break;
  }
  if (!img) return { err: '技能块里没有技能贴图' };
  const r = img.im.getBoundingClientRect();
  const M = 16;
  /* 视口坐标 —— 外层截的是整屏，量出来的就是同一套坐标。 */
  return { x: r.left - M, y: r.top - M, width: r.width + M * 2, height: r.height + M * 2,
           imgX: r.left, imgY: r.top, imgW: r.width, imgH: r.height,
           vw: innerWidth, vh: innerHeight };
}
"""

WIKI_HIDE = r"""
([sel, hide]) => {
  const root = document.querySelector(sel);
  if (!root) return { err: '找不到同步Ⅳ的 1技能' };
  for (const d of root.querySelectorAll('div')) {
    for (const im of d.querySelectorAll(':scope > img')) {
      /* 技能贴图的名字就是那串编号。页面上给的是缩略图，文件名带 `60px-` 前缀
       *（`60px-1031501.png`），框和底部那两张都是中文名，不会误伤。 */
      if (/\d{7}\.png$/.test(decodeURIComponent(im.src))) {
        im.style.visibility = hide ? 'hidden' : '';
      }
    }
  }
  return { ok: true };
}
"""

CARD_JS = r"""
() => {
  const seed = Library.seed();
  let item = null;
  for (const it of seed.items) if (it.id === 's_identity_10315') item = it;
  if (!item) return { err: '种子里没有 s_identity_10315' };

  /* 只留一个技能：块就落在卡片顶上，不用去整张图里找它 */
  const base = Model.deepCopy(item);
  base.skills = base.skills.filter(s => s.slot === '__SLOT__技能');

  function render(withIcon) {
    const c = Model.deepCopy(base);
    if (!withIcon) c.skills[0].icon = '';
    const cv = document.createElement('canvas');
    Card.render(cv, c, { width: 921, theme: 'dark', scale: 2, stage: 'iv' });
    return cv;
  }
  const A = render(true), B = render(false);
  /* 只扫顶上这一条：技能块就在那儿，整张一万八千像素高的图 getImageData 会吃掉几百 MB */
  const SLICE = Math.min(1400, A.height);
  const da = A.getContext('2d').getImageData(0, 0, A.width, SLICE).data;
  const db = B.getContext('2d').getImageData(0, 0, B.width, SLICE).data;
  let x0 = A.width, y0 = SLICE, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i+1] - db[i+1]) > 8 ||
        Math.abs(da[i+2] - db[i+2]) > 8 || Math.abs(da[i+3] - db[i+3]) > 8) {
      const p = i >> 2, x = p % A.width, y = (p / A.width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      n++;
    }
  }
  if (x1 < 0) return { err: '两次渲染没有任何差别，图标没画出来？' };
  /* 顺着外接矩形往外留 20 px，裁一张对照图出来 */
  const M = 20, cw = x1 - x0 + 1 + M * 2, ch = y1 - y0 + 1 + M * 2;
  const cc = document.createElement('canvas');
  cc.width = cw; cc.height = ch;
  cc.getContext('2d').drawImage(A, -(x0 - M), -(y0 - M));
  return { x0, y0, x1, y1, n, w: cw, h: ch, cardW: A.width, cardH: A.height,
           crop: cc.toDataURL('image/png') };
}
"""


def bbox_of_diff(a, b, w, h, thresh=8):
    """两个 RGBA 字节数组的差的外接矩形。返回值是 (x0, y0, x1, y1, n)。"""
    x0, y0, x1, y1, n = w, h, -1, -1, 0
    for i in range(0, len(a), 4):
        if (abs(a[i] - b[i]) > thresh or abs(a[i + 1] - b[i + 1]) > thresh or
                abs(a[i + 2] - b[i + 2]) > thresh or abs(a[i + 3] - b[i + 3]) > thresh):
            p = i // 4
            x, y = p % w, p // w
            if x < x0: x0 = x
            if x > x1: x1 = x
            if y < y0: y0 = y
            if y > y1: y1 = y
            n += 1
    return x0, y0, x1, y1, n


def main():
    from playwright.sync_api import sync_playwright
    from PIL import Image
    import numpy as np

    os.makedirs(OUTDIR, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True)

        # --- 灰机那边：截图两次，用 PIL 差 ---
        # 只截**贴着第一个图标**的一小块，而不是整个技能块：一个 `.3` 里可能有
        # 好几条技能（1技能 + 强化1技能…），整块截下来差出来的外接矩形会把所有
        # 图标框在一起，量不出单个六边形的形状。
        pg = b.new_page(viewport={'width': 1400, 'height': 900}, device_scale_factor=2)
        pg.goto('file:///' + PAGE.replace('\\', '/'), wait_until='load', timeout=120000)
        pg.wait_for_timeout(8000)
        # 缓存页自己带不上样式（`<link href="/load.php?…">` 是相对路径，file:// 下
        # 404），必须把真站的 CSS 注回去再量，否则 `<p>` 外边距、行高全是浏览器
        # 默认值，量出来的几何整体是错的 —— 见 tools/wiki_page.py。
        sys.path.insert(0, HERE)
        import wiki_page
        wiki_page.mount(pg)
        pg.wait_for_timeout(1200)
        el = pg.query_selector(WIKI_SEL)
        if el is None:
            sys.exit('缓存页面上找不到 %d技能 块' % SLOT)
        if not pg.evaluate(WIKI_CENTER, WIKI_SEL):
            sys.exit('滚不到那个技能块')
        pg.wait_for_timeout(500)
        M = 16      # 图标四周留这么多逻辑像素，好看见它跟框的相对位置
        box = pg.evaluate(WIKI_ICON_BOX, WIKI_SEL)
        if box.get('err'):
            sys.exit(box['err'])
        if (box['x'] < 0 or box['y'] < 0 or box['x'] + box['width'] > box['vw'] or
                box['y'] + box['height'] > box['vh']):
            sys.exit('图标那一小块没落在视口里：%s（视口 %dx%d）'
                     % (box, box['vw'], box['vh']))
        shots = []
        for hide in (False, True):
            r = pg.evaluate(WIKI_HIDE, [WIKI_SEL, hide])
            if r.get('err'):
                sys.exit(r['err'])
            pg.wait_for_timeout(200)
            f = os.path.join(OUTDIR, 'wiki_%s.png' % ('noicon' if hide else 'icon'))
            pg.screenshot(path=f)
            crop = (int(box['x'] * 2), int(box['y'] * 2),
                    int((box['x'] + box['width']) * 2), int((box['y'] + box['height']) * 2))
            shots.append(np.asarray(Image.open(f).convert('RGBA').crop(crop)).astype(int))
        # device_scale_factor=2，图上的坐标是逻辑坐标的两倍
        DSF = shots[0].shape[1] / float(box['width'])
        W = shots[0].shape[1]
        H = shots[0].shape[0]
        wb = bbox_of_diff(shots[0].reshape(-1), shots[1].reshape(-1), W, H, thresh=2)
        wiki = dict(zip(('x0', 'y0', 'x1', 'y1', 'n'), wb))
        wiki['w'] = wiki['x1'] - wiki['x0'] + 1
        wiki['h'] = wiki['y1'] - wiki['y0'] + 1
        wiki['dsf'] = DSF
        # 图标自己的方框在这个裁剪图里的位置，用来把「六边形」跟「贴图方框」对比
        wiki['img_x0'] = (box['imgX'] - box['x']) * DSF
        wiki['img_y0'] = (box['imgY'] - box['y']) * DSF
        wiki['img_w'] = box['imgW'] * DSF
        wiki['img_h'] = box['imgH'] * DSF

        # 再截一张**以图标外接矩形为中心**的图：这一张才跟卡片那边同框，能直接比
        # 框、底板相对图标的摆位（第一张的取景框是以图标方框为准的，两者不一样）。
        r = pg.evaluate(WIKI_HIDE, [WIKI_SEL, False])
        pg.wait_for_timeout(200)
        m = M * DSF
        wiki_center = os.path.join(OUTDIR, 'wiki_center%d.png' % SLOT)
        pg.screenshot(path=wiki_center)
        # 同一张整屏里，换成「以图标外接矩形为中心」的那块（都是视口坐标，直接换算）
        cx = (box['x'] + wiki['x0'] / DSF - M) * DSF
        cy = (box['y'] + wiki['y0'] / DSF - M) * DSF
        wi = Image.open(wiki_center).crop(
            (int(cx), int(cy),
             int(cx + wiki['w'] + 2 * m), int(cy + wiki['h'] + 2 * m)))

        # --- 卡片这边：两次渲染在 canvas 上差，只把外接矩形和裁好的图带回来 ---
        app = b.new_page(viewport={'width': 1400, 'height': 900}, device_scale_factor=1)
        app.goto('file:///' + INDEX.replace('\\', '/'))
        app.wait_for_timeout(1500)
        card = app.evaluate(CARD_JS.replace('__SLOT__', str(SLOT)))
        if card.get('err'):
            sys.exit(card['err'])
        card['w'] = card['x1'] - card['x0'] + 1
        card['h'] = card['y1'] - card['y0'] + 1
        card_crop = Image.open(io.BytesIO(
            base64.b64decode(card['crop'].split(',', 1)[1])))

        # 两张都按「图标外接矩形左上角」对齐：同一个裁剪框里图标落在同一处，于是
        # 框、底色板相对它的位移差多少，一眼就看得出来。
        from PIL import ImageDraw
        W2 = max(wi.width, card_crop.width)
        canvas = Image.new('RGB', (W2 + 20, wi.height + card_crop.height + 30),
                           (27, 27, 27))
        dr = ImageDraw.Draw(wi)
        dr.rectangle([M * DSF, M * DSF, M * DSF + wiki['w'] - 1, M * DSF + wiki['h'] - 1],
                     outline=(0, 255, 0))
        canvas.paste(wi, (10, 10))
        dr2 = ImageDraw.Draw(card_crop)
        dr2.rectangle([20, 20, 20 + card['w'] - 1, 20 + card['h'] - 1], outline=(0, 255, 0))
        canvas.paste(card_crop, (10, wi.height + 20))
        out = os.path.join(OUTDIR, 'side_by_side%d.png' % SLOT)
        canvas.save(out)

        # 两张图都按「图标外接矩形左上角」对齐之后逐像素相减。灰机那张是 DSF=2 的
        # 截屏、卡片那张是 canvas 自己的 2 倍尺度，两边同一块区域本该一模一样（除了
        # 抗锯齿和灰机页面字号带来的零点几像素）。差在哪、差多少，看 diff 图最快。
        PADW, PADC = M * DSF, 20
        n = int(min(wi.width - PADW, card_crop.width - PADC,
                    wi.height - PADW, card_crop.height - PADC))
        wa = np.asarray(wi.convert('RGB').crop((PADW, PADW, PADW + n, PADW + n))).astype(int)
        ca = np.asarray(card_crop.convert('RGB').crop((PADC, PADC, PADC + n, PADC + n))).astype(int)
        d = np.abs(wa - ca).sum(axis=2)
        mad = float(d.mean()) / 3.0
        bad = float((d > 30).mean()) * 100.0
        # 找最佳整数偏移：灰机的截图和卡片的 canvas 各自有半像素级的取整，直接减
        # 会把所有细线都点亮，看着像「到处都不一样」。先在 ±4 px 里找最小残差的
        # 那个偏移，再看残差 —— 才能分清「整体错位」和「真的不一样」。
        best, bestd = (0, 0), mad
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                a = wa[4:-4, 4:-4]
                c = ca[4 + dy:n - 4 + dy, 4 + dx:n - 4 + dx]
                v = float(np.abs(a - c).mean()) / 3.0
                if v < bestd:
                    best, bestd = (dx, dy), v
        diff = Image.fromarray(np.clip(d, 0, 255).astype('uint8')).convert('RGB')
        # 放到 3 倍再看：这一块本来就只有 120 px 见方，1:1 贴在屏幕上根本看不清
        # 图层之间差了几像素。
        Z = 3
        wp = wi.convert('RGB').crop((PADW, PADW, PADW + n, PADW + n)) \
            .resize((n * Z, n * Z), Image.LANCZOS)
        cp = card_crop.convert('RGB').crop((PADC, PADC, PADC + n, PADC + n)) \
            .resize((n * Z, n * Z), Image.LANCZOS)
        tri = Image.new('RGB', (n * Z * 3 + 20, n * Z + 10), (27, 27, 27))
        tri.paste(wp, (5, 5))
        tri.paste(cp, (n * Z + 10, 5))
        tri.paste(diff.resize((n * Z, n * Z), Image.NEAREST), (n * Z * 2 + 15, 5))
        tri_out = os.path.join(OUTDIR, 'diff%d.png' % SLOT)
        tri.save(tri_out)
        b.close()

    print("被六边形裁过之后的图标，外接矩形：\n")
    print("  灰机   %d×%d  （2 倍尺度，也就是 %.1f×%.1f 逻辑像素）"
          % (wiki['w'], wiki['h'], wiki['w'] / 2, wiki['h'] / 2))
    print("  卡片   %d×%d  （%.1f×%.1f 逻辑像素）"
          % (card['w'], card['h'], card['w'] / 2, card['h'] / 2))
    print("\n高宽比：灰机 %.3f   卡片 %.3f  （差 %+.1f%%）"
          % (wiki['h'] / wiki['w'], card['h'] / card['w'],
             100 * (card['h'] / card['w']) / (wiki['h'] / wiki['w']) - 100))
    print("\n对齐之后逐像素比：平均差 %.1f/255，差超 30 的像素占 %.2f%%"
          % (mad, bad))
    print("  最佳整数偏移 (dx=%+d, dy=%+d) 时残差 %.1f/255" % (best[0], best[1], bestd))
    print("\n对照图（上：灰机，下：卡片；两张都按图标外接矩形对齐，绿框是图标本身）"
          "\n  → %s\n三连图（灰机 | 卡片 | 差值) → %s" % (out, tri_out))


if __name__ == '__main__':
    main()
