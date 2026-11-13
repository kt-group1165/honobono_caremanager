// ============================================================================
// (保険者番号, 被保険者番号) の対で client を引き当てる共通ヘルパー。
//
// import_riyouhyou_service_usage.mjs の fetchAll()/resolveClients() を
// 切り出したもの (2026-09-14, H指示)。中身は逐語コピーではなく移動のみ・
// 挙動は変えていない (呼出側で sb を渡す形に変えた以外は同じロジック)。
//
// ⚠ 被保険者番号は **保険者の中でしか一意でない**。番号だけで引くと別人に
//   当たる (実例 28 件)。氏名は表記ゆれが多いので判定には使わず、
//   食い違ったら呼出側で警告を出すこと (normRiyouName で突合キーを作る)。
// ============================================================================

/** PostgREST の 1000 行上限を超えて全件取る */
export async function fetchAll(sb, build) {
  const out = [];
  const STEP = 1000;
  for (let from = 0; ; from += STEP) {
    const { data, error } = await build(sb).range(from, from + STEP - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < STEP) break;
  }
  return out;
}

/**
 * (保険者番号, 被保険者番号) の対から client_id を引き当てる。
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Map<string, {insurer: string, insured: string, nameKey: string}>} people
 *        キーは呼出側が自由に決めてよい (`${insurer}|${insured}` を想定)。
 *        値は insurer/insured (番号) と nameKey (呼出側の氏名正規化済みの氏名) を持つこと。
 * @param {{normalizeName?: (s: string) => string}} [opts]
 *        DB 側の生の氏名を people の nameKey と同じ土俵に正規化する関数。
 *        呼出側が氏名の正規化ルール (normRiyouName 等) を持っているときは
 *        **必ず同じ関数を渡すこと** (既定は空白除去のみの最小限の正規化で、
 *        末尾の連番記号除去などは行わないため、渡し忘れると片方だけ正規化された
 *        状態で比較され、一致するはずの氏名が食い違って見える)。
 * @param {(p: {insured: string}, matchedName: string) => void} [opts.onNameMatch]
 *        被保番プレースホルダを氏名で引き当てたときに呼ばれる (ログ出力用)。
 * @returns {Promise<{byPair: Map<string, Set<string>>, nameById: Map<string, {name:string, deleted:boolean}>}>}
 */
export async function resolveClients(sb, people, opts = {}) {
  const normalizeName = opts.normalizeName ?? normalizeForMatch;
  const onNameMatch = opts.onNameMatch ?? (() => {});
  const insureds = [...new Set([...people.values()].map((p) => p.insured))];
  const CH = 200;

  const recs = [];
  for (let i = 0; i < insureds.length; i += CH) {
    const chunk = insureds.slice(i, i + CH);
    recs.push(...await fetchAll(sb, (c) => c
      .from("client_insurance_records")
      .select("client_id, insurer_number, insured_number")
      .in("insured_number", chunk)));
  }
  const byPair = new Map();
  for (const r of recs) {
    if (!r.insurer_number || !r.insured_number) continue;
    const k = `${r.insurer_number}|${r.insured_number}`;
    if (!byPair.has(k)) byPair.set(k, new Set());
    byPair.get(k).add(r.client_id);
  }

  // clients 側にも番号があるので保険で見る
  const cli = [];
  for (let i = 0; i < insureds.length; i += CH) {
    const chunk = insureds.slice(i, i + CH);
    cli.push(...await fetchAll(sb, (c) => c
      .from("clients")
      .select("id, name, insurer_number, insured_number, deleted_at")
      .in("insured_number", chunk)));
  }
  for (const c of cli) {
    if (c.deleted_at) continue;
    const k = `${c.insurer_number}|${c.insured_number}`;
    if (!byPair.has(k)) byPair.set(k, new Set());
    byPair.get(k).add(c.id);
  }

  // 氏名は全 client_id ぶん要る (認定側でしか当たらない人もいる)
  const ids = [...new Set([...byPair.values()].flatMap((s) => [...s]))];
  const nameById = new Map();
  for (let i = 0; i < ids.length; i += CH) {
    const chunk = ids.slice(i, i + CH);
    const rows = await fetchAll(sb, (c) => c.from("clients").select("id, name, deleted_at").in("id", chunk));
    for (const c of rows) nameById.set(c.id, { name: c.name, deleted: !!c.deleted_at });
  }

  // ── 被保番がプレースホルダの人だけ、氏名で引き当てる ──────────────────
  //   ほのぼのには 被保番 "0000000000" のまま登録されている利用者が居る
  //   (木更津 佐久間 歌子)。番号では絶対に当たらないので氏名で引くしかない。
  //
  //   ⚠ 氏名一致は本来いちばん弱い手がかりなので、条件を厳しくする:
  //     ・PDF 側の被保番が **同じ数字の 10 桁** のときだけ
  //     ・当方も **番号を持っていない** client に限る (番号がある人は別人)
  //     ・氏名で **ちょうど 1 名**に決まるときだけ。2 名以上なら諦める
  const needName = [...people.values()].filter(
    (p) => /^(\d)\1{9}$/.test(p.insured ?? "") && !byPair.get(`${p.insurer}|${p.insured}`)?.size);
  if (needName.length) {
    const numberless = await fetchAll(sb, (c) => c.from("clients")
      .select("id, name, insured_number, deleted_at").is("insured_number", null));
    for (const p of needName) {
      const hit = numberless.filter((c) => !c.deleted_at && c.name && p.nameKey && normalizeName(c.name) === p.nameKey);
      if (hit.length !== 1) continue;
      byPair.set(`${p.insurer}|${p.insured}`, new Set([hit[0].id]));
      nameById.set(hit[0].id, { name: hit[0].name, deleted: false });
      onNameMatch(p, hit[0].name);
    }
  }
  return { byPair, nameById };
}

/**
 * 別表 (第7表) ページ先頭のヘッダだけで client を引き当てる (2026-11-13。H 指示で
 * import_care_plan3_usage_detail_from_pdf.mjs と fill_rental_units_from_betsuhyou.mjs の同じ処理を寄せた)。
 *
 * ヘッダには保険者番号が印字されないので、(被保番, 氏名) の **両方が一致する client が 1 人**のときだけ引き当てる。
 *   ・被保番だけでは引かない (保険者の中でしか一意でない。別人衝突の実例 28 件)
 *   ・氏名だけでも引かない (memory feedback_name_based_lookup_collision_risk)
 *
 * 居宅支援事業者番号 (officeNumber) が渡されたとき (H 指示 2026-11-13):
 *   ・★ 必須条件にはしない。client_office_assignments は実際に欠けていることがある既知の穴で
 *     (市原 鈴木浩隆・大網あい は割当が居宅にしか無く実績 0 件になっていた)、必須にすると本来入る人が静かに落ちる
 *   ・(被保番, 氏名) で 2 人以上残ったときだけ、その事業所に割当がある人で絞る (1 人に決まれば引き当てる)
 *   ・1 人に決まったが その事業所に割当が無い / 番号が offices に無い → 引き当てたうえで warn を付ける
 *     (割当の欠落そのものが別の不具合の兆候なので、見えるようにする)
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} sb
 * @param {Array<{key: string, insured: string, name: string, officeNumber?: string | null}>} entries  key は呼出側が決める (1 人 1 つ)
 * @param {{normalizeName: (s: string) => string}} opts  氏名の正規化 (呼出側と同じ関数を渡す)
 * @returns {Promise<{resolved: Map<string, {clientId: string, name: string, warn?: string, note?: string} | {reason: string}>, names: Map<string, string>}>}
 *          names は 被保番が一致した client (削除済みを除く) の id → 氏名
 */
export async function resolveByBetsuhyouHeader(sb, entries, opts) {
  const norm = opts.normalizeName;
  const CH = 150;
  const insureds = [...new Set(entries.map((e) => e.insured))];
  const recs = [];
  for (let i = 0; i < insureds.length; i += CH)
    recs.push(...await fetchAll(sb, (c) => c.from("client_insurance_records").select("id, client_id, insured_number")
      .in("insured_number", insureds.slice(i, i + CH)).order("id")));
  const cids = [...new Set(recs.map((r) => r.client_id))];
  const names = new Map();
  for (let i = 0; i < cids.length; i += CH)
    for (const c of await fetchAll(sb, (q) => q.from("clients").select("id, name, deleted_at").in("id", cids.slice(i, i + CH)).order("id")))
      if (!c.deleted_at) names.set(c.id, c.name ?? "");
  const hitsOf = (e) => {
    const cand = [...new Set(recs.filter((r) => r.insured_number === e.insured).map((r) => r.client_id))].filter((id) => names.has(id));
    return { cand, hit: cand.filter((id) => norm(names.get(id)) === norm(e.name)) };
  };

  // ── 居宅支援事業者番号 → offices.id、(client, office) の割当 ──
  const officeNumbers = [...new Set(entries.map((e) => e.officeNumber).filter(Boolean))];
  const officeIdsByNumber = new Map(); // 番号 -> Set(office_id)
  const assigned = new Set(); // `${client_id}|${office_id}`
  if (officeNumbers.length) {
    for (const o of await fetchAll(sb, (q) => q.from("offices").select("id, business_number").in("business_number", officeNumbers).order("id")))
      (officeIdsByNumber.get(o.business_number) ?? officeIdsByNumber.set(o.business_number, new Set()).get(o.business_number)).add(o.id);
    const hitIds = [...new Set(entries.filter((e) => e.officeNumber).flatMap((e) => hitsOf(e).hit))];
    const oids = [...new Set([...officeIdsByNumber.values()].flatMap((s) => [...s]))];
    for (let i = 0; i < hitIds.length && oids.length; i += CH)
      for (const a of await fetchAll(sb, (q) => q.from("client_office_assignments").select("id, client_id, office_id")
        .in("client_id", hitIds.slice(i, i + CH)).in("office_id", oids).order("id")))
        assigned.add(`${a.client_id}|${a.office_id}`);
  }
  const isAssigned = (clientId, num) => [...(officeIdsByNumber.get(num) ?? [])].some((oid) => assigned.has(`${clientId}|${oid}`));

  const resolved = new Map();
  for (const e of entries) {
    const { cand, hit } = hitsOf(e);
    if (hit.length === 1) {
      const r = { clientId: hit[0], name: names.get(hit[0]) };
      if (e.officeNumber && !officeIdsByNumber.has(e.officeNumber)) r.warn = `居宅支援事業者番号 ${e.officeNumber} が offices に無い (割当を確かめられない)`;
      else if (e.officeNumber && !isAssigned(hit[0], e.officeNumber)) r.warn = `居宅支援事業者番号 ${e.officeNumber} の事業所に client_office_assignments が無い (引き当ては 被保番+氏名 で成立。割当の欠落を確かめる)`;
      resolved.set(e.key, r);
      continue;
    }
    if (hit.length > 1 && e.officeNumber) {
      const narrowed = hit.filter((id) => isAssigned(id, e.officeNumber));
      if (narrowed.length === 1) {
        resolved.set(e.key, { clientId: narrowed[0], name: names.get(narrowed[0]), note: `被保番+氏名で ${hit.length} 人 → 居宅支援事業者番号 ${e.officeNumber} の割当で 1 人に絞った` });
        continue;
      }
      resolved.set(e.key, { reason: `別表ヘッダ 被保番${e.insured}「${e.name}」→ 被保番の一致 ${cand.length} 人 / うち氏名も一致 ${hit.length} 人 / うち事業所 ${e.officeNumber} の割当あり ${narrowed.length} 人 (1 人に決まらない)` });
      continue;
    }
    resolved.set(e.key, { reason: `別表ヘッダ 被保番${e.insured}「${e.name}」→ 被保番の一致 ${cand.length} 人 / うち氏名も一致 ${hit.length} 人 (1 人に決まらない)` });
  }
  return { resolved, names };
}

// nameKey は呼出側 (normRiyouName 等) で既に正規化済みの前提。ここでは
// DB 側の生の氏名を同じ土俵に上げるためだけに使う最小限の正規化に留める
// (空白除去のみ。異体字正規化などは呼出側の normRiyouName に任せる)。
function normalizeForMatch(s) {
  return (s || "").normalize("NFKC").replace(/[\s　]/g, "");
}
