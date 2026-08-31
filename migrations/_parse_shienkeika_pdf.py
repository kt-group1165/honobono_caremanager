# -*- coding: utf-8 -*-
"""
ほのぼのの「居宅介護支援経過」PDF を JSON にする。

── なぜ座標で読むか ────────────────────────────────────────────────────
  extract_text() をそのまま使うと段組が潰れて 1 行に
  「項目・内容・年月日」が混ざる。正規表現では切れない。
  pypdf の visitor_text で **文字の x 座標**が取れるので、列で切り分ける。

── PDF の作り (A4横・2 列組み) ─────────────────────────────────────────
  1 ページに同じ表が左右 2 組ある。列の x はほぼ固定。

    左組  x= 93 年月日 / 曜日 / (種別)      x=182 項目(+内容)   x=290 内容のみ
    右組  x=569 年月日 / 曜日 / (種別)      x=658 項目(+内容)   x=766 内容のみ

  ⚠ 項目の列は幅 6 文字ぶんしかなく、同じ行に内容があると
    pypdf が **項目と内容をつなげて 1 チャンク**にする
    (例「居宅契約・ア 二女宅を訪問し、本人と…」)。
    間に空白が入るので **最初の空白**で切る。空白が無ければ項目だけの行。

  ⚠ 1 レコードは「年月日が出る y」から「次の年月日が出る y」の手前まで。
    曜日は +19、種別は +38 の y に出る。

  使い方: python _parse_shienkeika_pdf.py <pdf> [<pdf> ...]  → JSON を stdout
"""
import sys, io, json, re, os
import pypdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# 列の x。プリンタによって少しずれるので幅を持たせる。
# ⚠ 決め打ちにせず、実際のチャンクから列を見つける (COLS は当たりを付けるだけ)。
COLS = [
    {"date": 93, "item": 182, "body": 290},    # 左組 (Microsoft Print to PDF)
    {"date": 569, "item": 658, "body": 766},   # 右組
    {"date": 82, "item": 156, "body": 277},    # CubePDF (回転を戻したあと)
]
TOL = 14
DATE_RE = re.compile(r"^([RH])\s*(\d+)/\s*(\d+)/\s*(\d+)$")
KIND_RE = re.compile(r"^[（(](.+?)[)）]$")


def wareki_to_iso(s):
    """R 8/ 1/12 → 2026-01-12。H は平成"""
    m = DATE_RE.match(s.strip())
    if not m:
        return None
    era, y, mo, d = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    year = (2018 + y) if era == "R" else (1988 + y)
    return f"{year}-{mo:02d}-{d:02d}"


def chunks_of(page):
    """
    (x, y, text) を返す。

    ⚠ **プリンタによって座標系が 90 度回る**。
      Microsoft Print to PDF は 横向きのまま出すので x=列 / y=行。
      CubePDF は 縦向きページに横向きで描くので **x と y が入れ替わる**
      (列が y、行が x になる)。
      「年月日」ラベルの位置で見分けて、以降は必ず x=列 / y=行 に正規化する。
    """
    out = []

    def visit(text, cm, tm, fd, fs):
        t = text.strip()
        if t:
            out.append((round(tm[4]), round(tm[5]), t))

    page.extract_text(visitor_text=visit)

    # 「年月日」「内　　　　　容」が同じ x に並んでいたら回転している
    labels = [(x, y) for x, y, t in out if t in ("年月日", "項　目", "内　　　　　容")]
    if len(labels) >= 2:
        xs = {x for x, _ in labels}
        ys = {y for _, y in labels}
        if len(xs) < len(ys):      # x が揃っている = 回転している
            out = [(y, x, t) for x, y, t in out]
    return out


def header_of(chunks):
    """
    ページ先頭のヘッダーから 利用者名 / 事業所名 / 要介護度 を取る。

    ⚠ プリンタによってラベルと値の並びが変わる。
      Microsoft Print to PDF: 「利用者名」ラベルと **同じ y** に氏名がある。
      CubePDF: 「要介護２ 要介護度」のように **1 チャンクに同居**することがある。
      どちらでも拾えるように両方見る。
    """
    name = office = level = None
    label_y = {}
    for x, y, t in chunks:
        if t == "利用者名":
            label_y["name"] = y
        elif t == "要介護度":
            label_y["level"] = y
        elif re.match(r"^要(介護|支援)[０-９0-9]", t):
            # 「要介護２ 要介護度」のように同居している
            level = re.split(r"[ 　]", t)[0]
        # 事業所名は「居宅」を含む短い語。ラベル文言は除く
        if ("居宅" in t or "ケアプラン" in t) and len(t) <= 14                 and t not in ("居宅介護支援経過", "利用者名", "要介護度")                 and "計画作成者" not in t:
            if office is None:
                office = t
    for x, y, t in chunks:
        if t in ("利用者名", "要介護度"):
            continue
        if y == label_y.get("name") and 60 < x < 500 and not t.startswith("要"):
            # 氏名は「殿」や日付ではない
            if t != "殿" and not re.match(r"^(令和|平成|R|H)", t):
                name = t
        if level is None and y == label_y.get("level") and 60 < x < 500:
            level = t
    return {"name": name, "office": office, "care_level": level}


def find_columns(chunks):
    """
    ヘッダーの「年月日 / 項　目 / 内　　　　　容」の x から列を決める。
    ⚠ プリンタで座標が変わるので決め打ちにしない。組 (左右) の数だけ返す。
    """
    dates = sorted(x for x, _, t in chunks if t == "年月日")
    items = sorted(x for x, _, t in chunks if t == "項　目")
    bodies = sorted(x for x, _, t in chunks if t == "内　　　　　容")
    if not dates or not bodies:
        return None
    cols = []
    for i, dx in enumerate(dates):
        # その組の 項目 / 内容 は 年月日 より右で一番近いもの
        ix = next((v for v in items if v > dx), None)
        bx = next((v for v in bodies if v > dx), None)
        if ix is None or bx is None:
            continue
        cols.append({"date": dx, "item": ix, "body": bx})
    return cols or None


# ── CubePDF は 1 行を 1 チャンクにまとめる ────────────────────────────────
#   Microsoft Print to PDF は列ごとに別チャンクになるが、CubePDF は
#   「モニタリング 自宅を訪問し… R 7/ 9/26」のように **行まるごと 1 つ**になる。
#   末尾に 年月日 / 曜日 / (種別) のどれかが付くので、そこで切り離す。
TAIL_DATE = re.compile(r"[ 　]([RH]\s*\d+/\s*\d+/\s*\d+)$")
TAIL_DOW = re.compile(r"[ 　]([日月火水木金土]曜日)$")
TAIL_KIND = re.compile(r"[ 　]([（(].+?[)）])$")


def split_merged_line(t):
    """行チャンクを (左側, 末尾) に割る。末尾が無ければ (t, None)"""
    for rx in (TAIL_DATE, TAIL_DOW, TAIL_KIND):
        m = rx.search(t)
        if m:
            return t[: m.start()].rstrip(), m.group(1)
    return t, None


def parse_page(chunks, carry=None):
    """
    1 ページ分のレコードを返す。

    ⚠ 記録は **ページ・列をまたいで続く**。ページ末尾で年月日だけ出て、
      曜日・種別・内容が次ページ (または右組) の先頭に来ることがある。
      carry に「直前の続き中レコード」を渡すと、そこに足してから始める。
      戻り値の 2 番目が次に渡す carry。
    """
    recs = []
    cols = find_columns(chunks) or COLS
    for col in cols:
        near = lambda x, c: abs(x - c) <= TOL
        # y → その列のチャンク
        # ⚠ ヘッダー行の y は プリンタで変わる (Microsoft=159 / CubePDF=119)。
        #   決め打ちにせず「年月日」ラベルの y より下だけを見る。
        head_y = max((y for _, y, t in chunks if t in ("年月日", "項　目", "内　　　　　容")),
                     default=0)
        rows = {}
        for x, y, t in chunks:
            if y <= head_y:      # ヘッダー行より上は無視
                continue
            # 右の組にはみ出しているチャンクは、この組では扱わない
            nxt = min((c["date"] for c in cols if c["date"] > col["date"]), default=1 << 30)
            if not (col["date"] - TOL <= x < nxt - TOL):
                continue
            if near(x, col["item"]) or near(x, col["date"]):
                # CubePDF は 項目・内容・末尾 が 1 チャンクに同居する
                left, tail = split_merged_line(t)
                if tail is not None:
                    rows.setdefault(y, {})["date"] = tail
                if left:
                    key = "date" if near(x, col["date"]) and tail is None else "item"
                    rows.setdefault(y, {})[key] = left
            elif near(x, col["body"]):
                rows.setdefault(y, {})["body"] = t
        if not rows:
            continue
        ys = sorted(rows)
        # 年月日が出る y = レコードの先頭
        starts = [y for y in ys if rows[y].get("date") and DATE_RE.match(rows[y]["date"])]

        # 先頭の年月日より前にある行は **前のレコードの続き**
        head_end = starts[0] if starts else (ys[-1] + 1)
        head = [y for y in ys if y < head_end]
        if head and carry is not None:
            for y in head:
                _merge(carry, rows[y])

        for i, sy in enumerate(starts):
            ey = starts[i + 1] if i + 1 < len(starts) else (ys[-1] + 1)
            cur = {"record_date": wareki_to_iso(rows[sy]["date"]),
                   "category": None, "item": "", "content": ""}
            for y in ys:
                if not (sy <= y < ey):
                    continue
                _merge(cur, rows[y], is_start=(y == sy))
            recs.append(cur)
            carry = cur          # 最後のレコードが次ページに続くかもしれない
    return recs, carry


def _merge(cur, r, is_start=False):
    """1 行ぶんを今のレコードに足す"""
    dt = r.get("date")
    if dt and not is_start:
        m = KIND_RE.match(dt)
        if m:
            cur["category"] = m.group(1)
        # 曜日は捨てる (record_date から出せる)
    if "item" in r:
        # 項目列に内容が混ざっている。最初の空白で切る
        parts = re.split(r"[ 　]", r["item"], maxsplit=1)
        cur["item"] += parts[0]
        if len(parts) > 1:
            cur["content"] += parts[1]
    if "body" in r:
        cur["content"] += r["body"]


def parse_pdf(path):
    r = pypdf.PdfReader(path)
    people = []
    cur = None
    carry = None          # ページ・列をまたいで続いているレコード
    for page in r.pages:
        ch = chunks_of(page)
        h = header_of(ch)
        if h.get("name"):
            if not cur or cur["name"] != h["name"]:
                cur = {"file": os.path.basename(path), **h, "records": []}
                people.append(cur)
                carry = None      # 人が変われば続きも切れる
        if cur is None:
            continue
        recs, carry = parse_page(ch, carry)
        cur["records"].extend(recs)
    return people


if __name__ == "__main__":
    out = []
    for p in sys.argv[1:]:
        out.extend(parse_pdf(p))
    print(json.dumps(out, ensure_ascii=False, indent=1))
