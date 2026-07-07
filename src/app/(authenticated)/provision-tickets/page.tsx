import { format, getDaysInMonth } from "date-fns";
import { createClient } from "@/lib/supabase/server";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";
import { getServiceSystemMap, isShogaiService } from "@/lib/service-system-lookup";
import { validInMonth, validToday } from "@/lib/service-code-valid";
import type {
  FormulaCode,
  GridState,
  KaigoStaff,
  KaigoUser,
  OfficeInfo,
  ServiceRow,
} from "./provision-tickets-content";
import { ProvisionTicketsShell } from "./provision-tickets-shell";

function makeRowKey(serviceType: string, startTime: string, endTime: string): string {
  return `${serviceType}__${startTime}__${endTime}`;
}

export default async function ProvisionTicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; office?: string }>;
}) {
  const { user: userId, office: officeId } = await searchParams;
  const supabase = await createClient();

  // 自事業所 (URL ?office=) のスタッフだけに絞り込む。officeId 未指定時は
  // BusinessTypeContext が初期化中なので空配列を返し、Client 側で再フェッチさせる想定。
  // Phase 9 close: members.office_id DROP 済 → member_offices junction 経由で絞り込み
  const staffQuery = officeId
    ? supabase
        .from("members")
        .select("id, name, member_offices!inner(office_id)")
        .eq("status", "active")
        .eq("member_offices.office_id", officeId)
        .order("name")
    : null;

  const [staffRes, officeRes, formulaRes] = await Promise.all([
    staffQuery ?? Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabase.from("offices").select("provider_number:business_number, office_name:name").eq("app_type", "kaigo-app").limit(1).maybeSingle(),
    // 加算系 formula コード (処遇改善加算等の monthly_aggregate type)
    // 有効期間: 今日時点で有効な世代のみ (改定跨ぎの同一コード複数世代ヒット防止)
    validToday(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_category, service_name, units, calculation_type, formula")
        .eq("system", "介護")
        .not("formula", "is", null),
    )
      .order("service_category")
      .order("service_code"),
  ]);
  const initialStaff = (staffRes.data ?? []) as KaigoStaff[];
  const initialOffice = (officeRes.data ?? null) as OfficeInfo | null;
  // serviceUnits は「基本」全件だと PostgREST 1000 行制限に切られてしまうため、
  // schedule に登場する service_type だけ後段 (userId ブロック内) で .in() 取得する
  const initialServiceUnits: Record<string, number> = {};
  const initialFormulaCodes: FormulaCode[] = (formulaRes.data ?? []) as FormulaCode[];

  let initialUser: KaigoUser | null = null;
  let initialServiceRows: ServiceRow[] = [];
  let initialGrid: GridState = {};

  if (userId) {
    const now = new Date();
    const monthStr = format(now, "yyyy-MM");
    const daysCount = getDaysInMonth(now);
    const from = `${monthStr}-01`;
    const to = `${monthStr}-${String(daysCount).padStart(2, "0")}`;

    const [userRes, scheduleRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, name_kana")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("kaigo_visit_schedule")
        .select("id, user_id, staff_id, visit_date, start_time, end_time, service_type, status, members!kaigo_visit_schedule_staff_id_fkey(name)")
        .eq("user_id", userId)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .order("start_time"),
    ]);
    initialUser = (userRes.data ?? null) as KaigoUser | null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allSchedules = (scheduleRes.data ?? []).map((r: any) => ({
      id: r.id as string,
      user_id: r.user_id as string,
      staff_id: r.staff_id as string | null,
      visit_date: r.visit_date as string,
      start_time: r.start_time as string,
      end_time: r.end_time as string,
      service_type: r.service_type as string,
      status: r.status as string,
      staff_name: (r.members?.name ?? null) as string | null,
    }));

    // 障害福祉サービスは介護保険の提供表に載せない (障害側の画面で扱う)
    const systemMap = await getServiceSystemMap(
      supabase,
      allSchedules.map((s) => s.service_type),
      { year: now.getFullYear(), month: now.getMonth() + 1 },
    );
    const schedules = allSchedules.filter(
      (s) => !isShogaiService(systemMap, s.service_type),
    );

    const rowMap = new Map<string, ServiceRow>();
    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      if (!rowMap.has(key)) {
        rowMap.set(key, {
          key,
          service_type: s.service_type,
          start_time: s.start_time,
          end_time: s.end_time,
          staff_id: s.staff_id ?? undefined,
          staff_name: s.staff_name ?? undefined,
        });
      }
    }
    const newGrid: GridState = {};
    for (const [key] of rowMap) newGrid[key] = {};
    for (const s of schedules) {
      const key = makeRowKey(s.service_type, s.start_time, s.end_time);
      const day = parseInt(s.visit_date.split("-")[2], 10);
      if (!newGrid[key][day]) newGrid[key][day] = { planned: false, actual: false };
      if (s.status === "scheduled" || s.status === "changed") newGrid[key][day].planned = true;
      // 実績は「予定どおり実施」として予定にも計上する (ほのぼの 準拠)
      if (s.status === "completed") {
        newGrid[key][day].planned = true;
        newGrid[key][day].actual = true;
      }
    }
    initialServiceRows = Array.from(rowMap.values()).sort((a, b) => a.start_time.localeCompare(b.start_time));
    initialGrid = newGrid;

    // schedule に登場する service_type の単位数だけを取得
    // マスタは全角数字 (身体介護３)、schedule は半角混在 (身体介護3) のため
    // variants で検索し、正規化キー (半角) で引ける map にする
    const serviceTypes = Array.from(new Set(schedules.map((s) => s.service_type))).filter(Boolean);
    if (serviceTypes.length > 0) {
      // 有効期間: 対象月に有効な世代のみ (改定跨ぎの複数世代ヒット防止)
      const { data: codeRows } = await validInMonth(
        supabase
          .from("kaigo_service_codes")
          .select("service_name, units")
          .in("service_name", serviceNameVariantsAll(serviceTypes))
          .eq("calculation_type", "基本"),
        now.getFullYear(),
        now.getMonth() + 1,
      );
      const byNorm = new Map<string, number>();
      for (const sc of (codeRows ?? []) as { service_name: string; units: number }[]) {
        const key = toHankakuDigits(sc.service_name);
        if (!byNorm.has(key)) byNorm.set(key, sc.units);
      }
      for (const t of serviceTypes) {
        const units = byNorm.get(toHankakuDigits(t));
        if (units !== undefined && !(t in initialServiceUnits)) {
          initialServiceUnits[t] = units;
        }
      }
    }
  }

  // 利用者切替は shell 内で client-side に行う (server 再実行を避けて高速化)
  return (
    <ProvisionTicketsShell
      initialUserId={userId ?? null}
      initialUser={initialUser}
      initialStaff={initialStaff}
      initialServiceUnits={initialServiceUnits}
      initialOffice={initialOffice}
      initialServiceRows={initialServiceRows}
      initialGrid={initialGrid}
      initialFormulaCodes={initialFormulaCodes}
    />
  );
}
