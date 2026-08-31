"use client";

/**
 * 請求個人設定 (居宅介護支援) — billing/seikyu の先頭タブ (ほのぼの居宅版レイアウト)
 *
 * 上段: 事業所単位の加減算 (特定事業所加算区分・医療介護連携・地域区分/単価・
 *       所属スタッフ数) の表示のみ (加算管理 /addons と 自事業所管理 /master/office から読む)
 * 本体: 利用者 × 加算マトリクス
 *   - 行 = 当事業所 (client_office_assignments) の全利用者
 *          (claims 有無問わず。claims 未生成者はグレーで編集不可)
 *   - 列 = フリガナ・性別・電話 | 初回加算 | 退院・退所加算 | 入院時情報連携 |
 *          緊急時等カンファ | 運営基準減算 | ターミナル | 通院時情報連携 | メッセージ(notes)
 *   - セル変更で該当 claim を即 UPDATE (単位・金額の再計算含む)
 *   - フッタ = 列ごとの該当件数
 * 入退院連動: 対象月に入院記録 (client_hospitalizations) がある利用者の
 *   入院時情報連携・退院退所セルに 🏥 ヒント。入院記録が無いのに加算を選ぶと amber 注意。
 *
 * ※ 一括生成 (レセプト編集) では個別加算は全て OFF で生成される。
 *   利用者ごとの算定はこのタブで行う (旧「届出があれば全員自動算定」は廃止)。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, AlertCircle, SquarePen } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  useKyotakuSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
} from "./_seikyu-context";
import {
  HOSPITAL_COORD_UNITS,
  DISCHARGE_UNITS,
  reductionUnitsOf,
  calcTotals,
  isYoboShienLevel,
  parseYoboShienKubun,
  isAddonActiveInMonth,
  type ClaimRow,
  type ClaimStatus,
  type HospitalCoordType,
  type DischargeType,
} from "../claims/claims-shared";
import { resolveCertForMonth, monthRange } from "@/lib/cert-for-month";
import { mapChunksParallel, ID_IN_CHUNK } from "@/lib/chunk-parallel";
import {
  getHospitalizationMap,
  hospitalizationsInRange,
  type HospitalizationPeriod,
} from "@/lib/hospitalization";

const PAGE = 1000;
// .in() の URI Too Long 回避用チャンク (_seikyu-context と同値)
const IN_CHUNK = ID_IN_CHUNK;

// 状態 / フリガナ・利用者名 / 性別 / 電話 / 初回 / 退院退所 / 入院時 / 緊急時 / 運営基準 / ターミナル / 通院時 / メッセージ
const GRID_COLS =
  "grid grid-cols-[56px_minmax(140px,1.2fr)_36px_minmax(96px,0.9fr)_44px_86px_78px_52px_52px_52px_52px_minmax(120px,1.4fr)]";

interface ClientRow {
  id: string;
  name: string;
  furigana: string | null;
  gender: string | null;
  phone: string | null;
  mobile: string | null;
}

interface MatrixRow {
  client: ClientRow;
  claim: ClaimRow | null;
  careLevel: string | null;
  hospInMonth: HospitalizationPeriod[];
}

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "未確定",
  confirmed: "確定済",
  submitted: "請求済",
};

const DISCHARGE_OPTIONS: { value: DischargeType; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "i_i", label: "Ⅰイ" },
  { value: "i_ro", label: "Ⅰロ" },
  { value: "ii_i", label: "Ⅱイ" },
  { value: "ii_ro", label: "Ⅱロ" },
  { value: "iii", label: "Ⅲ" },
];

// マトリクスで編集する加算の patch
interface MatrixPatch {
  initial?: boolean;
  discharge?: DischargeType;
  hospitalization?: HospitalCoordType;
  emergency?: boolean;
  unei?: boolean;
  terminal?: boolean;
  outpatient?: boolean;
}

export function KyotakuKojinSetteiContent() {
  const { monthKey, year, month, loading: ctxLoading, officeId, kanaMatches, reload } =
    useKyotakuSeikyuContext();
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [careLevelByClient, setCareLevelByClient] = useState<Map<string, string | null>>(new Map());
  const [hospMap, setHospMap] = useState<Map<string, HospitalizationPeriod[]>>(new Map());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  // notes 編集の draft (claim.id → text)。blur で保存
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});

  // ── 上段: 事業所単位の加減算 (表示のみ) ──
  const [officePanel, setOfficePanel] = useState<{
    tokutei: string | null;
    medicalCoop: boolean;
    area: string | null;
    unitPrice: number | null;
    addonNames: string[];
    staffCount: number | null;
    // 処遇改善加算 (居宅介護支援)。セル変更時の再計算に使うので表示以外にも要る
    shoguuPermil: number;
    shoguuCode: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    // 事業所が解決できるまでは読み込まない (解決中は Provider 側の ctxLoading で spinner)
    if (!officeId) {
      setClients([]);
      setClaims([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // 1) 当事業所の利用者 (active。法人エントリ除外)
      //    「自事業所」は client_office_assignments 経由 (clients.office_id は使わない)。
      //    以前は全法人の利用者 4500 名超を引いていたため、下の 認定/入退院 の chunk 往復が
      //    90 回超の直列となり読み込みが数十秒 = 事実上フリーズしていた。加えて他事業所
      //    (訪問介護等) の利用者が居宅の請求個人設定に並んでいた。
      //    母集団は介護請求タブ (fetchKyotakuClaimRows) と揃える (end_date は同様に見ない)。
      const cls: ClientRow[] = [];
      {
        let from = 0;
        while (true) {
          const { data, error: e } = await supabase
            .from("clients")
            .select(
              "id, name, furigana, gender, phone, mobile, client_office_assignments!inner(office_id)",
            )
            .eq("client_office_assignments.office_id", officeId)
            .eq("status", "active")
            .eq("is_facility", false)
            .is("deleted_at", null)
            .order("furigana", { ascending: true, nullsFirst: false })
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (e) throw new Error(`利用者の取得に失敗: ${e.message}`);
          if (!data || data.length === 0) break;
          cls.push(...(data as unknown as ClientRow[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }
      setClients(cls);
      if (cls.length === 0) {
        setClaims([]);
        setCareLevelByClient(new Map());
        setHospMap(new Map());
        return;
      }
      const clientIds = cls.map((c) => c.id);

      // 2) 対象月の claims (当事業所の利用者分のみ)
      //    select * — unei_kijun_gensan 列は migration 適用前でも壊れない
      const claimChunks = await mapChunksParallel(clientIds, IN_CHUNK, async (chunk) => {
        const acc: ClaimRow[] = [];
        let from = 0;
        while (true) {
          const { data, error: e } = await supabase
            .from("kaigo_care_support_claims")
            .select("*")
            .eq("billing_month", monthKey)
            .in("user_id", chunk)
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1);
          if (e) throw new Error(`レセプトの取得に失敗: ${e.message}`);
          if (!data || data.length === 0) break;
          acc.push(...(data as ClaimRow[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }
        return acc;
      });
      setClaims(claimChunks.flat());

      // 3) 対象月に有効な認定 (要介護度 — 要支援は個別加算 対象外の判定に使用)
      // 4) 入退院 (対象月ヒント + 加算矛盾注意用)
      //    互いに独立なので並列 (直列だと chunk 往復が積み上がる)
      const [certRes, hm] = await Promise.all([
        resolveCertForMonth(supabase, clientIds, year, month),
        getHospitalizationMap(supabase, clientIds),
      ]);
      setCareLevelByClient(
        new Map(cls.map((c) => [c.id, certRes.get(c.id)?.care_level ?? null])),
      );
      setHospMap(hm);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setClients([]);
      setClaims([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, monthKey, year, month, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    load();
  }, [load]);

  // 事業所単位パネル (加算管理 + 自事業所管理 + 所属スタッフ数)
  useEffect(() => {
    if (!officeId) return;
    let cancelled = false;
    (async () => {
      try {
        const [officeRes, addonsRes, staffRes] = await Promise.all([
          supabase
            .from("offices")
            .select("tokutei_kassan_type, medical_cooperation_kassan, area_category, unit_price, care_support_shoguu_code, care_support_shoguu_permil")
            .eq("id", officeId)
            .maybeSingle(),
          supabase
            .from("kaigo_billing_addons")
            .select("addon_code, status, applied_from, expires_at")
            .eq("office_id", officeId)
            .eq("business_type", "居宅介護支援")
            .eq("status", "active")
            .order("addon_code", { ascending: true })
            .limit(200),
          supabase
            .from("member_offices")
            .select("member_id", { count: "exact", head: true })
            .eq("office_id", officeId),
        ]);
        if (officeRes.error) throw new Error(officeRes.error.message);
        if (addonsRes.error) throw new Error(addonsRes.error.message);
        // member_offices は count のみ (error は握らず null 表示)
        const activeAddons = ((addonsRes.data ?? []) as {
          addon_code: string;
          status: string;
          applied_from: string;
          expires_at: string | null;
        }[]).filter((a) => isAddonActiveInMonth(a, monthKey));
        if (cancelled) return;
        setOfficePanel({
          tokutei: (officeRes.data?.tokutei_kassan_type as string | null) ?? null,
          medicalCoop: !!officeRes.data?.medical_cooperation_kassan,
          area: (officeRes.data?.area_category as string | null) ?? null,
          unitPrice: officeRes.data?.unit_price != null ? Number(officeRes.data.unit_price) : null,
          addonNames: activeAddons.map((a) => a.addon_code),
          staffCount: staffRes.error ? null : staffRes.count ?? null,
          shoguuPermil: Number(officeRes.data?.care_support_shoguu_permil ?? 0) || 0,
          shoguuCode: (officeRes.data?.care_support_shoguu_code as string | null) ?? null,
        });
      } catch (e) {
        console.error("事業所単位加減算の取得に失敗:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, officeId, monthKey]);

  // ── マトリクス行 (カナ索引適用) ──
  const { from: mFrom, to: mTo } = monthRange(year, month);
  const matrixRows = useMemo<MatrixRow[]>(() => {
    const claimByUser = new Map(claims.map((c) => [c.user_id, c]));
    return clients
      .filter((c) => kanaMatches({ user_name_kana: c.furigana, user_name: c.name }))
      .map((c) => ({
        client: c,
        claim: claimByUser.get(c.id) ?? null,
        careLevel: careLevelByClient.get(c.id) ?? null,
        hospInMonth: hospitalizationsInRange(hospMap.get(c.id), mFrom, mTo),
      }));
  }, [clients, claims, careLevelByClient, hospMap, kanaMatches, mFrom, mTo]);

  // ── セル変更 → 即 UPDATE (単位・金額の再計算含む) ──
  const applyPatch = async (row: MatrixRow, patch: MatrixPatch) => {
    const c = row.claim;
    if (!c) return;
    const next = {
      initial: patch.initial ?? c.initial_addition,
      discharge:
        patch.discharge ??
        ((c.discharge_type as DischargeType) ?? (c.discharge_addition ? "i_ro" : "none")),
      hospitalization:
        patch.hospitalization ??
        ((c.hospital_coordination
          ? c.hospital_coordination_units >= 250
            ? "i"
            : "ii"
          : "none") as HospitalCoordType),
      emergency: patch.emergency ?? (c.emergency_conference ?? false),
      unei: patch.unei ?? (c.unei_kijun_gensan ?? false),
      terminal: patch.terminal ?? (c.terminal_care ?? false),
      outpatient: patch.outpatient ?? c.medical_coordination,
    };

    // 加算単位 (特定事業所・医療介護連携は事業所体制系 = claim の既存値を保持)
    const addUnits =
      (next.initial ? 300 : 0) +
      (c.tokutei_kassan_units ?? 0) +
      (c.medical_coop_kassan ? (c.medical_coop_kassan_units ?? 125) : 0) +
      HOSPITAL_COORD_UNITS[next.hospitalization] +
      DISCHARGE_UNITS[next.discharge] +
      (next.outpatient ? 50 : 0) +
      (next.terminal ? 400 : 0) +
      (next.emergency ? 200 : 0);
    // 減算 (round 方式。BCP/虐待は claim の既存値、運営基準はマトリクスから)
    const uneiUnits = next.unei ? reductionUnitsOf(c.units, 50) : 0;
    const reductionUnits =
      (c.bcp_not_prepared ? reductionUnitsOf(c.units, c.bcp_reduction_pct || 1) : 0) +
      (c.abuse_prevention_not_implemented
        ? reductionUnitsOf(c.units, c.abuse_reduction_pct || 1)
        : 0) +
      uneiUnits;
    // 2026-08-31 監査での是正:
    //   以前は `c.units + addUnits - reductionUnits` で total を組み、
    //   **処遇改善加算を再計算していなかった** (payload にも入れていなかった)。
    //   加算を 1 つ ON にすると DB の total_amount / 正しい額 / 伝送 8124 が
    //   3 者とも食い違う状態になっていた。金額は必ず calcTotals を通す。
    //
    //   事業所設定 (率) が未読込のまま保存すると処遇改善 0 を書き込んでしまうので、
    //   読み込めるまで保存させない。
    if (!officePanel) {
      toast.error("事業所設定を読み込み中です。少し待ってからもう一度お試しください。");
      return;
    }
    // 予防支援 (46 始まり) には居宅介護支援の処遇改善は付かない
    const shoguuPermil = String(c.care_support_code ?? "").startsWith("43")
      ? officePanel.shoguuPermil
      : 0;
    const {
      total_amount: totalAmount,
      insurance_amount: insuranceAmount,
      shoguu_units: shoguuUnits,
    } = calcTotals(c.units, addUnits, reductionUnits, c.unit_price, shoguuPermil);

    const basePayload: Record<string, unknown> = {
      initial_addition: next.initial,
      initial_addition_units: next.initial ? 300 : 0,
      hospital_coordination: next.hospitalization !== "none",
      hospital_coordination_units: HOSPITAL_COORD_UNITS[next.hospitalization],
      discharge_addition: next.discharge !== "none",
      discharge_addition_units: DISCHARGE_UNITS[next.discharge],
      discharge_type: next.discharge === "none" ? null : next.discharge,
      medical_coordination: next.outpatient,
      medical_coordination_units: next.outpatient ? 50 : 0,
      terminal_care: next.terminal,
      terminal_care_units: next.terminal ? 400 : 0,
      emergency_conference: next.emergency,
      emergency_conference_units: next.emergency ? 200 : 0,
      total_amount: totalAmount,
      insurance_amount: insuranceAmount,
      shoguu_kaizen_units: shoguuUnits,
      shoguu_kaizen_code:
        shoguuUnits > 0 ? (officePanel.shoguuCode ?? c.shoguu_kaizen_code ?? null) : null,
      updated_at: new Date().toISOString(),
    };

    setSavingIds((prev) => new Set(prev).add(c.id));
    try {
      // 運営基準減算列は migration (kyotaku_billing_kojin_settei.sql) 適用後のみ存在
      let { error: e } = await supabase
        .from("kaigo_care_support_claims")
        .update({
          ...basePayload,
          unei_kijun_gensan: next.unei,
          unei_kijun_gensan_units: uneiUnits,
        })
        .eq("id", c.id);
      if (e && (e.code === "PGRST204" || e.code === "42703")) {
        if (patch.unei !== undefined) {
          toast.error(
            "運営基準減算列が未作成です。migrations/kyotaku_billing_kojin_settei.sql を適用してください",
          );
          return;
        }
        // 運営基準以外の変更は列なしで保存continue
        ({ error: e } = await supabase
          .from("kaigo_care_support_claims")
          .update(basePayload)
          .eq("id", c.id));
      }
      if (e) {
        toast.error("保存に失敗: " + e.message);
        return;
      }
      // 入退院整合の注意 (保存は許可)
      if (
        (next.hospitalization !== "none" || next.discharge !== "none") &&
        row.hospInMonth.length === 0 &&
        (patch.hospitalization !== undefined || patch.discharge !== undefined)
      ) {
        toast.warning(
          `${row.client.name}: 対象月に入院記録がありません (入退院連動の確認を推奨)`,
        );
      }
      await load();
      reload(); // 介護請求/国保請求タブの表示も更新
    } finally {
      setSavingIds((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(c.id);
        return nextSet;
      });
    }
  };

  // notes (メッセージ) 保存
  const saveNotes = async (claim: ClaimRow, text: string) => {
    if (text === (claim.notes ?? "")) return;
    const { error: e } = await supabase
      .from("kaigo_care_support_claims")
      .update({ notes: text || null, updated_at: new Date().toISOString() })
      .eq("id", claim.id);
    if (e) {
      toast.error("メッセージの保存に失敗: " + e.message);
      return;
    }
    await load();
    reload();
  };

  // ── フッタ: 列ごとの該当件数 ──
  const counts = useMemo(() => {
    const withClaim = matrixRows.filter((r) => r.claim);
    return {
      total: matrixRows.length,
      withClaim: withClaim.length,
      initial: withClaim.filter((r) => r.claim!.initial_addition).length,
      discharge: withClaim.filter((r) => r.claim!.discharge_addition).length,
      hospital: withClaim.filter((r) => r.claim!.hospital_coordination).length,
      emergency: withClaim.filter((r) => r.claim!.emergency_conference).length,
      unei: withClaim.filter((r) => r.claim!.unei_kijun_gensan).length,
      terminal: withClaim.filter((r) => r.claim!.terminal_care).length,
      outpatient: withClaim.filter((r) => r.claim!.medical_coordination).length,
    };
  }, [matrixRows]);

  const chkCls = "h-4 w-4 accent-blue-600 cursor-pointer disabled:cursor-not-allowed";
  const selCls =
    "w-full border border-gray-300 rounded px-0.5 py-0 text-[11px] bg-white focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:cursor-not-allowed";

  return (
    <div className="flex flex-1 min-h-0">
      <SeikyuKanaSidebar />

      <div className="flex flex-col flex-1 min-w-0">
        {/* ── ツールバー ── */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <SeikyuMonthNav />
          <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">
            請求個人設定
          </span>
          <span className="text-xs text-gray-500">{matrixRows.length} 名</span>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/billing/claims"
              title="レセプトの一括生成・確定は既存のレセプト管理画面から"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 text-xs"
            >
              <SquarePen size={13} />
              レセプト編集 (一括生成)
            </Link>
          </div>
        </div>

        {/* ── 上段: 事業所単位の加減算 (表示のみ) ── */}
        <div className="border-b border-gray-200 bg-white px-3 py-1.5 shrink-0 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-semibold text-gray-600">事業所単位:</span>
          <span
            className={`rounded-full border px-2 py-0.5 ${officePanel?.tokutei && officePanel.tokutei !== "なし" ? "border-indigo-300 bg-indigo-50 text-indigo-700 font-medium" : "border-gray-200 text-gray-400"}`}
          >
            特定事業所加算 {officePanel?.tokutei && officePanel.tokutei !== "なし" ? officePanel.tokutei : "なし"}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 ${officePanel?.medicalCoop ? "border-cyan-300 bg-cyan-50 text-cyan-700 font-medium" : "border-gray-200 text-gray-400"}`}
          >
            医療介護連携加算
          </span>
          <span className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-gray-700">
            地域区分 {officePanel?.area ?? "その他"} / 単価{" "}
            {officePanel?.unitPrice != null ? officePanel.unitPrice.toFixed(2) : "10.00"}円
          </span>
          <span className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-gray-700">
            所属スタッフ {officePanel?.staffCount ?? "—"} 名 (常勤ケアマネ数の参考)
          </span>
          {officePanel && officePanel.addonNames.length > 0 && (
            <span className="text-gray-500 truncate" title={officePanel.addonNames.join("、")}>
              届出済加算: {officePanel.addonNames.join("、")}
            </span>
          )}
          <a href="/addons" className="text-blue-600 hover:underline">加算管理 →</a>
          <a href="/master/offices?tab=group" className="text-blue-600 hover:underline">自事業所管理 →</a>
        </div>

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {loading || ctxLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={22} className="animate-spin text-indigo-400" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {/* ヘッダー行 */}
              <div className={`${GRID_COLS} border-b border-gray-400 bg-gradient-to-b from-sky-100 to-sky-200 text-[11px] leading-4 font-medium text-gray-700 text-center sticky top-0 z-10`}>
                <div className="px-1 py-1">状態</div>
                <div className="px-1 py-1 border-l border-sky-300 text-left">利用者名 / フリガナ</div>
                <div className="px-1 py-1 border-l border-sky-300">性別</div>
                <div className="px-1 py-1 border-l border-sky-300">電話</div>
                <div className="px-1 py-1 border-l border-sky-300 text-blue-800">初回<br />加算</div>
                <div className="px-1 py-1 border-l border-sky-300 text-blue-800">退院・退所<br />加算</div>
                <div className="px-1 py-1 border-l border-sky-300 text-blue-800">入院時<br />情報連携</div>
                <div className="px-1 py-1 border-l border-sky-300 text-blue-800">緊急時<br />カンファ</div>
                <div className="px-1 py-1 border-l border-sky-300 text-red-700 bg-red-50/60">運営基準<br />減算</div>
                <div className="px-1 py-1 border-l border-sky-300 text-blue-800">ターミ<br />ナル</div>
                <div className="px-1 py-1 border-l border-sky-300 text-blue-800">通院時<br />情報連携</div>
                <div className="px-1 py-1 border-l border-sky-300">メッセージ</div>
              </div>

              {matrixRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10 text-sm">
                  対象の利用者がいません
                </p>
              ) : matrixRows.map((r) => {
                const c = r.claim;
                const isYobo = isYoboShienLevel(r.careLevel);
                const itaku = c ? parseYoboShienKubun(c.notes) === "itaku" : false;
                const locked = !c || c.status !== "draft" || isYobo || itaku;
                const saving = c ? savingIds.has(c.id) : false;
                const hasHosp = r.hospInMonth.length > 0;
                // 入院記録が無いのに入院系加算あり → amber 注意
                const hospMismatch =
                  !!c && !hasHosp && (c.hospital_coordination || c.discharge_addition);
                const hospTitle = hasHosp
                  ? `対象月に入院記録あり: ${r.hospInMonth
                      .map((h) => `${h.hospital_name ?? "入院"} ${h.admission_date}〜${h.discharge_date ?? "入院中"}`)
                      .join(" / ")}`
                  : "対象月の入院記録なし";
                const rowCls = !c
                  ? "bg-gray-100 text-gray-400"
                  : saving
                    ? "bg-blue-50/50"
                    : "bg-white hover:bg-sky-50";
                return (
                  <div
                    key={r.client.id}
                    className={`${GRID_COLS} border-b border-gray-200 text-[11px] leading-4 transition-colors ${rowCls}`}
                  >
                    {/* 状態 */}
                    <div className="px-1 py-1 text-center">
                      {!c ? (
                        <span
                          className="text-gray-400"
                          title="レセプト未生成。レセプト編集 (一括生成) 後に編集できます"
                        >
                          未生成
                        </span>
                      ) : itaku ? (
                        <span className="text-gray-500">委託</span>
                      ) : (
                        <span className={c.status === "draft" ? "text-yellow-700" : "text-emerald-700"}>
                          {CLAIM_STATUS_LABELS[c.status]}
                        </span>
                      )}
                    </div>
                    {/* 利用者名 / フリガナ */}
                    <div className="px-1.5 py-0.5 border-l border-gray-200 min-w-0">
                      <div className="text-[9px] text-gray-400 leading-tight truncate">
                        {r.client.furigana ?? ""}
                      </div>
                      <div className={`leading-tight truncate font-medium ${c ? "text-gray-900" : "text-gray-400"}`}>
                        {r.client.name}
                        {isYobo && (
                          <span className="ml-1 rounded bg-purple-50 px-1 text-[9px] text-purple-600" title="要支援 (介護予防支援) は居宅介護支援費の個別加算は算定不可">
                            {r.careLevel}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* 性別 */}
                    <div className="px-1 py-1 border-l border-gray-200 text-center">
                      <span className={r.client.gender === "女" ? "text-pink-600" : "text-blue-600"}>
                        {r.client.gender ?? "—"}
                      </span>
                    </div>
                    {/* 電話 */}
                    <div className="px-1 py-0.5 border-l border-gray-200 text-gray-500 text-[10px]">
                      <div className="truncate">{r.client.phone ?? ""}</div>
                      <div className="truncate text-gray-400">{r.client.mobile ?? ""}</div>
                    </div>
                    {/* 初回加算 */}
                    <div className="px-1 py-1 border-l border-gray-200 text-center">
                      <input
                        type="checkbox"
                        checked={c?.initial_addition ?? false}
                        disabled={locked || saving}
                        onChange={(e) => applyPatch(r, { initial: e.target.checked })}
                        className={chkCls}
                      />
                    </div>
                    {/* 退院・退所加算 (入退院連動: 🏥 ヒント / 記録なし選択は amber) */}
                    <div
                      className={`px-1 py-0.5 border-l border-gray-200 ${hospMismatch && c?.discharge_addition ? "bg-amber-100" : ""}`}
                      title={hospTitle}
                    >
                      <div className="flex items-center gap-0.5">
                        {hasHosp && <span title={hospTitle}>🏥</span>}
                        <select
                          value={(c?.discharge_type as DischargeType) ?? (c?.discharge_addition ? "i_ro" : "none")}
                          disabled={locked || saving}
                          onChange={(e) => applyPatch(r, { discharge: e.target.value as DischargeType })}
                          className={selCls}
                        >
                          {DISCHARGE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {/* 入院時情報連携 */}
                    <div
                      className={`px-1 py-0.5 border-l border-gray-200 ${hospMismatch && c?.hospital_coordination ? "bg-amber-100" : ""}`}
                      title={hospTitle}
                    >
                      <div className="flex items-center gap-0.5">
                        {hasHosp && <span title={hospTitle}>🏥</span>}
                        <select
                          value={
                            c?.hospital_coordination
                              ? c.hospital_coordination_units >= 250
                                ? "i"
                                : "ii"
                              : "none"
                          }
                          disabled={locked || saving}
                          onChange={(e) => applyPatch(r, { hospitalization: e.target.value as HospitalCoordType })}
                          className={selCls}
                        >
                          <option value="none">なし</option>
                          <option value="i">Ⅰ</option>
                          <option value="ii">Ⅱ</option>
                        </select>
                      </div>
                    </div>
                    {/* 緊急時等カンファ */}
                    <div className="px-1 py-1 border-l border-gray-200 text-center">
                      <input
                        type="checkbox"
                        checked={c?.emergency_conference ?? false}
                        disabled={locked || saving}
                        onChange={(e) => applyPatch(r, { emergency: e.target.checked })}
                        className={chkCls}
                      />
                    </div>
                    {/* 運営基準減算 */}
                    <div className="px-1 py-1 border-l border-gray-200 text-center bg-red-50/30">
                      <input
                        type="checkbox"
                        checked={c?.unei_kijun_gensan ?? false}
                        disabled={locked || saving}
                        onChange={(e) => applyPatch(r, { unei: e.target.checked })}
                        title="運営基準減算 (所定単位数×50%)"
                        className="h-4 w-4 accent-red-600 cursor-pointer disabled:cursor-not-allowed"
                      />
                    </div>
                    {/* ターミナル */}
                    <div className="px-1 py-1 border-l border-gray-200 text-center">
                      <input
                        type="checkbox"
                        checked={c?.terminal_care ?? false}
                        disabled={locked || saving}
                        onChange={(e) => applyPatch(r, { terminal: e.target.checked })}
                        className={chkCls}
                      />
                    </div>
                    {/* 通院時情報連携 */}
                    <div className="px-1 py-1 border-l border-gray-200 text-center">
                      <input
                        type="checkbox"
                        checked={c?.medical_coordination ?? false}
                        disabled={locked || saving}
                        onChange={(e) => applyPatch(r, { outpatient: e.target.checked })}
                        className={chkCls}
                      />
                    </div>
                    {/* メッセージ (notes) */}
                    <div className="px-1 py-0.5 border-l border-gray-200">
                      {c ? (
                        <input
                          type="text"
                          value={notesDraft[c.id] ?? c.notes ?? ""}
                          disabled={c.status !== "draft"}
                          onChange={(e) =>
                            setNotesDraft((prev) => ({ ...prev, [c.id]: e.target.value }))
                          }
                          onBlur={(e) => {
                            saveNotes(c, e.target.value);
                            setNotesDraft((prev) => {
                              const nx = { ...prev };
                              delete nx[c.id];
                              return nx;
                            });
                          }}
                          placeholder="メモ"
                          className="w-full border border-gray-200 rounded px-1 py-0.5 text-[10px] text-gray-600 bg-white focus:border-blue-500 focus:outline-none disabled:bg-gray-50"
                        />
                      ) : (
                        <span className="text-[10px] text-gray-400">一括生成後に編集可</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── フッタ: 列ごとの該当件数 ── */}
            <div className="border-t border-gray-400 bg-gray-100 px-3 py-1.5 shrink-0 text-[11px] text-gray-800 flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">利用者</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[48px] text-right font-mono">{counts.total}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">レセプトあり</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[48px] text-right font-mono">{counts.withClaim}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">初回</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.initial}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">退院退所</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.discharge}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">入院時</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.hospital}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">緊急時</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.emergency}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-red-50 px-2 py-0.5 whitespace-nowrap text-red-700">運営基準</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.unei}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">ターミナル</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.terminal}</span>
              </span>
              <span className="inline-flex">
                <span className="border border-gray-400 bg-sky-100 px-2 py-0.5 whitespace-nowrap">通院時</span>
                <span className="border border-gray-400 border-l-0 bg-white px-2 py-0.5 min-w-[40px] text-right font-mono">{counts.outpatient}</span>
              </span>
              <span className="ml-auto text-gray-400">
                🏥 = 対象月に入院記録あり / 黄 = 入院記録なしで入院系加算あり (要確認)
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
