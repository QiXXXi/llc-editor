# -*- coding: utf-8 -*-
"""把抓下来的原始数据揉成 data/seed.json。

    python tools/parse_seed.py            解析（用 _ref 里的缓存）
    python tools/parse_seed.py --no-art   跳过立绘，只出文本部分（调试用，快很多）

输入：
    _ref/huiji/raw/Data_{Identitychoose,Egochoose,Identitypassive}_tabx.*  三张数据表
    _ref/huiji/raw/<人格名>.<hash>.txt      190 个人格页 wikitext
    _ref/huiji/raw/<EGO页名>.<hash>.txt     116 个 E.G.O 页 wikitext
    _ref/huiji/art/{identity,ego}.<编号>.png   306 张立绘

输出：
    data/seed.json   —— 构建时整个塞进 index.html 的 <script id="seed">

两条设计上的硬规矩：

1. **枚举词汇表只在 src/const.js 里写一次。** 罪孽、罪人、攻击类型、守备类型、
   触发时机这几十个中文词，本可以直接在这里复制一遍，但那样迟早出现
   「const.js 加了个触发时机，解析器不认」这种漂移。所以 load_enums() 是去
   const.js 里把数组抠出来用的。

2. **解析失败一律打印明细，不静默丢。** 静默丢数据是一次性脚本最容易留下的
   长期隐患 —— 半年后谁也说不清某个字段是「源数据本来就没有」还是
   「当时没解析出来」。
"""

import argparse
import base64
import html
import io
import json
import os
import re
import sys
import time
from collections import Counter

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "_ref", "huiji", "raw")
ART = os.path.join(ROOT, "_ref", "huiji", "art")
OUT_DIR = os.path.join(ROOT, "data")
OUT = os.path.join(OUT_DIR, "seed.json")

sys.path.insert(0, HERE)
import fetch_wiki as fw          # noqa: E402  复用它的缓存命名和 _safe()

NOW = int(time.time() * 1000)
WARNINGS = []

# 与 model.js 的 MAX_BATTLE_PASSIVES 保持一致。灰机被动表里最多的是 6 条
# （奥提斯蜘蛛巢中指父辈），8 够用且能挡住畸形数据。
MAX_BATTLE_PASSIVES = 8

# 被动表缺行的人格攒着一起报。灰机的 Identitypassive.tabx 只到 id 1121621，
# 比最新的人格慢一拍 —— 这几个人格的被动在源数据里就是空的，不是我们没解析出来。
MISSING_PASSIVE_OWNERS = []


def warn(msg):
    WARNINGS.append(msg)


# ---------------------------------------------------------------- 枚举表

def _js_array(src, name):
    """从 JS 源码里抠出一个数组字面量的内容。够用就行，不做完整 JS 解析。"""
    m = re.search(r'\bvar\s+%s\s*=\s*\[' % re.escape(name), src)
    if not m:
        raise RuntimeError("const.js 里找不到数组 %s" % name)
    i = m.end() - 1
    depth = 0
    quote = None
    while i < len(src):
        ch = src[i]
        if quote:
            if ch == '\\':
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                return src[m.end():i]
        i += 1
    raise RuntimeError("const.js 里 %s 的数组没闭合" % name)


def _pairs(body):
    """[{key:'x', cn:'中文', ...}] → [(key, cn)]"""
    return re.findall(r"\{\s*key:\s*'([^']*)'\s*,\s*cn:\s*'([^']*)'", body)


def _strings(body):
    return re.findall(r"'([^']*)'", body)


class Enums(object):
    pass


def load_enums():
    src = open(os.path.join(ROOT, "src", "const.js"), encoding="utf-8").read()
    e = Enums()
    e.sin_cn = dict((cn, k) for k, cn in _pairs(_js_array(src, 'SINS')))
    e.sin_keys = [k for k, _ in _pairs(_js_array(src, 'SINS'))]
    e.atk_cn = dict((cn, k) for k, cn in _pairs(_js_array(src, 'ATK_TYPES')))
    e.def_cn = dict((cn, k) for k, cn in _pairs(_js_array(src, 'DEF_TYPES')))
    e.cond_cn = dict((cn, k) for k, cn in _pairs(_js_array(src, 'PASSIVE_COND')))
    e.where_cn = dict((cn, k) for k, cn in _pairs(_js_array(src, 'PASSIVE_WHERE')))
    e.sinner_cn = dict((cn, k) for k, cn in _pairs(_js_array(src, 'SINNERS')))
    e.grade_keys = [k for k, _ in _pairs(_js_array(src, 'EGO_GRADE'))]

    # 触发时机的合法取值 = 常用组 ∪ 其他组。'none'（「无」）是哨兵值，不算触发时机。
    e.triggers = set(_strings(_js_array(src, 'TRIGGERS_COMMON')))
    e.triggers |= set(_strings(_js_array(src, 'TRIGGERS_ALL')))
    e.triggers.discard('（无）')

    # 灰机表里实际出现过的异体写法（与 const.js 的 CN_LOOKUP 保持一致）
    e.atk_cn['穿刺'] = 'pierce'                  # 数据表里有 1 条写成「穿刺」
    e.def_cn.update({'反击_斩击': 'counter_slash', '反击_突刺': 'counter_pierce',
                     '反击_打击': 'counter_blunt', '反击': 'counter_slash'})
    e.cond_cn.update({'常时': 'always', '常驻': 'always',
                      '共鸣': 'resonance', '持有': 'hold'})
    return e


E = load_enums()


# ---------------------------------------------------------------- 富文本

COIN_RE = re.compile(r'\{\{硬币\|(\d+)\}\}')
COLOR_RE = re.compile(r'\{\{颜色\|([^}|]+)\}\}')
BR_RE = re.compile(r'<br\s*/?>', re.I)
NOTRIG = 'none'          # 「没有触发时机」的哨兵值，见 const.js 的 TRIGGERS

# buff 内部 id → 中文名。由 load_buffs() 在 main() 开头填（Data:Buff.tabx）。
BUFF_CN = {}
BUFF_KIND = {}           # buff id → 正面/负面/状态/特殊，见 模板:状态2 的配色
BUFF_ICON = {}           # buff id → 图标文件名（Buff.tabx 的 image 字段）
BUFF_UNKNOWN = Counter()


def _color_sub(m):
    """触发时机已经被抽成独立字段了，正文里剩下的 {{颜色|X}} 只留文字。
    X 本身是触发时机的一律删掉，否则卡片上会把「命中时」再印一遍。"""
    v = m.group(1).strip()
    return '' if v in E.triggers else v


def clean(text):
    """wikitext 片段 → 卡片上能直接画的纯文本。状态名转成 **粗体**。"""
    if not text:
        return ''
    s = str(text)
    # {{状态2|沉沦|4=负面}} → **沉沦**；{{状态2|充能}} → **充能**
    s = re.sub(r'\{\{状态2\|([^}|]+)((?:\|[^}]*)?)\}\}', _status_sub, s)
    # {{状态|血宴}} / {{状态|血宴|}} —— 和状态2 同义，只是没有颜色参数
    s = re.sub(r'\{\{状态\|([^}|]+)\|?\s*\}\}', _plain_status_sub, s)
    # {{罪孽颜色|傲慢|3技能}} → **3技能**
    s = re.sub(r'\{\{罪孽颜色\|([^}|]+)((?:\|[^}]*)?)\}\}', _sin_color_sub, s)
    s = re.sub(r'\{\{BuffPro\|([^}|]+)\}\}', _buff_sub, s)
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    s = re.sub(r"'''(.+?)'''", r'**\1**', s)
    s = re.sub(r'\[\[[^\]|]*\|([^\]]+)\]\]', r'\1', s)      # [[A|B]] → B
    s = re.sub(r'\[\[([^\]]+)\]\]', r'\1', s)
    s = re.sub(r'\[https?://\S+\s+([^\]]+)\]', r'\1', s)    # [url 文字] → 文字
    s = re.sub(r'\{\{[^{}]*\}\}', '', s)                    # 剩下的模板整个丢掉
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def _status_token(parts):
    """{{状态2|…}} 的位置参数 → (文字名, 颜色种类, 图标名)。

    模板:状态2 的源码是
        [[文件:{{{3|{{{1}}}}}}.png|15px]]<span …>{{color|{{#switch:{{{4|正面}}}…}}|{{{2|{{{1}}}}}}}}</span>
    也就是：**图标**取第 3 个位置参数、没有就退回第 1 个；**文字**取第 2 个、
    没有就退回第 1 个；**颜色**只看第 4 个参数，没有就当「正面」（金色）。
    整段源码里没有任何对 Buff.tabx 的查询 —— 颜色不是查出来的，是写死的。

    实测 `{{状态2|沉沦}}` 在页面上渲染成 #FF0000，对应的是
    `{{状态2|沉沦|4=负面}}`，所以第 4 个参数必须一路留到卡片上。"""
    pos = [p.strip() for p in parts if p.strip() and '=' not in p]
    if not pos:
        return None
    text = pos[1] if len(pos) > 1 else pos[0]
    icon = pos[2] if len(pos) > 2 else pos[0]
    kind = '正面'
    for p in parts:
        p = p.strip()
        if p.startswith('4='):
            kind = p[2:].strip() or '正面'
    return text, kind, icon


def _status_mark(text, kind, icon):
    """三元组 → 卡片用的 token。`|` 不可能出现在状态名里，所以拿它当分隔符。

        呼吸法                    图标、文字同名，默认金色
        沉沦|负面                 颜色换掉
        狂信|正面|狂信（我方）    图标和文字不是一个名字

    只在必要时才多写一段：绝大多数状态就是光秃秃一个名字。同一套语法在
    src/const.js 的 parseStatus() 和 src/wikitext.js 的导出里各实现一遍，
    改动要同步。"""
    if icon and icon != text:
        return '**%s|%s|%s**' % (text, kind, icon)
    if kind and kind != '正面':
        return '**%s|%s**' % (text, kind)
    return '**%s**' % text


def _status_sub(m):
    """{{状态2|A|B|4=负面}} → **B|负面**（图标仍是 A）"""
    tok = _status_token([m.group(1)] + (m.group(2) or '').split('|'))
    if not tok:
        return ''
    return _status_mark(*tok)


def _plain_status_sub(m):
    """{{状态|血宴}} —— 没有颜色参数的写法，语义和 {{状态2}} 一样。"""
    name = (m.group(1) or '').strip()
    return _status_mark(name, '正面', name) if name else ''


def _sin_color_sub(m):
    """{{罪孽颜色|傲慢|您的盾牌}} → **您的盾牌|@傲慢**；只有一个参数时退回罪孽名。

    kind 槽位以 `@` 开头表示「按罪孽色染色」，长这样的是纯染色文字，没有图标
    也没有下划线（见 模板:罪孽颜色，它就是个 <span style="color:…">）。不处理的话
    末尾那句 `re.sub(r'\\{\\{[^{}]*\\}\\}', '', s)` 会把它整个删掉 —— 那
    「{{罪孽颜色|傲慢|3技能}}进行反击」就只剩「进行反击」了。"""
    disp = None
    for part in (m.group(2) or '').split('|'):
        part = part.strip()
        if part and '=' not in part:
            disp = part
            break
    return '**%s|@%s**' % (disp or m.group(1).strip(), m.group(1).strip())


def _buff_sub(m):
    """{{BuffPro|ChargeNoirAlly}} → **保存|负面**。

    参数是**内部 buff id**（英文），中文名和分类都要去 Data:Buff.tabx 里查。

    跟 {{状态2}} 的区别在于颜色从哪来：状态2 的颜色是调用时写死的（第 4 个
    参数），BuffPro 没有参数可写，站点的 JS 只能去 Buff.tabx 里读 kind。
    所以这里把 kind 直接写进 token，卡片就不用再查一次表了。

    查不到就原样留着 id 并记账：黑派那一批技能的效果文本几乎是清一色的
    BuffPro，少查一个就是满屏英文 id，宁可难看也不能把它默默删掉。"""
    bid = m.group(1).strip()
    cn = BUFF_CN.get(bid)
    if cn is None:
        BUFF_UNKNOWN[bid] += 1
        return '**%s**' % bid
    # 图标也取自表里（页面上就是这么渲染的：`保存.png` 加 `#daa520` 那句），
    # 只有查不到才退回用名字当图标名
    return _status_mark(cn, BUFF_KIND.get(bid, '正面'), BUFF_ICON.get(bid, cn))


def parse_effects(value):
    """{{硬币|1}}{{颜色|命中时}}文本<br>{{颜色|攻击前}}文本2
       → [{coin:1, trigger:'命中时', text:'文本'},
          {coin:None, trigger:'攻击前', text:'文本2'}]

    一行 = 一条效果。没有硬币号的（技能级效果）coin 记 None；没有触发时机的
    纯描述行（如「指定站位最靠后的单位」）trigger 记 'none'。

    光秃秃一条 `{{颜色|无法拼点}}<br>`（有触发时机、没正文）**要留下**：
    它渲染出来就是那个 `[无法拼点]` 红标签本身，丢掉它整行提示就没了。"""
    out = []
    if not value:
        return out
    for seg in BR_RE.split(value):
        seg = seg.strip()
        if not seg:
            continue
        m = COIN_RE.search(seg)
        coin = int(m.group(1)) if m else None
        trig = ''
        for cm in COLOR_RE.finditer(seg):
            v = cm.group(1).strip()
            if v in E.triggers:
                trig = v
                break
        text = clean(COLOR_RE.sub(_color_sub, COIN_RE.sub('', seg)))
        if not text and not trig:
            continue                     # 空行
        out.append({'coin': coin, 'trigger': trig or NOTRIG, 'text': text})
    return out


# ---------------------------------------------------------------- 模板解析

# 模板开头既可能是 {{技能链接| ，也可能是 {{EGO技能链接\n| ，所以 \s* 不能省。
def _tmpl_re(name):
    return re.compile(r'\{\{%s\s*\|(.*?)\n\}\}' % re.escape(name), re.S)


def tmpl_params(text, name):
    """抠出第一个 {{name|...}} 块的参数 → {键: 值}。
    按行首 '|' 切，所以值里带 {{颜色|命中时}} 这种内嵌竖线也不会把参数切坏。"""
    if not text:
        return None
    m = _tmpl_re(name).search(text)
    return _split_params(m.group(1)) if m else None


def tmpl_params_all(text, name):
    if not text:
        return []
    return [_split_params(m.group(1)) for m in _tmpl_re(name).finditer(text)]


def _split_params(body):
    """把模板体切成 {键: 值}。

    注意第一种参数的位置：{{技能链接| 后面跟着换行，所以第一个参数在第二行；
    而 {{EGO技能链接|类型=… 的第一个参数就在模板名那一行。两种写法都得认，
    否则 E.G.O 的 blocks 会解析出一堆 None。"""
    d = {}
    for idx, line in enumerate(body.split('\n')):
        line = line.rstrip()
        if line.startswith('|'):
            line = line[1:]
        elif idx != 0:
            continue                      # 续行，不参与参数解析
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        d[k.strip()] = v
    return d


def _num(v):
    if v is None or v == '':
        return None
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _signed(v):
    """'+6' / '-1' / '0' → '+6' / '-1' / '+0'。硬币威力在卡片上永远带正负号。"""
    if v is None or v == '':
        return None
    s = str(v).strip()
    if s[:1] in '+-':
        return s
    return ('+' + s) if s.isdigit() else s


# ---------------------------------------------------------------- 数据表 / 页面

def load_table(page):
    path = os.path.join(RAW, fw._safe(page) + '.txt')
    if not os.path.exists(path):
        raise RuntimeError("数据表没抓下来：%s（先跑 tools/fetch_wiki.py）" % page)
    blob = json.loads(open(path, encoding='utf-8').read())
    fields = [f['name'] for f in blob['schema']['fields']]
    return [dict(zip(fields, row)) for row in blob['data']]


def load_buffs():
    """Data:Buff.tabx（1629 行 / 1477 个 id）→ BUFF_CN。

    优先取 show 而不是 name：show 是游戏里实际印出来的短名（`保存神域`），
    name 带阵营后缀（`保存神域（我方）`），正是页面正文里那个 id 对应的一侧。"""
    for r in load_table('Data:Buff.tabx'):
        bid = (r.get('buffid') or '').strip()
        if bid and bid not in BUFF_CN:
            BUFF_CN[bid] = (r.get('show') or r.get('name') or bid).strip()
            kind = (r.get('kind') or '').strip()
            if kind in ('正面', '负面', '状态', '特殊'):
                BUFF_KIND[bid] = kind
            ic = re.sub(r'\.png$', '', (r.get('image') or '').strip())
            if ic:
                BUFF_ICON[bid] = ic


REDIRECT_RE = re.compile(r'^\s*#\s*(?:重定向|REDIRECT)\s*\[\[([^\]|]+)', re.I)
REDIRECTS = {}


def page_raw(title, depth=0):
    """取页面 wikitext，自动跟一层重定向。

    数据表里的页面标题和真实页面标题不总是对得上 —— 灰机把 `E.G.O::` 这类标题
    重命名过，表里留的是老的 `E.G.O:` 形式，那 24 个页面抓下来正文只有一行
    `#重定向 [[新标题]]`。不跟重定向的话，这些人的技能名和效果会整片丢失。"""
    if depth > 3:
        warn("重定向套得太深，放弃：%s" % title)
        return None
    path = os.path.join(RAW, fw._safe(title) + '.txt')
    txt = open(path, encoding='utf-8').read() if os.path.exists(path) else None
    if not txt:
        txt = fw.raw(title)          # 缓存里没有就补抓一次（重定向目标属于这种情况）
    if not txt:
        if depth == 0:
            warn("页面抓不到：%s" % title)
        return None
    m = REDIRECT_RE.match(txt)
    if m:
        tgt = m.group(1).strip()
        if depth == 0:
            REDIRECTS[title] = tgt
        return page_raw(tgt, depth + 1)
    return txt


def _resist(v):
    """灰机的抗性列：0 → ×0.5，其余数字就是倍率本身（见 const.js 的 RESIST_TIERS）。"""
    if v is None or v == '':
        return '1'
    try:
        n = float(v)
    except (TypeError, ValueError):
        warn("认不出的抗性值 %r，按 ×1 处理" % (v,))
        return '1'
    if n == 0:
        return '0.5'
    return str(int(n)) if n == int(n) else str(n)


# 灰机的数据表里有少数格子塞了内联 HTML —— 那是站点模板留下的排版记号，不是
# 给编辑器用的。实测只出现在两处：人格表的 `tag` 列（5 条）和被动表的名列（1 条）。
#
#   <span class="heimu" >天杀星</span>               黑幕，取文字本身
#   <span style="color:#d40000"><s>大&zwnj;师</s></span>  删除线 = 该词条已被除名
#
# 卡片是画在 canvas 上的，原样喂进去只会把 `<span` 一个字母一个字母画出来。所以
# 在这里压成最小记号：删除线用 `~~…~~`（跟 Markdown 一个写法，card.js 的 chipFlow
# 认这个），其余标签一律抹掉只留文字。
_STRIKE_RE = re.compile(r'<\s*(?:s|del|strike)\s*>(.*?)<\s*/\s*(?:s|del|strike)\s*>',
                        re.S | re.I)
_TAG_RE = re.compile(r'<[^>]*>')
# 零宽字符。`&zwnj;` 是灰机为了拆词塞进去的，留着会让 canvas 量文字时多出一个
# 空档（「大师」两个字中间凭空宽一格）。
_ZERO_WIDTH_RE = re.compile(u'[​-‍⁠﻿]')


def html_to_text(v):
    """数据表格子里的内联 HTML → 卡片能画的纯文字。没有标签就原样返回。

    必须在**拆词之前**调用：`~~大师~~` 是一整个词，拆完再补记号就补不回去了。"""
    if not v or '<' not in str(v):
        return v
    s = _STRIKE_RE.sub(lambda m: '~~' + m.group(1) + '~~', str(v))
    s = _TAG_RE.sub('', s)
    s = html.unescape(s)
    return _ZERO_WIDTH_RE.sub('', s).strip()


def _stamp(item, kind, code, page):
    item['id'] = 's_%s_%s' % (kind, code or re.sub(r'\W+', '', page)[:24])
    item['rev'] = 1
    item['basedOn'] = None
    item['seedRev'] = None
    item['createdAt'] = NOW
    item['updatedAt'] = NOW
    return item


# ---------------------------------------------------------------- 人格

def build_identity(row, passives_by_id):
    page = row['name']
    sinner_cn = row.get('belong') or ''
    raw = page_raw(page)
    if raw is None:
        warn("人格页正文没抓到，技能名和分阶效果会缺：%s" % page)

    # 显示名 = 页面标题去掉罪人前缀（'李箱W公司3级清扫人员' → 'W公司3级清扫人员'）。
    # 罪人在卡片上是分开的一栏，名字里再重复一遍很碍眼。
    disp = page
    if sinner_cn and page.startswith(sinner_cn) and len(page) > len(sinner_cn):
        disp = page[len(sinner_cn):]
    # wiki 标题里的下划线就是空格（'高级定制:黑派_品牌经理' 实际显示成
    # '高级定制:黑派 品牌经理'），照抄下来卡片上会多出一根下划线
    disp = disp.replace('_', ' ')

    item = {
        'kind': 'identity',
        'name': disp,
        'nameAlt': page.replace('_', ' ') if page != disp else '',
        'sinner': E.sinner_cn.get(sinner_cn, 'yiSang'),
        'code': str(row.get('png1') or ''),
        'rarity': str(row.get('rarity') if row.get('rarity') is not None else '1'),
        'season': str(row['season']) if row.get('season') is not None else '',
        'released': row.get('time') or '',
        'obtain': row.get('get') or '',
        'org': row.get('organize2') or '',
        'tag': html_to_text(row.get('tag') or ''),
        'hp': _num(row.get('hp')),
        'hpRate': str(row['hp_rate']) if row.get('hp_rate') is not None else '',
        'defRate': str(row['def_rate']) if row.get('def_rate') is not None else '',
        'spd': [str(row[k]) if row.get(k) is not None else ''
                for k in ('u1_spd', 'u2_spd', 'u3_spd', 'u4_spd')],
        'stagger': [str(row[k]) if row.get(k) is not None else ''
                    for k in ('stagger1', 'stagger2', 'stagger3')],
        'resist': {'slash': _resist(row.get('sres')),
                   'pierce': _resist(row.get('pres')),
                   'blunt': _resist(row.get('hres'))},
        'egoRes': ''
    }

    block = tmpl_params(raw, '技能链接')
    if raw and block is None:
        warn("人格页里找不到 {{技能链接}} 块：%s" % page)

    item['skills'] = [_page_skill(block, s, row, page) for s in skill_slots(block)]
    if not item['skills']:
        # 正文整个缺了就退回数据表的 1/2/3/4 四个固定槽位，聊胜于无
        item['skills'] = [_page_skill({}, '%d技能' % i, row, page) for i in (1, 2, 3, 4)]
        warn("人格页没有技能组，只有数据表数值：%s" % page)

    # 正文里的 {{人格被动链接|1080101}} 指向 Identitypassive.id
    battle, support, missing = [], [], []
    for pid in dict.fromkeys(re.findall(r'\{\{人格被动链接\|(\d+)\s*\}\}', raw or '')):
        p = passives_by_id.get(int(pid))
        if p is None:
            missing.append(pid)
            continue
        (support if p['where'] == 'support' else battle).append(p)
    if missing:
        MISSING_PASSIVE_OWNERS.append('%s（id %s）' % (page, '、'.join(missing)))
    # 战斗被动的条数不固定：老人格 1~2 条，新人格到 6 条都有。模型侧的
    # passives 本来就是变长数组，所以这里照单全收，只兜个底。
    if len(battle) > MAX_BATTLE_PASSIVES:
        warn("人格 %s 有 %d 条战斗被动，超出上限 %d，截断：%s"
             % (page, len(battle), MAX_BATTLE_PASSIVES,
                '、'.join(p['name'] for p in battle[MAX_BATTLE_PASSIVES:])))
        battle = battle[:MAX_BATTLE_PASSIVES]
    while len(battle) < 2:
        battle.append(_blank_passive('battle'))
    item['passives'] = battle

    if len(support) > 1:
        warn("人格 %s 有 %d 条支援被动，只留第一条" % (page, len(support)))
    sup = support[0] if support else _blank_passive('support')
    sup['where'] = 'support'
    item['support'] = sup

    return _stamp(item, 'identity', item['code'], page)


# 灰机人格页把技能拆成一组组参数：`1技能` / `2技能` / `3技能` / `4技能`(守备)
# 是四个固定槽位，此外还有 `5技能` / `6技能` / `7技能`（第四、五、六个技能）和
# 「强化N技能」家族 —— 同一个技能的强化形态，`强化3技能2` 是第三个技能的第
# 二种强化。190 个页面实测一共 861 个技能条目，最多的一个页面有 11 个
# （辛克莱高级定制::红派 赤红之神）。只认 1~4 会把黑派堂吉诃德、句点收尾人
# 希斯克利夫这些人的技能整片丢掉 —— 这就是之前那版漏掉的东西。
# 强化形态的后缀不止数字一种：`强化3技能2` 是数字，`强化4技能攻击` 是汉字
# （浮士德黎明事务所收尾人，4技能「烙印」的强化形态「正午的解体」）。
SLOT_RE = re.compile(r'^(强化)?(\d+)技能(.*)$')
SKILL_SUFFIX = ('图标', '名称', '类型', '罪孽', '罪孽2', '硬币数', '修正值',
                '攻击容量', '突破')


def slot_sort_key(slot):
    """1技能 < 强化1技能 < 强化1技能2 < 2技能 < … < 4技能 < 强化4技能攻击 < 5技能。

    「是否强化」排在序号后面当第二位，强化形态才会紧跟在本体后面，
    而不是被排到所有本体的后面去。"""
    m = SLOT_RE.match(slot or '')
    if not m:
        return (99, 0, 1, 0, slot or '')
    var = m.group(3) or ''
    enh = 1 if m.group(1) else 0
    # 空后缀按「第 0 种强化」排，`强化1技能` 才会排在 `强化1技能2` 前面
    if var == '' or var.isdigit():
        return (int(m.group(2)), enh, 0, int(var or 0), '')
    return (int(m.group(2)), enh, 1, 0, var)


def skill_slots(block):
    """从 {{技能链接}} 块里找出所有技能组，按显示顺序返回。

    先按第一个连字符切出组名再匹配，而不是枚举已知的组名 —— 灰机以后再加
    一种强化写法就不用回来改这里。末尾是保留参数名的要排除掉：页面上有
    `6技能类型=攻击` 这种漏写连字符的写法（3 处），不排除会凭空多出一个
    没有名字的「技能6类型」。"""
    if not block:
        return []
    out = set()
    for k in block:
        head = k.split('-', 1)[0]
        if SLOT_RE.match(head) and not head.endswith(SKILL_SUFFIX):
            out.add(head)
    return sorted(out, key=slot_sort_key)


def _slot_params(block, slot):
    """把整个 {{技能链接}} 块里属于 slot 的参数挑出来 → {后缀: 值}。

    少数地方漏写了连字符（`6技能类型=攻击`，页面上共 3 处），一并归位，
    否则那几个技能的属性会静默丢掉。"""
    out = {}
    for k, v in (block or {}).items():
        head, sep, tail = k.partition('-')
        if sep:
            if head == slot:
                out[tail] = v
        elif k.startswith(slot) and k[len(slot):] in SKILL_SUFFIX:
            out.setdefault(k[len(slot):], v)
    return out


def _page_skill(block, slot, row, page):
    """一个技能条目。数值和名称都来自页面正文的 {{技能链接}}。

    只有 1/2/3/4 这四个固定槽位能在 Identitychoose.tabx 里找到兜底数据 ——
    5/6/7技能 和「强化N技能」在表里**根本没有行**，正文是唯一来源。"""
    p = _slot_params(block, slot)
    num, enh, _, _, _ = slot_sort_key(slot)
    # 4技能 按约定就是守备技能；其余槽位看有没有「类型」：有类型的是攻击技能，
    # 没有的是守备（希斯克利夫的 7技能「掩护」就是一条可拼点防御，没有类型）。
    is_def = (slot == '4技能') or ('类型' not in p)

    coins, mod, atk, def_type, sin = None, None, '', '', None
    if enh == 0 and 1 <= num <= 4 and row:
        # 表里的兜底。正文说了话就听正文的，正文没说才用表里的。
        if num < 4:
            atk = E.atk_cn.get(row.get('skill%satk' % num), '')
            coins = _num(row.get('skill%snum' % num))
            sin = E.sin_cn.get(row.get('skill%saffinity' % num))
        else:
            def_type = E.def_cn.get(row.get('skill4def'), 'defend')
            sin = E.sin_cn.get(row.get('def_affinity'))
    if is_def and not def_type:
        def_type = 'defend'
    if not atk:
        atk = E.atk_cn.get(p.get('类型', ''), '')
    if sin is None:
        sin = E.sin_cn.get(p.get('罪孽', ''))

    if coins is None:
        coins = _num(p.get('硬币数'))
    mod = _signed(p.get('修正值'))

    stages = [{'on': False, 'power': None, 'coinPower': None, 'effects': []}
              for _ in range(4)]
    for k in range(1, 5):
        power = _num(p.get('%d阶技能威力' % k))
        coin = _signed(p.get('%d阶硬币威力' % k))
        eff = parse_effects(p.get('%d阶' % k))
        if power is None and coin is None and not eff:
            continue                     # wiki 上没写这一阶，不是我们丢了
        stages[k - 1] = {'on': True, 'power': power, 'coinPower': coin, 'effects': eff}

    if enh == 0 and num < 4 and not any(st['on'] for st in stages) and row:
        # 正文缺失时退回数据表（表里只有「1阶」这一组，聊胜于无）
        power = _num(row.get('skill%svalue' % num))
        coin = _signed(row.get('skill%sadd' % num))
        if power is not None or coin is not None:
            stages[0] = {'on': True, 'power': power, 'coinPower': coin, 'effects': []}
            warn("技能数值退回数据表（%s 的 %s 正文里没有分阶数据）" % (page, slot))

    weight = _num(p.get('攻击容量'))
    return {
        'slot': slot,
        'kind': 'def' if is_def else 'atk',
        'name': clean(p.get('名称', '')),
        'icon': p.get('图标', ''),
        'atk': atk,
        'defType': def_type,
        'sins': [sin] if sin else [],
        'coins': coins,
        'mod': mod or '+0',
        'weight': weight if weight is not None else 1,
        'breakthrough': bool(_num(p.get('突破'))),
        'stages': stages
    }


def _blank_passive(where):
    return {
        'name': '', 'where': where, 'cond': 'hold',
        'cost': {'aff1': '', 'num1': None, 'aff2': '', 'num2': None,
                 'aff3': '', 'num3': None},
        'stages': [{'on': False, 'text': ''}, {'on': False, 'text': ''}]
    }


def build_passive(row):
    cost = {}
    for i in (1, 2, 3):
        cost['aff%d' % i] = E.sin_cn.get(row.get('aff%d' % i)) or ''
        cost['num%d' % i] = _num(row.get('num%d' % i))
    # 数据表的 level1/level2 记的是「这条效果从共鸣/持有第几阶开始生效」。模型里
    # 被动只有「效果1 / 效果2」两格，等级本身不落库；空效果按 on=false 记下来，
    # 否则卡片上会多出一行空白。
    stages = [{'on': bool(clean(row.get(k) or '')), 'text': clean(row.get(k) or '')}
              for k in ('desc1', 'desc2')]
    return {
        'name': html_to_text(row.get('name') or ''),
        'where': E.where_cn.get(row.get('where') or '', 'battle'),
        'cond': E.cond_cn.get(row.get('trigger') or '', 'always'),
        'cost': cost,
        'stages': stages
    }


# ---------------------------------------------------------------- E.G.O

# 灰机 EGO 模板的参数下标：异想解析阶段 Ⅰ 和 Ⅱ 共用下标 1（Ⅱ 就是 Ⅰ 的逐字复制），
# Ⅲ→3、Ⅳ→4、Ⅴ→5。所以四级模型（见 const.js 的 EGO_STAGES）取 1/3/4/5。
EGO_STAGE_PARAM = [1, 3, 4, 5]


def build_ego(row):
    page = row['name']
    raw = page_raw(page)
    if raw is None:
        warn("E.G.O 页正文没抓到，技能名和分阶效果会缺：%s" % page)

    grade = row.get('grade') or 'ZAYIN'
    if grade not in E.grade_keys:
        warn("未知的危险等级 %r（%s），按 ZAYIN 处理" % (grade, page))
        grade = 'ZAYIN'

    name = clean(row.get('egoname') or page).replace('_', ' ')
    sin = E.sin_cn.get(row.get('affinity'))
    keys = E.sin_keys

    item = {
        'kind': 'ego',
        'name': name,
        'nameAlt': page.replace('_', ' ') if page != name else '',
        'sinner': E.sinner_cn.get(row.get('belong'), 'yiSang'),
        'code': str(row.get('png') or ''),
        'grade': grade,
        'origin': clean(row.get('origin') or ''),
        'rarity': str(row.get('rarity') if row.get('rarity') is not None else '0'),
        'season': '',
        'released': row.get('time') or '',
        'obtain': row.get('get') or '',
        'tag': '',
        'sp': _num(row.get('san')),
        'spCorrode': _num(row.get('sancor')),
        # Egochoose 表里没有超频（OC）理智消耗这一列。宁可不填也不臆造 san*2。
        'spOC': None,
        'atk': E.atk_cn.get(row.get('atk'), 'slash'),
        'sins': [sin] if sin else [],
        'sinsRes': dict((k, _resist(row.get(k))) for k in keys),
        'cost': dict((k, _num(row.get(k + 'cost')) or 0) for k in keys)
    }

    blocks = tmpl_params_all(raw, 'EGO技能链接')
    if raw and not blocks:
        warn("E.G.O 页里找不到 {{EGO技能链接}} 块：%s" % page)

    item['awaken'] = _ego_skill(row, _ego_block(blocks, 'E.G.O觉醒'), 'awaken',
                                row.get('atk'), coins=row.get('num'),
                                blind=row.get('identify'))
    item['corrode'] = _ego_skill(row, _ego_block(blocks, 'E.G.O侵蚀'), 'corrode',
                                 row.get('atkcor') or row.get('atk'),
                                 sin=row.get('affinitycor'), coins=row.get('numcor'),
                                 blind=row.get('identifycor'), suffix='cor')

    p = _blank_passive('battle')
    pb = tmpl_params(raw, 'EGO被动链接')
    if pb:
        p['name'] = clean(pb.get('名称', ''))
        txt = clean(pb.get('效果', ''))
        if txt:
            p['stages'][0] = {'on': True, 'text': txt}
    item['passive'] = p

    return _stamp(item, 'ego', item['code'], page)


def _ego_block(blocks, kind_cn):
    for b in blocks:
        if b.get('类型', '').strip() == kind_cn:
            return b
    return None


def _ego_skill(row, block, kind, atk, sin=None, coins=None, blind=None, suffix=''):
    stages = [{'on': False, 'power': None, 'coinPower': None,
               'weight': None, 'effects': []}
              for _ in range(len(EGO_STAGE_PARAM))]

    if block:
        coins = _num(block.get('硬币数'))
        # 正文里每个块自己写了攻击属性 / 罪孽属性，比数据表可靠
        # （数据表每个 EGO 只有一栏，侵蚀其实可以换成别的罪孽）
        atk = block.get('攻击属性') or atk
        sin = block.get('罪孽属性') or sin
        for i, n in enumerate(EGO_STAGE_PARAM):
            power = _num(block.get('基础值%d' % n))
            coin = _signed(block.get('变动值%d' % n))
            weight = _num(block.get('攻击容量%d' % n))
            eff = parse_effects(block.get('效果%d' % n))
            if power is None and coin is None and not eff:
                continue
            stages[i] = {'on': True, 'power': power, 'coinPower': coin,
                         'weight': weight, 'effects': eff}
    else:
        # 没正文就退回数据表：value3/4/5 → 我们的 Ⅲ/Ⅳ/Ⅴ（落在下标 1/2/3 上）
        for i, n in zip((1, 2, 3), (3, 4, 5)):
            power = _num(row.get('value%d%s' % (n, suffix)))
            coin = _signed(row.get('add%d%s' % (n, suffix)))
            weight = _num(row.get('weight%d%s' % (n, suffix)))
            if power is None and coin is None:
                continue
            stages[i] = {'on': True, 'power': power, 'coinPower': coin,
                         'weight': weight, 'effects': []}

    s = E.sin_cn.get(sin)
    return {
        'kind': kind,
        'name': clean((block or {}).get('名称', '')),
        'icon': (block or {}).get('图片', ''),
        'atk': E.atk_cn.get(atk, 'slash'),
        'defType': '',
        'sins': [s] if s else [],
        'coins': coins,
        'mod': _signed((block or {}).get('修正值')) or '+0',
        'weight': _num(row.get('weight3%s' % suffix)) or 1,
        'blind': bool(blind),
        'stages': stages
    }


# ---------------------------------------------------------------- 立绘

def encode_portraits(items):
    """立绘 → 128px webp 的 data URL。

    卡片只能画 data URL 的图：画一张外链图会把 canvas 污染掉，之后 toBlob 直接
    抛 SecurityError，导出 PNG 就废了。file:// 下 Origin 是 null，连 CORS 都没得谈。
    所以内置库的立绘必须在构建时抓下来内嵌，没有第二种做法。"""
    try:
        from PIL import Image
    except ImportError:
        warn("没装 Pillow，立绘全部跳过（卡片会退回占位块）。pip install Pillow 后重跑。")
        return {}

    out, hits, miss = {}, Counter(), []
    for it in items:
        kind, code = it['kind'], it['code']
        if not code:
            continue
        src = os.path.join(ART, '%s.%s.png' % (kind, code))
        if not os.path.exists(src):
            miss.append('%s %s' % (kind, code))
            continue
        try:
            im = Image.open(src).convert('RGB')
            im.thumbnail((128, 128), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'WEBP', quality=80, method=6)
            out['%s:%s' % (kind, code)] = (
                'data:image/webp;base64,' +
                base64.b64encode(buf.getvalue()).decode('ascii'))
            hits[kind] += 1
        except Exception as exc:
            miss.append('%s %s (%s)' % (kind, code, exc))

    total = sum(len(v) for v in out.values())
    print("  立绘内嵌：人格 %d、E.G.O %d，合计 %.1f MB 的 base64"
          % (hits['identity'], hits['ego'], total / 1048576))
    if miss:
        warn("有 %d 张立绘没内嵌（卡片上会退回占位块）：%s%s"
             % (len(miss), '、'.join(miss[:10]), ' …' if len(miss) > 10 else ''))
    return out


# ---------------------------------------------------------------- 图标

ICON_DIR = os.path.join(ROOT, "_ref", "huiji", "icons")
ICON_INDEX = os.path.join(ICON_DIR, "index.json")
MIME_BY_EXT = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg"}


def encode_icons():
    """游戏 UI 素材 → data URL。立绘那边同样的理由，见 encode_portraits()。

    产物：`_ref/huiji/icons/index.json` 由 tools/fetch_icons.py 写，键是素材名
    （`数值图标-生命`、`傲慢-等级1`、`沉沦`…），值是个本地文件名。"""
    if not os.path.exists(ICON_INDEX):
        warn("没有 _ref/huiji/icons/index.json，图标全部跳过（先跑 tools/fetch_icons.py）")
        return {}, {}
    idx = json.load(open(ICON_INDEX, encoding="utf-8"))

    out, total, miss = {}, 0, []
    for name, fn in (idx.get("icons") or {}).items():
        src = os.path.join(ICON_DIR, fn)
        mime = MIME_BY_EXT.get(os.path.splitext(fn)[1].lower())
        if not os.path.exists(src) or not mime:
            miss.append(name)
            continue
        raw = open(src, "rb").read()
        out[name] = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))
        total += len(raw)
    # 兜底表：正文里那个状态文字名 → 图标名，只在同名图标不存在时才用得上
    status_icons = {k: v for k, v in (idx.get("statusIcons") or {}).items()
                    if v in out and k not in out}
    print("  图标内嵌：%d 个，%d 个状态名走兜底图标，原始 %.1f MB（base64 后 %.1f MB）"
          % (len(out), len(status_icons), total / 1048576,
             sum(len(v) for v in out.values()) / 1048576))
    if miss:
        warn("索引里有 %d 个图标的文件不在缓存里：%s" % (len(miss), miss[:10]))
    return out, status_icons


# ---------------------------------------------------------------- 技能名横幅染色

BANNER_SRC = 'BattleUI CoinPopup skillName'
BANNER_PREFIX = '技能名-'
CONST_JS = os.path.join(ROOT, 'src', 'const.js')
CARD_JS = os.path.join(ROOT, 'src', 'card.js')


def sin_colors_from_src():
    """从 src/ 里抠出「罪孽中文名 → 色号」，外加「常规」那个中性色。

    为什么不在这里另抄一份色号：技能名横幅用的是**同一个罪孽色**（菱形、技能框
    也是它），抄两份迟早会漂。const.js 那张 `SINS` 表出自灰机「模板:颜色」的罪孽
    色号，而灰机给技能名染色的是 `MediaWiki:Common.js` 里的 `COLOR_MAP` ——
    两边实测**逐个相同**（含 `常规: #a16a3b`），所以直接引用这两份当唯一真相。"""
    try:
        src = open(CONST_JS, encoding='utf-8').read()
        card = open(CARD_JS, encoding='utf-8').read()
    except OSError as exc:
        raise SystemExit('读不到 %s，没法给技能名横幅取色号' % exc)
    # 只在 `var SINS = [ … ];` 这一段里找：三张枚举表（罪孽/攻击类型/罪人）
    # 的字段形状一模一样，不圈定范围会连 SINNERS 的 12 个配色一起捞出来。
    blk = re.search(r"var SINS = \[(.*?)\n  \];", src, re.S)
    pairs = (re.findall(r"cn: '([^']+)', color: '(#[0-9a-fA-F]{6})'", blk.group(1))
             if blk else [])
    if len(pairs) != 7:
        raise SystemExit('src/const.js 的 SINS 表读出来 %d 个罪孽（应该是 7），'
                         '改过格式的话这里的分界也要跟着改' % len(pairs))
    # 「常规」那个中性色在 card.js 里（`NEUTRAL_SIN_COLOR`，模板默认值的色号）
    m = re.search(r"NEUTRAL_SIN_COLOR = '(#[0-9a-fA-F]{6})'", card)
    if not m:
        raise SystemExit('src/card.js 里找不到 NEUTRAL_SIN_COLOR')
    return dict(pairs), m.group(1)


def encode_banner_tints(icons):
    """把技能名横幅的底图按罪孽色**逐像素染色**，生成一套 `技能名-{罪孽}`。

    灰机上横幅本来是一张白底图，颜色是 `MediaWiki:Common.js` 在浏览器里刷上去的：

        var brightness = (R + G + B) / 765;      // 0~1 的亮度
        R = r * brightness; G = g * brightness; B = b * brightness;

    也就是「拿亮度当权重把白图乘成目标色」—— 白的部分变成纯罪孽色，描边那些深灰
    变成同色系的暗调。alpha 不动。这段就是它的等价 Python 实现（Uint8ClampedArray
    是四舍五入到偶数，Python 的 round() 正好一样）。

    在**构建时**染色，而不是像灰机那样交给页面 JS：卡片是一张 canvas，本来就要
    data URL，染色后直接当普通图标用 `imgOf()` 取，运行时不碰 getImageData。"""
    if BANNER_SRC not in icons:
        warn('没有 %s 这张底图，技能名横幅会退回纯色块' % BANNER_SRC)
        return
    try:
        from PIL import Image
    except ImportError:
        warn('没装 Pillow，技能名横幅没法染色（会退回白底）')
        return
    colors, neutral = sin_colors_from_src()
    colors = dict(colors)
    colors['常规'] = neutral

    raw = icons[BANNER_SRC]
    head, _, b64 = raw.partition(',')
    src = Image.open(io.BytesIO(base64.b64decode(b64))).convert('RGBA')
    px = src.load()
    added = 0
    for cn, hexv in sorted(colors.items()):
        r = int(hexv[1:3], 16)
        g = int(hexv[3:5], 16)
        b = int(hexv[5:7], 16)
        out = Image.new('RGBA', src.size)
        op = out.load()
        for y in range(src.size[1]):
            for x in range(src.size[0]):
                p = px[x, y]
                k = (p[0] + p[1] + p[2]) / 765.0
                op[x, y] = (min(255, round(r * k)), min(255, round(g * k)),
                            min(255, round(b * k)), p[3])
        # 无损：这张是平滑渐变的窄条，有损压缩最容易在渐变上压出彩色带纹，
        # 而 8 张加起来也就十几 KB，不值得省。
        buf = io.BytesIO()
        out.save(buf, 'WEBP', lossless=True, quality=100, method=6)
        icons[BANNER_PREFIX + cn] = ('data:image/webp;base64,' +
                                     base64.b64encode(buf.getvalue()).decode('ascii'))
        added += 1
    print("  技能名横幅：底图 %d×%d 染成 %d 张（%s）"
          % (src.size[0], src.size[1], added,
             '、'.join(BANNER_PREFIX + c for c in sorted(colors))))


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-art', action='store_true', help='跳过立绘内嵌（调试用）')
    args = ap.parse_args()

    print("== 读数据表 ==")
    id_rows = load_table('Data:Identitychoose.tabx')
    ego_rows = load_table('Data:Egochoose.tabx')
    pas_rows = load_table('Data:Identitypassive.tabx')
    load_buffs()
    print("  人格 %d / E.G.O %d / 被动 %d / buff 名 %d"
          % (len(id_rows), len(ego_rows), len(pas_rows), len(BUFF_CN)))

    passives_by_id = {}
    for r in pas_rows:
        if r.get('id') is not None:
            passives_by_id[int(r['id'])] = build_passive(r)

    print("== 解析人格 ==")
    identities = [build_identity(r, passives_by_id) for r in id_rows if r.get('name')]
    print("== 解析 E.G.O ==")
    egos = [build_ego(r) for r in ego_rows if r.get('name')]
    items = identities + egos
    if REDIRECTS:
        print("  跟了 %d 个重定向（数据表标题 ≠ 真实页面标题）" % len(REDIRECTS))
    if MISSING_PASSIVE_OWNERS:
        warn("这 %d 个人格引用的被动在灰机被动表里根本没有行（表最新只到 id %s），"
             "被动栏会留空：%s"
             % (len(MISSING_PASSIVE_OWNERS), max(passives_by_id),
                '；'.join(MISSING_PASSIVE_OWNERS)))

    portraits = {}
    if not args.no_art:
        print("== 内嵌立绘 ==")
        portraits = encode_portraits(items)

    print("== 内嵌图标 ==")
    icons, status_icons = encode_icons()
    print("== 技能名横幅染色 ==")
    encode_banner_tints(icons)

    _report(identities, egos, portraits)

    os.makedirs(OUT_DIR, exist_ok=True)
    payload = {
        'generated': time.strftime('%Y-%m-%d %H:%M:%S'),
        'source': 'https://limbuscompany.huijiwiki.com/',
        'sourceNote': '内置数据取自灰机（huijiwiki）边狱公司中文维基，CC BY-SA 4.0',
        'counts': {'identity': len(identities), 'ego': len(egos)},
        'items': items,
        'portraits': portraits,
        'icons': icons,
        'statusIcons': status_icons
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print("\n写出 %s（%.1f MB）" % (OUT, os.path.getsize(OUT) / 1048576))

    if WARNINGS:
        print("\n%d 条提示：" % len(WARNINGS))
        for w in WARNINGS[:40]:
            print("  !", w)
        if len(WARNINGS) > 40:
            print("  ... 另 %d 条" % (len(WARNINGS) - 40))
    else:
        print("没有异常。")


def _all_skills(it):
    if it['kind'] == 'identity':
        return it['skills']
    return [it['awaken'], it['corrode']]


def _report(identities, egos, portraits):
    print("\n== 自检 ==")
    print("  人格 %d 条，E.G.O %d 条" % (len(identities), len(egos)))

    n_skill = n_named = n_effects = n_partial = n_passive = slots = 0
    max_battle = 0
    for it in identities:
        for sk in _all_skills(it):
            n_skill += 1
            if sk['name']:
                n_named += 1
            ons = [st for st in sk['stages'] if st['on']]
            if ons:
                if any(st['effects'] for st in ons):
                    n_effects += 1
                else:
                    n_partial += 1
        slots += len(it['passives']) + 1
        max_battle = max(max_battle, len(it['passives']))
        for p in it['passives'] + [it['support']]:
            if p['name']:
                n_passive += 1

    def pct(a, b):
        return 100.0 * a / max(1, b)

    print("  人格技能 %d 个：有名 %d（%.0f%%）、带硬币效果 %d（%.0f%%）、只有数值没效果 %d"
          % (n_skill, n_named, pct(n_named, n_skill),
             n_effects, pct(n_effects, n_skill), n_partial))

    # 技能条目数分布。只认 1~4 槽位的时候每人都正好是 4 —— 这个数字掉回
    # 4.x 就说明技能分组又解析漏了。
    cs = Counter(len(it['skills']) for it in identities)
    extra = sum(v for k, v in cs.items() if k > 4)
    print("  每人技能条目数：%s；多于 4 条的 %d 人（%s）"
          % ('，'.join('%d条×%d人' % (k, cs[k]) for k in sorted(cs)),
             extra, '含强化/5~7技能'))
    print("  被动 %d / %d 格填上了（%.0f%%；每人 N 条战斗 + 1 条支援，N 最多 %d）"
          % (n_passive, slots, pct(n_passive, slots), max_battle))

    n_aw = sum(1 for it in egos if it['awaken']['name'])
    n_cr = sum(1 for it in egos if it['corrode']['name'])
    n_creff = sum(1 for it in egos if any(st['on'] for st in it['corrode']['stages']))
    n_pas = sum(1 for it in egos if it['passive']['name'])
    print("  E.G.O：觉醒技能有名 %d/%d，侵蚀有名 %d，侵蚀有阶段数据 %d，被动有名 %d"
          % (n_aw, len(egos), n_cr, n_creff, n_pas))

    # 抗性分布。出现 0.5/0.75/1/1.5/2/3 以外的值就是解析错了。
    c = Counter()
    for it in identities:
        c.update(it['resist'].values())
    print("  物理抗性取值：%s" % _fmt(c))
    c2 = Counter()
    for it in egos:
        c2.update(it['sinsRes'].values())
    print("  罪孽抗性取值：%s" % _fmt(c2))

    c3 = Counter()
    for it in identities + egos:
        for sk in _all_skills(it):
            for st in sk['stages']:
                for e in st['effects']:
                    c3[e['trigger']] += 1
    print("  触发时机用得最多：%s" % _fmt(c3, 12))

    # {{BuffPro|X}} 里查不到中文名的 id。正常情况下只有一个位数，冒出一堆
    # 就说明 Data:Buff.tabx 抓旧了。
    if BUFF_UNKNOWN:
        warn("有 %d 个 buff id 在 Data:Buff.tabx 里查不到中文名（卡片上会显示"
             "英文 id）：%s" % (len(BUFF_UNKNOWN),
                             '、'.join('%s×%d' % (k, v)
                                       for k, v in BUFF_UNKNOWN.most_common())))

    if portraits:
        c4 = Counter(k.split(':', 1)[0] for k in portraits)
        print("  立绘命中：人格 %d/%d，E.G.O %d/%d"
              % (c4['identity'], len(identities), c4['ego'], len(egos)))
    else:
        print("  立绘：未内嵌")


def _fmt(counter, n=8):
    return '，'.join('%s×%d' % (k, v) for k, v in counter.most_common(n))


if __name__ == '__main__':
    main()
