# -*- coding: utf-8 -*-
"""打开 `_ref/huiji` 里缓存的灰机页面，**并且把站点 CSS 喂回去**。

    python tools/wiki_page.py            # 重新下载那几份 CSS（模板变了再跑）

为什么非要有这个模块
--------------------
缓存那份 HTML 里所有样式表都是 `<link href="/load.php?...">` —— **相对路径**。
用 `file://` 打开时它解析成 `file:///load.php`，必然 404，于是整页**一张皮肤样式
都没带上**，只剩下那 25 个内联 `<style>`。看上去页面还是「有版式的」（内容样式
大都在内联块里），所以特别难发现，但凡是靠浏览器默认值撑着的尺寸全都会漂：

  · `<p>` 退回 UA 默认的 `margin: 1em 0` = **16px**；真站 DragonHide 皮肤写的是
    `#content p{margin:7.5px 0; line-height:1.8}`。MediaWiki 会把「独占一行的图片」
    套进 `<p>`，于是技能图标那块**底色板**的 y 差了 8.5px。
  · 行高退回 `normal`（≈18px）；真站是 1.8 × 16 = **28.8px**。技能贴图那个 div 里
    只有一个行内 `<img>`，div 的高度是**行盒**高度：`normal` 时是 60×**64**（底下多
    出 4px 降部），1.8 行高时正好 60×**60**。

`#content p` 那条规则就躺在 `_ref/huiji/css/skin.css` 里，可以随时 grep 复核。

用法
----
    with styled_page(browser, PAGE) as pg:
        ...
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
CSSDIR = os.path.join(HUIJI, "css")

PAGE = os.path.join(HUIJI, "page_堂吉诃德高级定制_黑派_品牌经理.425eae6dc2.html")

# 缓存页 `<link>` 里的那几份，一个不少地照搬过来。`font-awesome` 那份是绝对 URL，
# 让浏览器自己去拿（拿不到也只是少几个图标字形）。
CSS_MODULES = {
    "skin": "skins.dragonhide.legacy.style",
    "gadget": ("ext.gadget.Ihover.css%7Cext.gadget.InPageEdit%E7%81%B0%E6%9C%BA"
               "%E8%A1%A5%E4%B8%81%2ChuijiLesser%2Ctbui-nav-pills"
               "%7Cext.gadget.Tabber.css"),
    "site": "site.styles",
    "ext": ("ext.MobileDetect.nomobile%7Cext.smw.style%7Cext.smw.tooltip.styles"
            "%7Cext.srf.styles%7Cext.tmh.player.styles"
            "%7Cjquery.makeCollapsible.styles%7Cmediawiki.page.gallery.styles"),
}


def ensure_css(force=False):
    """把那几份 CSS 下到 `_ref/huiji/css/`。已经下过就跳过。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "fw", os.path.join(HERE, "fetch_wiki.py"))
    fw = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fw)
    os.makedirs(CSSDIR, exist_ok=True)
    for key, mods in CSS_MODULES.items():
        url = "%s/load.php?lang=zh-hans&modules=%s&only=styles" % (fw.BASE, mods)
        text = fw._get(url, os.path.join(CSSDIR, key + ".css"), force=force)
        if isinstance(text, bytes):
            text = text.decode("utf-8", "replace")
        with open(os.path.join(CSSDIR, key + ".css"), "w",
                  encoding="utf-8", newline="\n") as fp:
            fp.write(text)


def css_text():
    ensure_css()
    out = []
    for key in ("skin", "gadget", "site", "ext"):
        path = os.path.join(CSSDIR, key + ".css")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fp:
                out.append(fp.read())
    return "\n".join(out)


def mount(pg):
    """把真站 CSS 注入当前页面。

    本来想用 `pg.route("**/load.php*", …)` 把样式请求按真站答回去 —— **不行**，
    Playwright 的路由只拦 http/https，`file:///load.php` 拦不到，注了个寂寞。
    那就 `add_style_tag`：排在最后，但它跟页面上原来那些 `<link>` 不冲突 ——
    那些全是 404、一条规则都没有（这正是要修的问题），页面上只剩下 25 个内联
    `<style>`，里面没有 `#content p` 这类规则，优先级也压不过 `#content p`。
    """
    return pg.add_style_tag(content=css_text())


def styled_page(browser, page_path=PAGE, viewport=None, dsf=1, settle=6000,
                after_css=1200):
    """开一张带真站样式的缓存页。返回值直接用，用完自己 close。"""
    pg = browser.new_page(viewport=viewport or {"width": 1400, "height": 900},
                          device_scale_factor=dsf)
    pg.goto("file:///" + page_path.replace(os.sep, "/"), wait_until="load",
            timeout=120000)
    pg.wait_for_timeout(settle)
    mount(pg)
    pg.wait_for_timeout(after_css)      # 重新排版 + 重新解码图片
    return pg


def main():
    ensure_css(force=True)
    css = css_text()
    print("CSS 已更新：%s" % CSSDIR)
    for key in CSS_MODULES:
        path = os.path.join(CSSDIR, key + ".css")
        print("  %-8s %8d 字节" % (key, os.path.getsize(path)))
    print("合计 %d 字节" % len(css.encode("utf-8")))


if __name__ == "__main__":
    main()
