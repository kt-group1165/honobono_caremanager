// ============================================================================
// MEISAI 取込 (介護/障害共通) が「対象月ぶんを削除して入れ直す」ときに、
// 後から別script (set_schedule_system_from_densou.mjs /
// fix_shogai_rows_billed_as_kaigo.mjs 等) で system・service_type を是正された
// 行が、削除条件 (office_id+月+notesマーカー) には引っかかるのに再INSERT時は
// 元の値で無条件に上書きされ、黙って巻き戻る問題への共通対処。
//
// 2026-09-14 介護取込 (import_meisai_visit_records.mjs) で最初に実装。
// 障害取込 (import_meisai_shougai_records.mjs) にも同型の問題があったため
// 共通moduleに切り出した (逐語コピーを避ける)。
//
// ── 引き継ぎキーに service_code (notesに埋め込まれた値) を使う理由 ─────────
//   service_type は世代解決や制度変換を経た**表示用の値**そのものが是正対象に
//   なりうる (障害取込は system と service_type を両方書き換えられる)。
//   一方 notes には import 時点の生コードがそのまま残るので、そちらで引けば
//   表示値の変化に影響されない安定したキーになる。
//
// ⚠ DB の start_time は time型で "HH:MM:SS" (秒付き) で返るが、CSV由来の
//   新payload側は "HH:MM" (秒無し)。先頭5文字に揃えないと必ず不一致になる
//   (2026-09-14 介護取込の実装で実際に踏んだ)。
// ============================================================================

export function extractCodeFromNotes(notes) {
  return /code=([^\]]+)\]/.exec(notes ?? "")?.[1];
}

export function timeKey(t) {
  return (t ?? "").slice(0, 5);
}

export function buildCarryKey(userId, visitDate, startTime, code) {
  return `${userId}|${visitDate}|${timeKey(startTime)}|${code}`;
}

/** office_id + 月 + notesマーカーで、既存の取込行を order 付きページングで全件取得する。 */
export async function fetchExistingMarkedRows(sb, { officeId, notesPrefix, monthFirst, monthLast, extraColumns = [] }) {
  const cols = ["id", "user_id", "visit_date", "start_time", "notes", ...extraColumns].join(",");
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("kaigo_visit_schedule")
      .select(cols)
      .eq("office_id", officeId).like("notes", `${notesPrefix}%`)
      .gte("visit_date", monthFirst).lte("visit_date", monthLast)
      .order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`既存行取得失敗: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/**
 * 引き継ぎ計画を作る。newPayloads の要素は system 引き継ぎ用の _code
 * (notesと同じ生コード) を持っている前提。一致した payload は carryFields を
 * 直接書き換える (副作用あり)。
 *
 * @param existingRows   fetchExistingMarkedRows の戻り値 (carryFields の現在値を含む select 済みのもの)
 * @param newPayloads    これから INSERT する payload 配列 (各要素に _code が必要)
 * @param carryFields    引き継ぐ列名 (例 ["system"] や ["system","service_type"])
 * @param referenceField carryFields[0] 相当。「是正されていない」とみなす基準列 (通常 "system")
 * @param referenceValue 基準列の「本来この取込が書く値」(介護取込なら"介護"、障害取込なら"障害")
 * @param skip           true なら引き継ぎを行わず、対象を全て missing/collisions に振り分ける
 *                        (SKIP_SYSTEM_CARRYOVER=1 の負のコントロール用)
 */
export function planCarryover({ existingRows, newPayloads, carryFields, referenceField, referenceValue, skip = false }) {
  const existingByKey = new Map();
  for (const r of existingRows) {
    const code = extractCodeFromNotes(r.notes);
    if (!code) continue; // 想定外のnotes形式。キー化できないので引き継ぎ対象にしない
    const k = buildCarryKey(r.user_id, r.visit_date, r.start_time, code);
    if (!existingByKey.has(k)) existingByKey.set(k, []);
    existingByKey.get(k).push(r);
  }
  const existingCorrected = [...existingByKey.entries()]
    .filter(([, list]) => list.some((r) => r[referenceField] !== referenceValue));

  const newKeys = new Set(newPayloads.map((p) => buildCarryKey(p.user_id, p.visit_date, p.start_time, p._code)));

  const collisions = [];
  const missing = [];
  for (const [k, list] of existingCorrected) {
    if (list.length > 1) { collisions.push({ key: k, rows: list }); continue; }
    if (skip || !newKeys.has(k)) { missing.push({ key: k, rows: list }); continue; }
  }

  let carriedCount = 0;
  if (!skip && collisions.length === 0) {
    for (const p of newPayloads) {
      const k = buildCarryKey(p.user_id, p.visit_date, p.start_time, p._code);
      const list = existingByKey.get(k);
      if (list && list.length === 1 && list[0][referenceField] !== referenceValue) {
        for (const f of carryFields) p[f] = list[0][f];
        carriedCount++;
      }
    }
  }
  return { existingByKey, existingCorrected, collisions, missing, carriedCount };
}

export function printCarryoverSummary({ existingRows, existingCorrected, carriedCount, missing, collisions, carryFields, skip = false }) {
  console.log(`― system 引き継ぎ (既存の取込行 ${existingRows.length}件中、是正済み ${existingCorrected.length}件) ―`);
  console.log(`  引き継ぐ行数: ${carriedCount}${skip ? " (SKIP_SYSTEM_CARRYOVER=1のため0固定)" : ""}`);
  console.log(`  引き継げず消える行数: ${missing.length}`);
  console.log(`  キー衝突 (既存側で同キー複数、判定不能): ${collisions.length}`);
  if (missing.length) {
    console.log("  ★消える行の内訳:");
    for (const { rows } of missing) {
      const r = rows[0];
      console.log(`    ${r.visit_date} ${r.start_time} user_id=${r.user_id.slice(0, 8)}… `
        + `${carryFields.map((f) => `${f}=${r[f]}`).join(" ")} notes=${r.notes}`);
    }
  }
  if (collisions.length) {
    console.log("  ★衝突の内訳:");
    for (const { key, rows } of collisions) {
      console.log(`    key=${key} → ${rows.map((r) => `id=${r.id.slice(0, 8)}…(${carryFields.map((f) => `${f}=${r[f]}`).join(",")})`).join(" / ")}`);
    }
  }
  console.log("");
}
