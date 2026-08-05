# -*- coding: utf-8 -*-
"""ほのぼの 障害受給者証一覧表 (SGF0318P01) → shougai_import_<area>.json  **汎用版**

parse_shougai_goi.py (五井) のロジックをそのまま引数化したもの。
事業所ごとにファイルを増やさず、これ 1 本で全事業所を捌く。

  python migrations/parse_shougai_certs.py --area 木更津 \
      --office 木更津ムツミヘルパーステーション \
      --pdf 利用者データ/木更津/障害/木更津受給者証居宅介護.pdf \
      --pdf 利用者データ/木更津/障害/木更津受給者証同行援護.pdf \
      [--kihon 利用者データ/木更津/障害/木更津基本情報.pdf]

出力:
  migrations/shougai_import_<area>.json   { office, clients, stats, warnings }
  migrations/parse_report_<area>.txt      (人が読む検証用サマリ)

このレイアウトで踏んだ罠 ([[project_honobono_shougai_import]]):
  1. **利用者番号は 10 桁のこともある**。受給者証番号と桁数が同じなので
     「氏名 → 利用者番号 → 受給者証番号」の**並び**で切る (桁数で判別しない)。
  2. 事業種別行は 居宅介護が「〜事業【居宅介護】」なのに対し、重度訪問介護・同行援護の
     事業所エントリでは **サービス名だけの 1 行**になる (SERVICE_ONLY)。
  3. ヘッダ行は前後にスペースが付く (" 受給者証一覧表")。事業所名 (※〜) も毎ページ出る。
  4. 基本情報一覧表は **pdfplumber**、受給者証一覧表は **fitz**。
     fitz は 1 フィールド 1 行に分解するので基本情報の行パターンが取れない。
  5. 基本情報が無くても通す (生年月日は取れないが利用者番号で既存 clients に突合できる)。
"""
import argparse
import io
import json
import re
import unicodedata

import fitz

ERA = {"S": 1925, "H": 1988, "R": 2018}
ERA_FULL = {"M": 1867, "T": 1911, "S": 1925, "H": 1988, "R": 2018}
REF_DATE = "2026-06-30"  # この日を含む証を「現在有効」とする (令和8年6月請求)

HEADER = {
    "利用者番号", "利用者名", "期間", "メ　モ", "受給者証番号", "支給量等",
    "交付年月日", "受給者証一覧表",
    "都道府県(市)名", "事業種別（受給者証種別）",
}
DATE_ONLY = re.compile(r"^[SHR]\s*\d+/\s*\d+/\s*\d+$")
TEN_DIGIT = re.compile(r"^\d{10}$")
NUMERIC = re.compile(r"^[\d\s/]+$")
CITY_PAT = re.compile(r"^[^\s【】0-9]+[市町村区]$")
JIGYOU_PAT = re.compile(r"^(.+?事業)【(.+?)】\s*$")
SERVICE_ONLY = {"重度訪問介護", "同行援護", "行動援護", "居宅介護", "重度障害者等包括支援"}
# 基本情報一覧表の行。**利用者番号が空欄の事業所がある** (四街道) ので 2 パターン持つ。
#   A: "232 松戸 孝雄 男 S20/ 1/ 2 …"   利用者番号あり
#   B: "赤池晴子 女 S39/ 5/27 …"        利用者番号なし (氏名から始まる)
KIHON_ROW = re.compile(r"^(\d+)\s+(\S+?)\s+([男女])\s+([SHRTM]\s*\d+/\s*\d+/\s*\d+)")
KIHON_ROW_NONUM = re.compile(r"^(\S+?)\s+([男女])\s+([SHRTM]\s*\d+/\s*\d+/\s*\d+)")


def wareki(s, era=ERA):
    m = re.match(r"^([SHRTM])\s*(\d+)/\s*(\d+)/\s*(\d+)$", (s or "").strip())
    if not m or m.group(1) not in era:
        return None
    return f"{era[m.group(1)]+int(m.group(2)):04d}-{int(m.group(3)):02d}-{int(m.group(4)):02d}"


def norm(s):
    return unicodedata.normalize("NFKC", s or "").replace(" ", "").replace("　", "")


# 事業所名 (ページヘッダ)。改ページで途中から切れて「ーステーション四街道」のような
#   断片になり氏名と誤認されるので、事業所名の**部分文字列なら捨てる**。
OFFICE_NAME_NORM = ""

# 氏名に見えるが人ではない語。上限額管理事業所名が折り返すと氏名行に化ける
#   (高品「事業団 千葉ﾘﾊ 愛育園（短期入所」「業団 愛育園」)。
ORG_WORDS = re.compile(
    r"事業(所|団)|センター|ステーション|施設|法人|協会|会社|支援|ヘルパー|ケア|訪問|居宅|"
    r"[（(]|園$|荘$|苑$|会$"
)


def is_office_fragment(t):
    """ページヘッダの事業所名 (改頁で途中から切れた断片も含む) か。

    --office は「Hanaヘルパーステーション高品（身障）」のようにサービス種類が
    付くので、括弧より前の部分で部分一致を見る。

    ⚠ ここで ORG_WORDS を見てはいけない。is_header から呼ばれるため、
      「支援」を含む **【障害支援区分】…の支給量行までヘッダ扱いで捨てて**しまう
      (2026-08-05 に高品で発生。全員の支給量・利用者負担上限月額が空になった)。
      組織名の除外は氏名判定 (is_name_line) 側だけで行う。
    """
    n = norm(t)
    if not n:
        return False
    return bool(OFFICE_NAME_NORM) and len(n) >= 4 and n in OFFICE_NAME_NORM


def is_header(s):
    t = (s or "").strip()
    return (
        is_office_fragment(t)
        or (not t)
        or (t in HEADER)
        or t.startswith("令和")
        or bool(re.match(r"^\d+ / \d+$", t))
        or t.startswith("SGF")
        or t.startswith("※")
    )


def is_name_line(s):
    return (
        s
        and not is_header(s)
        and not DATE_ONLY.match(s)
        and not NUMERIC.match(s)
        # 支給量ブロックの折り返し行 (「額】0」「管理事業所】木更津ムツミ…」) を氏名と誤認しない。
        #   五井は【…】が 1 行に収まったが木更津は途中で折り返すので **】単独でも除外**する。
        and "【" not in s
        and "】" not in s
        and s != "～"
        and not CITY_PAT.match(s)
        and s not in SERVICE_ONLY
        # 上限額管理事業所名が折り返して氏名行に化けるのを弾く
        and not ORG_WORDS.search(norm(s))
    )


def is_user_number(s):
    """利用者番号らしい行。ページ番号 (3 / 14) を弾く"""
    t = (s or "").strip()
    return bool(NUMERIC.match(t)) and not is_header(t)


def is_person_start(lines, i):
    """人ブロックの開始判定。**利用者番号が空欄の事業所がある**ので 2 形を許す。

      A: 氏名 → 利用者番号 → 受給者証番号(10桁)   … 五井・木更津・姉ム・さつきが丘
      B: 氏名 → 受給者証番号(10桁) → 交付年月日   … 四街道 (利用者番号が空)

    事業所名 (木更津は ※ が付かない) や支給量の折り返しが氏名に見えてしまうので、
    後続の並びまで見て判定する。B で 3 行目の日付まで見るのは、
    【上限額管理事業所】の事業所名が折り返した直後に次の証の 10 桁番号が来る形を
    弾くため (木更津の「まくさ太陽介護センター」で誤検出した)。
    """
    if i + 2 >= len(lines) or not is_name_line(lines[i].strip()):
        return False
    a, b = lines[i + 1].strip(), lines[i + 2].strip()
    if is_user_number(a) and TEN_DIGIT.match(b):
        return True  # A
    return bool(TEN_DIGIT.match(a) and DATE_ONLY.match(b))  # B


def person_number(lines, i):
    """is_person_start の位置から (利用者番号, 次に読む行index) を返す"""
    a, b = lines[i + 1].strip(), lines[i + 2].strip()
    if is_user_number(a) and TEN_DIGIT.match(b):
        return a, i + 2          # A: 利用者番号を消費
    return None, i + 1           # B: 利用者番号は無い。次は受給者証番号


def parse_shikyuryo(raw):
    out = {}
    m = re.search(r"【障害支援区分】([０-９0-9一二三四五六]+|なし)", raw)
    if m:
        z = unicodedata.normalize("NFKC", m.group(1))
        kan = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6"}
        out["support_level"] = "非該当" if z == "なし" else ("区分" + kan.get(z, z))
    m = re.search(r"【所得区分】(\S+?)【", raw)
    if m:
        out["income_category"] = m.group(1)
    m = re.search(r"【利用者負担上限月額】([\d,]+)", raw)
    if m:
        out["payment_limit"] = int(m.group(1).replace(",", ""))
    qty = {}
    for sm in re.finditer(r"【([^】]+?)】(\d+)時間(\d+)分", raw):
        key = sm.group(1)
        if key in ("障害支援区分", "所得区分", "利用者負担上限月額"):
            continue
        qty[key] = {"hours": int(sm.group(2)), "minutes": int(sm.group(3))}
    for sm in re.finditer(r"【([^】]+?)】(\d+)回", raw):
        qty[sm.group(1)] = {"count": int(sm.group(2))}
    out["quantities"] = qty
    m = re.search(r"【上限額?管理事業所】(.+?)(?:【|$)", raw)
    if m:
        out["jogen_kanri_office"] = m.group(1).strip()
    if "【H30/4以降支給決定】" in raw:
        out["flag_h30_after"] = True
    return out


def load_kihon(paths, warnings):
    """基本情報一覧表 (任意)。norm(氏名) -> 生年月日ほか"""
    kihon = {}
    if not paths:
        return kihon
    import pdfplumber

    for kp in paths:
        with pdfplumber.open(kp) as pdf:
            lines = []
            for pg in pdf.pages:
                lines += (pg.extract_text() or "").split("\n")
        hit = 0
        for idx, line in enumerate(lines):
            t = line.strip()
            m = KIHON_ROW.match(t)
            if m:
                uno, nm, gender, bd = m.group(1), m.group(2), m.group(3), m.group(4)
            else:
                m2 = KIHON_ROW_NONUM.match(t)
                if not m2:
                    continue
                uno, nm, gender, bd = None, m2.group(1), m2.group(2), m2.group(3)
            hit += 1
            addr = lines[idx + 1].strip() if idx + 1 < len(lines) else ""
            am = re.match(r"^(\d{3}-\d{4}|-)\s*(.*)$", addr)
            kihon[norm(nm)] = {
                "user_number_kihon": uno,
                "gender": gender,
                "birth_date": wareki(bd, ERA_FULL),
                "postal_code": (am.group(1) if am and am.group(1) != "-" else None),
                "address": (am.group(2).strip() if am else None) or None,
            }
        if hit == 0:
            warnings.append(f"基本情報一覧表から 1 行も取れなかった: {kp}")
    return kihon


def parse(pdf_paths, kihon, warnings):
    clients, order = {}, []

    def get_client(uno, name):
        if uno not in clients:
            k = kihon.get(norm(name), {})
            if kihon and not k:
                warnings.append(f"基本情報一覧表に氏名なし (生年月日が取れない): {name} ({uno})")
            clients[uno] = {
                "user_number": uno, "name": name,
                "gender": k.get("gender"), "birth_date": k.get("birth_date"),
                "postal_code": k.get("postal_code"), "address": k.get("address"),
                "certs": [],
            }
            order.append(uno)
        elif clients[uno]["name"] != name:
            warnings.append(f"同一利用者番号 {uno} に別氏名: {clients[uno]['name']} / {name}")
        return clients[uno]

    for pdf_path in pdf_paths:
        doc = fitz.open(pdf_path)
        lines = []
        for pi in range(doc.page_count):
            lines += [l.rstrip() for l in doc[pi].get_text().split("\n")]

        i, n = 0, len(lines)
        cur = None
        before = len(order)
        while i < n:
            s = lines[i].strip()
            if is_header(s):
                i += 1
                continue
            if is_person_start(lines, i):
                uno, nxt = person_number(lines, i)
                nm = re.sub(r"\s+", " ", s).strip()
                # 利用者番号が無い事業所は氏名をキーにする (基本情報側も番号が空なので突合できる)
                cur = get_client(uno if uno else f"@{norm(nm)}", nm)
                i = nxt
                continue
            if cur is None:
                i += 1
                continue
            if TEN_DIGIT.match(s):
                cert_no = s
                i += 1
                dates = []
                while i < n and DATE_ONLY.match(lines[i].strip()):
                    dates.append(wareki(lines[i].strip()))
                    i += 1
                if i < n and lines[i].strip() == "～":
                    i += 1
                city = None
                if i < n and CITY_PAT.match(lines[i].strip()):
                    city = lines[i].strip()
                    i += 1
                jigyou = service = None
                if i < n:
                    t0 = lines[i].strip()
                    jm = JIGYOU_PAT.match(t0)
                    if jm:
                        jigyou, service = jm.group(1), jm.group(2)
                        i += 1
                    elif t0 in SERVICE_ONLY:
                        jigyou, service = t0, t0
                        i += 1
                raw = ""
                while i < n:
                    t = lines[i].strip()
                    if is_header(t):
                        i += 1
                        continue
                    if TEN_DIGIT.match(t) or is_person_start(lines, i):
                        break
                    if ("【" in t) or ("】" in t) or raw:
                        raw += t
                        i += 1
                        continue
                    break
                issue = period_end = period_start = None
                if len(dates) >= 3:
                    issue, period_end, period_start = dates[0], dates[1], dates[2]
                elif len(dates) == 2:
                    period_end, period_start = dates[0], dates[1]
                elif len(dates) == 1:
                    period_end = dates[0]
                if period_start and period_end and period_start > period_end:
                    period_start, period_end = period_end, period_start
                entry = {
                    "cert_number": cert_no, "issue_date": issue,
                    "period_start": period_start, "period_end": period_end,
                    "city": city, "jigyou": jigyou, "service": service,
                    "shikyuryo_raw": raw, "src": pdf_path.replace("\\", "/").split("/")[-1],
                }
                entry.update(parse_shikyuryo(raw))
                cur["certs"].append(entry)
                continue
            i += 1
        if len(order) == before:
            warnings.append(f"このファイルから新しい利用者が 1 人も増えなかった: {pdf_path}")

    return clients, order


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--area", required=True, help="出力ファイル名に使う識別子 (例: 木更津)")
    ap.add_argument("--office", default="", help="事業所名 (レポート表示用)")
    ap.add_argument("--pdf", action="append", required=True, help="受給者証一覧表 PDF (複数可)")
    ap.add_argument("--kihon", action="append", default=[], help="基本情報一覧表 PDF (任意・複数可)")
    args = ap.parse_args()

    global OFFICE_NAME_NORM
    # 括弧以降 (（身障）等のサービス種類) を落として比較する
    OFFICE_NAME_NORM = re.sub(r"[（(].*$", "", norm(args.office))
    warnings = []
    kihon = load_kihon(args.kihon, warnings)
    clients, order = parse(args.pdf, kihon, warnings)

    for uno in order:
        c = clients[uno]
        cur = [
            e for e in c["certs"]
            if e["period_start"] and e["period_end"] and e["period_start"] <= REF_DATE <= e["period_end"]
        ]
        if not cur and c["certs"]:
            best = max(c["certs"], key=lambda e: e["period_end"] or "")
            cur = [best]
            warnings.append(
                f"現在有効な受給者証なし: {c['name']} ({uno}) → 最新 {best['period_end']} を採用 (期限切れ)")
        seen, dedup = set(), []
        for e in cur:
            sig = (e["cert_number"], e["period_start"], e["period_end"], e.get("service"),
                   json.dumps(e.get("quantities", {}), ensure_ascii=False, sort_keys=True))
            if sig in seen:
                continue
            seen.add(sig)
            dedup.append(e)
        c["current_certs"] = dedup
        if not c["certs"]:
            warnings.append(f"受給者証 entry が 1 件も無い: {c['name']} ({uno})")

    client_list = [clients[k] for k in order]
    result = {
        "office": args.office or args.area,
        "area": args.area,
        "clients": client_list,
        "stats": {
            "pdf_files": len(args.pdf),
            "kihon_rows": len(kihon),
            "birth_date_missing": sum(1 for c in client_list if not c.get("birth_date")),
            "clients": len(client_list),
            "certs_total": sum(len(c["certs"]) for c in client_list),
            "current_certs": sum(len(c["current_certs"]) for c in client_list),
            "multi_current": sum(1 for c in client_list if len(c["current_certs"]) > 1),
        },
        "warnings": warnings,
    }
    out_json = f"migrations/shougai_import_{args.area}.json"
    io.open(out_json, "w", encoding="utf-8").write(json.dumps(result, ensure_ascii=False, indent=1))

    rep = io.StringIO()
    rep.write(f"=== {args.office or args.area} 障害受給者証 パース結果 ===\n")
    for k, v in result["stats"].items():
        rep.write(f"  {k}: {v}\n")
    rep.write(f"\n--- 利用者 {len(client_list)} 名 ---\n")
    for c in client_list:
        for e in c["current_certs"]:
            q = " ".join(f"{k}{v.get('hours', v.get('count'))}" for k, v in (e.get("quantities") or {}).items())
            rep.write(f"  {c['user_number']:>10} {c['name']:<12} {e['cert_number']} "
                      f"{e['period_start']}~{e['period_end']} {e.get('city') or '?'} "
                      f"[{e.get('service')}] {e.get('support_level') or ''} 上限{e.get('payment_limit')} {q}\n")
    if warnings:
        rep.write(f"\n--- warnings {len(warnings)} ---\n")
        for w in warnings:
            rep.write(f"  {w}\n")
    io.open(f"migrations/parse_report_{args.area}.txt", "w", encoding="utf-8").write(rep.getvalue())
    print(rep.getvalue()[:5000])


if __name__ == "__main__":
    main()
