"""障害 CSV の prefix ごとに代表的な service_name を 3 個ずつ表示"""
import csv, sys
sys.stdout.reconfigure(encoding="utf-8")

files = sys.argv[1:] or ["service_codes_shogai_part1.csv", "service_codes_shogai_part2.csv"]

from collections import defaultdict
by_cat = defaultdict(list)
for path in files:
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            by_cat[r["service_category"]].append(r["service_name"])

for k in sorted(by_cat):
    items = by_cat[k]
    print(f"{k}: {len(items)} 件 — samples: {', '.join(items[:3])}")
