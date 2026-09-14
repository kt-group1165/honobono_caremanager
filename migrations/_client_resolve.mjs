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

// nameKey は呼出側 (normRiyouName 等) で既に正規化済みの前提。ここでは
// DB 側の生の氏名を同じ土俵に上げるためだけに使う最小限の正規化に留める
// (空白除去のみ。異体字正規化などは呼出側の normRiyouName に任せる)。
function normalizeForMatch(s) {
  return (s || "").normalize("NFKC").replace(/[\s　]/g, "");
}
