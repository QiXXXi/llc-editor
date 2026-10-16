# -*- coding: utf-8 -*-
"""从灰机（limbuscompany.huijiwiki.com）抓取人格 / E.G.O 原始数据。

    python tools/fetch_wiki.py           增量抓取（已抓过的直接跳过）
    python tools/fetch_wiki.py --force   忽略缓存全量重抓

为什么用 curl_cffi 而不是 requests / playwright：
    灰机全站挂在 Cloudflare 的「请稍候…」JS 挑战后面。普通 curl 和 requests 只会拿到
    挑战页；但挑战只挡 TLS 指纹，curl_cffi 用 impersonate="chrome" 复刻 Chrome 的
    ClientHello 就能直接 200。比开浏览器省事得多，抓 300 多个页面也不用等渲染。

抓什么、为什么：
    1. Data:*.tabx  —— 灰机的 SMongo 数据表，本身就是结构化 JSON（schema + data 二维数组），
       人格 190 条 46 字段、E.G.O 116 条、被动 461 条。这是种子的主干，不需要写 HTML 解析器。
    2. 每个人格/EGO 页的 ?action=raw —— 技能名称和「每枚硬币的触发效果」富文本只存在于
       页面正文里，tabx 表没有。raw 版比渲染后的 HTML 小两个数量级（5 KB vs 440 KB）。
    3. 立绘 —— 先批量问 API 每个页面用了哪些文件（prop=images，一次 50 个条目），
       再批量问这些文件的缩略图 URL（prop=imageinfo&iiurlwidth），拿 160px 的缩略图就够了，
       原图单张好几 MB，306 张下不起。

产物全部落在 _ref/huiji/ 下，是纯缓存，不参与构建输出。
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from curl_cffi import requests as cffi

BASE = "https://limbuscompany.huijiwiki.com"
API = BASE + "/api.php"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "_ref", "huiji")
RAW_DIR = os.path.join(CACHE, "raw")
API_DIR = os.path.join(CACHE, "api")
ART_DIR = os.path.join(CACHE, "art")

IMPERSONATE = "chrome"
DELAY = 0.15          # 每次请求之间的间隔，别把人家站打疼
TIMEOUT = 45
RETRIES = 4


# ---------------------------------------------------------------- 基础设施

MISSES = []


def _ensure_dirs():
    for d in (CACHE, RAW_DIR, API_DIR, ART_DIR):
        os.makedirs(d, exist_ok=True)


def _get(url, cache_path, force=False):
    """带磁盘缓存的 GET。cache_path 为 None 表示不缓存（立绘图自己管缓存）。"""
    if cache_path and not force and os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return f.read()
    last = None
    for attempt in range(RETRIES):
        try:
            r = cffi.get(url, impersonate=IMPERSONATE, timeout=TIMEOUT)
            if r.status_code == 200:
                time.sleep(DELAY)
                body = r.content
                if cache_path:
                    tmp = cache_path + ".part"
                    with open(tmp, "wb") as f:
                        f.write(body)
                    os.replace(tmp, cache_path)
                return body
            # 404 / 403 之类的重试没意义，但 Cloudflare 偶尔会 403 一次
            last = "HTTP %s" % r.status_code
            if r.status_code not in (403, 429, 500, 502, 503, 504):
                break
        except Exception as exc:                      # 网络层错误，重试
            last = "%s: %s" % (type(exc).__name__, str(exc)[:120])
        time.sleep(1.2 * (attempt + 1))
    raise RuntimeError("抓取失败 %s (%s)" % (url, last))


def _safe(name):
    """把 wiki 标题变成合法文件名。标题里有 ':' '/' 之类 Windows 不认的字符。"""
    h = hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]
    keep = re.sub(r'[^0-9A-Za-z一-鿿_-]', "_", name)[:48]
    return "%s.%s" % (keep, h)


def api(params, cache_key=None, force=False):
    """调一次 api.php，返回解析后的 JSON。默认按参数哈希缓存。"""
    params = dict(params)
    params.setdefault("format", "json")
    params.setdefault("formatversion", "2")
    qs = "&".join("%s=%s" % (k, v) for k, v in params.items())
    url = "%s?%s" % (API, qs)
    key = cache_key or _safe(qs)
    data = _get(url, os.path.join(API_DIR, key + ".json"), force=force)
    try:
        return json.loads(data.decode("utf-8"))
    except Exception:
        raise RuntimeError("api.php 返回的不是 JSON：%s" % data[:200])


def raw(title, force=False):
    """拿页面的 wikitext 源码。404 返回 None 而不是抛异常（有些标题真的不存在）。"""
    from urllib.parse import quote
    url = "%s/index.php?title=%s&action=raw" % (BASE, quote(title))
    path = os.path.join(RAW_DIR, _safe(title) + ".txt")
    if not force and os.path.exists(path):
        with open(path, "rb") as f:
            b = f.read()
        return b.decode("utf-8") if b else None
    try:
        body = _get(url, path, force=force)
    except RuntimeError:
        MISSES.append(title)
        with open(path, "wb") as f:
            f.write(b"")
        return None
    text = body.decode("utf-8", errors="replace")
    # action=raw 对不存在的页面返回 200 + 空内容
    return text or None


class Tabx(object):
    """Data:*.tabx —— 灰机 SMongo 数据表，本质是 {"schema":{...},"data":[[...],...]}。"""

    def __init__(self, blob):
        fields = blob["schema"]["fields"]
        self.fields = [f["name"] for f in fields]
        self.titles = {f["name"]: (f.get("title") or {}).get("zh", "") for f in fields}
        self.rows = [dict(zip(self.fields, row)) for row in blob["data"]]

    def __len__(self):
        return len(self.rows)

    @classmethod
    def fetch(cls, page, force=False):
        text = raw(page, force=force)
        if not text:
            raise RuntimeError("数据表不存在或为空：%s" % page)
        return cls(json.loads(text))


# ---------------------------------------------------------------- 立绘

def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# 立绘文件名是确定性的，不用去猜：
#   人格  -> <png1> normal.png          例如 10101 normal.png
#   E.G.O -> <png> awaken profile.png   例如 21101 awaken profile.png
# （png1 / png 是数据表里的编号字段，190/190、116/116 全部非空，实测全部文件都在。）
# 之前想用「页面上引用过的图片里挑最短的那个」，结果 prop=images 会被导航模板污染，
# 拉进来几百个别的罪人的头像，完全挑不准。别走那条路。
ART_PATTERNS = {
    "identity": ("%s normal.png",),
    "ego": ("%s awaken profile.png",),
}


def fetch_portrait_urls(codes, kind, force=False):
    """批量问缩略图 URL。返回 {编号: url}。"""
    urls = {}
    for group in _chunks(sorted(set(codes)), 50):
        key = "art.%s.%s" % (kind, hashlib.sha1("|".join(group).encode()).hexdigest()[:10])
        d = api({"action": "query",
                 "titles": "|".join("文件:" + p % c for c in group
                                    for p in ART_PATTERNS[kind]),
                 "prop": "imageinfo", "iiprop": "url|size", "iiurlwidth": "160"},
                cache_key=key, force=force)
        for page in d.get("query", {}).get("pages", []):
            ii = page.get("imageinfo")
            if not ii:
                continue
            # 从标题里把编号抠回来
            m = re.match(r"文件:(\d+) ", page["title"])
            if m:
                urls[m.group(1)] = ii[0].get("thumburl") or ii[0]["url"]
    return urls


def download_portraits(codes, kind, force=False):
    """按编号下载立绘，返回 {编号: 本地路径}。"""
    urls = fetch_portrait_urls(codes, kind, force=force)
    out = {}
    for code in codes:
        url = urls.get(code)
        if not url:
            continue
        dest = os.path.join(ART_DIR, "%s.%s.png" % (kind, code))
        if force or not os.path.exists(dest):
            try:
                _get(url, dest, force=force)
            except RuntimeError as exc:
                print("  ! 立绘下载失败 %s (%s)" % (url, exc))
                continue
        out[code] = dest
    return out


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="忽略缓存全量重抓")
    args = ap.parse_args()
    _ensure_dirs()

    print("== 1/4 数据表 ==")
    ident = Tabx.fetch("Data:Identitychoose.tabx", args.force)
    ego = Tabx.fetch("Data:Egochoose.tabx", args.force)
    pas = Tabx.fetch("Data:Identitypassive.tabx", args.force)
    # Buff 表不参与建模，只用来把正文里的 {{BuffPro|ChargeNoirAlly}} 翻成
    # 中文（保存）—— 黑派那一批技能的效果文本几乎全是这种英文 id。
    buff = Tabx.fetch("Data:Buff.tabx", args.force)
    print("  人格 %d 条 / E.G.O %d 条 / 被动 %d 条 / buff %d 条"
          % (len(ident), len(ego), len(pas), len(buff)))

    id_title = "name"
    id_names = [r[id_title] for r in ident.rows if r.get(id_title)]
    ego_names = [r["name"] for r in ego.rows if r.get("name")]
    print("  标题样本：%s / %s" % (id_names[0], ego_names[0]))

    print("== 2/4 人格页正文 (%d) ==" % len(id_names))
    for i, name in enumerate(id_names, 1):
        raw(name, args.force)
        if i % 40 == 0:
            print("  %d/%d" % (i, len(id_names)))

    print("== 3/4 E.G.O 页正文 (%d) ==" % len(ego_names))
    for i, name in enumerate(ego_names, 1):
        raw(name, args.force)
        if i % 40 == 0:
            print("  %d/%d" % (i, len(ego_names)))

    print("== 4/4 立绘 ==")
    for kind, label, codes in (("identity", "人格", [r["png1"] for r in ident.rows]),
                               ("ego", "E.G.O", [r["png"] for r in ego.rows])):
        codes = [c for c in codes if c]
        found = download_portraits(codes, kind, args.force)
        print("  %s 立绘命中 %d/%d" % (label, len(found), len(codes)))

    if MISSES:
        print("\n以下标题拿不到内容（多为重定向或已删除）：")
        for m in MISSES[:20]:
            print("  -", m)
        if len(MISSES) > 20:
            print("  ... 另 %d 条" % (len(MISSES) - 20))

    print("\n原始数据已缓存到 %s" % CACHE)


if __name__ == "__main__":
    main()
