// ============================================================================
// 「削除 → INSERT」型の取込スクリプト用 FK ガード。
//
// ── なぜ要るか ────────────────────────────────────────────────────────
//   取込スクリプトは冪等にするため **既存を削除してから INSERT** する。
//   INSERT が FK 違反で落ちると **削除だけ実行されてデータが消えたまま**になる。
//
//   2026-08-30 に花見川で実際に起きた。名寄せ
//   (_meisai_num_to_client_花見川.json) の client_id が重複統合で消えていて
//   (414000166 村上泉)、599 行が消えたまま 0 件 INSERT で終わった。
//
//   → **削除する前に**、これから INSERT する行の参照先が実在するか確かめる。
//
// ── 使い方 ────────────────────────────────────────────────────────────
//   import { assertRefsExist } from "./_fk_guard.mjs";
//
//   await assertRefsExist(sb, rows, [
//     { column: "user_id",  table: "clients", label: "利用者" },
//     { column: "staff_id", table: "members", label: "職員" },
//   ], { hint: `migrations/_meisai_num_to_client_${MAP_TAG}.json を確認` });
//   // ここを通ったら削除して良い
//
//   参照先が無ければ **何も消さずに process.exit(1)**。
// ============================================================================

/**
 * これから INSERT する行の外部キーが実在するか確かめる。
 * 1 件でも欠けていたら中止する (呼出側が削除する前に呼ぶこと)。
 *
 * @param sb        supabase client (service_role)
 * @param rows      INSERT 予定の行
 * @param refs      [{ column, table, label }]
 * @param opts      { hint?: string, resolveKey?: (id) => string|null }
 *                  resolveKey は「その id が名寄せのどのキーだったか」を返す関数。
 *                  原因追跡のために出力に添える。
 */
export async function assertRefsExist(sb, rows, refs, opts = {}) {
  const problems = [];
  for (const ref of refs) {
    const ids = [...new Set(rows.map((r) => r[ref.column]).filter(Boolean))];
    if (!ids.length) continue;
    const found = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from(ref.table).select("id").in("id", ids.slice(i, i + 200));
      if (error) {
        console.error(`✗ ${ref.table} の存在確認に失敗: ${error.message}`);
        process.exit(1);
      }
      for (const r of data) found.add(r.id);
    }
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) problems.push({ ref, missing, total: ids.length });
    else console.log(`  FK OK  ${ref.label ?? ref.column}: ${ids.length} 件`);
  }

  if (!problems.length) return;

  console.error("\n✗ 参照先が存在しないため **何も削除せずに中止**しました");
  for (const p of problems) {
    console.error(`  ${p.ref.table} に無い ${p.ref.column} が ${p.missing.length}/${p.total} 件:`);
    for (const id of p.missing.slice(0, 10)) {
      const key = opts.resolveKey?.(id);
      console.error(`    ${id}${key ? `  (名寄せキー: ${key})` : ""}`);
    }
    if (p.missing.length > 10) console.error(`    … 他 ${p.missing.length - 10} 件`);
  }
  if (opts.hint) console.error(`\n  → ${opts.hint}`);
  console.error("  → 重複統合 (merge_duplicate_clients.mjs) で client_id が変わった可能性。" +
    "現行の id に張り替えること");
  process.exit(1);
}
