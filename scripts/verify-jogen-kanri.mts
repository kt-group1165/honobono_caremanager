/**
 * 利用者負担上限額管理 の検算ハーネス (READ ONLY — DB 書込なし)
 *
 *   npx tsx scripts/verify-jogen-kanri.mts
 *
 * seed_fake_jogen_kanri_test.mjs が投入したテストデータに対して
 *   ① aggregateMonthlyShogaiSeikyu の 利用者負担額 / 給付費請求額
 *   ② buildShogaiDensou の J121 明細書 (項12/15/16/17/22/25/26/27/28) と J411
 * を、手計算した期待値と突合する。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { aggregateMonthlyShogaiSeikyu, type ShogaiSeikyuRow } from "@/lib/shogai-seikyu/aggregate";
import {
  buildShogaiDensou,
  type ShogaiDensouUser,
  type ShogaiDensouVisit,
  type ShogaiDensouKanriLine,
} from "@/lib/shogai-densou/build";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(__dirname, "..", "migrations", "_fake_jogen_test_manifest.json");
// ⚠ ★ この harness は seed → verify → delete の 一巡が前提。
//   delete が manifest を `_fake_jogen_test_manifest.deleted.json` にリネームするので、
//   ★ 一巡した後に verify 単体を回すと manifest が無く ENOENT で crash していた
//   (2026-09-05 に K が発見。★ 私が一巡後の状態のまま commit したのが原因)。
//   → ★ crash ではなく 何をすればよいかを出して 正常終了する。
//   ★ 「サンプルが無い状態で PASS を出す」ことはしない (exit 0 だが PASS とも言わない)。
if (!existsSync(MANIFEST)) {
  console.log("★ サンプル未投入のため スキップします (合格でも不合格でもありません)");
  console.log(`   manifest が見つかりません: ${MANIFEST}`);
  if (existsSync(`${MANIFEST.slice(0, -5)}.deleted.json`)) {
    console.log("   ★ .deleted.json はあります = 一度 seed → verify → delete を回した後の状態です");
  }
  console.log("   回すには:");
  console.log("     node migrations/seed_fake_jogen_kanri_test.mjs            # DRY RUN");
  console.log("     node migrations/seed_fake_jogen_kanri_test.mjs --execute  # ★ DB 書換");
  console.log("     npx tsx scripts/verify-jogen-kanri.mts");
  console.log("     node migrations/delete_fake_jogen_kanri_test.mjs --execute");
  process.exit(0);
}
const man = JSON.parse(readFileSync(MANIFEST, "utf8"));
const YEAR = Number(man.month.slice(0, 4));
const MONTH = Number(man.month.slice(5, 7));
const UNIT_PRICE: number = man.unit_price;
const OFFICE1 = man.offices[0];
const OFFICE2 = man.offices[1];

const rawEnv = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
const env: Record<string, string> = {};
for (const line of rawEnv.split("\n")) {
  const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
  if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ─── 手計算した期待値 ─────────────────────────────────────────────────────────
interface Expect {
  tag: string;
  office: 1 | 2;
  units: number;
  total: number;
  ichiwari: number;
  limit: number;
  kanriResult: number | null;
  /** 期待する 利用者負担額 */
  user: number;
  /** 期待する 給付費請求額 */
  benefit: number;
  /** 管理結果が未入力だった場合の 利用者負担額 (過大請求の比較用) */
  userIfMissing: number;
  note: string;
}
const EXPECT: Expect[] = [
  { tag: "A", office: 1, units: 5120, total: 51200, ichiwari: 5120, limit: 4600, kanriResult: 2, user: 4600, benefit: 46600, userIfMissing: 4600, note: "① 自事業所・単独 / 区分2 = 調整なし" },
  { tag: "B", office: 1, units: 1280, total: 12800, ichiwari: 1280, limit: 9300, kanriResult: 3, user: 1280, benefit: 11520, userIfMissing: 1280, note: "② 自事業所・3事業所 按分 / 区分3" },
  { tag: "C", office: 1, units: 56580, total: 565800, ichiwari: 56580, limit: 37200, kanriResult: 3, user: 12000, benefit: 553800, userIfMissing: 37200, note: "③ 他事業所・入力済 区分3" },
  { tag: "D", office: 1, units: 12800, total: 128000, ichiwari: 12800, limit: 9300, kanriResult: null, user: 9300, benefit: 118700, userIfMissing: 9300, note: "④ 他事業所・未入力" },
  { tag: "E", office: 1, units: 6400, total: 64000, ichiwari: 6400, limit: 0, kanriResult: null, user: 0, benefit: 64000, userIfMissing: 0, note: "④ 他事業所・未入力 / 上限0円 (対照群)" },
  { tag: "F", office: 1, units: 7680, total: 76800, ichiwari: 7680, limit: 4600, kanriResult: 1, user: 0, benefit: 76800, userIfMissing: 4600, note: "③ 他事業所・入力済 区分1 (充当済)" },
  { tag: "G", office: 1, units: 56580, total: 565800, ichiwari: 56580, limit: 37200, kanriResult: 3, user: 20000, benefit: 545800, userIfMissing: 37200, note: "③ 他事業所・入力済 / 当社 甲事業所ぶん" },
  { tag: "G", office: 2, units: 9430, total: 94300, ichiwari: 9430, limit: 37200, kanriResult: 3, user: 8000, benefit: 86300, userIfMissing: 9430, note: "③ 他事業所・入力済 / 当社 乙事業所ぶん" },
];

const clientByTag = new Map<string, string>();
for (const c of man.clients) clientByTag.set(c.tag, c.id);
const tagByClient = new Map<string, string>();
for (const c of man.clients) tagByClient.set(c.id, c.tag);

let ng = 0;
const chk = (label: string, actual: unknown, expected: unknown) => {
  const ok = String(actual) === String(expected);
  if (!ok) ng++;
  return `${ok ? "  ok " : "  NG "} ${label.padEnd(34)} 実測 ${String(actual).padStart(9)}  期待 ${String(expected).padStart(9)}`;
};

async function loadVisits(officeId: string): Promise<Map<string, ShogaiDensouVisit[]>> {
  const mStr = `${YEAR}-${String(MONTH).padStart(2, "0")}`;
  const last = new Date(YEAR, MONTH, 0).getDate();
  const out = new Map<string, ShogaiDensouVisit[]>();
  const { data, error } = await supabase
    .from("shogai_service_records")
    .select("client_id, service_date, start_time, end_time, duration_minutes, service_category, service_code")
    .eq("status", "confirmed")
    .gte("service_date", `${mStr}-01`)
    .lte("service_date", `${mStr}-${String(last).padStart(2, "0")}`)
    .eq("office_id", officeId)
    .order("id")
    .range(0, 999);
  if (error) throw new Error("実績取得失敗: " + error.message);
  for (const r of data ?? []) {
    const v: ShogaiDensouVisit = {
      date: r.service_date,
      startTime: r.start_time,
      endTime: r.end_time,
      durationMinutes: r.duration_minutes,
      category: r.service_category,
      serviceCode: r.service_code,
    };
    const list = out.get(r.client_id);
    if (list) list.push(v);
    else out.set(r.client_id, [v]);
  }
  return out;
}

async function runOffice(which: 1 | 2) {
  const office = which === 1 ? OFFICE1 : OFFICE2;
  console.log(`\n${"═".repeat(96)}`);
  console.log(`■ 事業所${which === 1 ? "甲" : "乙"}  ${office.name}  (障害番号 ${office.shogai_business_number})`);
  console.log("═".repeat(96));

  const agg = await aggregateMonthlyShogaiSeikyu(supabase, {
    year: YEAR,
    month: MONTH,
    unitPrice: UNIT_PRICE,
    officeId: office.id,
  });
  const rows = agg.rows.filter((r) => tagByClient.has(r.user_id));
  const byTag = new Map<string, ShogaiSeikyuRow>();
  for (const r of rows) byTag.set(tagByClient.get(r.user_id)!, r);

  console.log(`  対象 ${rows.length} 名 / 実績 ${agg.recordCount} 件`);
  if (agg.warnings.length) {
    const own = agg.warnings.filter((w) => w.includes("ZZテスト"));
    if (own.length) console.log("  aggregate warnings:\n    - " + own.join("\n    - "));
  }

  for (const e of EXPECT.filter((x) => x.office === which)) {
    const r = byTag.get(e.tag);
    console.log(`\n── ${e.tag} ${r?.user_name.replace(/ \[fake.*$/, "") ?? "(見つからない)"} — ${e.note}`);
    if (!r) {
      ng++;
      console.log("  NG  集計に出てこない");
      continue;
    }
    console.log(chk("総単位数", r.totalUnits, e.units));
    console.log(chk("総費用額", r.totalAmount, e.total));
    console.log(chk("負担上限月額", r.self_payment_limit, e.limit));
    console.log(chk("管理結果区分", r.kanriResult ?? "(未入力)", e.kanriResult ?? "(未入力)"));
    console.log(chk("利用者負担額", r.userAmount, e.user));
    console.log(chk("給付費請求額", r.benefitAmount, e.benefit));
    console.log(
      `       1割相当 ${e.ichiwari.toLocaleString()} / 上限 ${e.limit.toLocaleString()} → 上限適用後 ${Math.min(e.ichiwari, e.limit).toLocaleString()}` +
        (e.kanriResult != null && e.kanriResult !== 2
          ? ` → 管理結果 ${e.user.toLocaleString()}`
          : ""),
    );
    const over = e.userIfMissing - e.user;
    if (over > 0) {
      console.log(
        `       ⚠ 管理結果が未入力だと 利用者負担 ${e.userIfMissing.toLocaleString()}円 (差 +${over.toLocaleString()}円) / 給付費 ${(e.total - e.userIfMissing).toLocaleString()}円 (差 -${over.toLocaleString()}円)`,
      );
    }
  }

  // ── 伝送 (J121 / J411) ────────────────────────────────────────────────────
  const visits = await loadVisits(office.id);
  const mStr = `${YEAR}-${String(MONTH).padStart(2, "0")}`;
  const selfIds = rows.filter((r) => r.jogenKanriKubun === "自事業所").map((r) => r.user_id);
  const linesByClient = new Map<string, ShogaiDensouKanriLine[]>();
  if (selfIds.length > 0) {
    const { data, error } = await supabase
      .from("shogai_jogen_kanri_results")
      .select("client_id, office_lines")
      .eq("target_month", mStr)
      .eq("office_id", office.id)
      .in("client_id", selfIds);
    if (error) throw new Error("上限管理結果取得失敗: " + error.message);
    for (const k of data ?? []) {
      if (Array.isArray(k.office_lines) && k.office_lines.length > 0)
        linesByClient.set(k.client_id, k.office_lines as ShogaiDensouKanriLine[]);
    }
  }
  const users: ShogaiDensouUser[] = rows.map((r) => ({
    row: r,
    visits: visits.get(r.user_id) ?? [],
    contracts: [],
    contractAmountText: "身体介護 30時間/月",
    contractStartDate: "2026-04-01",
    contractEntryNumber: "1",
    jogenOfficeLines: linesByClient.get(r.user_id) ?? null,
  }));
  const built = buildShogaiDensou(users, {
    officeNumber: office.shogai_business_number,
    year: YEAR,
    month: MONTH,
    unitPrice: UNIT_PRICE,
    areaCategory: "その他",
  });

  console.log(`\n── 伝送 J121 明細書 基本情報(01) — 項12 上限月額 / 15 管理事業所番号 / 16 管理結果 / 17 管理結果額 / 22 上限月額調整 / 25 調整後 / 26 上限管理後 / 27 決定利用者負担 / 28 給付費`);
  if (process.env.RAW) {
    console.log("  [RAW J11]\n" + built.seikyuFile.content.split(/\r?\n/).slice(0, 6).map((l) => "    " + l).join("\n"));
    if (built.jogenFile)
      console.log("  [RAW J41]\n" + built.jogenFile.content.split(/\r?\n/).slice(0, 8).map((l) => "    " + l).join("\n"));
  }
  for (const line of built.seikyuFile.content.split(/\r?\n/)) {
    const c = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
    if (c[2] !== "J121" || c[3] !== "01") continue;
    const tag = [...byTag.entries()].find(([, r]) => r.beneficiary_number === c[7])?.[0] ?? "?";
    console.log(
      `  ${tag}  受給者${c[7]}  項12=${(c[13] || "空").padStart(6)} 項15=${(c[16] || "空").padStart(10)} 項16=${(c[17] || "空").padStart(2)} 項17=${(c[18] || "空").padStart(7)} 項22=${(c[23] || "空").padStart(7)} 項25=${(c[26] || "空").padStart(7)} 項26=${(c[27] || "空").padStart(7)} 項27=${(c[28] || "空").padStart(7)} 項28=${(c[29] || "空").padStart(8)}`,
    );
  }

  console.log(`\n── 伝送 J411 上限額管理結果票 (自事業所管理のみ)`);
  if (!built.jogenFile) console.log("  (出力なし)");
  else
    for (const line of built.jogenFile.content.split("\r\n")) {
      const c = line.split(",").map((x) => x.replace(/^"|"$/g, ""));
      if (c[2] !== "J411") continue;
      if (c[3] === "01")
        console.log(`  01 管理事業所${c[7]} 受給者${c[8]} 上限${c[11]} 結果${c[12]} 合計総費用${c[13]} 合計負担${c[14]} 合計管理後${c[15]}`);
      if (c[3] === "02")
        console.log(`     02 項番${c[8]} 事業所${c[9]} 総費用${c[10]} 利用者負担${c[11]} 管理後${c[12]}`);
    }

  const own = built.warnings.filter((w) => w.includes("ZZテスト"));
  console.log(`\n── build warnings (テストデータ分)`);
  if (own.length) console.log("  - " + own.join("\n  - "));
  else console.log("  (なし)");
}

await runOffice(1);
await runOffice(2);

console.log(`\n${"═".repeat(96)}`);
console.log(ng === 0 ? "✅ 全項目 期待値と一致" : `❌ 不一致 ${ng} 件`);
// ⚠ 2026-09-05 是正: ng を数えるだけで exit code に反映していなかった (B-2x と同型)。
process.exitCode = ng > 0 ? 1 : 0;
