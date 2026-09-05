// ⚠ 調査用・常設でない (2026-09-05 分類)。ZK### サンプル (SAMPLE_DATA_PROTOCOL 5章) が
//   DB に投入されていないと「分母0=測れていない」で終わる (現在は撤去済)。
//
// 段2: 訪問介護サンプル (ZK###) から 7111/7131 を生成し、様式の項番・桁・恒等式を見る。
//
//   npx tsx scripts/verify-sample-densou-k.mts
//
// ⚠ 出力先は scratch。伝送データ/ には書かない (SAMPLE_DATA_PROTOCOL 5章)。
// ⚠ この検証が証明していないこと: 実際に国保連が受理するか / 公費・月遅れ・再請求の様式。
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { aggregateMonthlyVisitSeikyu } from "../src/lib/visit-seikyu/aggregate";
import { buildKokuhoDensou } from "../src/lib/kokuho-densou/build";

const env: Record<string, string> = {};
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const OUT = String.raw`C:\Users\domen-PC\AppData\Local\Temp\claude\sample-k`;
const OFFICE_BN = "1270501180";

let pass = 0;
const fail: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fail.push(`${name}${detail ? `\n     ${detail}` : ""}`);
};

const { data: offs, error: oe } = await sb
  .from("offices").select("id, name, unit_price").eq("business_number", OFFICE_BN).limit(1);
if (oe) throw new Error(`事業所取得に失敗: ${oe.message}`);
if (!offs?.length) throw new Error(`事業所 ${OFFICE_BN} が見つかりません`);

const res = await aggregateMonthlyVisitSeikyu(sb as never, {
  officeId: offs[0].id as string, tenantId: "kt-group", year: 2026, month: 12,
});
type R = { user_number: string | null; totalUnits: number; totalAmount: number; insuranceAmount: number };
const mine = (res.rows as unknown as R[]).filter((r) => /^ZK\d+$/.test(String(r.user_number ?? "")));
console.log(`集計 ${res.rows.length} 行 / サンプル(k) ${mine.length}  ← 分母`);
if (mine.length === 0) { console.log("★ 分母 0 = 測れていない。判定を出さない"); process.exit(1); }

const built = buildKokuhoDensou(res.rows as never, {
  officeNumber: OFFICE_BN, year: 2026, month: 12,
  unitPrice: Number(offs[0].unit_price ?? 10), seikyuYear: 2027, seikyuMonth: 1,
} as never);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}\\${built.fileName}`, built.content, "latin1");
console.log(`出力: ${OUT}\\${built.fileName}  (${built.dataRecordCount} データレコード)`);
if (built.warnings.length) {
  console.log(`\n⚠ builder の警告 ${built.warnings.length} 件:`);
  for (const w of built.warnings.slice(0, 6)) console.log(`   ${w}`);
}

// ── 様式の検査 ───────────────────────────────────────────────────────────
const lines = built.content.split(/\r\n/).filter((l) => l !== "");
const cells = lines.map((l) => l.split(","));
const ctrl = cells.filter((c) => c[0] === "1");
const data = cells.filter((c) => c[0] === "2");
console.log(`\n行: 全 ${lines.length} / コントロール ${ctrl.length} / データ ${data.length}`);

ok("コントロールレコードが 1 行だけある", ctrl.length === 1, `実際 ${ctrl.length} 行`);
// コントロールレコード: 1,レコード種別,0,★データ件数,様式,...,事業所番号,0
ok("データレコード数がコントロールの申告と一致",
  Number(ctrl[0]?.[3] ?? -1) === data.length,
  `コントロール: ${ctrl[0]?.slice(0, 9).join(",")} / 実データ ${data.length} 行`);
ok("dataRecordCount が実際のデータ行数と一致",
  built.dataRecordCount === data.length, `申告 ${built.dataRecordCount} / 実際 ${data.length}`);

const f7111 = data.filter((c) => c[2] === '"7111"');
const f7131 = data.filter((c) => c[2] === '"7131"');
console.log(`  7111 (請求書) ${f7111.length} 行 / 7131 (明細書) ${f7131.length} 行`);
ok("7111 と 7131 の両方が出ている", f7111.length > 0 && f7131.length > 0);

// 明細 (7131 区分02) の恒等式: 単位数 × 回数 = サービス単位数
const meisai = f7131.filter((c) => c[3] === "02");
const idBad: string[] = [];
for (const c of meisai) {
  const unit = Number(c[10]), cnt = Number(c[11]), total = Number(c[15]);
  if (unit * cnt !== total)
    idBad.push(`  ${c[8]}${c[9]}  ${unit} × ${cnt} = ${unit * cnt} だが サービス単位数 ${total}`);
}
console.log(`  7131 明細 (区分02) ${meisai.length} 行  ← 分母`);
ok("明細の恒等式 単位数 × 回数 = サービス単位数",
  meisai.length > 0 && idBad.length === 0,
  meisai.length === 0 ? "★ 明細行が 0 = 測れていない" : idBad.slice(0, 4).join("\n     "));

// 桁・書式
const badLen = meisai.filter((c) => !/^\d{2}$/.test(c[8] ?? "") || !/^\d{4}$/.test(c[9] ?? ""));
ok("サービス種類コードは2桁 / 項目コードは4桁", badLen.length === 0,
  badLen.slice(0, 3).map((c) => `種類"${c[8]}" 項目"${c[9]}"`).join(" / "));

// ⚠ 7111 (請求書) と 7131 (明細書) は **項番のレイアウトが違う**。
//   同じ添字で検査すると 7111 の事業所番号を提供年月として読んでしまう (実際に踏んだ)。
//   位置に依存する検査は 7131 に限定する。
const badYm = f7131.filter((c) => !/^\d{6}$/.test(c[4] ?? ""));
ok("7131: 提供年月は6桁 (YYYYMM)", f7131.length > 0 && badYm.length === 0,
  f7131.length === 0 ? "★ 7131 が 0 行 = 測れていない" : badYm.slice(0, 3).map((c) => c[4]).join(" / "));
const badBn = f7131.filter((c) => (c[5] ?? "") !== OFFICE_BN);
ok("7131: 事業所番号が全行で一致", f7131.length > 0 && badBn.length === 0, `不一致 ${badBn.length} 行`);
ok("7131: 提供年月が対象月 (202612)",
  f7131.length > 0 && f7131.every((c) => c[4] === "202612"),
  [...new Set(f7131.map((c) => c[4]))].join(" / "));

// 保険者・被保番が空の行が無いこと (空だと返戻)
const emptyNum = f7131.filter((c) => !(c[6] ?? "").trim() || !(c[7] ?? "").replace(/"/g, "").trim());
ok("7131: 保険者番号・被保険者番号が空の行が無い", f7131.length > 0 && emptyNum.length === 0, `${emptyNum.length} 行`);

// 7111 (請求書) と 7131 (明細書) の件数が整合するか
const meisaiUsers = new Set(f7131.filter((c) => c[3] === "01").map((c) => `${c[6]}|${c[7]}`));
ok("7111 の件数欄と 明細書の利用者数が整合",
  meisaiUsers.size === mine.length,
  `明細書の利用者 ${meisaiUsers.size} / 集計のサンプル ${mine.length}`);

console.log(`\n合格 ${pass} / ${pass + fail.length}`);
for (const f of fail) console.log("★ " + f);
console.log("\n⚠ 証明していないこと: 国保連が実際に受理するか / 公費併用・月遅れ・再請求の様式 /");
console.log("   7111 の合計額が 7131 の積み上げと一致するか (別途)。");
