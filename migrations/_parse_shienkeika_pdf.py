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

# 列の x。多少ずれるので幅を持たせる
COLS = [
    {"date": 93, "item": 182, "body": 290},    # 左組
    {"date": 569, "item": 658, "body": 766},   # 右組
]
TOL = 12
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
    out = []

    def visit(text, cm, tm, fd, fs):
        t = text.strip()
        if t:
            out.append((round(tm[4]), round(tm[5]), t))

    page.extract_text(visitor_text=visit)
    return out


def header_of(chunks):
    """ページ先頭のヘッダーから 利用者名 / 事業所名 / 要介護度 を取る"""
    d = {}
    for x, y, t in chunks:
        if t == "利用者名":
            d["name_label_y"] = y
        elif t == "要介護度":
            d["level_label_y"] = y
    name = office = level = None
    for x, y, t in chunks:
        if y == d.get("name_label_y") and 150 < x < 400:
            name = t
        if y == d.get("level_label_y") and 150 < x < 400:
            level = t
        if t.startswith("Hana") or ("居宅" in t and x > 900):
            office = t
    return {"name": name, "office": office, "care_level": level}


def parse_page(chunks, carry=None):
    """
    1 ページ分のレコードを返す。

    ⚠ 記録は **ページ・列をまたいで続く**。ページ末尾で年月日だけ出て、
      曜日・種別・内容が次ページ (または右組) の先頭に来ることがある。
      carry に「直前の続き中レコード」を渡すと、そこに足してから始める。
      戻り値の 2 番目が次に渡す carry。
    """
    recs = []
    for col in COLS:
        near = lambda x, c: abs(x - c) <= TOL
        # y → その列のチャンク
        rows = {}
        for x, y, t in chunks:
            if y < 170:          # ヘッダー行より上は無視
                continue
            for key in ("date", "item", "body"):
                if near(x, col[key]):
                    rows.setdefault(y, {})[key] = t
                    break
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
