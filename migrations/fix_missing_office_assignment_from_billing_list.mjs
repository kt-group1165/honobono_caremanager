// ============================================================================
// 介護請求(明細付)_一覧.CSV で「その事業所が請求している」のに
// client_office_assignments が無い利用者に、割当を足す。
//
//   MONTH=202606 node migrations/fix_missing_office_assignment_from_billing_list.mjs            # DRY RUN
//   MONTH=202606 node migrations/fix_missing_office_assignment_from_billing_list.mjs --execute
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
//   MEISAI の取込は「その事業所の利用者」の中から 利用者番号 で client を引く。
//   割当が無いと引けず、**稼働があるのに実績が 1 件も入らない**。
//   しかも silent なので、突合するまで気づけない。
//
//   実例 (2026-06): 市原ムツミヘルパーステーション が請求している
//     鈴木 浩隆 (611000165) / 大網 あい (2113007214)
//   の 2 名が **ムツミ居宅介護支援事業所にしか割当が無く**、
//   訪問介護の実績 (117211 生2 / A22411 訪独サ21) が丸ごと落ちていた。
//
// ── 何を根拠に足すか ────────────────────────────────────────────────────
//   ほのぼの自身が「この事業所番号でこの利用者を請求した」と書いているので、
//   その事業所の利用者であることは ほのぼの側で確定している。推測ではない。
//
// ⚠ **氏名が一致する候補がちょうど 1 人のときだけ**足す。
//   利用者番号は拠点の中でしか一意でないので、番号だけで引くと別人に当たる。
//
// ⚠ 割当を足しただけでは実績は入らない。**取込を回し直す必要がある**。
//   取込は「その事業所の当月ぶんを消して入れ直す」ので、手で足したデータが
//   あると消える。回すかどうかは user 判断。
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const MONTH = process.env.MONTH ?? "202606";
const AREA = process.env.AREA ?? "";
const SLASH = `${MONTH.slice(0, 4)}/${MONTH.slice(4)}`;
const KAIGO = fileURLToPath(new URL("../", import.meta.url));

const env = Object.fromEntries(
  readFileSync(path.join(KAIGO, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const dec = (b) => new TextDecoder("shift_jis").decode(b);
const norm = (s) => (s ?? "").normalize("NFKC").replace(/\s+/g, "");
/** 一覧CSV は全項目が引用符付きで、住所・事業所名にカンマが入りうる */
const splitCsvLine = (line) => {
  const out = []; let cur = "", quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
};

async function main() {
  console.log(`=== ${SLASH} 一覧CSV で請求されているのに割当が無い利用者 ===`);
  console.log(EXECUTE ? "*** 本番実行 ***" : "*** DRY RUN (--execute で反映) ***");

  // 1) 一覧CSV から (事業所番号, 利用者番号, 氏名) を集める
  const ROOT = path.join(KAIGO, "サービス実績データ");
  const want = new Map();
  for (const area of readdirSync(ROOT)) {
    if (AREA && area !== AREA) continue;
    const dir = path.join(ROOT, area, MONTH, "訪問介護", "介護");
    if (!existsSync(dir)) continue;
    const f = readdirSync(dir).find((x) => x.includes("一覧"));
    if (!f) continue;
    const lines = dec(readFileSync(path.join(dir, f))).split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) continue;
    const h = splitCsvLine(lines[0]);
    const gi = (n) => h.indexOf(n);
    for (const line of lines.slice(1)) {
      const c = splitCsvLine(line);
      // 月はフォルダ名でなく **行に書かれている提供年月** で決める (月遅れは翌月フォルダ)
      if (c[gi("提供年月")] !== SLASH) continue;
      if (!c[gi("請求年月")]) continue;                 // 未発行は対象外
      const bn = c[gi("事業所番号")], num = c[gi("利用者番号")];
      if (!bn || !num) continue;
      want.set(`${bn}|${num}`, { bn, num, name: c[gi("利用者名")], area });
    }
  }
  console.log(`一覧の (事業所×利用者) ${want.size} 組\n`);
  if (!want.size) { console.log("対象なし"); return; }

  // 2) 事業所番号 → office
  //   ⚠ 総合事業は **保険者ごとに別の事業所番号** (`12A…`) を持ち、offices には無い。
  //     office_sougou_numbers を引かないと総合事業の行が丸ごと素通りする。
  const { data: offs, error: offErr } = await sb.from("offices").select("id,name,business_number,tenant_id");
  if (offErr) { console.error(`offices: ${offErr.message}`); process.exit(1); }
  const byBn = new Map((offs ?? []).filter((o) => o.business_number).map((o) => [o.business_number, o]));
  const offById = new Map((offs ?? []).map((o) => [o.id, o]));
  const { data: sougouNo, error: sgErr } = await sb.from("office_sougou_numbers").select("office_id,business_number");
  if (sgErr) { console.error(`office_sougou_numbers: ${sgErr.message}`); process.exit(1); }
  for (const r of sougouNo ?? []) {
    const o = offById.get(r.office_id);
    if (o && !byBn.has(r.business_number)) byBn.set(r.business_number, o);
  }

  // 3) 利用者番号 → clients
  const nums = [...new Set([...want.values()].map((w) => w.num))];
  const numToClients = new Map();
  for (let i = 0; i < nums.length; i += 200) {
    const { data, error } = await sb.from("clients").select("id,name,user_number,tenant_id")
      .in("user_number", nums.slice(i, i + 200));
    if (error) { console.error(`clients: ${error.message}`); process.exit(1); }
    for (const c of data ?? []) {
      const a = numToClients.get(c.user_number) ?? []; a.push(c); numToClients.set(c.user_number, a);
    }
  }

  // 4) 既存の割当
  const ids = [...new Set([...numToClients.values()].flat().map((c) => c.id))];
  const assign = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from("client_office_assignments").select("client_id,office_id")
      .in("client_id", ids.slice(i, i + 200));
    if (error) { console.error(`client_office_assignments: ${error.message}`); process.exit(1); }
    for (const a of data ?? []) {
      const s = assign.get(a.client_id) ?? new Set(); s.add(a.office_id); assign.set(a.client_id, s);
    }
  }

  // 5) 判定
  const plan = [], ambiguous = [], unknownOffice = new Set();
  for (const w of want.values()) {
    const off = byBn.get(w.bn);
    if (!off) { unknownOffice.add(w.bn); continue; }
    // 氏名が一致する候補が **ちょうど 1 人**のときだけ。番号だけでは別人に当たる
    const cands = (numToClients.get(w.num) ?? []).filter((c) => norm(c.name) === norm(w.name));
    if (cands.length !== 1) { if (cands.length > 1) ambiguous.push({ ...w, n: cands.length }); continue; }
    const cl = cands[0];
    if ((assign.get(cl.id) ?? new Set()).has(off.id)) continue;
    plan.push({ ...w, offId: off.id, offName: off.name, cid: cl.id, tenant: cl.tenant_id ?? off.tenant_id ?? "kt-group" });
  }

  if (unknownOffice.size) console.log(`事業所番号が offices / office_sougou_numbers のどちらにも無い: ${[...unknownOffice].join(", ")} (対象外)\n`);
  if (ambiguous.length) {
    console.log(`同姓同名が複数いて決められない ${ambiguous.length} 件 (対象外):`);
    ambiguous.forEach((a) => console.log(`   ${a.area} ${a.num} ${a.name} — ${a.n} 人`));
    console.log("");
  }
  console.log(`割当を足す ${plan.length} 件`);
  plan.forEach((p) => console.log(`   ${p.area.padEnd(8)} ${p.num.padEnd(12)} ${p.name.padEnd(16)} → ${p.offName}`));
  if (!plan.length) { console.log("対象なし"); return; }
  if (!EXECUTE) { console.log("\nDRY RUN。--execute で反映する。"); return; }

  let ok = 0, ng = 0;
  for (const p of plan) {
    // tenant_id は NOT NULL
    const { error } = await sb.from("client_office_assignments")
      .insert({ client_id: p.cid, office_id: p.offId, tenant_id: p.tenant });
    if (error) { ng++; console.error(`  ✗ ${p.name}: ${error.message}`); continue; }
    ok++;
  }
  console.log(`\n反映 ${ok} 件 / 失敗 ${ng} 件`);
  console.log("⚠ 割当を足しただけでは実績は入らない。取込を回し直すこと (回すかは user 判断)。");
  if (ng) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
