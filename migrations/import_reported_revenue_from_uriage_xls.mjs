// ============================================================================
// 事業所の売上報告書 (Excel) から **予防プラン**と**その他収入**を取り込む
//
// ── なぜ Excel から入れるのか ──────────────────────────────────────────
//   当システムが実績から計算できるのは **要介護のケアプラン分**だけ。
//     予防プラン (介護予防支援)  地域包括からの委託。国保連を通らず包括から
//                                直接支払われるので請求データが当システムに無い
//     その他収入                  文書料・自費等。請求システムに乗らない
//   当面はここを報告書の数字で埋める (2026-08-31 user 判断)。
//
// ⚠ **システムが実績から計算した値ではない**。人が作った報告書の写しである。
//   だから別表 (kaigo_office_reported_revenue) に入れ、source に出典を必ず残す。
//   介護プラン分は入れない (当システムが伝送と 1 円一致で出せるため)。
//
//   読み元: 売上（事業所から）/<提供年月>/売上/<n 拠点名>/売上報告.xls
//   ⚠ Excel は python(xlrd) で読む。Node に xls リーダを足さない方針
//     (uriage-kyotaku-diff.mts と同じやり方)。
//
//   MONTH=2026-06 node migrations/import_reported_revenue_from_uriage_xls.mjs
//   MONTH=2026-06 node migrations/import_reported_revenue_from_uriage_xls.mjs --execute
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);
const YM = MONTH.replace("-", "");
const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SALES_DIR = path.join(ROOT, "売上（事業所から）", YM, "売上");

const env = {};
for (const l of readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

/**
 * 売上報告.xls を読む。列は月 (1月=B列=index 1 … 6月=index 6)。
 * ⚠ 予防プランの下にも「月遅れ 件数/総額」の行があり、**介護プランのそれと同じ label**。
 *   ラベルだけで引くと介護側を拾ってしまうので、「予防プラン総額」の行より
 *   **下にある**月遅れ行を予防の月遅れとする。
 */
function readReports() {
  const py = `
import xlrd, json, os, sys
base = sys.argv[1]; col = int(sys.argv[2]); year = sys.argv[3]
out = []
for d in sorted(os.listdir(base)):
    f = os.path.join(base, d, '売上報告.xls')
    if not os.path.exists(f): continue
    b = xlrd.open_workbook(f, encoding_override='cp932')
    tgt = [n for n in b.sheet_names() if year[-2:] in n]
    s = b.sheet_by_name(tgt[-1]) if tgt else b.sheet_by_index(len(b.sheet_names()) - 1)
    office = ''
    for r in range(3):
        for c in range(s.ncols):
            v = str(s.cell_value(r, c))
            if '事業所名' in v:
                office = v.split('事業所名')[-1].strip()
    def label(r):
        return str(s.cell_value(r, 0)).replace(' ', '').replace('　', '')
    def val(r):
        v = s.cell_value(r, col)
        return int(v) if isinstance(v, (int, float)) and v != '' else 0
    rows = {}
    yobo_row = None
    for r in range(s.nrows):
        if label(r) == '予防プラン総額':
            yobo_row = r
    for r in range(s.nrows):
        lab = label(r)
        if lab == '予防プラン件数': rows['yoboCount'] = val(r)
        elif lab == '予防プラン総額': rows['yoboAmount'] = val(r)
        elif lab == 'その他収入': rows['otherAmount'] = val(r)
        elif lab == '月遅れ件数' and yobo_row is not None and r > yobo_row: rows['yoboLateCount'] = val(r)
        elif lab == '月遅れ総額' and yobo_row is not None and r > yobo_row: rows['yoboLateAmount'] = val(r)
    rows['dir'] = d; rows['officeName'] = office
    out.append(rows)
print(json.dumps(out, ensure_ascii=False))
`;
  // ⚠ Windows の python は既定 cp932 で出力するので事業所名が壊れる。必ず明示する
  const raw = execFileSync("python", ["-c", py, SALES_DIR, String(M), String(Y)], {
    encoding: "utf8", maxBuffer: 1 << 24,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return JSON.parse(raw);
}

/**
 * 報告書のフォルダ名 → offices。事業所名セルが空だったり表記が違う拠点があるので、
 * 拠点名から一意に決まらないものは **明示する**。推測に頼らない。
 */
const AREA_TO_OFFICE = {
  "姉ム": "ムツミ居宅介護支援事業所",
  "袖ム": "袖ヶ浦ムツミ居宅支援センター",
  "花見川": "ケアプランＨａｎａ",
  "五井": "ケイ・ティ・サービス居宅介護支援事業所",
  "ＫＴ姉崎": "ＫＴ在宅サポートセンター",
  "茂原": "リンクス居宅介護支援事業所",
};

/** 報告書のフォルダ名 (「9 ＫＴ姉崎」) → offices の居宅事業所 */
function matchOffice(dir, officeName, offices) {
  const norm = (s) => (s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  const area = norm(dir).replace(/^\d+/, "");
  // ⚠ NFKC で「ＫＴ姉崎」→「KT姉崎」になるので、対応表のキーも同じように寄せる
  const explicit = Object.entries(AREA_TO_OFFICE).find(([k]) => norm(k) === area)?.[1];
  if (explicit) {
    const hit = offices.find((o) => norm(o.name) === norm(explicit));
    if (hit) return hit;
  }
  const byName = offices.find((o) => norm(o.name) === norm(officeName));
  if (byName) return byName;
  // 報告書の事業所名が空/表記ゆれのときは拠点名で部分一致
  const hits = offices.filter((o) => norm(o.name).includes(area) || area.includes(norm(o.name)));
  return hits.length === 1 ? hits[0] : null;
}

async function main() {
  console.log(`=== 報告書から 予防プラン・その他収入 を取込 ${MONTH} ${EXECUTE ? "【本番】" : "【DRY RUN】"} ===\n`);
  console.log(`  ⚠ これはシステムの計算値ではなく **事業所の報告書 (Excel) の写し**です\n`);
  if (!existsSync(SALES_DIR)) { console.error(`✗ ${SALES_DIR} がありません`); process.exit(1); }

  const reports = readReports();
  const { data: offices, error } = await sb.from("offices")
    .select("id, name, service_type").eq("tenant_id", TENANT).eq("service_type", "居宅介護支援");
  if (error) { console.error(`✗ 事業所取得失敗: ${error.message}`); process.exit(1); }

  const rows = [];
  const problems = [];
  for (const r of reports) {
    const off = matchOffice(r.dir, r.officeName, offices ?? []);
    if (!off) { problems.push(`${r.dir} (${r.officeName || "事業所名なし"}): offices に引けない`); continue; }
    const put = (category, amount, count) => {
      if (!amount && !count) return;
      rows.push({
        tenant_id: TENANT, office_id: off.id, month: MONTH, category,
        amount: amount ?? 0, count: count ?? null,
        source: "事業所報告書(Excel)",
        source_file: `売上（事業所から）/${YM}/売上/${r.dir}/売上報告.xls`,
        notes: `${r.dir} — システムの実績から計算した値ではない`,
      });
    };
    put("予防プラン", r.yoboAmount, r.yoboCount);
    put("予防プラン月遅れ", r.yoboLateAmount, r.yoboLateCount);
    put("その他収入", r.otherAmount, null);
    console.log(`  ${r.dir.padEnd(12, "　").slice(0, 12)} ${off.name}`);
    console.log(`     予防 ${String(r.yoboAmount ?? 0).padStart(9)} 円 (${r.yoboCount ?? 0} 件)`
      + `  予防月遅れ ${String(r.yoboLateAmount ?? 0).padStart(7)} 円`
      + `  その他 ${String(r.otherAmount ?? 0).padStart(7)} 円`);
  }
  const sum = (c) => rows.filter((x) => x.category === c).reduce((s, x) => s + x.amount, 0);
  console.log(`\n  合計: 予防 ${sum("予防プラン").toLocaleString()} 円 / `
    + `予防月遅れ ${sum("予防プラン月遅れ").toLocaleString()} 円 / `
    + `その他 ${sum("その他収入").toLocaleString()} 円`);
  if (problems.length) {
    console.log(`\n  -- 引けないもの ${problems.length} 件 --`);
    for (const p of problems) console.log(`     ${p}`);
  }

  if (!EXECUTE) { console.log("\n※ DRY RUN。--execute で保存します。"); return; }

  const { error: eU } = await sb.from("kaigo_office_reported_revenue")
    .upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
            { onConflict: "office_id,month,category" });
  if (eU) { console.error(`✗ 保存失敗: ${eU.message}`); process.exit(1); }
  console.log(`\n✓ ${rows.length} 行を保存しました (source = 事業所報告書(Excel))`);
}

main();
