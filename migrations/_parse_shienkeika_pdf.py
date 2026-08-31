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

⚠ **CubePDF で出したものを使うこと。**
  Microsoft Print to PDF 版は 1 レコードが複数ページにまたがると取りこぼす
  (阿部代始子 43 件 → 18 件)。CubePDF 版は 1 行 1 チャンクで素直に読めるうえ、
  保存ダイアログも出ない。出し方は docs/HONOBONO_PDF_EXPORT.md。
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


def find_columns(chunks, head_y):
    """
    列の x を **実データから**決める。

    ⚠ ヘッダーのラベルは列の中央に置かれるので、そのまま列の x にはできない
      (「内　　　　　容」は中央寄せで、データは左寄せ)。
    ⚠ 決め打ちの COLS に落ちると、左組と右組の両方でデータを拾ってしまい
      **同じ記録を二重に数える** (阿部代始子で 43 件が 64 件になった)。

    やり方: 「年月日」ラベルの x で組の境界を決め、組ごとに
      データの x を集めて 小さい順に 年月日 / 項目 / 内容 とする。
    """
    starts = sorted(x for x, _, t in chunks if t == "年月日")
    if not starts:
        return None
    # ⚠ 組の境界は「年月日」ラベルの **中間**で切る。
    #   ラベルの x をそのまま下限にすると、ラベルより左にあるデータ (Microsoft は
    #   ラベル 109 / データ 93) が漏れ、次の組の左端が混ざる。
    mids = [(a + b) // 2 for a, b in zip(starts, starts[1:])]
    edges = [-(1 << 30)] + mids + [1 << 30]
    bounds = list(zip(edges, edges[1:]))
    cols = []
    for lo, hi in bounds:
        xs = sorted({x for x, y, _ in chunks if y > head_y and lo <= x < hi})
        # 近い x はまとめる (1〜2px のゆらぎ)
        groups = []
        for x in xs:
            if groups and x - groups[-1][-1] <= 3:
                groups[-1].append(x)
            else:
                groups.append([x])
        reps = [g[0] for g in groups]
        if len(reps) >= 3:
            cols.append({"date": reps[0], "item": reps[1], "body": reps[2]})
        elif len(reps) == 2:
            # 年月日の列にデータが無いページ (続きだけ) もある
            cols.append({"date": reps[0] - 90, "item": reps[0], "body": reps[1]})
    return cols or None


# ── CubePDF は 1 行を 1 チャンクにまとめる ────────────────────────────────
#   Microsoft Print to PDF は列ごとに別チャンクになるが、CubePDF は
#   「モニタリング 自宅を訪問し… R 7/ 9/26」のように **行まるごと 1 つ**になる。
#   末尾に 年月日 / 曜日 / (種別) のどれかが付くので、そこで切り離す。
TAIL_DATE = re.compile(r"[ 　]([RH]\s*\d+/\s*\d+/\s*\d+)$")
TAIL_DOW = re.compile(r"[ 　]([日月火水木金土]曜日)$")
# ⚠ 種別は行末の括弧だが、**本文中の括弧を拾ってはいけない**。
#   「…デイサービス)「続けていけるのね」 (訪問)」のような行があるので、
#   括弧の中身を **既知の種別だけ**に限る。
KIND_WORDS = ("訪問", "電話", "来所", "メール", "ＦＡＸ", "FAX", "LINE", "ＬＩＮＥ",
              "MCS", "ＭＣＳ", "その他", "カンファレンス", "サービス担当者会議",
              "モニタリング", "文書", "郵送", "面談")
TAIL_KIND = re.compile(r"[ 　]([（(](?:" + "|".join(KIND_WORDS) + r")[)）])$")
# 行のどこにあっても拾う版 (括弧の中身は既知の種別に限る)
KIND_ANY = re.compile(r"[（(](" + "|".join(KIND_WORDS) + r")[)）]")
DOW_ANY = re.compile(r"[ 　]?[日月火水木金土]曜日")
# ページ番号 (「2 / 3」)。本文の列に紛れるので落とす
PAGENO_RE = re.compile(r"^\d+\s*/\s*\d+$")


def split_merged_line(t):
    """行チャンクを (左側, 末尾) に割る。末尾が無ければ (t, None)"""
    for rx in (TAIL_DATE, TAIL_DOW, TAIL_KIND):
        m = rx.search(t)
        if m:
            return t[: m.start()].rstrip(), m.group(1)
    return t, None


def parse_page_merged(chunks, head_y, carry=None):
    """
    CubePDF が出した PDF を読む。

    ⚠ CubePDF は **1 行を 1 チャンクにまとめる**ので、列で切り分けられない。
      Microsoft Print to PDF は列ごとに別チャンクになるのと対照的。

        x=136  「モニタリング 自宅を訪問し、本人・長男と面談する R 7/ 9/26」
        x=217  「玄関外に出ていることもあるが、外用」          ← 内容の続きだけ

      行末に 年月日 / 曜日 / (種別) のどれかが付くので、そこで切り離す。
      項目があるかどうかは **x で判る** (項目付き=左寄り / 内容だけ=右寄り)。
    """
    # ⚠ ページ番号「2 / 3」が本文の列に紛れて混ざる。落としておかないと
    #   内容が変わって二重取込になる (青木春夫 2/2 で実際に起きた)。
    data = [c for c in chunks if c[1] > head_y and not PAGENO_RE.match(c[2])]
    if not data:
        return [], carry

    # 組の境界は「年月日」ラベルの x。2 組 (左右) あるのが普通
    starts = sorted(x for x, _, t in chunks if t == "年月日")
    if not starts:
        starts = [0]
    bounds = list(zip(starts, starts[1:] + [1 << 30]))

    recs = []
    for lo, hi in bounds:
        cols = [c for c in data if lo <= c[0] < hi]
        if not cols:
            continue
        # 項目付きの行は、その組の中で一番左に出る
        item_x = min(x for x, _, _ in cols)
        cur = carry
        for y in sorted({y for _, y, _ in cols}):
            line = [c for c in cols if c[1] == y]
            line.sort(key=lambda c: c[0])
            text = "".join(t for _, _, t in line)
            has_item = abs(line[0][0] - item_x) <= TOL

            # ⚠ 種別が本文と同じ行に紛れることがある
            #   (「…特別 土曜日火曜(電話)」のように曜日と続けて出る)。
            #   行末だけを見ると取りこぼすので、行のどこにあっても拾う。
            if cur is not None and cur.get("category") is None:
                mk = KIND_ANY.search(text)
                if mk:
                    cur["category"] = mk.group(1)
                    text = (text[: mk.start()] + text[mk.end():]).strip()
            # 曜日も同様に本文へ紛れるので、拾って捨てる
            text = DOW_ANY.sub("", text).strip()
            body, tail = split_merged_line(text)
            if tail and DATE_RE.match(tail):
                # 新しいレコードの先頭
                cur = {"record_date": wareki_to_iso(tail), "category": None,
                       "item": "", "content": ""}
                recs.append(cur)
            elif tail and KIND_RE.match(tail) and cur is not None:
                if cur.get("category") is None:
                    cur["category"] = KIND_RE.match(tail).group(1)
            # 曜日は捨てる (record_date から出せる)

            if cur is None or not body:
                continue
            if has_item:
                parts = re.split(r"[ 　]", body, maxsplit=1)
                cur["item"] += parts[0]
                if len(parts) > 1:
                    cur["content"] += parts[1]
            else:
                cur["content"] += body
        carry = cur
    return recs, carry


def parse_page(chunks, carry=None):
    """
    1 ページ分のレコードを返す。

    ⚠ 記録は **ページ・列をまたいで続く**。ページ末尾で年月日だけ出て、
      曜日・種別・内容が次ページ (または右組) の先頭に来ることがある。
      carry に「直前の続き中レコード」を渡すと、そこに足してから始める。
      戻り値の 2 番目が次に渡す carry。
    """
    recs = []
    head_y = max((y for _, y, t in chunks if t in ("年月日", "項　目", "内　　　　　容")),
                 default=0)
    cols = find_columns(chunks, head_y)
    if not cols:
        return [], carry
    for col in cols:
        near = lambda x, c: abs(x - c) <= TOL
        rows = {}
        for x, y, t in chunks:
            if y <= head_y:      # ヘッダー行より上は無視
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
        # ヘッダー行の y は プリンタで変わる (Microsoft 159 / CubePDF 119)
        head_y = max((y for _, y, t in ch if t in ("年月日", "項　目", "内　　　　　容")),
                     default=0)
        # 純粋な日付だけのチャンクがあれば列が分かれている (Microsoft)。
        # 無ければ行がまとまっている (CubePDF)。
        split_cols = any(DATE_RE.match(t) for x, y, t in ch if y > head_y)
        recs, carry = (parse_page(ch, carry) if split_cols
                       else parse_page_merged(ch, head_y, carry))
        cur["records"].extend(recs)
    return people


if __name__ == "__main__":
    out = []
    for p in sys.argv[1:]:
        out.extend(parse_pdf(p))
    print(json.dumps(out, ensure_ascii=False, indent=1))
