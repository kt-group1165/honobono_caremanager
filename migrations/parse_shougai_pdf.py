# -*- coding: utf-8 -*-
"""ほのぼの 障害受給者証一覧表 (SGF0318P01) + 基本情報CSV → shougai_import_<tag>.json

parse_shougai_oami.py (大網で確立) を env でマルチ事業所化したもの。
基本情報は法人共通 CSV (フリガナ・生年月日・住所) を氏名で引き、
受給者証 PDF の氏名ブロックと突合する。文字化けは端末表示だけ (fitz は正常 Unicode)。

env (未指定は大網デフォルト):
  SH_CSV          基本情報CSV パス           (default: 利用者データ/大網/基本情報_______.CSV)
  SH_PDF          受給者証一覧PDF パス         (default: 利用者データ/大網/大網受給者証.pdf)
  SH_OFFICE_NAME  PDFヘッダーの事業所名(skip用) (default: リンクス大網白里事業所)
  SH_OUT          出力JSON パス               (default: migrations/shougai_import_oami.json)
  SH_LABEL        office ラベル (json 内)      (default: リンクス大網白里事業所)
  SH_REF_DATE     現在有効判定の基準日          (default: 2026-06-30)

取込対象 = 基準日を含む有効証。無ければ最新1件 (期限切れ warning)。
"""
import re, io, json, csv, os, unicodedata

ERA = {"S": 1925, "H": 1988, "R": 2018}
REF_DATE = os.environ.get("SH_REF_DATE", "2026-06-30")
CSV_PATH = os.environ.get("SH_CSV", "利用者データ/大網/基本情報_______.CSV")
PDF_PATH = os.environ.get("SH_PDF", "利用者データ/大網/大網受給者証.pdf")
OFFICE_NAME = os.environ.get("SH_OFFICE_NAME", "リンクス大網白里事業所")
OUT_PATH = os.environ.get("SH_OUT", "migrations/shougai_import_oami.json")
LABEL = os.environ.get("SH_LABEL", OFFICE_NAME)


def wareki(s):
    m = re.match(r"^([SHR])\s*(\d+)/\s*(\d+)/\s*(\d+)$", (s or "").strip())
    if not m:
        return None
    e, y, mo, d = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    return f"{ERA[e]+y:04d}-{mo:02d}-{d:02d}"


def norm(s):
    return unicodedata.normalize("NFKC", s or "").replace(" ", "").replace("　", "")


def iso_ymd(s):
    m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", (s or "").strip())
    if not m:
        return None
    return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


# ---------------- 基本情報 CSV ----------------
rows = list(csv.reader(io.open(CSV_PATH, encoding="cp932")))
by_name = {}
for r in rows[1:]:
    if len(r) < 16:
        continue
    name = (r[3] or "").strip()
    if not name:
        continue
    furi_full = unicodedata.normalize("NFKC", ((r[4] or "") + (r[5] or "")).strip())
    d = {
        "user_number": (r[0] or "").strip() or None,
        "name": re.sub(r"\s+", " ", name).strip(),
        "furigana": furi_full or None,
        "gender": (r[8] or "").strip() or None,
        "birth_date": iso_ymd(r[11]),
        "postal_code": (r[12] or "").strip() or None,
        "address": (r[13] or "").strip() or None,
        "phone": (r[14] or "").strip() or None,
        "mobile": (r[15] or "").strip() or None,
    }
    by_name[norm(name)] = d
csvnames = set(by_name.keys())

# ---------------- 受給者証 PDF ----------------
import fitz
doc = fitz.open(PDF_PATH)
lines = []
for pi in range(doc.page_count):
    lines += [l.rstrip() for l in doc[pi].get_text().split("\n")]

HEADER = {
    "利用者番号", "利用者名", "期間", "メ　モ", "受給者証番号", "支給量等",
    "交付年月日", " 受給者証一覧表", OFFICE_NAME,
    "都道府県(市)名", "事業種別（受給者証種別）",
}


def is_header(s):
    return (not s) or (s in HEADER) or s.startswith("令和") \
        or bool(re.match(r"^\d+ / \d+$", s)) or s.startswith("SGF")


DATE_ONLY = re.compile(r"^[SHR]\s*\d+/\s*\d+/\s*\d+$")
TEN_DIGIT = re.compile(r"^\d{10}$")
CITY_PAT = re.compile(r"^[^\s【】0-9]+[市町村区]$")
JIGYOU_PAT = re.compile(r"^(.+?事業)【(.+?)】\s*$")

warnings = []
clients = {}
order = []


def get_client(nkey):
    if nkey not in clients:
        base = by_name.get(nkey)
        c = {
            "name_key": nkey,
            "user_number": base["user_number"] if base else None,
            "name": base["name"] if base else nkey,
            "furigana": base["furigana"] if base else None,
            "gender": base["gender"] if base else None,
            "birth_date": base["birth_date"] if base else None,
            "postal_code": base["postal_code"] if base else None,
            "address": base["address"] if base else None,
            "phone": base["phone"] if base else None,
            "mobile": base["mobile"] if base else None,
            "certs": [],
        }
        if base is None:
            warnings.append(f"CSV に基本情報なし (氏名紐付け不能): {nkey}")
        clients[nkey] = c
        order.append(nkey)
    return clients[nkey]


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


i = 0
n = len(lines)
cur_key = None
expect_userno = False
while i < n:
    s = lines[i].strip()
    if is_header(s):
        i += 1
        continue
    if norm(s) in csvnames and "【" not in s and not TEN_DIGIT.match(s):
        cur_key = norm(s)
        get_client(cur_key)
        expect_userno = True
        i += 1
        continue
    if cur_key is None:
        i += 1
        continue
    if expect_userno and TEN_DIGIT.match(s):
        expect_userno = False
        i += 1
        continue
    expect_userno = False
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
            jm = JIGYOU_PAT.match(lines[i].strip())
            if jm:
                jigyou, service = jm.group(1), jm.group(2)
                i += 1
        raw = ""
        while i < n:
            t = lines[i].strip()
            if is_header(t):
                i += 1
                continue
            if TEN_DIGIT.match(t) or (norm(t) in csvnames and "【" not in t):
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
            "cert_number": cert_no,
            "issue_date": issue,
            "period_start": period_start,
            "period_end": period_end,
            "city": city,
            "jigyou": jigyou,
            "service": service,
            "shikyuryo_raw": raw,
        }
        entry.update(parse_shikyuryo(raw))
        clients[cur_key]["certs"].append(entry)
        continue
    i += 1

for nkey in order:
    c = clients[nkey]
    cur = [e for e in c["certs"]
           if e["period_start"] and e["period_end"]
           and e["period_start"] <= REF_DATE <= e["period_end"]]
    if not cur and c["certs"]:
        best = max(c["certs"], key=lambda e: e["period_end"] or "")
        cur = [best]
        warnings.append(
            f"現在有効な受給者証なし: {c['name']} → 最新 {best['period_end']} を採用 (期限切れ)")
    seen_sig = set()
    dedup = []
    for e in cur:
        sig = (e["cert_number"], e["period_start"], e["period_end"], e.get("service"),
               json.dumps(e.get("quantities", {}), ensure_ascii=False, sort_keys=True))
        if sig in seen_sig:
            warnings.append(
                f"重複証を畳んだ: {c['name']} cert={e['cert_number']} "
                f"{e['period_start']}~{e['period_end']} ({e.get('jigyou')})")
            continue
        seen_sig.add(sig)
        dedup.append(e)
    c["current_certs"] = dedup
    if not c["certs"]:
        warnings.append(f"受給者証 entry が 1 件も無い: {c['name']} ({c['user_number']})")

client_list = [clients[k] for k in order]
result = {
    "office": LABEL,
    "clients": client_list,
    "stats": {
        "client_count": len(client_list),
        "total_cert_entries": sum(len(c["certs"]) for c in client_list),
        "clients_with_current": sum(1 for c in client_list if c.get("current_certs")),
    },
    "warnings": warnings,
}
with io.open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=1, default=str)

report_path = OUT_PATH.replace(".json", "_report.txt")
with io.open(report_path, "w", encoding="utf-8") as f:
    f.write(f"office={LABEL}  csv={CSV_PATH}  pdf={PDF_PATH}  ref={REF_DATE}\n")
    f.write(json.dumps(result["stats"], ensure_ascii=False, indent=1) + "\n\nWARNINGS:\n")
    for w in warnings:
        f.write("  - " + w + "\n")
    f.write("\n--- 現在有効受給者証 (取込対象) ---\n")
    for c in client_list:
        f.write(f"\n{c['user_number'] or '(番号なし)'} {c['name']}  生{c['birth_date']}  {c['furigana']}\n")
        for e in c.get("current_certs", []):
            q = json.dumps(e.get("quantities", {}), ensure_ascii=False)
            f.write(f"   cert={e['cert_number']} {e['period_start']}~{e['period_end']} "
                    f"{e.get('support_level','?')} {e.get('jigyou')}[{e.get('service')}] {e['city']} "
                    f"所得={e.get('income_category')} 上限={e.get('payment_limit')} 量={q}\n")
print("done: %d clients, %d cert entries -> %s" % (
    result["stats"]["client_count"], result["stats"]["total_cert_entries"], OUT_PATH))
