# -*- coding: utf-8 -*-
"""
ほのぼの「生活アセスメント (1)〜(5)」PDF を JSON にする。

  python migrations/_parse_seikatsu_assessment_pdf.py <pdf...>

── なぜ座標で読むか ────────────────────────────────────────────────────
  この帳票は **選択肢を全部印字して、選んだものにチェックを付ける** 様式。
  素直に extract_text() すると

      布団 ü ベッド ⇒ ü 固定式 ギャッチ 電動

  のように「ü」と選択肢が混ざった 1 本の文字列になり、どれが選ばれたのか
  判別できない。文字ごとの x/y を見ると規則がある:

      ü の x + 約 12 ≒ 選ばれた選択肢の x     (同じ y 帯)

  例)  115:ü | 127:集合住宅        → 集合住宅
       88:1階 | 109:ü | 121:2階    → 2階   (1階ではない)

  なので **ü の右どなりで一番近い chunk** を選択値とする。

── 記述式 ──────────────────────────────────────────────────────────
  生活史・相談内容・既往歴・特記事項は長文で、枠内に折り返して入る。
  同じ x 列で y が連続する chunk を 1 ブロックに束ねる。

⚠ ほのぼのの「印刷」は **中身が空でも枠だけ印字する**。値が 1 つも無い
  PDF が普通に出てくる (作成ボタンだけ押した人)。空は空として返す。
"""
import sys, json, re, unicodedata
import pypdf
import pdfplumber  # 相談内容欄の座標判定にだけ使う (consultation_boxes 参照)

CHECK = "ü"          # Wingdings のチェック。選択された選択肢の左に置かれる
CHECK_DX = (4, 22)   # ü から選択肢までの x 差の許容範囲
SAME_ROW_DY = 3.5    # 同じ行とみなす y の差


def chunks_of(page):
    """(x, y, text) の一覧。text は空白 strip 済み。"""
    out = []

    def visit(text, cm, tm, font_dict, font_size):
        t = text.strip()
        if t:
            out.append((round(tm[4], 1), round(tm[5], 1), t))

    page.extract_text(visitor_text=visit)
    return out


def resolve_checks(items):
    """ü を「選ばれた選択肢の文字列」に解決して返す。

    戻り値: [(x, y, 選択肢), ...]  選択肢が見つからない ü は捨てる。
    """
    picked = []
    for x, y, t in items:
        if CHECK not in t:
            continue
        # ü だけの chunk と「ü付きの語」の両方がある。後者はその語自身が答え。
        bare = t.replace(CHECK, "").strip()
        if bare:
            picked.append((x, y, bare))
            continue
        best = None
        for x2, y2, t2 in items:
            if abs(y2 - y) > SAME_ROW_DY:
                continue
            if CHECK in t2:
                continue
            dx = x2 - x
            if CHECK_DX[0] <= dx <= CHECK_DX[1]:
                if best is None or dx < best[0]:
                    best = (dx, t2)
        if best:
            picked.append((x, y, best[1]))
    return picked


def split_series(rows):
    """同じ x 列の行を「枠ごと」に分ける。

    ⚠ ここが一番の罠。**上下に並んだ 2 つの枠のテキストが 1 行ずつ交互に
      描かれる**ことがある。フェースシートの「相談内容(本人)」と
      「(介護者・家族)」がまさにそれで、y はこう並ぶ:

        382.8 物忘れから…      ← 家族 1行目
        367.9 寝たきりに…      ← 本人 1行目   (差 14.9 = 別の枠)
        301.9 いる。現在の…    ← 家族 2行目   (差 66.0 = 同じ枠の次行)
        286.9 自分でやって…    ← 本人 2行目
        220.9 ると良いと…      ← 家族 3行目
        206.0 ない。            ← 本人 3行目

      素朴に「y が近ければ同じかたまり」とすると 2 人の話が混ざる。
      **差が小さいほうが別枠、大きいほうが同じ枠の次行**なので、
      差の分布を見て境目を決める。

      **枠ごとに y は等間隔**なので、周期 (= 小さい差 + 大きい差) で
      y を割った余りが枠の識別子になる。上の例なら周期 81 で

        367.9 % 81 = 43.9   286.9 % 81 = 43.9   206.0 % 81 = 44.0   ← 本人
        382.8 % 81 = 58.8   301.9 % 81 = 58.9   220.9 % 81 = 58.9   ← 家族

      ときれいに 2 つに割れる。

    rows: [(y, text), ...]  y 降順
    戻り値: [[(y, text), ...], ...]  枠ごとの行リスト (y 降順)
    """
    if len(rows) <= 2:
        return [rows]
    gaps = sorted(rows[i][0] - rows[i + 1][0] for i in range(len(rows) - 1))
    lo, hi = gaps[0], gaps[-1]
    # 差が 2 種類にはっきり割れているときだけ「交互に描かれている」とみなす
    if hi < lo * 2.2 or hi - lo < 18:
        return [rows]

    period = lo + hi
    buckets = {}
    for y, t in rows:
        key = round((y % period) / 6)      # 6pt 単位に丸めて揺れを吸収
        buckets.setdefault(key, []).append((y, t))
    if len(buckets) < 2:
        return [rows]
    # y が大きい枠から順に返す
    out = []
    for _, b in sorted(buckets.items(), key=lambda kv: -max(y for y, _ in kv[1])):
        out.append(sorted(b, key=lambda r: -r[0]))
    return out


# 帳票に最初から刷ってある見出し。値ではないので本文ブロックから外す。
# ⚠ ここに入れ忘れると見出しが本文の 1 行目に混ざる (実際に踏んだ)。
LABELS = (
    "（本人）", "（介護者・家族）", "(主訴", "(主な生活史）",
    "■相談内容", "■これまでの生活の経過", "【特記事項】", "【特記、",
    "【周辺環境", "利用者氏名", "〔全社協",
)


def is_label(t):
    return any(t.startswith(p) or t == p.strip("（）") for p in LABELS)


def text_blocks(items, min_len=8):
    """長めの chunk を「同じ x 列の枠ごと」に束ねる。

    枠内で折り返した長文を 1 本に戻すためのもの。
    """
    # ⚠ 座標が取れない chunk (x=y=0) が混ざる。集めると 1 つの巨大ブロックに
    #   化けて本文を汚すので落とす。
    longs = [
        (x, y, t) for x, y, t in items
        if len(t) >= min_len and CHECK not in t and not is_label(t)
        and not (x == 0 and y == 0)
    ]
    cols = {}
    for x, y, t in longs:
        cols.setdefault(round(x / 6) * 6, []).append((x, y, t))

    blocks = []
    for _, rows in sorted(cols.items()):
        rows.sort(key=lambda a: -a[1])
        # まず y が大きく離れたら別の枠として切る
        groups, cur = [], [rows[0]]
        for i in range(1, len(rows)):
            if cur[-1][1] - rows[i][1] <= 100:
                cur.append(rows[i])
            else:
                groups.append(cur)
                cur = [rows[i]]
        groups.append(cur)
        for g in groups:
            for series in split_series([(y, t) for _, y, t in g]):
                if not series:
                    continue
                blocks.append({
                    "x": g[0][0],
                    # ⚠ グループの先頭ではなく **その系列の先頭 y**。
                    #   ここを間違えると交互に描かれた 2 枠が同じ y になり、
                    #   どちらが上か分からなくなる (本人/家族の取り違え)。
                    "y_top": series[0][0],
                    "text": "\n".join(t for _, t in series),
                })
    blocks.sort(key=lambda b: (-b["y_top"], b["x"]))
    return blocks


def near_label(items, label, dx=(0, 400), dy=SAME_ROW_DY):
    """label と同じ行にある、label の右側で一番近い chunk を返す。"""
    anchors = [(x, y) for x, y, t in items if t.startswith(label)]
    if not anchors:
        return None
    ax, ay = anchors[0]
    best = None
    for x, y, t in items:
        if abs(y - ay) > dy or t.startswith(label):
            continue
        d = x - ax
        if dx[0] < d <= dx[1]:
            if best is None or d < best[0]:
                best = (d, t)
    return best[1] if best else None


def form_kind(text):
    """1 ページ目のテキストから帳票の種類を判定する。"""
    if "フェースシート" in text:
        return "face_sheet"
    if "家族状況とインフォーマルな支援" in text or "サービス利用状況" in text:
        return "family_service"
    if "住居等の状況" in text:
        return "housing"
    if "本人の健康状態・受診等の状況" in text:
        return "health"
    return "unknown"


NAME_RE = re.compile(r"令和\s*\d+年\s*\d+月\s*\d+日\s+(.+?)\s+利用者氏名")
NAME_RE2 = re.compile(r"利用者氏名：\s*(.+)")


def user_name(text, items):
    m = NAME_RE.search(text) or NAME_RE2.search(text)
    if m:
        return unicodedata.normalize("NFKC", m.group(1)).strip()
    # 座標で拾う: 「利用者氏名：」の右
    v = near_label(items, "利用者氏名")
    return unicodedata.normalize("NFKC", v).strip() if v else None


# 「■相談内容」枠の右端。実測 (2026-09-03 / 40 枚): 左カラムの語は x0<=290、
# 右カラムの生活史は x0>=310 で、その間に語が 1 つも無い。
CONSULT_X_RIGHT = 300
CONSULT_LABELS = {"初回相談内容", "■相談内容", "（本人）", "（介護者・家族）"}


def consultation_boxes(pl_page):
    """「■相談内容」枠を **印字ラベルの y 区間** で切って (本人, 介護者・家族) を返す。

    ⚠ 座標は **pdfplumber** で取る。pypdf の visitor が返す tm[5] は行位置と
      一致せず、同じ枠の判定に使うと 40 枚すべてで別物になる (2026-09-03 実測)。
      pdfplumber は既に parse_shougai_certs.py で使っている依存。

    ⚠ ブロックを y 順に並べて left[0]=家族 / left[1]=本人 と **位置で決めてはいけない**。
      片方の枠だけ記入された様式が実在し、ブロックが 1 個のときに
      **本人の発言が家族欄に入る**。2026-09-03 に 40 枚を実測して 13 枚で発生していた
      ((100)(101)(102)(103)(105)(108)(109)(11)(115)(118)(120)(124)(128))。

    枠の座標は全 40 枚で 2 通りしか無く、ラベルは 3 点とも全枚に存在する:
        「（本人）」        y=529.3 (36 枚) / 522.6 (4 枚)
        「（介護者・家族）」 y=400.3 (36 枚) / 392.1 (4 枚)
        枠の下端 (罫線)     y=311.8 (36 枚) / 305.8 (4 枚)
    下端は pypdf では罫線が取れないので、直下の「介護保険」ラベル
    (y=300.6 / 296.0) の少し上を使う。取れなければ y_fam-92 で打ち切る。
    """
    h = pl_page.height
    left = [
        (w["x0"], h - w["top"], w["text"])
        for w in pl_page.extract_words()
        if w["x0"] < CONSULT_X_RIGHT
    ]
    y_user = next((y for x, y, t in left if x < 62 and "本人" in t and 500 < y < 560), None)
    y_fam = next((y for x, y, t in left if x < 62 and "介護者" in t), None)
    if y_user is None or y_fam is None:
        return None, None
    y_ins = next((y for x, y, t in left if x < 80 and "介護保険" in t and y < y_fam), None)
    y_bot = y_ins + 6 if y_ins is not None else y_fam - 92

    def grab(lo, hi):
        rows = {}
        for x, y, t in left:
            if lo < y < hi and t.strip() not in CONSULT_LABELS:
                rows.setdefault(round(y / 2) * 2, []).append((x, t))
        s = "".join("".join(t for _, t in sorted(v)) for _, v in sorted(rows.items(), reverse=True))
        return s or None

    return grab(y_fam, y_user), grab(y_bot, y_fam)


def parse_page(page, pl_page=None):
    items = chunks_of(page)
    text = page.extract_text()
    kind = form_kind(text)
    consult_user, consult_family = (
        consultation_boxes(pl_page) if kind == "face_sheet" and pl_page is not None else (None, None)
    )
    return {
        "kind": kind,
        "name": user_name(text, items),
        "checks": [{"x": x, "y": y, "value": v} for x, y, v in resolve_checks(items)],
        "blocks": [
            {"x": round(b["x"], 1), "y": round(b["y_top"], 1), "text": b["text"]}
            for b in text_blocks(items)
        ],
        "consultation_user": consult_user,
        "consultation_family": consult_family,
        "raw_len": len(text),
    }


def main(paths):
    out = []
    for p in paths:
        try:
            reader = pypdf.PdfReader(p)
        except Exception as e:  # 壊れた PDF は握りつぶさず記録する
            out.append({"file": p, "error": str(e)})
            continue
        # 相談内容欄の座標だけ pdfplumber で取る (上の consultation_boxes 参照)。
        # 開けなくても他の抽出は続ける — 握りつぶさず error に残す。
        pl_pages, pl_err = [], None
        try:
            with pdfplumber.open(p) as pl:
                pl_pages = list(pl.pages)
                pages = [
                    parse_page(pg, pl_pages[i] if i < len(pl_pages) else None)
                    for i, pg in enumerate(reader.pages)
                ]
        except Exception as e:
            pl_err = str(e)
            pages = [parse_page(pg) for pg in reader.pages]
        rec = {"file": p, "pages": pages}
        if pl_err:
            rec["consultation_error"] = pl_err
        out.append(rec)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    # ⚠ Windows の既定は cp932。リダイレクトすると日本語が壊れるので固定する。
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print("使い方: _parse_seikatsu_assessment_pdf.py <pdf...>", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1:])
