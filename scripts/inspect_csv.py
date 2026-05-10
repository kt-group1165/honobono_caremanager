"""抽出した service_codes_zaitaku.csv の内容を確認"""
import csv, sys
sys.stdout.reconfigure(encoding="utf-8")

path = sys.argv[1] if len(sys.argv) > 1 else "service_codes_zaitaku.csv"

with open(path, encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

from collections import Counter
cats = Counter(r["service_category"] for r in rows)
print(f"=== {path} : {len(rows)} records ===\n")

print("=== カテゴリ別件数 ===")
for k, v in sorted(cats.items()):
    sample = next((r for r in rows if r["service_category"] == k), None)
    cat_name = sample["service_category_name"] if sample else "?"
    print(f"  {k} {cat_name}: {v}")

print("\n=== 各カテゴリ先頭 3 件 ===")
for cat in sorted(cats):
    print(f"\n--- {cat} ---")
    for s in [r for r in rows if r["service_category"] == cat][:3]:
        print(f"  {s['service_code']} | {s['service_name']} | unit={s['units']} | {s['unit_type']} | {s['calculation_type']}")
