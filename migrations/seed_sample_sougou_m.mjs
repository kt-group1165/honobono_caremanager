// ============================================================================
// 総合事業 (71R1 / 7113) サンプルデータ — 担当 M / マーカー "m"
//
//   node migrations/seed_sample_sougou_m.mjs            # DRY RUN (既定)
//   node migrations/seed_sample_sougou_m.mjs --execute  # 投入
//   node migrations/seed_sample_sougou_m.mjs --delete   # 撤去
//
// SAMPLE_DATA_PROTOCOL.md 準拠:
//   対象月 2026-12 固定 / user_number=ZM*** / 氏名末尾 [sample-m]
//   事業所は実在のものを使い **offices は 1 バイトも変更しない**
//
// ── 何を踏ませるサンプルか (claude-06 割当分の残り2点) ──────────────────
//   実データで 0 件だった枝を踏ませる (限度額 ちょうど/超過 は G が既に検証済 = 71b3011。
//   ここでは重複させない):
//   ① 住所地特例 (clients.jusho_tokurei + jusho_tokurei_insurer_number)
//      → 71R1 明細行が 種別02 ではなく 種別14 で出るか。項18=施設所在保険者番号
//      対照 (ZM004): 同条件で jusho_tokurei=false → 種別02 のまま (分岐が本当に効いているかの負のコントロール)
//   ② 要介護3-5 と総合事業の併用 (継続利用要介護者 / 区分変更月)
//      → aggregate-sougou.ts の SOUGOU_CARE_LEVEL_LIMITS[要介護3/5] が実際に使われるか
//      ZM002: 認定に限度額あり (cert 優先経路)
//      ZM003: 認定の限度額を意図的に null → 内蔵マップへのフォールバック経路
// ============================================================================
import {
  sb, MONTH, TENANT, TAGS, noteMarker,
  sampleClient, sampleInsurance, sampleAssignment, insertRows, deleteByTag, assertSafeMonth,
} from "./_sample_data.mjs";

const TAG = TAGS.m;
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
assertSafeMonth(MONTH);

/** リンクスヘルパーステーションいすみ (実在。G と同じ事業所 = 保険者122382の総合事業番号が登録済み) */
const OFFICE_ID = "4015f747-4f75-4769-a1f2-dca3db6a24fc";
const INSURER = "122382";
const SERVICE = "訪問型独自サービスⅢ";

const SAMPLES = [
  { seq: 1, careLevel: "要支援1", days: 1,
    jushoTokurei: true, jushoTokureiInsurerNumber: "123456",
    note: "① 住所地特例あり → 71R1 種別14 (項18=施設所在保険者番号) で出るはず" },
  { seq: 2, careLevel: "要介護3", days: 1,
    note: "② 要介護3 + 総合事業併用・認定に限度額あり(cert優先経路)。警告文言の発火を確認" },
  { seq: 3, careLevel: "要介護5", days: 1, limitFromCert: null,
    note: "② 要介護5 + 総合事業併用・認定の限度額を意図的に空 → 内蔵 SOUGOU_CARE_LEVEL_LIMITS[要介護5]=36217 へのフォールバックを確認" },
  { seq: 4, careLevel: "要支援1", days: 1,
    note: "① 負のコントロール: ZM001と同条件だが jusho_tokurei=false → 種別02のままであること" },
];

/** service_type 名 → 対象月に有効な MB_ の単位数 */
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
    // G の script と同じ理由: kaigo_visit_schedule は user_id 列 (client_id ではない)
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

  const { data: off, error: offErr } = await sb
    .from("offices").select("id, name, unit_price, business_number").eq("id", OFFICE_ID).maybeSingle();
  if (offErr) { console.error(`✗ 事業所取得失敗: ${offErr.message}`); process.exit(1); }
  if (!off) { console.error(`✗ 事業所が見つかりません: ${OFFICE_ID}`); process.exit(1); }
  console.log(`  事業所: ${off.name} (介護番号 ${off.business_number} / 地域単価 ${off.unit_price})`);
  console.log("  ⚠ offices は読むだけ。1 バイトも変更しない\n");

  const master = await unitsOf(SERVICE);
  console.log(`  サービス: ${master.service_code} ${SERVICE} ${master.units}単位/${master.unit_type}\n`);

  const clients = [], certs = [], assigns = [], scheds = [];
  for (const s of SAMPLES) {
    const perMonth = master.unit_type.includes("月");
    const totalUnits = perMonth ? master.units : master.units * s.days;

    // ⚠ .insert([...]) は複数行を1回で送るため、行ごとにキー集合が違うと
    //   PostgREST が欠けている列を **NULL 明示送信**する (DB の DEFAULT が効かない)。
    //   jusho_tokurei は NOT NULL なので、全行で明示的に true/false を渡す。
    const c = sampleClient({
      tag: TAG, seq: s.seq, careLevel: s.careLevel, insurerNumber: INSURER,
      extra: {
        jusho_tokurei: !!s.jushoTokurei,
        jusho_tokurei_insurer_number: s.jushoTokurei ? s.jushoTokureiInsurerNumber : null,
      },
    });
    clients.push(c);
    certs.push({
      ...sampleInsurance(null, {
        careLevel: s.careLevel, insurerNumber: INSURER, tag: TAG, seq: s.seq,
        // seq3 だけ意図的に cert の限度額を空にする (内蔵マップへのフォールバック経路を通す)
        extra: "limitFromCert" in s ? { service_limit_amount: s.limitFromCert } : {},
      }),
      _seq: s.seq,
      insured_number: c.insured_number,
      notes: `総合事業サンプル ${noteMarker(TAG)}`,
    });
    assigns.push({ ...sampleAssignment(null, OFFICE_ID), _seq: s.seq });
    for (let d = 0; d < s.days; d++) {
      scheds.push({
        _seq: s.seq,
        tenant_id: TENANT,
        office_id: OFFICE_ID,
        service_type: SERVICE,
        system: "総合事業",
        status: "completed",
        visit_date: `${MONTH}-${String(d + 1).padStart(2, "0")}`,
        start_time: "09:00:00",
        end_time: "10:00:00",
        notes: `総合事業サンプル ${noteMarker(TAG)}`,
      });
    }
    console.log(
      `  ZM${String(s.seq).padStart(3, "0")} ${s.careLevel.padEnd(6)} ${master.service_code} ×${s.days} = ${totalUnits}単位` +
        `${s.jushoTokurei ? ` / 住所地特例(施設所在保険者${s.jushoTokureiInsurerNumber})` : ""}` +
        `${"limitFromCert" in s ? " / cert限度額=空(内蔵マップへフォールバック)" : ""}\n         ${s.note}`,
    );
  }

  if (!EXECUTE) {
    console.log(`\n※ DRY RUN。--execute で投入します (利用者 ${clients.length} / 実績 ${scheds.length} 行)。`);
    console.log("※ 先に --delete が動くことを確認してから --execute すること。");
    return;
  }

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

  const { count, error: cErr } = await sb
    .from("clients").select("id", { count: "exact", head: true }).like("user_number", `Z${TAG.toUpperCase()}%`);
  if (cErr) console.error(`✗ 件数確認失敗: ${cErr.message}`);
  else console.log(`\n✓ 投入完了。clients ${count} 件 (marker Z${TAG.toUpperCase()}*)`);
}

main();
