# -*- coding: utf-8 -*-
"""抓灰机上的游戏 UI 素材（技能框、罪孽图标、硬币、状态图标……）。

    python tools/fetch_icons.py            增量抓（已抓过的跳过）
    python tools/fetch_icons.py --force    全量重抓

为什么单独一个脚本、而不是并进 fetch_wiki.py：
    fetch_wiki.py 抓的是**文本**（tabx 表 + 页面正文），几百个请求就跑完了。
    图标是**一千多张位图**，失败模式完全不同（缩略图服务会限流、个别文件会被删），
    单独跑可以中途重试而不用重抓正文。

图标哪来的：
    灰机的人格页技能块就是**游戏内战斗 UI 的复刻**，用的是游戏自己的贴图。
    这些贴图在灰机上都有独立的 File: 页面，命名有规律：
      · 技能框   `{罪孽}-等级{1,2}.png` + 同名 `-底部`，3 技能（等级3）走
                 `Icon skillFrame 1 _{i}.png` / `Icon skillFrame Invert _{i+7}.png`
      · 技能图标 `{图标参数}.png`，就是页面上 `{{技能链接|N技能-图标=…}}` 那个值
      · 状态图标 名字等于状态中文名（`沉沦.png`），从 Data:Buff.tabx 的 image 字段拿
      · 其余     `数值图标-*` / `硬币*` / `罪孽-*` / `斩击|突刺|打击` / `技能-类型-罪孽`

为什么不抓原图：
    原图动辄几十上百 KB（`傲慢-等级1.png` 原图 54 KB），而卡片上只画 40~75 px。
    统一抓 80px 缩略图，一张 2~3 KB，还保留了透明通道。

产物：`_ref/huiji/icons/<名字>.<ext>` + `_ref/huiji/icons/index.json`：
    `icons`       名字 → 本地文件名（内嵌时会变成 data URL）
    `statusIcons` 状态文字名 → 兜底图标名（见 buff_images()）
    `thumbWidth`  缩略图宽度，卡片按它算缩放比
"""

import argparse
import json
import os
import re
import sys
import threading
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from curl_cffi import requests as cffi

API = "https://limbuscompany.huijiwiki.com/api.php"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "_ref", "huiji")
ICON_DIR = os.path.join(CACHE, "icons")
RAW_DIR = os.path.join(CACHE, "raw")
SEED = os.path.join(ROOT, "data", "seed.json")
INDEX = os.path.join(ICON_DIR, "index.json")

IMPERSONATE = "chrome"
BATCH = 50          # API 一次最多查 50 个标题
THUMB_W = 80        # 缩略图宽度，卡片上最大也就画到 75px
# 例外：这张不是图标而是**技能名横幅的底图**，卡片上要摊到 183.385×32（导出
# PNG 时 2 倍就是 367×64），80px 宽的缩略图摊上去糊得没法看。它原图本来也只有
# 149×26，索性按原分辨率取。原图还要在 parse_seed.py 里按罪孽色逐像素染色。
FULL_RES = {"BattleUI CoinPopup skillName"}
DELAY = 0.05
TIMEOUT = 60
RETRIES = 4
WORKERS = 4         # 并发下载数。每个线程自己开一个 session，curl_cffi 的 Session 不是线程安全的

# 缩略图服务按 Accept 头自动转格式：不发 Accept 就给 webp，明写 image/png 才给 PNG。
# 但同一张 80px 图，webp 3.2 KB、PNG 19 KB —— 差 6 倍，1243 张就是 4 MB 对 24 MB。
# webp 在 Edge/Chrome/Firefox/Safari 14+ 上 canvas 都能直接画，所以**收 webp**。
EXT_BY_MAGIC = [(b"\x89PNG\r\n\x1a\n", "png"), (b"RIFF", "webp")]


def _what(b):
    """按魔数判格式，顺带确认不是 Cloudflare 的挑战页。"""
    for magic, ext in EXT_BY_MAGIC:
        if b[:len(magic)] == magic:
            if ext == "webp" and b[8:12] != b"WEBP":
                return None
            return ext
    return None


def _cached(name):
    for ext in ("webp", "png"):
        if os.path.exists(os.path.join(ICON_DIR, name + "." + ext)):
            return name + "." + ext
    return None


_local = threading.local()


def _session():
    """每个线程一个长连接 session。

    这一点很要命：`cffi.get()` 每次调用都新建 session，也就是每次重新做一次
    Chrome 的 TLS 握手 —— 一千多张图跑下来光握手就是半小时。session 复用之后
    实测快一个数量级。"""
    s = getattr(_local, "s", None)
    if s is None:
        s = cffi.Session(impersonate=IMPERSONATE, timeout=TIMEOUT)
        _local.s = s
    return s

# 7 罪孽的固定顺序。罪孽图标的等级 3 帧号跟这个下标绑死：
# 暴怒→Icon skillFrame 1 0 / Invert 7，嫉妒→1 6 / Invert 13。
SINS = ["暴怒", "色欲", "怠惰", "暴食", "忧郁", "傲慢", "嫉妒"]
# 攻击类型的中文名（暗色徽章 / E.G.O 徽章都用它拼文件名）
ATK_NAMES = ["斩击", "突刺", "打击"]


def fixed_names():
    """跟种子无关的固定素材。"""
    names = [
        "数值图标-攻击", "数值图标-守备", "数值图标-攻击容量",
        "数值图标-生命", "数值图标-防御",
        "数值图标-速度-1", "数值图标-速度-2", "数值图标-速度-3", "数值图标-速度-4",
        "理智值消耗", "硬币",
        "斩击", "突刺", "打击",
    ]
    names += ["硬币%d" % i for i in range(1, 14)]
    names += ["罪孽-%s" % s for s in SINS]
    for s in SINS:
        names += ["%s-等级1" % s, "%s-等级2" % s,
                  "%s-等级1-底部" % s, "%s-等级2-底部" % s]
    names += ["常规-等级1", "常规-等级1-底部"]
    # 等级3（3 技能）用的是通用框，下标见上面注释
    for i in range(len(SINS)):
        names += ["Icon skillFrame 1 %d" % i, "Icon skillFrame Invert %d" % (i + 7)]
    # 技能卡片上的罪孽×攻击类型暗色徽章
    for s in SINS:
        for a in ATK_NAMES:
            names.append("%s-%s-暗色" % (s, a))
    # E.G.O 技能卡上的是同义的亮色徽章，但命名顺序反过来
    for a in ATK_NAMES:
        for s in SINS:
            names.append("技能-%s-%s" % (a, s))
    names.append("BattleUI CoinPopup skillName")
    return names


# 模板:状态2 的调用。正文里的状态一共有三种写法：
#     {{状态2|沉沦}}                  → 图标「沉沦」、文字「沉沦」
#     {{状态2|沉沦|4=负面}}           → 同上，颜色换成负面的红
#     {{状态2|狂信（我方）|狂信}}     → 图标「狂信（我方）」、文字「狂信」
#     {{状态2|硬血（我方）|硬血|硬血}} → 图标「硬血」、文字「硬血」
# 模板源码（{{#switch:{{{4|正面}}}…}}）里 **没有任何对 Buff.tabx 的查询**：
# 图标文件名就是第 3 个位置参数、没有就退回第 1 个，颜色只看第 4 个参数、
# 没有就当「正面」。所以这里要的是正文里那些 token 本身，不是 Buff.tabx
# 的 image 字段 —— 两者有 15 个对不上（`孤独` vs `陷入恐慌`），而页面上
# 印出来的那个图标是前者。
STATUS2_RE = re.compile(r"\{\{状态2\|([^}]*)\}\}")


def status_tokens():
    """扫原始正文，取所有 {{状态2|…}} 的（文字名, 图标名, 颜色种类）。

    由 tools/parse_seed.py 的 _status_sub() 用同一套规则归一化，两边的解析
    必须一致 —— 改了这里就得改那边（反过来也是）。"""
    disp, icon, kind = set(), set(), {}
    for fn in os.listdir(RAW_DIR):
        if not fn.endswith(".txt"):
            continue
        try:
            txt = open(os.path.join(RAW_DIR, fn), encoding="utf-8").read()
        except Exception:
            continue
        for m in STATUS2_RE.finditer(txt):
            parts = m.group(1).split("|")
            pos = [p.strip() for p in parts if p.strip() and "=" not in p]
            if not pos:
                continue
            text = pos[1] if len(pos) > 1 else pos[0]
            ic = pos[2] if len(pos) > 2 else pos[0]
            k = "正面"
            for p in parts:
                if p.strip().startswith("4="):
                    k = p.strip()[2:].strip() or "正面"
            disp.add(text)
            icon.add(ic)
            kind.setdefault(text, k)
    return disp, icon, kind


def query(names, force=False):
    """批量问 imageinfo，返回 {名字: 缩略图 URL}。"""
    out = {}
    todo = []
    for n in names:
        if _cached(n) and not force:
            out[n] = None          # 已有缓存
        else:
            todo.append(n)
    print("  已有缓存 %d 个，待问 %d 个" % (len(out), len(todo)), flush=True)

    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        titles = "|".join("File:%s.png" % n for n in chunk)
        params = {"action": "query", "titles": titles, "prop": "imageinfo",
                  "iiprop": "url", "iiurlwidth": THUMB_W, "format": "json"}
        data = None
        for _ in range(RETRIES):
            try:
                r = _session().get(API, params=params)
                if r.status_code == 200:
                    data = r.json()
                    break
            except Exception as e:
                print("    ! %s" % e, flush=True)
            time.sleep(1.5)
        time.sleep(DELAY)
        if not data:
            print("    !! 批次 %d 失败" % (i // BATCH), flush=True)
            continue
        for page in (data.get("query", {}).get("pages") or {}).values():
            title = page.get("title", "")
            name = re.sub(r"^(文件|File):", "", title)
            name = re.sub(r"\.png$", "", name)
            ii = (page.get("imageinfo") or [{}])[0]
            # 横幅要原图（见 FULL_RES），其余用 80px 缩略图省体积
            out[name] = (ii.get("url") if name in FULL_RES
                         else (ii.get("thumburl") or ii.get("url")))
        print("  问完 %4d/%d" % (min(i + BATCH, len(todo)), len(todo)), flush=True)
    return out


def download(urls, force=False):
    """把 URL 落盘。返回 (落地数, 灰机上没有的数, 下载失败数)。"""
    jobs = []
    for name, url in urls.items():
        if url is None or (_cached(name) and not force):
            continue
        jobs.append((name, url))
    skipped = len(urls) - len(jobs)
    miss = sum(1 for u in urls.values() if u is None)
    print("  要下 %d 张，已有/缺席 %d 张" % (len(jobs), skipped), flush=True)

    lock = threading.Lock()
    done = [0]
    fail = []

    def work(chunk):
        for name, url in chunk:
            ok = False
            for _ in range(RETRIES):
                try:
                    r = _session().get(url)
                    if r.status_code == 200:
                        ext = _what(r.content)
                        if ext:
                            with open(os.path.join(ICON_DIR, name + "." + ext), "wb") as f:
                                f.write(r.content)
                            ok = True
                            break
                    elif r.status_code == 404:
                        break
                except Exception:
                    pass
                time.sleep(1.0)
            time.sleep(DELAY)
            with lock:
                done[0] += 1
                if not ok:
                    fail.append(name)
                if done[0] % 200 == 0:
                    print("  下到 %d/%d" % (done[0], len(jobs)), flush=True)

    chunks = [jobs[i::WORKERS] for i in range(WORKERS)]
    threads = [threading.Thread(target=work, args=(c,)) for c in chunks if c]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for n in fail[:20]:
        print("    !! 下载失败 %s" % n, flush=True)
    return len(jobs) - len(fail) + skipped - miss, miss, len(fail)


def buff_table():
    """Data:Buff.tabx → 两个索引：`image`（名字 → 图标名）和 `bid`（内部 id → 图标名）。

    图标名跟状态名**不是一回事**：`保存` 的图标是 `保存.png`，`震颤` 的是
    `震颤.png`，但也有对不上的。页面上 `{{状态2}}` 用的是它自己的参数，
    `{{BuffPro}}` 用的才是这张表的 image —— 所以两边都得抓。"""
    by_name, by_id = {}, {}
    path = os.path.join(RAW_DIR, "Data_Buff_tabx.5a6055cc93.txt")
    if not os.path.exists(path):
        return by_name, by_id
    b = json.load(open(path, encoding="utf-8"))
    cols = [f["name"] for f in b["schema"]["fields"]]
    for row in b["data"]:
        r = dict(zip(cols, row))
        img = re.sub(r"\.png$", "", (r.get("image") or "").strip())
        if not img:
            continue
        bid = (r.get("buffid") or "").strip()
        if bid:
            by_id.setdefault(bid, img)
        for key in (r.get("name"), r.get("show")):
            if key:
                by_name.setdefault(str(key).strip(), img)
    return by_name, by_id


BUFFPRO_RE = re.compile(r"\{\{BuffPro\|([^}|]+)\}\}")


def buffpro_icons(by_id):
    """正文里所有 `{{BuffPro|id}}` 用到的图标名。

    这些**必须**单独收一遍：BuffPro 的文字名走的是 show 字段（`保存`），跟
    `{{状态2}}` 那批文字名不重合，光按名字收会漏掉四十来个图标。"""
    out = set()
    for fn in os.listdir(RAW_DIR):
        if not fn.endswith(".txt"):
            continue
        try:
            txt = open(os.path.join(RAW_DIR, fn), encoding="utf-8").read()
        except Exception:
            continue
        for m in BUFFPRO_RE.finditer(txt):
            hit = by_id.get(m.group(1).strip())
            if hit:
                out.add(hit)
    return out


def skill_icons():
    """种子里每条技能的 `icon` 参数。"""
    out = set()
    if not os.path.exists(SEED):
        return out
    d = json.load(open(SEED, encoding="utf-8"))
    for it in d.get("items") or []:
        for sk in it.get("skills") or []:
            if sk.get("icon"):
                out.add(sk["icon"].strip())
    return out


def ego_profiles():
    """E.G.O 技能卡左边的立绘：`{编号} awaken profile` / `{编号} corrode profile`。

    人格技能框里嵌的是六边形裁切的技能图标，E.G.O 那边却直接铺一张 70×70 的
    技能立绘 —— 命名规则不一样，得单独收。"""
    out = set()
    if not os.path.exists(SEED):
        return out
    d = json.load(open(SEED, encoding="utf-8"))
    for it in d.get("items") or []:
        if it.get("kind") != "ego" or not it.get("code"):
            continue
        out.add("%s awaken profile" % it["code"])
        out.add("%s corrode profile" % it["code"])
    return out


def seed_status_icons():
    """种子里 `**名字|分类|图标**` 第三种写法的图标名。

    走 BuffPro 进来的状态，图标是从 Data:Buff.tabx 的 image 字段来的（名字跟
    图标名不是一回事，`保存` 的图标是 `保存.png`，`震颤` 的是 `震颤.png`），
    光扫正文的 {{状态2}} 抓不到这些 —— 所以直接从种子里捡。"""
    out = set()
    if not os.path.exists(SEED):
        return out
    d = json.load(open(SEED, encoding="utf-8"))
    for it in d.get("items") or []:
        for sk in it.get("skills") or []:
            for st in sk.get("stages") or []:
                for e in st.get("effects") or []:
                    for m in re.finditer(r"\*\*([^*]+?)\*\*", e.get("text") or ""):
                        p = m.group(1).split("|")
                        if len(p) > 2 and p[2]:
                            out.add(p[2].strip())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="忽略缓存全量重抓")
    ap.add_argument("--index-only", action="store_true",
                    help="不联网，只按目录里已有的图重写 index.json")
    args = ap.parse_args()
    os.makedirs(ICON_DIR, exist_ok=True)

    disp, icon_tokens, kind = status_tokens()
    buf_img, buf_id = buff_table()
    sk_icons = skill_icons()
    seed_tokens = seed_status_icons()
    icon_tokens |= seed_tokens | buffpro_icons(buf_id)

    # 兜底表：状态文字名 → Buff.tabx 里的图标名。卡片的取图顺序是
    # 「先按 token 里的图标名找，找不到再查这张表」，所以两边都要抓下来。
    fallback = {n: buf_img[n] for n in disp if buf_img.get(n)}
    profiles = ego_profiles()
    names = (fixed_names() + sorted(sk_icons) + sorted(icon_tokens) + sorted(profiles)
             + sorted(set(fallback.values())))
    seen, uniq = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            uniq.append(n)

    print("固定素材 %d + 技能图标 %d + 状态图标 token %d（种子补了 %d 个，"
          "状态文字名共 %d，Buff.tabx 兜底 %d）"
          % (len(fixed_names()), len(sk_icons), len(icon_tokens), len(seed_tokens),
             len(disp), len(set(fallback.values()))), flush=True)
    print("合计 %d 个文件" % len(uniq), flush=True)

    if args.index_only:
        print("--index-only：跳过联网，直接扫目录重建索引", flush=True)
    else:
        print("问 URL…", flush=True)
        urls = query(uniq, force=args.force)
        print("落盘…", flush=True)
        got, miss, fail = download(urls, force=args.force)

    # 索引**扫目录**建，而不是遍历 uniq：一是抓漏/被抓过但已不在需求表里的
    # 图标也能进索引（卡片才找得到），二是 `--index-only` 才能单独补索引。
    index, total = {}, 0
    for fn in os.listdir(ICON_DIR):
        stem, ext = os.path.splitext(fn)
        if ext.lower() not in (".webp", ".png"):
            continue
        index[stem] = fn
        total += os.path.getsize(os.path.join(ICON_DIR, fn))
    # 兜底表只留真正抓到的，免得浏览器去问一个空名字
    status_icons = {s: v for s, v in sorted(fallback.items()) if v in index}
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump({"thumbWidth": THUMB_W, "icons": index,
                   "statusIcons": status_icons}, f, ensure_ascii=False, indent=1)

    print("\n落地 %d 个，共 %.1f MB（平均 %.1f KB）"
          % (len(index), total / 1048576.0, total / max(1, len(index)) / 1024.0),
          flush=True)
    no_icon = [n for n in uniq if n not in index]
    if no_icon:
        print("灰机上没有的 %d 个（前 30）：%s" % (len(no_icon), no_icon[:30]), flush=True)
    naked = sorted(s for s in disp if s not in icon_tokens and buf_img.get(s) not in index)
    if naked:
        print("连兜底都查不到图标的状态名 %d 个：%s" % (len(naked), naked[:40]), flush=True)
    print("索引写进 %s" % INDEX)


if __name__ == "__main__":
    main()
