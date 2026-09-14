#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ほのぼの「サービス担当者会議の要点」(第4表) PDF を JSON にする。

  python migrations/_parse_meeting_record_pdf.py <file...>

── 座標で分かったこと (2026-09-14・実PDF1件で確認) ──────────────────────────
  ・作成年月日と印刷日が両方出る (モニタリングと同じ罠。1回目=作成年月日、
    2回目=ページ最上部の印刷日)。
  ・「検討内容」欄が「別紙参照」になっており、★本文は2ページ目の
    「結論　別紙1」以降に流れる。1ページ目だけでは検討内容の本文が取れない。
  ・「結論」も1ページ目(短い結び)と2ページ目(別紙1、詳細)の両方にまたがる。
    ★このparserは両方を連結してconclusionとして出す。
  ・会議出席者は「所属（職種）」「氏名」のペアが横に最大3組並ぶ表だが、
    ★1人の氏名が複数語(姓・名・様)に分かれて印字され、語間の間隔だけでは
    セルの境界を安定して判定できなかった(実測1件では所属セルと氏名セルの
    語間隔が近い値になり、閾値で綺麗に割れない)。
    ⚠ 無理に構造化せず、★会議出席者ブロックの行ごとの生テキストをそのまま
    attendees_raw (文字列の配列) として出す。所属/氏名への分解が必要になれば
    実PDFをもっと集めてから判断する (2026-09-14時点は参照されていない=
    未実装のほうが安全という判断)。
"""
import sys
import json
import re
import pdfplumber


def wareki_to_iso(era_year: int, month: int, day: int) -> str:
    return f"{2018 + era_year:04d}-{month:02d}-{day:02d}"


def cluster_rows(words, tol=2.5):
    rows = []
    for w in sorted(words, key=lambda w: w["top"]):
        if rows and abs(rows[-1][0]["top"] - w["top"]) <= tol:
            rows[-1].append(w)
        else:
            rows.append([w])
    for r in rows:
        r.sort(key=lambda w: w["x0"])
    return rows


def row_text(row):
    return "".join(w["text"] for w in row)


def find_dates(rows):
    """令和年月日を出現順(top昇順)に全部拾う。1つ目=作成年月日、2つ目=印刷日"""
    flat = [w for row in rows for w in row]
    flat.sort(key=lambda w: (w["top"], w["x0"]))
    dates = []
    i = 0
    while i < len(flat):
        if flat[i]["text"] == "令和" and i + 2 < len(flat):
            my = re.match(r"(\d+)年", flat[i + 1]["text"])
            md = re.match(r"(\d+)月(\d+)日", flat[i + 2]["text"])
            if my and md:
                dates.append((flat[i]["top"], wareki_to_iso(int(my.group(1)), int(md.group(1)), int(md.group(2)))))
            i += 3
        else:
            i += 1
    dates.sort(key=lambda d: d[0])
    return dates


def value_after_label(rows, label, max_tokens=6):
    """ラベルと同じ行の右側にある値を返す (要介護度/利用者名と同じ形の項目用)"""
    for row in rows:
        texts = [w["text"] for w in row]
        if label in texts:
            idx = texts.index(label)
            return "".join(texts[idx + 1: idx + 1 + max_tokens]).strip()
    return None


def find_row_index(rows, predicate):
    for i, row in enumerate(rows):
        if predicate(row):
            return i
    return None


def extract_section(rows, start_label, end_predicate, skip_rows_after_label=0):
    """
    start_labelを含む行から end_predicate が真になる行の手前までを連結して返す。
    ⚠ ラベルとセクション本文の1行目が★同じ行にクラスタリングされることがある
    (フォントのベースライン差でtopが0.5〜1ptずれ、行のグルーピング許容誤差に
    収まってしまうため。実データで発覚)。ラベル語より★右側の残りをまず
    1行目として拾い、それから次の行以降を通常どおり連結する。
    """
    start_idx = find_row_index(rows, lambda row: start_label in [w["text"] for w in row])
    if start_idx is None:
        return None
    label_row = rows[start_idx]
    texts = [w["text"] for w in label_row]
    label_idx = texts.index(start_label)
    lines = []
    trailing = "".join(texts[label_idx + 1:]).strip()
    if trailing:
        lines.append(trailing)
    for row in rows[start_idx + 1 + skip_rows_after_label:]:
        if end_predicate(row):
            break
        t = row_text(row).strip()
        if t:
            lines.append(t)
    return "\n".join(lines) if lines else None


def parse_page0(rows):
    out = {}
    out["office"] = None
    for row in rows:
        for w in row:
            if w["text"].startswith("*"):
                out["office"] = w["text"][1:]

    dates = find_dates(rows)
    out["print_date"] = dates[0][1] if dates else None
    out["created_date"] = dates[1][1] if len(dates) > 1 else None

    out["client_name"] = value_after_label(rows, "利用者名", max_tokens=2)
    out["creator_name"] = value_after_label(rows, "居宅サービス計画作成者(担当者)氏名", max_tokens=2)
    out["meeting_date"] = None
    for row in rows:
        texts = [w["text"] for w in row]
        if "開催日" in texts:
            idx = texts.index("開催日")
            my = re.match(r"(\d+)年", texts[idx + 2]) if idx + 2 < len(texts) else None
            md = re.match(r"(\d+)月(\d+)日", texts[idx + 3]) if idx + 3 < len(texts) else None
            if my and md:
                out["meeting_date"] = wareki_to_iso(int(my.group(1)), int(md.group(1)), int(md.group(2)))
    out["meeting_place"] = value_after_label(rows, "開催場所", max_tokens=3)
    out["meeting_time"] = value_after_label(rows, "開催時間", max_tokens=1)
    out["meeting_count"] = value_after_label(rows, "開催回数", max_tokens=2)

    # 会議出席者ブロック: ラベル行自体が列見出し(所属/氏名)まで同じ行にクラスタ
    # されている (実測で確認)。ラベル行の直後 (skip_rows_after_label=0) から
    # 「検討した項目」の前まで。
    att_idx = find_row_index(rows, lambda row: "会議出席者" in [w["text"] for w in row])
    di_idx = find_row_index(rows, lambda row: "検討した項目" in [w["text"] for w in row])
    attendees_raw = []
    if att_idx is not None and di_idx is not None:
        for row in rows[att_idx + 1:di_idx]:
            t = row_text(row).strip()
            if t:
                attendees_raw.append(t)
    out["attendees_raw"] = attendees_raw

    def is_page_number(row):
        t = row_text(row).strip().replace(" ", "")
        return bool(re.fullmatch(r"\d+/\d+", t))

    out["discussed_items"] = extract_section(
        rows, "検討した項目", lambda row: "検討内容" in [w["text"] for w in row])
    out["discussion_content_page0"] = extract_section(
        rows, "検討内容", lambda row: row_text(row).strip() == "結論")
    out["conclusion_page0"] = extract_section(
        rows, "結論", lambda row: "残された課題" in [w["text"] for w in row])
    out["remaining_issues"] = extract_section(
        rows, "残された課題", is_page_number)

    return out


def parse_appendix_page(rows):
    """3ページ目以降の別紙ページ1枚を読む。

    ⚠ 2026-09-14実測 (秋葉法昌 8/19分、3ページ構成) で判明: 別紙は
    **1件とは限らず、検討内容用と結論用が別々のページに分かれることがある**。
    各ページ先頭に「検討内容　別紙1」または「結論　別紙1」という自己ラベルが
    付き、★どちらの欄の別紙かはこのラベルで判別できる (中身では判別できない)。
    以前は「別紙は必ず結論の別紙」と決め打ちしていたが誤りだった。

    「検討内容」「結論」という語が本文中に**2回**出る: ①ページ上部の自己ラベル
    (「別紙1」も同じ行) ②本文が始まる行 (ラベル＋本文の1行目が同じ行に
    クラスタされている・実測で確認)。①をスキップして②から trailing-text
    方式で拾う。

    @returns (target, text) target は "discussion_content" | "conclusion" | None
    """
    def is_page_number(row):
        return bool(re.fullmatch(r"\d+/\d+", row_text(row).strip().replace(" ", "")))

    def find_body(label):
        label_rows = [i for i, row in enumerate(rows) if label in [w["text"] for w in row]]
        return next((i for i in label_rows if "別紙1" not in [w["text"] for w in rows[i]]), None)

    self_label_row = next((row for row in rows if "別紙1" in [w["text"] for w in row]), None)
    self_label_texts = [w["text"] for w in self_label_row] if self_label_row else []

    if "検討内容" in self_label_texts:
        target = "discussion_content"
        label = "検討内容"
    elif "結論" in self_label_texts:
        target = "conclusion"
        label = "結論"
    else:
        return None, ""  # 未知の自己ラベル。中身では判別しない (推測しない)

    body_idx = find_body(label)
    if body_idx is None:
        return target, ""
    return target, extract_section(rows[body_idx:], label, is_page_number) or ""


def parse_one(path):
    with pdfplumber.open(path) as pdf:
        rows0 = cluster_rows(pdf.pages[0].extract_words())
        header = parse_page0(rows0)
        appendices = {"discussion_content": None, "conclusion": None}
        unknown_appendix_pages = 0
        for page in pdf.pages[1:]:
            rows = cluster_rows(page.extract_words())
            target, text = parse_appendix_page(rows)
            if target is None:
                unknown_appendix_pages += 1
                continue
            appendices[target] = ((appendices[target] or "") + "\n" + text).strip() if appendices[target] else text

    # 本文欄が「別紙参照」のときは、対応する自己ラベルの別紙ページの中身を連結する。
    # 別紙が無い/自己ラベルが読めないときは「別紙参照」という原文のまま残す
    # (中身を無理に埋めない)。
    discussion_content = header.pop("discussion_content_page0")
    if appendices["discussion_content"]:
        discussion_content = ((discussion_content or "") + "\n" + appendices["discussion_content"]).strip()
    conclusion = header.pop("conclusion_page0") or ""
    if appendices["conclusion"]:
        conclusion = (conclusion + "\n" + appendices["conclusion"]).strip()

    return {
        **header,
        "discussion_content": discussion_content,
        "conclusion": conclusion or None,
        "unknown_appendix_pages": unknown_appendix_pages,
        "source_file": path,
    }


def main():
    files = sys.argv[1:]
    out = [parse_one(f) for f in files]
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
