# -*- coding: utf-8 -*-
"""把 src/* 和 data/seed.json 拼成一个自包含的 index.html。

    python tools/build.py

产出是**单文件、零外部依赖**的网页应用：双击就能用，直接 file:// 打开也行。
所以这里不能出现任何 <script src> / <link rel=stylesheet> / import / fetch。

三件容易踩的事，这个脚本专门处理：

1. **拼接顺序**：const 必须在最前（其它文件都在模块加载期就读 Enums），app 最后
   （它在加载期末尾自动 boot）。顺序写死在 ORDER 里，不靠 glob 的字母序。

2. **种子数据里的 `<`**：内联 JSON 时要把每个 `<` 转成 `\\u003c`。否则数据里只要
   出现一个字面量 `</script>`，浏览器会当场把 <script> 块截断，页面白屏。
   转义之后 JSON 本身没变（`\\u003c` 是合法转义），JSON.parse 读回来还是 `<`。

3. **构建时间戳**：戳在页脚，方便一眼看出 index.html 是哪天构建的。
"""

import json
import os
import re
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "src")
SEED = os.path.join(ROOT, "data", "seed.json")
OUT = os.path.join(ROOT, "index.html")

# 拼接顺序 = 依赖顺序，不能改
ORDER = ["const.js", "schema.js", "model.js", "store.js", "card.js",
         "form.js", "library.js", "wikitext.js", "app.js"]

# 卡片宽度。**921 是默认值**，不是随便挑的：灰机技能块容器（`.personalityskillN .3`）
# 的内容宽度实测 893，加上左右各 14px 内边距正好 921。卡片按这个宽度排，技能块里
# 那一堆绝对定位的像素值（框 35、横幅 115、攻击容量 200、徽章 55…）才能原样照抄。
DEFAULT_W = 921
WIDTHS = [560, 720, 820, DEFAULT_W, 1024]


def esc_html(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def shell(css, js_blocks, seed_json, stamp):
    width_opts = "".join(
        '<option value="%d"%s>%d px</option>'
        % (w, " selected" if w == DEFAULT_W else "", w) for w in WIDTHS)

    return """<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>边狱公司 · 自定义人格 / E.G.O 编辑器</title>
<style>
%s
</style>
</head>
<body>

<header class="top">
  <div class="brand">边狱公司<small>自定义人格 / E.G.O 编辑器</small></div>
  <div class="tb">
    <button data-act="newIdentity" class="primary">＋ 新建人格</button>
    <button data-act="newEgo" class="primary">＋ 新建 E.G.O</button>
    <span class="sep"></span>
    <button data-act="import">导入 JSON</button>
    <button data-act="exportJSON">导出 JSON</button>
    <button data-act="exportText">导出 wiki 文本</button>
    <span class="sep"></span>
    <button data-act="theme" title="界面深色 / 浅色">主题</button>
    <button data-act="help">用法</button>
  </div>
  <span class="state" id="storeState"></span>
</header>

<main>
  <section id="lib"></section>

  <section id="form">
    <div class="cur-head">
      <div class="row1"><span class="kind" id="curMeta"></span></div>
      <div class="based" id="curBased"></div>
    </div>
    <div id="formScroll"></div>
  </section>

  <section id="preview">
    <div class="pv-toolbar">
      <button data-act="upImg">上传立绘</button>
      <button data-act="clearImg">清除立绘</button>
      <button data-act="cardTheme" title="卡片自身的深色 / 浅色">卡片配色</button>
      <button data-act="png" class="primary">导出 PNG</button>
      <select id="cardWidth">%s</select>
      <select id="cardStage" title="技能块画哪一阶">
        <option value="iv">仅最高阶</option>
        <option value="all">全部阶段</option>
      </select>
      <span id="pvSize" class="pv-size"></span>
      <span class="sep"></span>
      <button data-act="exportText">导出文本</button>
      <select id="textFormat" title="导出 wiki 文本用哪种语法">
        <option value="huiji">灰机 wikitext</option>
        <option value="mediawiki">MediaWiki 表格</option>
      </select>
    </div>
    <div class="pv-scroll"><canvas id="card"></canvas></div>
    <div class="pv-foot">
      <span id="pvIssues" class="issues"></span>
      <span class="attr" id="stamp">%s</span>
      <span class="attr">内置数据取自
        <a href="https://limbuscompany.huijiwiki.com/" target="_blank" rel="noreferrer">灰机 · 边狱公司中文维基</a>（CC BY-SA 4.0）
      </span>
    </div>
    <div class="text-preview">
      <div class="tp-h"><span>导出的 wiki 文本（可直接复制）</span>
        <button data-act="closeText" class="mini">关闭</button></div>
      <pre id="textPreview"></pre>
    </div>
  </section>
</main>

<div id="modal"></div>
<div id="toast" class="toast"></div>

<input type="file" id="fileJSON" accept=".json,application/json" hidden>
<input type="file" id="fileImg" accept="image/*" hidden>

<script type="application/json" id="seed">%s</script>

%s
</body>
</html>
""" % (css, width_opts, esc_html(stamp), seed_json, js_blocks)


def main():
    if not os.path.exists(SEED):
        sys.exit("找不到 %s —— 先跑 tools/parse_seed.py" % SEED)

    raw_seed = open(SEED, encoding="utf-8").read()

    # 内联 JSON 的转义：< 一律写成 <，见文件头说明
    safe_seed = raw_seed.replace("<", "\\u003c")
    try:
        back = json.loads(safe_seed)
    except ValueError as exc:
        sys.exit("转义后的种子 JSON 读不回来，说明里面有非法字符：%s" % exc)

    seed = json.loads(raw_seed)
    if back["counts"] != seed["counts"]:
        sys.exit("转义前后条目数对不上，停止构建")
    print("种子校验：人格 %d、E.G.O %d、立绘 %d 张，转义后仍可 json.loads"
          % (seed["counts"]["identity"], seed["counts"]["ego"], len(seed["portraits"])))

    css = open(os.path.join(SRC, "styles.css"), encoding="utf-8").read()
    if "</style" in css.lower():
        sys.exit("styles.css 里有 </style，会截断内联样式")

    blocks = []
    total_js = 0
    for name in ORDER:
        path = os.path.join(SRC, name)
        if not os.path.exists(path):
            sys.exit("缺少源文件：%s" % path)
        code = open(path, encoding="utf-8").read()
        if re.search(r"</script", code, re.I):
            sys.exit("%s 里有 </script 字面量，会截断 <script> 块" % name)
        total_js += len(code)
        blocks.append("<script>\n/* ===== src/%s ===== */\n%s\n</script>" % (name, code))

    stamp = "构建于 %s" % time.strftime("%Y-%m-%d %H:%M:%S")
    html = shell(css, "\n\n".join(blocks), safe_seed, stamp)

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print("写出 %s：%.2f MB（JS %.0f KB、CSS %.0f KB、种子 %.2f MB）"
          % (OUT, size / 1048576, total_js / 1024, len(css) / 1024,
             len(safe_seed) / 1048576))
    print("双击 index.html 即可使用（不需要服务器、不需要联网）。")


if __name__ == "__main__":
    main()
