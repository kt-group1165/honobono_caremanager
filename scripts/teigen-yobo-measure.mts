/**
 * 逓減制の取扱件数 — 介護予防支援 (要支援) の 1/3 換算を実データで測る (READ ONLY)
 *
 *   MONTH=2026-06 npx tsx scripts/teigen-yobo-measure.mts
 *
 * 背景: AUDIT_2026_08_31.md:477 の【要確認】
 *   claims-content.tsx は 逓減制の取扱件数から 予防「委託」を **除外** している。
 *   老企36号は「委託を受けた件数に 1/3 を乗じた数」を **算入** する読みが有力で、
 *   もし逆なら件数過小 → 本来ⅱの人が ⅰ のまま = **過大請求**。
 *
 * この script は制度解釈を決めない。**3 通りの数え方すべてで tier が動くか**を測る。
 *   A 現行実装      予防 (委託除く) × 1/3
 *   B 告示の読み    予防 (委託のみ) × 1/3
 *   C 上限          予防 (全員)     × 1/3
 *
 * ★ この検査が証明しないこと (ルール 3-1):
 *   - どの読みが正しいか (制度解釈。user/保険者への確認事項)
 *   - 予防の区分 (Ⅰ/Ⅱ/委託) が実際の運用と合っているか
 *     (notes マーカーが無い利用者は実装と同じく既定 "II" = 請求対象 として数える)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  teigenTierForIndex,
  isYoboShienLevel,
  parseYoboShienKubun,
  type YoboShienKubun,
} from "@/app/(authenticated)/billing/claims/claims-shared";
import { resolveCertForMonth } from "@/lib/cert-for-month";

const MONTH = process.env.MONTH ?? "2026-06";
const [GEN_Y, GEN_M] = MONTH.split("-").map(Number);

const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
const IN_CHUNK = 150; // memory: feedback_postgrest_in_query_plan_cliff

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

type OfficeRow = {
  id: string; name: string; service_type: string | null;
  caremane_jokin_kansan: number | string | null; teigen_kanwa_from: string | null;
};

/** order 付きページング (memory: feedback_postgrest_paging_needs_order) */
async function pageClientIds(officeId: string): Promise<string[]> {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("client_office_assignments")
      .select("client_id")
      .eq("office_id", officeId)
      .order("client_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`client_office_assignments: ${error.message}`);
    const rows = (data ?? []) as { client_id: string }[];
    if (rows.length === 0) break;
    out.push(...rows.map((r) => r.client_id));
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  const { data: offices, error: oErr } = await sb
    .from("offices")
    .select("id, name, service_type, caremane_jokin_kansan, teigen_kanwa_from")
    .eq("is_active", true)
    .order("name");
  if (oErr) throw new Error("offices: " + oErr.message);
  const officeRows = (offices ?? []) as OfficeRow[];
  const kyotaku = officeRows.filter((o) => (o.service_type ?? "").includes("居宅介護支援"));
  if (kyotaku.length === 0) {
    console.error(
      `✗ 居宅介護支援の事業所が 0 件。service_type の実値: ${[
        ...new Set(officeRows.map((o) => o.service_type)),
      ].join(" / ")}`,
    );
    process.exit(1);
  }
  console.log(`対象月 ${MONTH} / 居宅介護支援 ${kyotaku.length} 事業所\n`);

  type Row = {
    name: string;
    fte: number | null;
    kanwa: boolean;
    yokaigo: number;
    yoboAll: number;
    yoboItaku: number;
    yoboBillable: number;
    yoboNoMarker: number;
    perCm: Record<"A" | "B" | "C", number | null>;
    worst: Record<"A" | "B" | "C", string>;
  };
  const rows: Row[] = [];
  let noFte = 0;

  for (const o of kyotaku) {
    const clientIds = [...new Set(await pageClientIds(o.id))];

    const users: { id: string }[] = [];
    for (const c of chunk(clientIds, IN_CHUNK)) {
      const { data, error } = await sb
        .from("clients")
        .select("id")
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .in("id", c);
      if (error) throw new Error("clients: " + error.message);
      users.push(...((data ?? []) as { id: string }[]));
    }

    const plans: { user_id: string }[] = [];
    for (const c of chunk(users.map((u) => u.id), IN_CHUNK)) {
      const { data, error } = await sb
        .from("kaigo_care_plans")
        .select("user_id")
        .eq("status", "active")
        .in("user_id", c);
      if (error) throw new Error("kaigo_care_plans: " + error.message);
      plans.push(...((data ?? []) as { user_id: string }[]));
    }
    const activeIds = [...new Set(plans.map((p) => p.user_id))];
    if (activeIds.length === 0) continue;

    const certs = await resolveCertForMonth(sb, activeIds, GEN_Y, GEN_M);

    // 予防区分マーカー (対象月以前の最新) — 実装 (claims-content 5-f) と同じ引き方
    const kubunBy = new Map<string, YoboShienKubun>();
    for (const c of chunk(activeIds, IN_CHUNK)) {
      const { data, error } = await sb
        .from("kaigo_care_support_claims")
        .select("user_id, notes, billing_month")
        .in("user_id", c)
        .lte("billing_month", MONTH)
        .like("notes", "%[予防支援:%")
        .order("billing_month", { ascending: false });
      if (error) throw new Error("claims: " + error.message);
      for (const r of (data ?? []) as { user_id: string; notes: string | null }[]) {
        if (kubunBy.has(r.user_id)) continue;
        const k = parseYoboShienKubun(r.notes);
        if (k) kubunBy.set(r.user_id, k);
      }
    }

    let yokaigo = 0, yoboAll = 0, yoboItaku = 0, yoboBillable = 0, yoboNoMarker = 0;
    for (const id of activeIds) {
      const cert = certs.get(id);
      const lv = cert?.care_level ?? "";
      if (!lv) continue;
      if (isYoboShienLevel(lv)) {
        yoboAll++;
        if (!kubunBy.has(id)) yoboNoMarker++;
        if ((kubunBy.get(id) ?? "II") === "itaku") yoboItaku++;
        else yoboBillable++;
      } else if (/^要介護[1-5]$/.test(lv)) yokaigo++;
    }

    const fteRaw = Number(o.caremane_jokin_kansan ?? 0);
    const fte = Number.isFinite(fteRaw) && fteRaw > 0 ? fteRaw : null;
    if (fte === null) noFte++;
    const kanwa = !!o.teigen_kanwa_from && `${MONTH}-01` >= o.teigen_kanwa_from;

    const offsets = { A: yoboBillable / 3, B: yoboItaku / 3, C: yoboAll / 3 };
    const perCm: Row["perCm"] = { A: null, B: null, C: null };
    const worst: Row["worst"] = { A: "-", B: "-", C: "-" };
    for (const k of ["A", "B", "C"] as const) {
      if (fte === null) continue;
      const total = offsets[k] + yokaigo;
      perCm[k] = total / fte;
      // 最後 (= 最も件数が積み上がった) 利用者の tier。実装と同じ 1 始まり累積
      worst[k] = yokaigo > 0 ? teigenTierForIndex(offsets[k] + yokaigo, fte, kanwa) : "-";
    }

    rows.push({
      name: o.name, fte, kanwa, yokaigo, yoboAll, yoboItaku, yoboBillable, yoboNoMarker, perCm, worst,
    });
  }

  if (rows.length === 0) {
    console.error("✗ 測定できた事業所が 0 件 (= 測れていない。分母を確認すること)");
    process.exit(1);
  }

  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
  console.log(
    pad("事業所", 34) + pad("常勤", 6) + pad("要介護", 7) + pad("要支援", 7) +
    pad("委託", 6) + pad("印無", 6) + pad("A件/人", 9) + pad("B件/人", 9) + pad("C件/人", 9) + "tier A/B/C",
  );
  const f = (n: number | null) => (n === null ? "—" : n.toFixed(1));
  for (const r of rows) {
    console.log(
      pad(r.name, 34) + pad(r.fte === null ? "未設定" : String(r.fte), 6) +
      pad(String(r.yokaigo), 7) + pad(String(r.yoboAll), 7) +
      pad(String(r.yoboItaku), 6) + pad(String(r.yoboNoMarker), 6) +
      pad(f(r.perCm.A), 9) + pad(f(r.perCm.B), 9) + pad(f(r.perCm.C), 9) +
      `${r.worst.A}/${r.worst.B}/${r.worst.C}` + (r.kanwa ? "  (緩和)" : ""),
    );
  }

  const measurable = rows.filter((r) => r.fte !== null);
  console.log(`\n── 分母 ──`);
  console.log(`  事業所            ${rows.length} (うち常勤換算 未設定 ${noFte} = ★ 判定不能)`);
  console.log(`  要支援の利用者     ${rows.reduce((s, r) => s + r.yoboAll, 0)} 名 ` +
    `(委託 ${rows.reduce((s, r) => s + r.yoboItaku, 0)} / 区分マーカー無し ${rows.reduce((s, r) => s + r.yoboNoMarker, 0)})`);
  console.log(`  要介護の利用者     ${rows.reduce((s, r) => s + r.yokaigo, 0)} 名`);

  const diff = measurable.filter((r) => r.worst.A !== r.worst.B || r.worst.A !== r.worst.C);
  console.log(`\n── 判定 ──`);
  if (measurable.length === 0) {
    console.log(`  ✗ 常勤換算が全事業所で未設定 → ★ 測れていない`);
    process.exit(1);
  }
  const maxA = Math.max(...measurable.map((r) => r.perCm.A ?? 0));
  const maxC = Math.max(...measurable.map((r) => r.perCm.C ?? 0));
  console.log(`  最大 件数/人   A ${maxA.toFixed(1)}  /  C(上限) ${maxC.toFixed(1)}   閾値 45 (緩和 50)`);
  if (diff.length === 0) {
    console.log(`  ✅ 3 通りのどの数え方でも tier は同じ (${measurable.length} 事業所)`);
    console.log(`     → 制度解釈が未確定でも ★ 現時点の請求額は変わらない`);
  } else {
    console.log(`  ★ 数え方で tier が変わる事業所が ${diff.length} 件:`);
    for (const r of diff) console.log(`     ${r.name}  A=${r.worst.A} B=${r.worst.B} C=${r.worst.C}`);
  }
  // 負のコントロール (ルール 3-9): 閾値が動けば tier も動くことを見る
  const probe = measurable[0];
  const nc = teigenTierForIndex((probe.perCm.C ?? 0) * (probe.fte ?? 1) + 100 * (probe.fte ?? 1), probe.fte ?? 1, probe.kanwa);
  console.log(`\n  負のコントロール: ${probe.name} に +100件/人 を足すと tier ${probe.worst.C} → ${nc} ` +
    (nc === "ⅲ" ? "(検査は動いている)" : "★ 動いていない = 検査を疑うこと"));
}

main().catch((e) => { console.error(e); process.exit(1); });
