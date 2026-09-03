// ============================================================================
// 総合事業 (71R1 / 7113) サンプルデータ — 担当 G / マーカー "g"
//
//   node migrations/seed_sample_sougou_g.mjs            # DRY RUN (既定)
//   node migrations/seed_sample_sougou_g.mjs --execute  # 投入
//   node migrations/seed_sample_sougou_g.mjs --delete   # 撤去
//
// SAMPLE_DATA_PROTOCOL.md 準拠:
//   対象月 2026-12 固定 / user_number=ZG*** / 氏名末尾 [sample-g]
//   事業所は実在のものを使い **offices は 1 バイトも変更しない**
//
// ── 何を踏ませるサンプルか ──────────────────────────────────────────────
//   ① 保険者ごとの事業所番号   122382 = office_sougou_numbers 登録あり (12A8600011)
//                              122184 = 登録なし → 介護番号 1278600398 に **黙って**
//                                       フォールバックする経路 (警告が出ないことの再現)
//   ② 対象者区分               事業対象者 / 要支援1 / 要支援2
//   ③ 月額コードと回数コード   1月につき (A21111 等) / 1回につき (A21411)
//   ④ 限度額の境界             ちょうど / +1 単位超過
//   ⑤ 処遇改善 suffix 一致     ★ 本番では 0/1 でしか成立していない設計の第1候補。
//                              事業所の適用コードは 116274 (suffix 6274) だが
//                              **自治体 (MB_) 側に 6274 が無い**ため原理的に一致しない。
//                              116184 (suffix 6184) なら MB_A26184 と一致する。
//                              → 検証 script 側で appliedFormulaCodes を渡して両方通す
//                              (offices は変更しない)
// ============================================================================
import {
  sb, MONTH, MONTH_START, TENANT, TAGS, marker, noteMarker, userNumber,
  sampleClient, sampleInsurance, sampleAssignment, insertRows, deleteByTag, assertSafeMonth,
} from "./_sample_data.mjs";

const TAG = TAGS.g;
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
assertSafeMonth(MONTH);

/** リンクスヘルパーステーションいすみ (実在)。総合事業の保険者が 2 種に分かれる唯一の事業所 */
const OFFICE_ID = "4015f747-4f75-4769-a1f2-dca3db6a24fc";

/**
 * サンプル利用者。service は kaigo_visit_schedule.service_type に入れる名前で、
 * kaigo_service_codes (system=総合事業 / MB_) から解決される。
 * ⚠ 単位はマスタ由来。**この script では単位数を持たない** (期待値は検証 script が
 *   マスタから引いて手計算する。マスタの固定値をコピペしない)。
 */
const SAMPLES = [
  { seq: 1, careLevel: "要支援1", insurer: "122382", service: "訪問型独自サービスⅠ", days: 1,
    note: "保険者=登録あり(12A8600011)・月額コード" },
  { seq: 2, careLevel: "要支援2", insurer: "122184", service: "訪問型独自サービスⅡ", days: 1,
    note: "保険者=登録なし → 介護番号にフォールバック (警告が出ないことの再現)" },
  { seq: 3, careLevel: "事業対象者", insurer: "122382", service: "訪問型独自サービスⅢ", days: 1,
    note: "事業対象者 (限度額は要支援1と同じ 5,032 の標準補完)" },
  { seq: 4, careLevel: "要支援1", insurer: "122184", service: "訪問型独自短時間サービス", days: 9,
    note: "1回につき のコード × 9 回 (回数で単位が変わることの確認)" },
  // 限度額の境界。認定の限度額を実測単位に合わせて ちょうど / −1 にする
  { seq: 5, careLevel: "要支援1", insurer: "122382", service: "訪問型独自サービスⅢ", days: 1,
    limitMode: "exact", note: "限度額 ちょうど (超過 0 になること)" },
  { seq: 6, careLevel: "要支援1", insurer: "122382", service: "訪問型独自サービスⅢ", days: 1,
    limitMode: "minus1", note: "限度額 −1 (超過 1 単位が自費に分離されること)" },
];

/** service_type 名 → 対象月に有効な MB_ の単位数 (限度額の境界を作るのに要る) */
async function unitsOf(serviceName) {
  const { data, error } = await sb
    .from("kaigo_service_codes")
    .select("service_code, service_name, units, unit_type, valid_from, valid_until")
    .eq("system", "総合事業")
    .eq("calculation_type", "基本")
    .eq("service_name", serviceName)
    .like("service_code", "MB_%");
  if (error) { console.error(`✗ サービスコード取得失敗: ${error.message}`); process.exit(1); }
  const first = `${MONTH}-01`;
  const hit = (data ?? []).find(
    (r) => (!r.valid_from || r.valid_from <= first) && (!r.valid_until || r.valid_until >= first),
  );
  if (!hit) { console.error(`✗ ${MONTH} に有効な「${serviceName}」(MB_) がマスタにありません`); process.exit(1); }
  return hit;
}

async function main() {
  console.log(`=== 総合事業 サンプル (担当 ${TAG}) ${DELETE ? "【撤去】" : EXECUTE ? "【投入】" : "【DRY RUN】"} ===`);
  console.log(`  対象月 ${MONTH} / 事業所 ${OFFICE_ID}\n`);

  if (DELETE) {
    // ⚠ 共有ヘルパー deleteByTag の extraTables は **client_id 前提**だが、
    //   kaigo_visit_schedule の利用者列は **user_id** なのでここで自前で消す。
    //   (共有ヘルパーは他セッションも使うので、こちらを合わせる)
    const { data: mine, error: selErr } = await sb
      .from("clients").select("id").like("user_number", `Z${TAG.toUpperCase()}%`);
    if (selErr) { console.error(`✗ 対象利用者の取得失敗: ${selErr.message}`); process.exit(1); }
    const ids = (mine ?? []).map((r) => r.id);
    if (ids.length === 0) console.log("撤去対象: 0 名");
    else if (!EXECUTE) console.log(`  [DRY] kaigo_visit_schedule から user_id in (${ids.length}件) を削除`);
    else {
      const { error } = await sb.from("kaigo_visit_schedule").delete().in("user_id", ids);
      if (error) { console.error(`✗ kaigo_visit_schedule DELETE 失敗: ${error.message}`); process.exit(1); }
      console.log(`  kaigo_visit_schedule から実績を削除 (利用者 ${ids.length} 名ぶん)`);
    }
    await deleteByTag(TAG, { dryRun: !EXECUTE });
    return;
  }

  // 事業所が実在することだけ確認する (変更はしない)
  const { data: off, error: offErr } = await sb
    .from("offices").select("id, name, unit_price, business_number").eq("id", OFFICE_ID).maybeSingle();
  if (offErr) { console.error(`✗ 事業所取得失敗: ${offErr.message}`); process.exit(1); }
  if (!off) { console.error(`✗ 事業所が見つかりません: ${OFFICE_ID}`); process.exit(1); }
  console.log(`  事業所: ${off.name} (介護番号 ${off.business_number} / 地域単価 ${off.unit_price})`);
  console.log("  ⚠ offices は読むだけ。1 バイトも変更しない\n");

  const clients = [], certs = [], assigns = [], scheds = [];
  for (const s of SAMPLES) {
    const master = await unitsOf(s.service);
    const perMonth = master.unit_type.includes("月");
    const totalUnits = perMonth ? master.units : master.units * s.days;
    const limit =
      s.limitMode === "exact" ? totalUnits :
      s.limitMode === "minus1" ? totalUnits - 1 : undefined;

    const c = sampleClient({ tag: TAG, seq: s.seq, careLevel: s.careLevel, insurerNumber: s.insurer });
    clients.push(c);
    certs.push({
      ...sampleInsurance(null, { careLevel: s.careLevel, insurerNumber: s.insurer }),
      _seq: s.seq,
      // ⚠ 集計は **被保険者番号を認定 (cert) から**読む。sampleInsurance は入れないので
      //   ここで必ず付ける。無いと伝送から除外され「請求 0 円」になる (実際に踏んだ)。
      insured_number: c.insured_number,
      ...(limit != null ? { service_limit_amount: limit } : {}),
      notes: `総合事業サンプル ${noteMarker(TAG)}`,
    });
    assigns.push({ ...sampleAssignment(null, OFFICE_ID), _seq: s.seq });
    for (let d = 0; d < s.days; d++) {
      scheds.push({
        _seq: s.seq,
        tenant_id: TENANT,
        office_id: OFFICE_ID,
        service_type: s.service,
        system: "総合事業",
        status: "completed",
        visit_date: `${MONTH}-${String(d + 1).padStart(2, "0")}`,
        start_time: "09:00:00",
        end_time: "10:00:00",
        notes: `総合事業サンプル ${noteMarker(TAG)}`,
      });
    }
    console.log(
      `  ZG${String(s.seq).padStart(3, "0")} ${s.careLevel.padEnd(6)} 保険者${s.insurer} ` +
        `${master.service_code} ${s.service} ${master.units}単位/${master.unit_type} ×${s.days} = ${totalUnits}単位` +
        `${limit != null ? ` / 限度額 ${limit}` : ""}\n         ${s.note}`,
    );
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で投入します (利用者 ${clients.length} / 実績 ${scheds.length} 行)。`);
    console.log("※ 先に --delete が動くことを確認してから --execute すること。");
    return;
  }

  // 1) clients → id を回収して子行に配る
  // ⚠ insertRows は **id の配列**を返す (行オブジェクトではない)。
  //   INSERT は送った順で返るので index で対応づける。
  const ins = await insertRows("clients", clients, { dryRun: false });
  if (ins.length !== clients.length) {
    console.error(`✗ clients: ${clients.length} 行送って ${ins.length} 件しか返らない`);
    process.exit(1);
  }
  const idBySeq = new Map();
  clients.forEach((c, i) => {
    const seq = Number(String(c.user_number).replace(/^Z[A-Z]/, ""));
    idBySeq.set(seq, ins[i]);
  });
  const attach = (rows) => rows.map(({ _seq, ...r }) => ({ ...r, client_id: idBySeq.get(_seq) }));
  await insertRows("client_insurance_records", attach(certs), { dryRun: false });
  await insertRows("client_office_assignments", attach(assigns), { dryRun: false });
  await insertRows(
    "kaigo_visit_schedule",
    attach(scheds).map(({ client_id, ...r }) => ({ ...r, user_id: client_id })),
    { dryRun: false },
  );

  // 件数確認 (silent failure を作らない)
  const { count, error: cErr } = await sb
    .from("clients").select("id", { count: "exact", head: true }).like("user_number", `Z${TAG.toUpperCase()}%`);
  if (cErr) console.error(`✗ 件数確認失敗: ${cErr.message}`);
  else console.log(`\n✓ 投入完了。clients ${count} 件 (marker Z${TAG.toUpperCase()}*)`);
}

main();
