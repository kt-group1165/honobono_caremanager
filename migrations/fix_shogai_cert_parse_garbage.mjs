#!/usr/bin/env node
/**
 * 受給者証一覧表 PDF の行ズレで作られた「利用者でないもの」を片付ける。
 *
 * ── 症状 ──────────────────────────────────────────────────────
 * PDF から受給者証を取り込むときに行がずれ、**備考文や事業所名の断片が氏名**として
 * client に登録された。しかもその行が持っていた受給者証 (現行世代) はゴミ側に付き、
 * 実在の人には**期限切れの古い証しか残らない**。
 *
 *   1222126235  廣瀨 英明 (実績5)  2023-11-20〜2024-10-31 ← 期限切れ
 *               「代」   (実績0)  2025-11-01〜2026-10-31 ← 現行
 *   1222907097  田口 正秋 (実績17) 2020-01-01〜2020-12-31 ← 期限切れ
 *               「R3.3.1～家事１５時間追加している。」    2026-01-01〜2026-12-31 ← 現行
 *
 * これで `npm run check:densou` に「実績があるのに有効な受給者証が無い」と出ていた。
 * 障害伝送は受給者証番号が無い利用者を除外するので、**そのままだと請求漏れ**になる。
 *
 * ── 対象の決め方 (推測しない) ─────────────────────────────────
 * 同じ受給者証番号が 2 人以上に付いていて、片方が
 *   ① 生年月日なし  ② 対象期間に実績 0 件
 * のときだけ、その片方をゴミと判定する。**両方に生年月日があるペアは触らない**
 * (K姉 佐々木祐子 / 竹内由紀 のように別人かもしれないため)。
 *
 * ── やること ─────────────────────────────────────────────────
 *   1. ゴミが持つ受給者証を実在の人へ付け替える。
 *      実在の人が同じ (番号, 開始日) を既に持っていれば重複なので削除する
 *   2. ゴミの client_office_assignments を削除
 *   3. ゴミの client を削除 (FK で消せないときは残して報告する)
 *
 * 受給者証番号は人を一意に指すので、番号が同じ古い世代も同じ人のものとして移す。
 *
 *   node migrations/fix_shogai_cert_parse_garbage.mjs            # DRY RUN
 *   node migrations/fix_shogai_cert_parse_garbage.mjs --execute
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTE = process.argv.includes("--execute");
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(qs, init) {
  const r = await fetch(`${SB}/rest/v1/${qs}`, { headers: H, ...init });
  const text = await r.text();
  if (!r.ok) throw new Error(`${qs}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : [];
}
async function fetchAll(table, select, extra = "") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await rest(`${table}?select=${select}${extra}&offset=${from}&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const clients = await fetchAll("clients", "id,name,user_number,birth_date");
const certs = await fetchAll(
  "shougai_certifications",
  "id,client_id,beneficiary_number,certification_start_date,certification_end_date",
);
const clientById = new Map(clients.map((c) => [c.id, c]));

// 実績件数 (期間は問わない。1 件でもあれば実在扱い)
const visitCount = new Map();
for (const r of await fetchAll("kaigo_visit_schedule", "user_id")) {
  visitCount.set(r.user_id, (visitCount.get(r.user_id) ?? 0) + 1);
}

// 受給者証番号 → client_id[]
const byNumber = new Map();
for (const c of certs) {
  if (!c.beneficiary_number) continue;
  if (!byNumber.has(c.beneficiary_number)) byNumber.set(c.beneficiary_number, new Set());
  byNumber.get(c.beneficiary_number).add(c.client_id);
}

const plans = [];
const skipped = [];
for (const [number, idSet] of byNumber) {
  if (idSet.size < 2) continue;
  const members = [...idSet].map((id) => clientById.get(id)).filter(Boolean);
  const garbage = members.filter((c) => !c.birth_date && !(visitCount.get(c.id) > 0));
  const real = members.filter((c) => !garbage.includes(c));
  if (!garbage.length) { skipped.push({ number, members, why: "ゴミ判定に当てはまるものが無い" }); continue; }
  if (real.length !== 1) { skipped.push({ number, members, why: `実在側が ${real.length} 人で決められない` }); continue; }
  plans.push({ number, real: real[0], garbage });
}

console.log(`受給者証番号が重複しているもの: ${[...byNumber.values()].filter((s) => s.size > 1).length} 件`);
console.log(`  → 是正対象 ${plans.length} 件 / 触らない ${skipped.length} 件\n`);
for (const s of skipped) {
  console.log(`— 触らない ${s.number} (${s.why}): ${s.members.map((m) => `${m.name}[実績${visitCount.get(m.id) ?? 0}/生年${m.birth_date ?? "なし"}]`).join(" / ")}`);
}
if (skipped.length) console.log("");

const moves = [];   // 証を付け替える
const dropCerts = [];  // 重複なので消す証
const dropClients = [];
for (const p of plans) {
  const realCerts = certs.filter((c) => c.client_id === p.real.id && c.beneficiary_number === p.number);
  const has = new Set(realCerts.map((c) => `${c.beneficiary_number}|${c.certification_start_date}`));
  console.log(`### ${p.number}  実在: ${p.real.name} (実績 ${visitCount.get(p.real.id) ?? 0} 件)`);
  for (const rc of realCerts) console.log(`     いま持っている証: ${rc.certification_start_date}〜${rc.certification_end_date}`);
  for (const gc of p.garbage) {
    const gCerts = certs.filter((c) => c.client_id === gc.id);
    console.log(`   ゴミ: 「${gc.name}」 (${gc.user_number ?? "—"})`);
    for (const c of gCerts) {
      const key = `${c.beneficiary_number}|${c.certification_start_date}`;
      if (c.beneficiary_number === p.number && has.has(key)) {
        dropCerts.push(c);
        console.log(`       証 ${c.certification_start_date}〜${c.certification_end_date}  → 重複なので削除`);
      } else {
        moves.push({ cert: c, to: p.real });
        has.add(key);
        console.log(`       証 ${c.certification_start_date}〜${c.certification_end_date}  → ${p.real.name} へ付け替え`);
      }
    }
    dropClients.push(gc);
  }
  console.log("");
}

console.log(`まとめ: 付け替え ${moves.length} 証 / 重複削除 ${dropCerts.length} 証 / client 削除 ${dropClients.length} 件`);
if (!EXECUTE) {
  console.log("\nDRY RUN。書き込むには --execute を付ける。");
  process.exit(0);
}
if (!moves.length && !dropCerts.length && !dropClients.length) process.exit(0);

// ── バックアップ (消す前に必ず取る) ───────────────────────────────────────
const backupPath = fileURLToPath(new URL("./_backup_shogai_cert_parse_garbage.json", import.meta.url));
const assignments = [];
for (const gc of dropClients) {
  assignments.push(...(await rest(`client_office_assignments?select=*&client_id=eq.${gc.id}`)));
}
fs.writeFileSync(backupPath, JSON.stringify({
  moves: moves.map((m) => ({ cert: m.cert, to: m.to.id })),
  dropCerts, dropClients, assignments,
}, null, 1), "utf8");
console.log(`\nバックアップ: ${backupPath}`);

for (const m of moves) {
  await rest(`shougai_certifications?id=eq.${m.cert.id}`, {
    method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ client_id: m.to.id }),
  });
}
console.log(`✅ 証を付け替え ${moves.length} 件`);

for (const c of dropCerts) {
  await rest(`shougai_certifications?id=eq.${c.id}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
}
console.log(`✅ 重複証を削除 ${dropCerts.length} 件`);

let removed = 0;
const left = [];
for (const gc of dropClients) {
  try {
    await rest(`client_office_assignments?client_id=eq.${gc.id}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
    await rest(`clients?id=eq.${gc.id}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
    removed++;
  } catch (e) {
    left.push(`${gc.name}: ${String(e.message).slice(0, 160)}`);
  }
}
console.log(`✅ ゴミ client を削除 ${removed} / ${dropClients.length} 件`);
if (left.length) {
  console.log("⚠ 他テーブルから参照されていて消せなかったもの (証の付け替えは済んでいる):");
  for (const l of left) console.log(`   ${l}`);
}
