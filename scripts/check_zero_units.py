"""units=0 になっているコードの分布と内容を確認"""
import csv, sys
from collections import Counter, defaultdict
sys.stdout.reconfigure(encoding="utf-8")

for path in sys.argv[1:] or ["service_codes_zaitaku.csv", "service_codes_shogai.csv"]:
    print(f"\n========== {path} ==========")
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    total = len(rows)
    zeros = [r for r in rows if r["units"] == "0"]
    print(f"total: {total}  units=0: {len(zeros)} ({100*len(zeros)/total:.1f}%)")
    by_cat = Counter(r["service_category"] for r in zeros)
    print("--- units=0 by category ---")
    for k, v in sorted(by_cat.items(), key=lambda kv: -kv[1])[:15]:
        sample = next(r for r in zeros if r["service_category"] == k)
        print(f"  cat={k} ({sample['service_category_name']}): {v} 件  ex: {sample['service_code']} {sample['service_name']}")
