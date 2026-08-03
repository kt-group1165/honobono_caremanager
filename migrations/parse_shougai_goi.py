# -*- coding: utf-8 -*-
"""ほのぼの 障害受給者証 (五井 = ＫＴ五井ヘルパーステーション) → shougai_import_goi.json

入力 (SGF0318P01 受給者証一覧表。サービス種類ごとに事業所エントリが分かれている):
  利用者データ/五井/五井受給者証１.pdf          (19p / 居宅介護)
  利用者データ/五井/五井受給者証2重度.pdf        ( 4p / 重度訪問介護)
  利用者データ/五井/五井受給者証3同公園後.pdf     ( 7p / 同行援護ほか)

出力:
  migrations/shougai_import_goi.json   { clients:[...], stats:{...}, warnings:[...] }
  migrations/parse_report_goi.txt      (人が読む検証用サマリ)

大網版 (parse_shougai_oami.py) との違い:
  - **基本情報 CSV が無い**。氏名 → 利用者番号 → 受給者証番号 の**並び**で人ブロックを切る。
    生年月日・住所は取れないが、利用者番号で既存 clients に突合できるので実害なし
    ([[project_honobono_shougai_import]] の「名前ベース紐付けの弱点」を番号突合で回避)。
  - 3 ファイルを結合して 1 人にまとめる (同一人物が居宅介護と同行援護の両方を持つことがある)。

このレイアウトで踏んだ罠 (他事業所でも同じはず):
  1. **利用者番号は 10 桁のこともある** (井口恵子 = 2113113362)。受給者証番号と同じ桁数なので
     桁数で区別してはいけない。氏名行の直後の 1 行が利用者番号、という位置で決める。
  2. 事業種別行は 居宅介護が「〜事業【居宅介護】」なのに対し、**重度訪問介護・同行援護の
     事業所エントリではサービス名だけの 1 行**になる (SERVICE_ONLY)。
  3. ヘッダ行は前後にスペースが付く (" 受給者証一覧表")。事業所名 (※〜) も毎ページ出る。

python migrations/parse_shougai_goi.py
"""
import re, io, json, unicodedata
import fitz

ERA = {"S": 1925, "H": 1988, "R": 2018}
REF_DATE = "2026-06-30"  # この日を含む証を「現在有効」とする (令和8年6月請求)

PDFS = [
    "利用者データ/五井/五井受給者証１.pdf",
    "利用者データ/五井/五井受給者証2重度.pdf",
    "利用者データ/五井/五井受給者証3同公園後.pdf",
]


def wareki(s):
    m = re.match(r"^([SHR])\s*(\d+)/\s*(\d+)/\s*(\d+)$", (s or "").strip())
    if not m:
        return None
    e, y, mo, d = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    return f"{ERA[e]+y:04d}-{mo:02d}-{d:02d}"


def norm(s):
    return unicodedata.normalize("NFKC", s or "").replace(" ", "").replace("　", "")


HEADER = {
    "利用者番号", "利用者名", "期間", "メ　モ", "受給者証番号", "支給量等",
    "交付年月日", "受給者証一覧表",
    "都道府県(市)名", "事業種別（受給者証種別）",
}


def is_header(s):
    # ヘッダ行は前後に半角/全角スペースが付くことがあるので strip して比較する。
    # 事業所名 (※ＫＴ五井ヘルパーステーション / (重度) (同行) 付き) もページ毎に出るヘッダ。
    t = (s or "").strip()
    return (not t) or (t in HEADER) or t.startswith("令和") \
        or bool(re.match(r"^\d+ / \d+$", t)) or t.startswith("SGF") \
        or t.startswith("※")


DATE_ONLY = re.compile(r"^[SHR]\s*\d+/\s*\d+/\s*\d+$")
TEN_DIGIT = re.compile(r"^\d{10}$")
NUMERIC = re.compile(r"^[\d\s/]+$")  # 番号・ページ番号など数字だけの行
CITY_PAT = re.compile(r"^[^\s【】0-9]+[市町村区]$")
# 事業種別（受給者証種別）行。居宅介護は「〜事業【居宅介護】」だが、
#   重度訪問介護・同行援護の事業所エントリでは **サービス名だけの 1 行** になる。
JIGYOU_PAT = re.compile(r"^(.+?事業)【(.+?)】\s*$")
SERVICE_ONLY = {"重度訪問介護", "同行援護", "行動援護", "居宅介護", "重度障害者等包括支援"}


def is_name_line(s):
    """氏名行の判定。
    ⚠ **利用者番号は 10 桁のこともある** (井口恵子=2113113362) ので、桁数で
    受給者証番号と区別してはいけない。氏名 → 利用者番号 → 受給者証番号 の**並び**で決める。
    ヘッダ・日付・市町村・事業種別【…】・～・数字だけの行 を除いた残りが氏名行。
    """
    return (
        s
        and not is_header(s)
        and not DATE_ONLY.match(s)
        and not NUMERIC.match(s)
        and "【" not in s
        and s != "～"
        and not CITY_PAT.match(s)
        and s not in SERVICE_ONLY
    )


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


warnings = []
clients = {}  # user_number -> client dict
order = []


def get_client(uno, name):
    if uno not in clients:
        clients[uno] = {"user_number": uno, "name": name, "certs": []}
        order.append(uno)
    elif clients[uno]["name"] != name:
        warnings.append(f"同一利用者番号 {uno} に別氏名: {clients[uno]['name']} / {name}")
    return clients[uno]


for pdf_path in PDFS:
    doc = fitz.open(pdf_path)
    lines = []
    for pi in range(doc.page_count):
        lines += [l.rstrip() for l in doc[pi].get_text().split("\n")]

    i, n = 0, len(lines)
    cur = None
    while i < n:
        s = lines[i].strip()
        if is_header(s):
            i += 1
            continue
        # 氏名行 → 直後の 1 行が利用者番号 (桁数を問わない)
        if is_name_line(s):
            if i + 1 < n and NUMERIC.match(lines[i + 1].strip()):
                cur = get_client(lines[i + 1].strip(), re.sub(r"\s+", " ", s).strip())
                i += 2
            else:
                warnings.append(f"氏名行の直後に利用者番号が無い: {s!r} (行 {i})")
                i += 1
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
                    # 重度訪問介護・同行援護のエントリはサービス名だけの行
                    jigyou, service = t0, t0
                    i += 1
            raw = ""
            while i < n:
                t = lines[i].strip()
                if is_header(t):
                    i += 1
                    continue
                if TEN_DIGIT.match(t):
                    break
                if is_name_line(t):
                    break  # 次の人の氏名行
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
                "shikyuryo_raw": raw, "src": pdf_path.split("/")[-1],
            }
            entry.update(parse_shikyuryo(raw))
            cur["certs"].append(entry)
            continue
        i += 1

# ---------------- current_certs 判定 ----------------
for uno in order:
    c = clients[uno]
    cur = [e for e in c["certs"]
           if e["period_start"] and e["period_end"]
           and e["period_start"] <= REF_DATE <= e["period_end"]]
    if not cur and c["certs"]:
        best = max(c["certs"], key=lambda e: e["period_end"] or "")
        cur = [best]
        warnings.append(
            f"現在有効な受給者証なし: {c['name']} ({uno}) → 最新 {best['period_end']} を採用 (期限切れ)")
    # 同一受給者証番号・同一期間・同一支給量の重複 (事業種別ラベル違いの二重印字) を畳む
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
    "office": "ＫＴ五井ヘルパーステーション",
    "clients": client_list,
    "stats": {
        "pdf_files": len(PDFS),
        "clients": len(client_list),
        "certs_total": sum(len(c["certs"]) for c in client_list),
        "current_certs": sum(len(c["current_certs"]) for c in client_list),
        "multi_current": sum(1 for c in client_list if len(c["current_certs"]) > 1),
    },
    "warnings": warnings,
}
io.open("migrations/shougai_import_goi.json", "w", encoding="utf-8").write(
    json.dumps(result, ensure_ascii=False, indent=1))

# 人が読む検証用サマリ
rep = io.StringIO()
rep.write(f"=== 五井 障害受給者証 パース結果 ===\n")
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
io.open("migrations/parse_report_goi.txt", "w", encoding="utf-8").write(rep.getvalue())
print(rep.getvalue()[:4000])
