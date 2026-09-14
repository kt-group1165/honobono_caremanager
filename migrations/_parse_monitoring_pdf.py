#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ほのぼの「モニタリング記録表」PDF (要介護様式) を JSON にする。

  python migrations/_parse_monitoring_pdf.py <file...>

⚠ 段組がある帳票なので pypdf.extract_text() は列が混ざる (H様実測と一致)。
  pdfplumber の座標付き単語抽出で列を x 座標バケットに割り振って読む。

── 座標で分かったこと (2026-09-14・実PDF5件で確認) ──────────────────────────
  ・氏名は各ページに印字される (「利用者名」ラベルの右)。ただし ★旧字体
    (画面「浅井 珠恵」→PDF「淺井 珠惠」) が混ざる。呼出側 (import script) で
    異体字を畳んでから当方のclientsと突合すること (このparserはPDFの文字を
    そのまま出す。畳み込みはしない)。
  ・日付は1ページに2回出る。1回目=作成年月日(=monitoring_date)、
    2回目=印刷日(今日の日付、全ファイル共通)。★1回目だけを使う
    (assessment PDFで踏んだ「印刷日を掴む」罠と同型)。
  ・1課題ブロック = 課題(左列) / 短期目標(中列) / サービス内容(右列) の3列。
    ★見出しの並び順が画面と違う (「短期目標」ラベルが先に来る) が、
    データの列位置 (x座標) はラベルの位置と対応している。
  ・課題ブロックの下段 = 実行確認/確認方法/確認期日/本人(評価+自由文)/
    家族(評価+自由文)/ニーズ充足度/対応(評価+自由文) の7列。
    ★本人・家族・対応列は「1行目=評価の選択肢・2行目以降=自由文コメント」
    という構造 (評価とコメントが同じ列に縦に並ぶ)。
  ・満足度・ニーズ充足度・対応の実際の値は複数パターン確認済み:
      満足度       満足している / ある程度満足している / その他
      ニーズ充足度  ニーズ充足 / 変化なし
      対応         ケア継続 / 継続 / その他
    ★当方DBのCHECK制約 (user_satisfaction/family_satisfaction は
    '満足'/'不満' の2値のみ) はこの実データの粒度に対して狭すぎる。
    どうマッピングするかは呼出側 (import script) の判断。
    このparserは★見たままの文字列をそのまま出す (畳まない)。
  ・シート最後のページに「総括」「計画の変更等」(どちらも自由文・空のことがある)
    と「再アセスメントの必要 あり/なし」がある。
    ★あり/なしはテキストに印字されるだけでチェック文字は無い。選択は
    ★青い線で囲まれた楕円 (pdfplumber の curves) がどちらの単語を
    囲んでいるかで判定する (assessmentのチェック記号ü方式とは別の実装)。
    ⚠ 実測5件は全部「なし」を囲んでいた。「あり」の実例が無いため、
    楕円の座標が本当に選択に連動して動くのか (常に固定位置で「なし」を
    囲むだけの可能性もゼロではない) は★未確認。「あり」の実例が来たら
    必ず確認すること。
"""
import sys
import json
import pdfplumber

# 令和年月日 → ISO
def wareki_to_iso(era_year_kanji: str, month: int, day: int) -> str:
    # 令和 N年 → 2018 + N
    year = 2018 + era_year_kanji
    return f"{year:04d}-{month:02d}-{day:02d}"


def cluster_rows(words, tol=2.5):
    """words (x0,top,textを持つ辞書のリスト) を top でグループ化して行にする"""
    rows = []
    for w in sorted(words, key=lambda w: w["top"]):
        if rows and abs(rows[-1][0]["top"] - w["top"]) <= tol:
            rows[-1].append(w)
        else:
            rows.append([w])
    for r in rows:
        r.sort(key=lambda w: w["x0"])
    return rows


def col_of(x0, bounds):
    """bounds: [(name, xmin, xmax), ...] の先頭から一致する列名を返す。無ければ None"""
    for name, xmin, xmax in bounds:
        if xmin <= x0 < xmax:
            return name
    return None


HEADER_A = "生活全般の解決すべき課題"
HEADER_B = "短期目標"
HEADER_C = "サービス内容"
HEADER_D = "サービスの実行確認および確認方法"
HEADER_E = "利用者本人・家族の意見・要望"

TOP_COLS = [("kadai", 55, 280), ("mokuhyou", 280, 530), ("service", 530, 1000)]
BOTTOM_COLS = [
    ("jikkou", 55, 160), ("houhou", 160, 260), ("kakuninbi", 260, 320),
    ("honnin", 320, 421), ("kazoku", 421, 521), ("juusoku", 521, 641), ("taiou", 641, 1000),
]


def extract_header(words):
    """1ページ目の上部から 要介護度/氏名/事業所/作成日/作成者 を取る"""
    by_text = {}
    for w in words:
        by_text.setdefault(w["text"], []).append(w)

    def right_of(label, within_top, n=2):
        lw = next((w for w in words if w["text"] == label and w["top"] < within_top + 5 and w["top"] > within_top - 5), None)
        if not lw:
            lw = next((w for w in words if w["text"] == label), None)
        if not lw:
            return None
        row = [w for w in words if abs(w["top"] - lw["top"]) <= 2.5 and w["x0"] > lw["x0"]]
        row.sort(key=lambda w: w["x0"])
        return "".join(w["text"] for w in row[:n]) if row else None

    care_level = None
    name = None
    office = None
    rows = cluster_rows([w for w in words if w["top"] < 90])
    for row in rows:
        texts = [w["text"] for w in row]
        if "要介護度" in texts:
            idx = texts.index("要介護度")
            if idx + 1 < len(texts):
                care_level = texts[idx + 1]
        if "利用者名" in texts:
            idx = texts.index("利用者名")
            name = "".join(texts[idx + 1: idx + 3]).strip()
        for t in texts:
            if t.startswith("*"):
                office = t[1:]

    # 令和年月日を2つ拾う。★出現順(上から)ではなく「作成年月日」ラベルの行に
    # 近いほうを monitoring_date、遠い (ページ最上部の) ほうを print_date とする
    # (印刷日はページ最上部・作成年月日はその少し下、という位置関係が実測で一貫していた)。
    import re
    date_words = []
    flat = [w for row in rows for w in row]
    flat.sort(key=lambda w: (w["top"], w["x0"]))
    i = 0
    while i < len(flat):
        if flat[i]["text"] == "令和" and i + 2 < len(flat):
            my = re.match(r"(\d+)年", flat[i + 1]["text"])
            mm = re.match(r"(\d+)月(\d+)日", flat[i + 2]["text"])
            if my and mm:
                date_words.append((flat[i]["top"], wareki_to_iso(int(my.group(1)), int(mm.group(1)), int(mm.group(2)))))
            i += 3
        else:
            i += 1
    date_words.sort(key=lambda d: d[0])
    print_date = date_words[0][1] if date_words else None
    monitoring_date = date_words[1][1] if len(date_words) > 1 else None

    # 作成者: 「作成者」ラベルと同じ行の右側 (要介護度/利用者名と同じ形)
    assessor = None
    for row in rows:
        texts = [w["text"] for w in row]
        if "作成者" in texts:
            idx = texts.index("作成者")
            assessor = "".join(texts[idx + 1: idx + 3]).strip() or None
            break

    return {
        "care_level": care_level,
        "name": name,
        "office": office,
        "assessor_name": assessor,
        "monitoring_date": monitoring_date,
        "print_date": print_date,
    }


def extract_items(words):
    """1ページぶんの item ブロックを切り出す"""
    import re
    rows = cluster_rows(words)
    items = []
    cur = None
    mode = None  # "top" (課題/短期目標/サービス内容) / "bottom" (実行確認〜対応)
    for row in rows:
        texts = [w["text"] for w in row]
        joined = "".join(texts)
        # ページ下部の "1 / 2" ページ番号を除外 (最終列にコメントとして混入するため)
        if re.fullmatch(r"\d+\s*/\s*\d+", joined.replace(" ", "")):
            continue
        if HEADER_A in texts or (HEADER_B in texts and HEADER_C in texts):
            if cur:
                items.append(cur)
            cur = {"kadai": "", "mokuhyou": "", "service": "", "jikkou": "", "houhou": "",
                   "kakuninbi": "", "honnin_lines": [], "kazoku_lines": [], "juusoku_lines": [], "taiou_lines": []}
            mode = "top"
            continue
        if HEADER_D in texts or HEADER_E in texts:
            mode = "bottom_header"
            continue
        if texts == ["実行確認", "確認方法", "確認期日", "本人", "家族"] or ("実行確認" in texts and "確認方法" in texts):
            mode = "bottom"
            continue
        if "総括" in texts or "再アセスメントの必要" in joined:
            break
        if cur is None:
            continue
        if mode == "top":
            for w in row:
                c = col_of(w["x0"], TOP_COLS)
                if c == "kadai":
                    cur["kadai"] += w["text"]
                elif c == "mokuhyou":
                    cur["mokuhyou"] += w["text"]
                elif c == "service":
                    cur["service"] += w["text"]
        elif mode == "bottom":
            for w in row:
                c = col_of(w["x0"], BOTTOM_COLS)
                if c == "jikkou":
                    cur["jikkou"] += w["text"]
                elif c == "houhou":
                    cur["houhou"] += w["text"]
                elif c == "kakuninbi":
                    cur["kakuninbi"] += w["text"]
                elif c == "honnin":
                    cur["honnin_lines"].append(w["text"])
                elif c == "kazoku":
                    cur["kazoku_lines"].append(w["text"])
                elif c == "juusoku":
                    cur["juusoku_lines"].append(w["text"])
                elif c == "taiou":
                    cur["taiou_lines"].append(w["text"])
    if cur:
        items.append(cur)

    out = []
    for it in items:
        user_eval, user_comment = split_eval_comment(it["honnin_lines"])
        family_eval, family_comment = split_eval_comment(it["kazoku_lines"])
        needs, needs_comment = split_eval_comment(it["juusoku_lines"])
        response, response_comment = split_eval_comment(it["taiou_lines"])
        out.append({
            "kadai": it["kadai"],
            "short_term_goal": it["mokuhyou"],
            "service_content": it["service"],
            "implementation_status": it["jikkou"],
            "confirmation_method": it["houhou"],
            "confirmation_date": it["kakuninbi"],
            "user_evaluation": user_eval,
            "user_comment": user_comment,
            "family_evaluation": family_eval,
            "family_comment": family_comment,
            "needs_fulfillment": needs,
            "needs_fulfillment_comment": needs_comment,
            "response": response,
            "response_comment": response_comment,
        })
    return out


def split_eval_comment(lines):
    """列の1行目=評価の選択肢・2行目以降=自由文コメント、という構造を分離する。

    ⚠ 既知の限界 (2026-09-14・実データで発覚): 評価の文言自体が折り返して2行に
      なることがある (「ある程度満足して」+「いる」)。一方で対応列の自由文コメントが
      「継続」のような短い1単語だけのこともある (「ケア継続」+コメント「継続」)。
      ★どちらも「短い2行目」という見た目は同じで、行の文字数だけでは区別できない。
      安全側 (継続の誤結合＝サイレントな値の破損) を優先し、★連結はしない
      (評価は1行目だけを取る。折り返しがあった場合は見た目どおり途切れて出る
      = 目視で気づける形にする)。連結が必要なら実データを見て個別に対応すること。
    """
    if not lines:
        return "", ""
    return lines[0], "".join(lines[1:])


def extract_summary(words, curves):
    """最終ページの 総括/計画の変更等/再アセスメントの必要 を取る"""
    rows = cluster_rows(words)
    soukatsu_top = None
    for row in rows:
        if "総括" in [w["text"] for w in row]:
            soukatsu_top = row[0]["top"]
            break
    if soukatsu_top is None:
        return {"summary": None, "plan_change": None, "reassessment_needed": None}

    reassess_top = None
    for row in rows:
        if any("再アセスメントの必要" in w["text"] for w in row):
            reassess_top = row[0]["top"]
            break

    # ⚠ 2026-09-14実測 (新井秀雄8/18分) で判明: 総括(左列)と計画の変更等(右列)は
    #   ラベルが x=207.4/537.7 でも、★本文の開始xは 62.6/381.4 で
    #   ラベルの位置とは大きくずれる。旧しきい値 x0<500 だと右列(381.4)まで
    #   左列に混入し、両列が行ごとに交互に連結されて読めない文字列になっていた
    #   (計画の変更等が空欄の1サンプルだけで検証していたため見つからなかった)。
    #   本文開始xの中間 (62.6と381.4の間) である 300 をしきい値にする。
    left_lines, right_lines = [], []
    for row in rows:
        if row[0]["top"] <= soukatsu_top:
            continue
        if reassess_top is not None and row[0]["top"] >= reassess_top - 2:
            break
        for w in row:
            (left_lines if w["x0"] < 300 else right_lines).append(w["text"])
    summary = "".join(left_lines) or None
    plan_change = "".join(right_lines) or None

    reassessment = None
    if reassess_top is not None:
        ari = next((w for row in rows for w in row if w["text"] == "あり" and abs(w["top"] - reassess_top) < 3), None)
        nashi = next((w for row in rows for w in row if w["text"] == "なし" and abs(w["top"] - reassess_top) < 3), None)
        for c in curves:
            cx0, cx1, ctop = c["x0"], c["x1"], c["top"]
            if abs(ctop - reassess_top) > 20:
                continue
            if ari and cx0 <= ari["x0"] < cx1:
                reassessment = "あり"
                break
            if nashi and cx0 <= nashi["x0"] < cx1:
                reassessment = "なし"
                break

    return {"summary": summary, "plan_change": plan_change, "reassessment_needed": reassessment}


def parse_one(path):
    with pdfplumber.open(path) as pdf:
        header = extract_header(pdf.pages[0].extract_words())
        items = []
        for pg in pdf.pages:
            items.extend(extract_items(pg.extract_words()))
        last = pdf.pages[-1]
        summary = extract_summary(last.extract_words(), last.curves)
    return {**header, "items": items, **summary, "source_file": path}


def main():
    files = sys.argv[1:]
    out = [parse_one(f) for f in files]
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
