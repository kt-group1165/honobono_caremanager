/**
 * 総合事業 処遇改善加算の hybrid 解決 (suffix → 率照合 → fallback) 検証
 *
 * ⚠ **本番 DB には書き込まない。**
 *   §A は supabase クライアントを**モック**して全分岐を決定的に通す。
 *   §B は本番 DB を **READ ONLY** で参照し「各分岐が実データで何件通るか」を分母つきで出す。
 *
 * 検証対象: aggregate-sougou.ts の 4) 処遇改善ブロック
 *   a. 事業所の適用コード (介護 116274 等) を formula(monthly_aggregate) で率に解決
 *      - system='障害' の行は率が別体系なので除外される
 *   b. 自治体 prefix ごとに総合事業 A2 処遇改善コードを引き当てる
 *      1. suffix (下4桁) 一致
 *         - マスタに率あり & 一致      → マスタの率 (警告なし)
 *         - マスタに率あり & 不一致    → **マスタの率** + 警告 (自治体独自率の可能性)
 *         - マスタに率なし             → **事業所設定の率** + 警告 (ゼロにしない)
 *      2. suffix 不一致 → 率一致で fallback + ★ 警告 (2026-09-03 に警告を追加)
 *      3. どちらも無し → 加算 0 + 利用者ごとに警告
 *
 * 使い方: npx tsx scripts/sougou-shoguu-verify.mts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateSougouSeikyu } from "../src/lib/visit-seikyu/aggregate-sougou";

let pass = 0;
let fail = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  OK   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n         期待: ${e}\n         実際: ${a}`);
  }
};

// ── supabase モック ──────────────────────────────────────────────────────────
// チェーンした呼び出しを記録し、await 時に「テーブル+フィルタ」に応じた行を返す。
type Row = Record<string, unknown>;
interface MockData {
  /** 総合事業 基本コード (サービス名 → 単位) */
  serviceCodes: Row[];
  /** 事業所の適用処遇改善コード (formula 付き) */
  formulaCodes: Row[];
  /** 総合事業 A2 処遇改善コード候補 */
  shoguuCodes: Row[];
  clients: Row[];
  insurance: Row[];
}
const makeMock = (d: MockData): SupabaseClient => {
  const build = (table: string) => {
    const calls: { fn: string; args: unknown[] }[] = [];
    const resolve = (): { data: Row[]; error: null } => {
      const has = (fn: string, pred: (a: unknown[]) => boolean) =>
        calls.some((c) => c.fn === fn && pred(c.args));
      if (table === "clients") return { data: d.clients, error: null };
      if (table === "client_insurance_records") return { data: d.insurance, error: null };
      if (table === "care_offices") return { data: [], error: null };
      if (table === "kaigo_visit_addon_lines") return { data: [], error: null };
      if (table === "kaigo_service_codes") {
        // 事業所適用コードの率解決: .in("service_code", [...]) + .not("formula",...)
        if (has("in", (a) => a[0] === "service_code")) return { data: d.formulaCodes, error: null };
        // A2 処遇改善候補: .ilike("service_name", "%処遇改善%")
        if (has("ilike", (a) => String(a[1]).includes("処遇改善")))
          return { data: d.shoguuCodes, error: null };
        // 基本コード: .in("service_name", [...])
        return { data: d.serviceCodes, error: null };
      }
      return { data: [], error: null };
    };
    const proxy: Record<string, unknown> = {};
    for (const fn of [
      "select", "in", "not", "eq", "neq", "ilike", "like", "or", "gte", "lte", "gt", "lt",
      "order", "limit", "range", "filter", "is", "contains", "overlaps",
    ]) {
      proxy[fn] = (...args: unknown[]) => {
        calls.push({ fn, args });
        return proxy;
      };
    }
    proxy.then = (res: (v: { data: Row[]; error: null }) => unknown) => res(resolve());
    return proxy;
  };
  return { from: (t: string) => build(t) } as unknown as SupabaseClient;
};

const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const baseData = (over: Partial<MockData> = {}): MockData => ({
  serviceCodes: [
    {
      service_name: "訪問型サービス（１週に１回程度）", short_name: "訪問型1",
      units: 1176, unit_type: "1月につき", service_code: "MB_A21111", service_category: "A2",
    },
  ],
  formulaCodes: [
    {
      service_code: "116274", system: "介護", units: 0,
      formula: { type: "monthly_aggregate", numerator: 266, denominator: 1000 },
    },
  ],
  shoguuCodes: [],
  clients: [{ id: CLIENT_ID, name: "検証太郎", furigana: "ケンショウタロウ", user_number: "1" }],
  insurance: [
    {
      client_id: CLIENT_ID, insurer_number: "122101", insurer_name: "茂原市",
      insured_number: "0000000001", care_level: "要支援1", copay_rate: "1",
      certification_start_date: "2026-01-01", certification_end_date: "2027-12-31",
      service_limit_amount: 5032,
    },
  ],
  ...over,
});

const run = async (data: MockData, formulaCodes = ["116274"]) =>
  aggregateSougouSeikyu(
    makeMock(data),
    [{ user_id: CLIENT_ID, service_type: "訪問型サービス（１週に１回程度）", visit_date: "2026-06-03" }],
    { officeId: "office-1", year: 2026, month: 6, unitPrice: 10.42, effectiveFormulaCodes: formulaCodes },
  );

// 期待値: 本体 1176 単位 (月額)。処遇改善 266‰ → round(1176 × 266 / 1000) = 313
const BASE_UNITS = 1176;
const expectAddon = (num: number, den: number) => Math.round((BASE_UNITS * num) / den);

console.log("\n=== §A-1 suffix 一致 + マスタの率が一致 (通常) ===");
{
  const r = await run(
    baseData({
      shoguuCodes: [
        { service_code: "MB_A26274", service_name: "訪問型サービス処遇改善加算Ⅰ", units: 266, formula: null },
      ],
    }),
  );
  check("加算単位 = 313 (1176 × 266‰)", r.rows[0]?.addonUnits, expectAddon(266, 1000));
  check("処遇改善の警告は出ない", r.warnings.filter((w) => w.includes("処遇改善")).length, 0);
}

console.log("\n=== §A-2 suffix 一致 + マスタの率が食い違う (自治体独自率) ===");
{
  const r = await run(
    baseData({
      shoguuCodes: [
        // suffix 6274 は一致するが率が 300‰ (事業所設定は 266‰)
        { service_code: "MB_A26274", service_name: "訪問型サービス処遇改善加算Ⅰ", units: 300, formula: null },
      ],
    }),
  );
  check("マスタの率 300‰ を採用 (告示が正)", r.rows[0]?.addonUnits, expectAddon(300, 1000));
  check(
    "食い違いの警告が出る",
    r.warnings.some((w) => w.includes("自治体独自率") && w.includes("30%") && w.includes("26.6%")),
    true,
  );
}

console.log("\n=== §A-3 suffix 一致 + マスタに率が無い (取込漏れ) ===");
{
  const r = await run(
    baseData({
      shoguuCodes: [
        { service_code: "MB_A26274", service_name: "訪問型サービス処遇改善加算Ⅰ", units: 0, formula: null },
      ],
    }),
  );
  check("事業所設定の率で算定しゼロにしない", r.rows[0]?.addonUnits, expectAddon(266, 1000));
  check(
    "取込確認の警告が出る",
    r.warnings.some((w) => w.includes("マスタに率") && w.includes("事業所設定の率")),
    true,
  );
}

console.log("\n=== §A-4 suffix 不一致 → 率一致で fallback ===");
{
  const r = await run(
    baseData({
      shoguuCodes: [
        // suffix は 6184 で不一致。ただし率 266‰ が事業所設定と一致するので救済される
        { service_code: "MB_A26184", service_name: "訪問型サービス処遇改善加算Ⅰ(旧付番)", units: 266, formula: null },
      ],
    }),
  );
  check("率一致で拾えて 313 単位", r.rows[0]?.addonUnits, expectAddon(266, 1000));
  // ⚠ 期待値を 2026-09-03 に **0 → 1 に変更**した。理由:
  //   旧期待値「fallback は警告を出さない」は ★ 設計判断ではなく現状の追認だった
  //   (根拠がコードにも書かれていなかった)。規則 3-2 のとおり、赤いテストは期待値も疑う。
  //   fallback は **緩い経路**で、suffix 経路にある「マスタの率 != 事業所設定の率」の照合
  //   (= 自治体独自率の検知) が無い。ここを黙って通すと、コード付番が変わって suffix が
  //   外れた瞬間に独自率でも静かに通り、経路が変わったこと自体も分からない。
  //   ★ 金額は変えていない (従来どおり事業所設定の率)。見えるようにしただけ。
  //   ⚠ 実データでは fallback に到達していない (§B: 率が引けるのは 116184 のみで
  //     suffix 6184 が 11/11 自治体で一致) ので、この警告は現状 雑音にならない。
  check("fallback は ★ 警告を出す (経路が変わったことを見えるようにする)",
    r.warnings.filter((w) => w.includes("フォールバック")).length, 1);
}

console.log("\n=== §A-5 suffix も率も一致しない → 加算 0 + 警告 ===");
{
  const r = await run(
    baseData({
      shoguuCodes: [
        { service_code: "MB_A26184", service_name: "訪問型サービス処遇改善加算Ⅲ", units: 100, formula: null },
      ],
    }),
  );
  check("加算 0", r.rows[0]?.addonUnits, 0);
  check(
    "見つからない旨の警告が出る",
    r.warnings.some((w) => w.includes("一致する") && w.includes("見つかりません")),
    true,
  );
}

console.log("\n=== §A-6 障害の処遇改善コードは率に使わない ===");
{
  const r = await run(
    baseData({
      formulaCodes: [
        // 障害の率 (441‰) は総合事業に流用してはいけない
        { service_code: "115175", system: "障害", units: 0,
          formula: { type: "monthly_aggregate", numerator: 441, denominator: 1000 } },
      ],
      shoguuCodes: [
        { service_code: "MB_A25175", service_name: "訪問型サービス処遇改善加算", units: 441, formula: null },
      ],
    }),
    ["115175"],
  );
  check("障害の率で算定しない (加算 0)", r.rows[0]?.addonUnits, 0);
}

console.log("\n=== §A-7 自治体 (prefix) ごとに率が違っても取り違えない ===");
{
  // 利用者は茂原市 (MB_)。IH_ (他自治体) の率 500‰ に引きずられないこと
  const r = await run(
    baseData({
      shoguuCodes: [
        { service_code: "IH_A26274", service_name: "処遇改善加算Ⅰ(他自治体)", units: 500, formula: null },
        { service_code: "MB_A26274", service_name: "処遇改善加算Ⅰ(茂原)", units: 266, formula: null },
      ],
    }),
  );
  check("自分の自治体 (MB_) の率 266‰ を使う", r.rows[0]?.addonUnits, expectAddon(266, 1000));
  // 処遇改善は %加算なので明細行ではなく row.addonCode / addonLabel に載る
  check("加算コードも MB_ 側", (r.rows[0] as unknown as { addonCode?: string })?.addonCode, "MB_A26274");
}

console.log("\n=== §B 実データでの分岐通過数 (本番 DB を READ ONLY 参照) ===");
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m![1], m![2].replace(/^["']|["']$/g, "")]),
);
const rest = async (p: string) => {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`REST 失敗 (${p.slice(0, 70)}): ${JSON.stringify(j).slice(0, 200)}`);
  return j as Row[];
};
const page = async (path: string) => {
  const out: Row[] = [];
  for (let off = 0; ; off += 1000) {
    const p = await rest(`${path}&order=id&offset=${off}&limit=1000`);
    out.push(...p);
    if (p.length < 1000) break;
  }
  return out;
};

// 総合事業 A2 の処遇改善コード (自治体版) を prefix ごとに数える
const shoguu = await page(
  "kaigo_service_codes?select=id,service_code,service_name,units,formula,valid_from,valid_until" +
    "&system=eq.%E7%B7%8F%E5%90%88%E4%BA%8B%E6%A5%AD&service_category=eq.A2" +
    "&service_name=ilike.*%E5%87%A6%E9%81%87%E6%94%B9%E5%96%84*",
);
const prefixOf = (c: string) => (/^([A-Z]+)_/.exec(c ?? "")?.[1] ?? "") + (/^[A-Z]+_/.test(c ?? "") ? "_" : "");
const byPrefix = new Map<string, Row[]>();
for (const c of shoguu) {
  const p = prefixOf(String(c.service_code ?? ""));
  if (!byPrefix.has(p)) byPrefix.set(p, []);
  byPrefix.get(p)!.push(c);
}
console.log(`  総合事業 A2 処遇改善コード: ${shoguu.length} 件 / 自治体 prefix ${byPrefix.size} 種 (分母)`);
const noRate = shoguu.filter((c) => {
  const f = c.formula as { numerator?: number; denominator?: number } | null;
  return !(f?.numerator && f?.denominator) && !(Number(c.units) > 0);
});
console.log(`  うち率が引けない (formula も units も無い) コード: ${noRate.length} 件 → §A-3 の分岐`);

// 事業所が実際に適用している処遇改善コード
// 🔴 2026-09-03 是正: 適用コードの解決元は **2 か所**あり、優先されるのは期間指定のほう。
//   offices.applied_formula_codes だけ見ると 22 事業所中 1 件しか設定が無いように見え、
//   「suffix 一致は本番 0/1」という **誤った結論**を出していた (実際は 22/22 設定済み)。
//   kaigo_office_addon_periods は世代で切り替わる: 116274 (〜2026-05) → 116184 (2026-06〜)。
//   116184 は suffix 6184 で MB_A26184 と一致するので、**現行世代では suffix 一致が成立する**。
const offices = await rest("offices?select=id,name,applied_formula_codes,service_type&limit=200");
const periods = await rest("kaigo_office_addon_periods?select=office_id,formula_code,start_month,end_month");
const MONTH_KEY = process.env.MONTH ?? "2026-06";
const activePeriodCodes = new Map<string, string[]>();
for (const p of periods) {
  const st = String(p.start_month ?? ""), en = String(p.end_month ?? "");
  if ((st && st > MONTH_KEY) || (en && en < MONTH_KEY)) continue;
  const k = String(p.office_id);
  if (!activePeriodCodes.has(k)) activePeriodCodes.set(k, []);
  activePeriodCodes.get(k)!.push(String(p.formula_code));
}
const codesOf = (o: Row): string[] => {
  const fromPeriods = activePeriodCodes.get(String(o.id)) ?? [];
  if (fromPeriods.length) return fromPeriods;                       // 期間指定が優先
  return Array.isArray(o.applied_formula_codes) ? (o.applied_formula_codes as string[]) : [];
};
const withCodes = offices.filter((o) => codesOf(o).length > 0);
console.log(`  事業所: ${offices.length} 件 (分母) / 適用コードあり ${withCodes.length} 件`);
console.log(`    (内訳: 期間指定 ${offices.filter((o) => (activePeriodCodes.get(String(o.id)) ?? []).length).length} 件` +
  ` / 列のみ ${offices.filter((o) => !(activePeriodCodes.get(String(o.id)) ?? []).length && Array.isArray(o.applied_formula_codes) && (o.applied_formula_codes as unknown[]).length).length} 件)`);
const suffixes = new Set<string>();
for (const o of withCodes) {
  for (const c of codesOf(o)) suffixes.add(String(c).replace(/[^0-9]/g, "").slice(-4));
}
console.log(`  事業所側 suffix の種類: ${[...suffixes].sort().join(", ") || "(なし)"}`);
const shoguuSuffixes = new Set(shoguu.map((c) => String(c.service_code ?? "").replace(/[^0-9]/g, "").slice(-4)));
const matched = [...suffixes].filter((s) => shoguuSuffixes.has(s));
console.log(`  うち総合事業コードに suffix 一致するもの: ${matched.length} / ${suffixes.size} → §A-1/2/3 の分岐`);
console.log(`  suffix 一致しない (率 fallback 行き): ${suffixes.size - matched.length} → §A-4/5 の分岐`);

// fallback (率一致) が実際に成立するか = 加算が付くか付かない (0) かの分かれ目。
// 事業所の適用コードの率を引いて、prefix ごとに率一致候補があるかを数える。
const appliedCodes = [...new Set(withCodes.flatMap((o) => codesOf(o)))];
if (appliedCodes.length) {
  const fr = await rest(
    `kaigo_service_codes?select=service_code,system,formula&service_code=in.(${appliedCodes.join(",")})`,
  );
  const usable = fr.filter((r) => {
    const f = r.formula as { type?: string; numerator?: number; denominator?: number } | null;
    return r.system !== "障害" && f?.type === "monthly_aggregate" && f.numerator && f.denominator;
  });
  console.log(`  事業所適用コード ${appliedCodes.join(", ")} → 率が引ける行: ${usable.length} / ${fr.length} 件`);
  for (const u of usable) {
    const f = u.formula as { numerator: number; denominator: number };
    const okPrefixes: string[] = [];
    const ngPrefixes: string[] = [];
    for (const [p, list] of byPrefix) {
      const hit = list.some((c) => {
        const cf = c.formula as { numerator?: number; denominator?: number } | null;
        const r = cf?.numerator && cf?.denominator
          ? { num: cf.numerator, den: cf.denominator }
          : Number(c.units) > 0 ? { num: Number(c.units), den: 1000 } : null;
        return r != null && r.num * f.denominator === f.numerator * r.den;
      });
      (hit ? okPrefixes : ngPrefixes).push(p || "(prefix無し)");
    }
    console.log(
      `    ${u.service_code} (${(f.numerator * 100) / f.denominator}%): 率一致する自治体 ${okPrefixes.length} / ${byPrefix.size} 種`,
    );
    if (ngPrefixes.length) console.log(`      ⚠ 加算 0 になる自治体: ${ngPrefixes.join(", ")}`);
  }
}

console.log("\n=== §C 実績のある月×自治体で処遇改善が解決できるか (READ ONLY) ===");
// ⚠ サービスコードは世代管理。**実績のある月の世代**で判定しないと意味がない。
//   116274 は 2026-06 から 24.9% / それ以前は 22.4% で、率一致する自治体数が変わる。
{
  const sched = await page(
    "kaigo_visit_schedule?select=user_id,visit_date&system=eq.%E7%B7%8F%E5%90%88%E4%BA%8B%E6%A5%AD&status=eq.completed",
  );
  const months = [...new Set(sched.map((s) => String(s.visit_date).slice(0, 7)))].sort();
  console.log(`  総合事業の実績: ${sched.length} 件 / 対象月 ${months.length} ヶ月 (${months.join(", ")})`);

  // 利用者 → 保険者 (提供日に有効な認定のうち start が最新のもの = 実装と同じ規則)
  const uids = [...new Set(sched.map((s) => String(s.user_id)))];
  const certs: Row[] = [];
  for (let i = 0; i < uids.length; i += 80) {
    certs.push(
      ...(await rest(
        "client_insurance_records?select=client_id,insurer_number,certification_start_date," +
          `certification_end_date&client_id=in.(${uids.slice(i, i + 80).join(",")})`,
      )),
    );
  }
  // 保険者 → 自治体 prefix (2026-09-05: sougou-insurer-map.mjs に一本化済みなので直接 import する。
  //   以前はaggregate-sougou.tsのソーステキストを正規表現で読んでいたが、
  //   一本化でその場所からは無くなったため、読み先を変更した)
  const { SOUGOU_PREFIX_BY_INSURER } = await import("../src/lib/visit-seikyu/sougou-insurer-map.mjs");
  const prefixByInsurer = new Map(Object.entries(SOUGOU_PREFIX_BY_INSURER as Record<string, string>));

  const inMonth = (r: Row, ym: string) => {
    const f = String(r.valid_from ?? ""), u = String(r.valid_until ?? "");
    return (!f || f <= `${ym}-31`) && (!u || u >= `${ym}-01`);
  };
  let bad = 0;
  let checked = 0;
  for (const ym of months) {
    // その月の実績に出てくる保険者 → prefix
    const daySet = sched.filter((s) => String(s.visit_date).startsWith(ym));
    const prefixes = new Set<string>();
    for (const s of daySet) {
      const day = String(s.visit_date);
      const cs = certs
        .filter((c) => String(c.client_id) === String(s.user_id))
        .filter((c) => {
          const st = String(c.certification_start_date ?? ""), en = String(c.certification_end_date ?? "");
          return (!st || st <= day) && (!en || en >= day);
        })
        .sort((a, b) =>
          String(b.certification_start_date ?? "").localeCompare(String(a.certification_start_date ?? "")));
      if (cs[0]) prefixes.add(prefixByInsurer.get(String(cs[0].insurer_number ?? "").trim()) ?? "");
    }
    // その月の世代で事業所適用コードの率を解決
    const applied = appliedCodes.length
      ? (await rest(`kaigo_service_codes?select=service_code,system,formula,valid_from,valid_until&service_code=in.(${appliedCodes.join(",")})`))
          .filter((r) => r.system !== "障害" && inMonth(r, ym))
          .map((r) => r.formula as { type?: string; numerator?: number; denominator?: number } | null)
          .find((f) => f?.type === "monthly_aggregate" && f.numerator && f.denominator)
      : undefined;
    if (!applied?.numerator || !applied?.denominator) {
      console.log(`  ${ym}: 事業所適用コードの率を解決できず → 処遇改善なし (自治体 ${prefixes.size} 種)`);
      continue;
    }
    const ng: string[] = [];
    for (const p of prefixes) {
      checked++;
      const list = (byPrefix.get(p) ?? []).filter((c) => inMonth(c, ym));
      const hit = list.some((c) => {
        const cf = c.formula as { numerator?: number; denominator?: number } | null;
        const r = cf?.numerator && cf?.denominator
          ? { num: cf.numerator, den: cf.denominator }
          : Number(c.units) > 0 ? { num: Number(c.units), den: 1000 } : null;
        // suffix 一致が先だが、率一致で拾えれば加算は付く (どちらでも 0 にならない)
        const suffixHit = list.some(
          (x) => String(x.service_code).replace(/[^0-9]/g, "").slice(-4) ===
            String(appliedCodes[0]).replace(/[^0-9]/g, "").slice(-4));
        return suffixHit || (r != null && r.num * applied.denominator! === applied.numerator! * r.den);
      });
      if (!hit) {
        ng.push(p || "(prefix無し)");
        bad++;
      }
    }
    console.log(
      `  ${ym}: 率 ${(applied.numerator * 100) / applied.denominator}% / 実績のある自治体 ${prefixes.size} 種 (分母)` +
        ` → 加算 0 になる自治体 ${ng.length} 種${ng.length ? " ⚠ " + ng.join(", ") : ""}`,
    );
  }
  check(`実績のある月×自治体で処遇改善が 0 になる組合せ (分母 ${checked})`, bad, 0);
}

console.log(`\n=== 結果: PASS ${pass} / FAIL ${fail} ===`);
if (fail > 0) process.exit(1);
