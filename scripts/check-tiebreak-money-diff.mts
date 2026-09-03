/**
 * 認定の同着是正 (eba7ac4) が金額をいくら動かしたかを **是正前後の金額**で測る。
 *
 *   ⚠ 人数から逆算してはいけない。同じ symptom (保険↓/利用者↑/総額不変) を出す原因が
 *     2 つある — 負担割合 (copay_rate) と 区分支給限度額 (service_limit_amount)。
 *
 *   やり方: 本番の集計 (aggregateMonthlyVisitSeikyu) を **2 回**通す。
 *     after  = そのまま
 *     before = supabase を Proxy で包み、client_insurance_records の結果から
 *              **同着の負け行を落として「旧挙動が採っていた行」だけを残す**。
 *              こうすると新ロジックも同じ行を採るので、是正前が再現できる。
 *     ⚠ 旧挙動の並びは未定義なので、ここでの before は「DB が今返す順の先頭」。
 *       完全な再現ではないが、**同着グループのどれか**であることは保証される。
 *
 *   使い方: npx tsx scripts/check-tiebreak-money-diff.mts <officeId> <YYYY-MM> [...]
 *           npx tsx scripts/check-tiebreak-money-diff.mts   # 既定 = 高品 2026-06,2026-07
 */
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { aggregateMonthlyVisitSeikyu } from "@/lib/visit-seikyu/aggregate";

const OFFICE = process.argv[2] ?? "a707b5a2-b21b-4c4e-8dac-298191e90b61"; // 高品
const MONTHS = process.argv.length > 3 ? process.argv.slice(3) : ["2026-06", "2026-07"];

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------- before 用の Proxy
type Row = Record<string, unknown>;
/** 同着 (start と effective が同値) の 2 件目以降を落とす = 旧挙動の「先頭を採る」 */
function keepOldPick(rows: Row[]): Row[] {
  const seen = new Map<string, string>(); // client_id → 採用した (start|effective)
  const out: Row[] = [];
  for (const r of rows) {
    const cid = String(r.client_id ?? "");
    const key = `${r.certification_start_date ?? ""}|${r.effective_date ?? ""}`;
    const taken = seen.get(cid);
    if (taken === undefined) { seen.set(cid, key); out.push(r); continue; }
    if (taken === key) continue; // 同着の負け行 → 落とす
    out.push(r);
  }
  return out;
}

/** PostgREST のビルダは this を返すので、then だけ差し替えて結果を加工する */
function wrapBuilder<T extends object>(b: T): T {
  return new Proxy(b, {
    get(t, p, recv) {
      const v = Reflect.get(t, p, recv);
      if (p === "then") {
        return (onF: (x: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          (t as unknown as PromiseLike<{ data?: Row[] }>).then((res) => {
            const r = res as { data?: Row[] };
            return onF(Array.isArray(r?.data) ? { ...r, data: keepOldPick(r.data) } : res);
          }, onR);
      }
      if (typeof v === "function") {
        return (...a: unknown[]) => {
          const r = (v as (...x: unknown[]) => unknown).apply(t, a);
          return r && typeof r === "object" ? wrapBuilder(r as object) : r;
        };
      }
      return v;
    },
  }) as T;
}
const beforeClient = new Proxy(sb, {
  get(t, p, recv) {
    if (p === "from") {
      return (table: string) => {
        const b = t.from(table);
        return table === "client_insurance_records" ? wrapBuilder(b) : b;
      };
    }
    return Reflect.get(t, p, recv);
  },
}) as SupabaseClient;

// ---------------------------------------------------------------------- 実行
const { data: office, error: eo } = await sb
  .from("offices").select("id,name,tenant_id,unit_price,applied_formula_codes").eq("id", OFFICE).maybeSingle();
if (eo || !office) { console.error(`✗ 事業所が引けない: ${eo?.message ?? OFFICE}`); process.exit(1); }
console.log(`事業所: ${office.name}\n`);

for (const ms of MONTHS) {
  const [y, m] = ms.split("-").map(Number);
  const args = {
    officeId: office.id as string,
    tenantId: office.tenant_id as string,
    year: y, month: m,
    unitPrice: (office.unit_price ?? undefined) as number | undefined,
    appliedFormulaCodes: (office.applied_formula_codes ?? []) as string[],
  };
  const after = await aggregateMonthlyVisitSeikyu(sb, args);
  const before = await aggregateMonthlyVisitSeikyu(beforeClient, args);

  const sum = (rs: { insuranceAmount: number; userAmount: number; selfPayAmount: number; totalAmount: number }[]) =>
    rs.reduce((a, r) => ({
      ins: a.ins + r.insuranceAmount, usr: a.usr + r.userAmount,
      self: a.self + r.selfPayAmount, tot: a.tot + r.totalAmount,
    }), { ins: 0, usr: 0, self: 0, tot: 0 });
  const A = sum(after.rows as never), B = sum(before.rows as never);

  console.log(`=== ${ms} ===`);
  console.log(`  保険   ${B.ins} → ${A.ins}   (${A.ins - B.ins >= 0 ? "+" : ""}${A.ins - B.ins})`);
  console.log(`  利用者 ${B.usr} → ${A.usr}   (${A.usr - B.usr >= 0 ? "+" : ""}${A.usr - B.usr})`);
  console.log(`  超過   ${B.self} → ${A.self}   (${A.self - B.self >= 0 ? "+" : ""}${A.self - B.self})`);
  console.log(`  総額   ${B.tot} → ${A.tot}   (${A.tot - B.tot >= 0 ? "+" : ""}${A.tot - B.tot})  ${A.tot === B.tot ? "✓ 不変" : "★ 動いた"}`);

  // 利用者別の差
  const bm = new Map((before.rows as never as { user_id: string; insuranceAmount: number; userAmount: number; selfPayAmount: number; user_name: string }[]).map((r) => [r.user_id, r]));
  const diffs: string[] = [];
  for (const r of after.rows as never as { user_id: string; user_name: string; insuranceAmount: number; userAmount: number; selfPayAmount: number }[]) {
    const b = bm.get(r.user_id);
    if (!b) { diffs.push(`  ${r.user_name}  ★ before に居ない`); continue; }
    const di = r.insuranceAmount - b.insuranceAmount;
    const du = r.userAmount - b.userAmount;
    const ds = r.selfPayAmount - b.selfPayAmount;
    if (di || du || ds) diffs.push(`  ${r.user_name.padEnd(14)} 保険${di >= 0 ? "+" : ""}${di}  利用者${du >= 0 ? "+" : ""}${du}  超過${ds >= 0 ? "+" : ""}${ds}`);
  }
  console.log(`  利用者別に差が出た: ${diffs.length} 名`);
  for (const d of diffs) console.log(d);
  console.log();
}
