"use client";

/**
 * 国保請求 (居宅介護支援) — 国保連請求の集計 + 伝送ファイル・確認用CSV の作成
 * (見た目: billing-visit/kokuho-seikyu と同一のグレーヘッダ + 格子テーブル)
 *
 * 出力 (居宅介護支援事業所編の正式インタフェース / Shift_JIS):
 *   ファイル 1: 給付管理票 (8211 総括票 + 8221 給付管理票) — kaigo_benefit_management から
 *   ファイル 2: 居宅介護支援費請求 (7111 請求書 + 8121 明細書) — レセプトから
 *
 * kaigo_billing_status 連携:
 *   - 当月分のうち 月遅れ/返戻 フラグの行は伝送から除外 (後月に再請求)
 *   - 過去月の月遅れ/返戻 (未・国保対象) は再請求行として合流し、
 *     元提供月ごとに別ファイルとして出力する
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertCircle,
  Download,
  Send,
} from "lucide-react";
import Encoding from "encoding-japanese";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { ShinsaKekkaImport } from "@/components/kokuho-shinsa/shinsa-import";
import {
  useKyotakuSeikyuContext,
  SeikyuKanaSidebar,
  SeikyuMonthNav,
  loadKyotakuReSeikyuRows,
  parseKyufuKanriKubun,
  describeInsurerChange,
  KYUFU_KANRI_KUBUN_LABELS,
  type KyufuKanriKubun,
  type KyotakuSeikyuRow,
  type KyotakuReSeikyuRow,
} from "./_seikyu-context";
import {
  buildKyufuKanriFile,
  buildKeikakuhiFile,
  SERVICE_KIND_CODE,
  type KyufuKanriUser,
  type KyufuKanriSegment,
  type KyufuKanriDailyActual,
  type KeikakuhiUser,
} from "@/lib/kokuho-densou/build-kyotaku";
import {
  resolveCertsInMonth,
  resolveCertSegmentsForMonth,
} from "@/lib/cert-for-month";
import { validInMonth } from "@/lib/service-code-valid";
import {
  serviceNameVariantsAll,
  toHankakuDigits,
} from "@/lib/service-name-normalize";

// 対象 / 提供年月 / 保険者番号 / 被保険者番号 / 利用者名 / 要介護度 / 単位数 / 保険請求額 / 状態 / 給管作成区分
const GRID_COLS =
  "grid grid-cols-[32px_64px_88px_104px_1fr_72px_80px_96px_72px_80px]";

// kaigo_billing_status の 1 行 (当月フラグ確認 + 給付管理票作成区分マーカー用)
interface BillingStatusRow {
  client_id: string;
  tsukiokure: boolean;
  henrei: boolean;
  notes: string | null;
}

// 一覧の 1 行 (当月通常行 or 過去月の再請求行)
interface DisplayRow {
  key: string;
  row: KyotakuSeikyuRow;
  origMonthKey: string; // 'YYYY-MM'
  isReSeikyu: boolean;
  reasons: { tsukiokure: boolean; henrei: boolean } | null;
  /** kaigo_billing_status.notes (給付管理票 作成区分マーカー) */
  statusNotes: string | null;
}

// .in() の URI Too Long 対策 chunk (claims-content と同じ 50 個)
const IN_CHUNK_SIZE = 50;
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Shift_JIS でダウンロード (仕様: 伝送ファイルの文字コードはシフト JIS)
function downloadSjis(r: { content: string; fileName: string }) {
  const sjis = Encoding.convert(Encoding.stringToCode(r.content), {
    to: "SJIS",
    from: "UNICODE",
  });
  const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = r.fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function KyotakuKokuhoSeikyuContent() {
  const {
    year, month, monthKey, filteredRows, kanaMatches, loading, error,
    officeNumber, unitPrice, officeId, tenantId, onMonthChange,
  } = useKyotakuSeikyuContext();
  const supabase = useMemo(() => createClient(), []);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusByClient, setStatusByClient] = useState<Map<string, BillingStatusRow>>(new Map());
  const [reRows, setReRows] = useState<KyotakuReSeikyuRow[]>([]);
  const [exporting, setExporting] = useState(false);
  // 介護予防支援(46)の事業所番号 (office_service_designations)。要支援者は43と別番号で請求
  const [yoboNumber, setYoboNumber] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所切替時の derived reset/fetch
    if (!officeId) { setYoboNumber(null); return; }
    (async () => {
      const { data } = await supabase
        .from("office_service_designations")
        .select("business_number")
        .eq("office_id", officeId)
        .eq("service_category", "46")
        .maybeSingle();
      if (!cancelled) setYoboNumber(((data?.business_number ?? "") as string).trim() || null);
    })();
    return () => { cancelled = true; };
  }, [supabase, officeId]);

  // ── kaigo_billing_status (当月) — 月遅れ/返戻の除外判定用 (事業所単位) ──
  const loadStatus = useCallback(async () => {
    if (!officeId) {
      setStatusByClient(new Map());
      return;
    }
    const { data, error: e } = await supabase
      .from("kaigo_billing_status")
      .select("client_id, tsukiokure, henrei, notes")
      .eq("office_id", officeId)
      .eq("target_month", monthKey);
    if (e) {
      // table 未作成 (42P01) / PostgREST schema cache 未反映 (PGRST205) は状態なしとして続行
      if (e.code !== "42P01" && e.code !== "PGRST205") {
        toast.error("請求状態の取得に失敗: " + e.message);
      }
      setStatusByClient(new Map());
      return;
    }
    setStatusByClient(
      new Map(((data ?? []) as BillingStatusRow[]).map((r) => [r.client_id, r])),
    );
  }, [supabase, monthKey, officeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月変更時の fetch
    loadStatus();
  }, [loadStatus]);

  // ── 再請求行 (過去月の月遅れ/返戻・未国保対象) ──
  const loadReRows = useCallback(async () => {
    if (!officeId) {
      setReRows([]);
      return;
    }
    try {
      const list = await loadKyotakuReSeikyuRows(supabase, monthKey, officeId);
      setReRows(list);
    } catch (e) {
      toast.error(
        "再請求分の読込に失敗: " + (e instanceof Error ? e.message : String(e)),
      );
      setReRows([]);
    }
  }, [supabase, monthKey, officeId]);

  useEffect(() => {
    if (loading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月/事業所変更時の fetch
    loadReRows();
  }, [loading, loadReRows]);

  // ── 表示行: 再請求 (過去分) を上、当月分 (月遅れ/返戻フラグ行は除外) を下 ──
  const displayRows = useMemo<DisplayRow[]>(() => {
    const re: DisplayRow[] = reRows.filter(kanaMatches).map((r) => ({
      key: `re:${r.user_id}:${r.__origMonthKey}`,
      row: r,
      origMonthKey: r.__origMonthKey,
      isReSeikyu: true,
      reasons: r.__reasons,
      statusNotes: r.__statusNotes,
    }));
    const cur: DisplayRow[] = filteredRows
      .filter((r) => {
        const st = statusByClient.get(r.user_id);
        // 月遅れ/返戻フラグの当月行は今回の伝送から除外 (後月に再請求)
        return !(st?.tsukiokure || st?.henrei);
      })
      .map((r) => ({
        key: `cur:${r.user_id}`,
        row: r,
        origMonthKey: monthKey,
        isReSeikyu: false,
        reasons: null,
        statusNotes: statusByClient.get(r.user_id)?.notes ?? null,
      }));
    return [...re, ...cur];
  }, [filteredRows, reRows, kanaMatches, statusByClient, monthKey]);

  // ── 給付管理票情報作成区分 (8221 項5: 1新規/2修正/3取消) ──
  //    既定 = 当月行:新規 / 再請求行:修正。介護請求タブの給付管理票ペインで保存した
  //    マーカー ([給管:修正] 等) があればそれを優先。行の select で出力直前に上書き可。
  const [kubunOverride, setKubunOverride] = useState<Map<string, KyufuKanriKubun>>(new Map());
  const effectiveKubun = (d: DisplayRow): KyufuKanriKubun =>
    kubunOverride.get(d.key) ??
    parseKyufuKanriKubun(d.statusNotes) ??
    (d.isReSeikyu ? "2" : "1");

  const excludedCount = filteredRows.length - displayRows.filter((d) => !d.isReSeikyu).length;

  // ── 月途中の保険者変更 (転居) のある行 — 警告バナー用 ──
  const insurerChangeRows = useMemo(
    () => displayRows.filter((d) => d.row.midMonthInsurerChange),
    [displayRows],
  );

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () =>
    setChecked((prev) =>
      prev.size === displayRows.length
        ? new Set()
        : new Set(displayRows.map((d) => d.key)),
    );

  const targets = useMemo(
    () =>
      checked.size > 0
        ? displayRows.filter((d) => checked.has(d.key))
        : displayRows,
    [displayRows, checked],
  );

  const totalUnits = targets.reduce((s, d) => s + d.row.totalUnits, 0);
  const totalInsurance = targets.reduce((s, d) => s + d.row.insuranceAmount, 0);

  // ── 国保連伝送ファイル (給付管理票 8211/8221 + 計画費請求 7111/8121 / Shift_JIS) ──
  //    提供月ごとに 1 ファイルセット。再請求分は元提供月のファイルとして出す。
  const exportDensou = async () => {
    if (targets.length === 0) return;
    setExporting(true);
    try {
      // 未確定 (draft) レセプトは伝送に含めない (claims-content の国保連出力と同じ方針)
      const draftRows = targets.filter((d) => d.row.claimStatus === "draft");
      const exportTargets = targets.filter((d) => d.row.claimStatus !== "draft");

      if (exportTargets.length === 0) {
        toast.error(
          "確定済み (confirmed / submitted) のレセプトがありません。「レセプト編集」で確定してください。",
        );
        return;
      }
      // 要支援者 (介護予防支援=46) は居宅(43)と別事業所番号で請求するため、月内で
      // 43(要介護)/46(要支援) にパーティションして各番号で別ファイルを生成する。
      const isYobo = (d: DisplayRow) => (d.row.care_level ?? "").startsWith("要支援");

      // 提供月ごとにグループ化
      const byMonth = new Map<string, DisplayRow[]>();
      for (const d of exportTargets) {
        if (!byMonth.has(d.origMonthKey)) byMonth.set(d.origMonthKey, []);
        byMonth.get(d.origMonthKey)!.push(d);
      }

      const files: { content: string; fileName: string; label: string; count: number }[] = [];
      const warnings: string[] = [];

      // 処理対象年月 (コントロールレコード項11) = 審査実行月 = 今回提出分の翌月
      // (_if_kyotaku.txt 注1)。再請求 (過去提供月) のファイルも提出は今なので同じ値。
      const shoriDate = new Date(year, month, 1); // 表示中の請求月の翌月 1 日
      const shoriYear = shoriDate.getFullYear();
      const shoriMonth = shoriDate.getMonth() + 1;

      // 1提供月・1事業所番号ぶんのファイル (計画費 + 給付管理票) を生成して files に push。
      // 要介護は43(officeNumber)、要支援は46(yoboNumber) で別々に呼ぶ。
      const buildForGroup = async (
        mKey: string, oy: number, om: number, group: DisplayRow[],
        officeNum: string, labelSuffix: string,
      ) => {
        const opts = {
          officeNumber: officeNum,
          year: oy,
          month: om,
          unitPrice,
          shoriYear,
          shoriMonth,
        };
        // 給付管理票情報作成区分 (利用者ごと。既定=当月新規/再請求修正、UI で上書き可)
        const kubunByUser = new Map<string, KyufuKanriKubun>(
          group.map((d) => [d.row.user_id, effectiveKubun(d)]),
        );
        const users = group.map((d) => d.row);
        const userIds = users.map((u) => u.user_id);

        // ── ファイル 2: 計画費請求 (7111 + 8121) — レセプトから ──
        const keikakuUsers: KeikakuhiUser[] = users.map((u) => ({
          userName: u.user_name,
          insurerNumber: u.insurer_number ?? "",
          insuredNumber: u.insured_number ?? "",
          birthDate: u.birth_date,
          gender: u.gender,
          careLevel: u.care_level,
          certStart: u.certStart,
          certEnd: u.certEnd,
          requestDate: u.requestDate ?? null, // 計画作成依頼届出年月日 (kaigo_care_plans)。無ければ builder が認定開始日で代用
          serviceCode: u.serviceCode,
          units: u.totalUnits,
          // 8124 明細行 (基本+各加算+処遇改善)。最後の行が行番号99 (合計行) になる
          lines: u.lines.map((l) => ({ code: l.code, units: l.units, count: l.count })),
          careManagerNumber: u.careManagerNumber, // 介護支援専門員番号 (8124 各行)
          // 公費 (生活保護等)。公費単独 (H番号) は保険分 7111 から除外され公費分へ
          kohiTandoku: u.kohiTandoku,
          kohiHobetsu: u.kohiHobetsu,
          kohiFutanshaNumber: u.kohiFutansha,
          kohiJukyushaNumber: u.kohiJukyusha,
          // 月途中の保険者変更 (転居) — builder 側で warning (出力は月末時点の保険者)
          midMonthInsurerChange: u.midMonthInsurerChange,
        }));
        // 予防(46)は 43 と同月だと fileName (K/S+ym.CSV) が衝突するため接頭辞 Y を付ける
        const fname = (base: string) => (labelSuffix ? "Y" + base : base);
        const f2 = buildKeikakuhiFile(keikakuUsers, opts);
        warnings.push(...f2.warnings.map((w) => `[計画費 R${oy - 2018}/${om}${labelSuffix}] ${w}`));
        files.push({
          content: f2.content,
          fileName: fname(f2.fileName),
          label: `計画費請求 R${oy - 2018}/${om}${labelSuffix}`,
          count: f2.dataRecordCount,
        });

        // ── ファイル 1: 給付管理票 (8211 + 8221) — kaigo_benefit_management から ──
        type BenefitRow = {
          user_id: string;
          service_type: string;
          service_kind_code: string | null;
          provider_name: string | null;
          provider_number: string | null;
          planned_units: number | null;
        };
        const benefitRows: BenefitRow[] = [];
        for (const idChunk of chunkArray(userIds, IN_CHUNK_SIZE)) {
          const { data, error: be } = await supabase
            .from("kaigo_benefit_management")
            .select("user_id, service_type, service_kind_code, provider_name, provider_number, planned_units")
            .eq("billing_month", mKey)
            .in("user_id", idChunk);
          if (be) throw new Error(`給付管理データの取得に失敗 (${mKey}): ${be.message}`);
          benefitRows.push(...((data ?? []) as BenefitRow[]));
        }

        if (benefitRows.length === 0) {
          warnings.push(
            `[給付管理票 R${oy - 2018}/${om}] 給付管理データがありません (「給付管理」画面で作成すると給付管理票を出力できます)`,
          );
        } else {
          // サービス事業所番号 (provider_name → offices.business_number)
          // .in() は URI Too Long 回避のため chunk 化 (旧 slice(0,100) は 101 件目以降が
          // 黙って未解決になっていた)
          const providerNames = [
            ...new Set(benefitRows.map((r) => r.provider_name).filter(Boolean)),
          ] as string[];
          const officeNoByName = new Map<string, string>();
          for (const nameChunk of chunkArray(providerNames, IN_CHUNK_SIZE)) {
            const { data: offs, error: oe } = await supabase
              .from("offices")
              .select("name, business_number")
              .in("name", nameChunk);
            if (oe) throw new Error(`サービス事業所番号の取得に失敗: ${oe.message}`);
            for (const o of (offs ?? []) as { name: string; business_number: string | null }[]) {
              if (o.business_number) officeNoByName.set(o.name, o.business_number);
            }
          }

          // サービス種類コードが解決できない行を warning (8221 項19 が空になる)。
          // service_kind_code (CSV 実コード) があればそれで解決済みなので対象外。
          const unknownServiceTypes = [
            ...new Set(
              benefitRows
                .filter(
                  (r) =>
                    !(r.service_kind_code ?? "").trim() &&
                    r.service_type &&
                    !SERVICE_KIND_CODE[r.service_type],
                )
                .map((r) => r.service_type),
            ),
          ];
          if (unknownServiceTypes.length > 0) {
            warnings.push(
              `[給付管理票 R${oy - 2018}/${om}] サービス種類コード未登録のサービス種別: ${unknownServiceTypes.join("、")} (SERVICE_KIND_CODE に追加が必要)`,
            );
          }

          const rowsByUser = new Map<string, BenefitRow[]>();
          for (const r of benefitRows) {
            if (!rowsByUser.has(r.user_id)) rowsByUser.set(r.user_id, []);
            rowsByUser.get(r.user_id)!.push(r);
          }

          // ── 月途中の保険者変更 (転居): 保険者別分割の材料を用意 ──
          //   1. 認定セグメント (期間×保険者) — resolveCertSegmentsForMonth
          //   2. 自事業所の訪問介護実績 (日別単位数) — 分割の按分根拠
          //   境界日が判定できない利用者は材料を渡さない (builder 側で従来 warning)。
          const splitSegmentsByUser = new Map<string, KyufuKanriSegment[]>();
          const dailyActualsByUser = new Map<string, KyufuKanriDailyActual[]>();
          const changedUsers = users.filter(
            (u) => u.midMonthInsurerChange && rowsByUser.has(u.user_id),
          );
          if (changedUsers.length > 0) {
            const changedIds = changedUsers.map((u) => u.user_id);
            const certsRes = await resolveCertsInMonth(supabase, changedIds, oy, om);
            for (const u of changedUsers) {
              const segRes = resolveCertSegmentsForMonth(
                certsRes.get(u.user_id) ?? [],
                oy,
                om,
              );
              if (segRes.undetermined || segRes.segments.length < 2) continue;
              splitSegmentsByUser.set(
                u.user_id,
                segRes.segments.map((s) => ({
                  from: s.from,
                  to: s.to,
                  insurerNumber: s.cert.insurer_number ?? "",
                  insuredNumber: s.cert.insured_number ?? "",
                  careLevel: s.cert.care_level,
                  limitStart: s.cert.certification_start_date,
                  limitEnd: s.cert.certification_end_date,
                  // 転居月は新旧保険者それぞれで限度額満額 (制度根拠確認済)
                  limitUnits: s.cert.service_limit_amount ?? 0,
                })),
              );
            }
          }
          if (splitSegmentsByUser.size > 0) {
            // 自事業所の訪問介護実績 (status=completed) を日別に取得
            const targetIds = [...splitSegmentsByUser.keys()];
            const monthStart = `${mKey}-01`;
            const monthLastDay = new Date(oy, om, 0).getDate();
            const monthEnd = `${mKey}-${String(monthLastDay).padStart(2, "0")}`;
            interface VisitRow {
              user_id: string;
              service_type: string;
              visit_date: string;
              office_id?: string | null;
            }
            const visits: VisitRow[] = [];
            let withOfficeCol = true; // office_id 列未適用 (42703) は列なしで再試行
            for (const idChunk of chunkArray(targetIds, IN_CHUNK_SIZE)) {
              let offset = 0;
              while (true) {
                const cols = withOfficeCol
                  ? "user_id, service_type, visit_date, office_id"
                  : "user_id, service_type, visit_date";
                const { data: vData, error: ve } = await supabase
                  .from("kaigo_visit_schedule")
                  .select(cols)
                  .eq("status", "completed")
                  .gte("visit_date", monthStart)
                  .lte("visit_date", monthEnd)
                  .in("user_id", idChunk)
                  .order("id", { ascending: true })
                  .range(offset, offset + 999);
                if (ve) {
                  if (
                    withOfficeCol &&
                    (ve.code === "42703" || /does not exist/i.test(ve.message ?? ""))
                  ) {
                    withOfficeCol = false;
                    continue;
                  }
                  throw new Error(`訪問介護実績の取得に失敗 (${mKey}): ${ve.message}`);
                }
                const vRows = (vData ?? []) as unknown as VisitRow[];
                visits.push(...vRows);
                if (vRows.length < 1000) break;
                offset += 1000;
              }
            }

            // サービス名 → 単位数/サービス種類 (kaigo_service_codes 対象月世代)
            const SYSTEM_PRIORITY: Record<string, number> = {
              "介護": 0, "総合事業": 1, "独自": 2, "障害": 3,
            };
            const masterByNorm = new Map<
              string,
              { units: number; kind: string; system: string }
            >();
            const stNames = [...new Set(visits.map((v) => v.service_type))];
            for (const nameChunk of chunkArray(serviceNameVariantsAll(stNames), IN_CHUNK_SIZE)) {
              const { data: codes, error: se } = await validInMonth(
                supabase
                  .from("kaigo_service_codes")
                  .select("service_name, units, service_category, system")
                  .in("service_name", nameChunk)
                  .eq("calculation_type", "基本"),
                oy,
                om,
              );
              if (se) throw new Error(`サービスコードの取得に失敗: ${se.message}`);
              for (const c of (codes ?? []) as {
                service_name: string;
                units: number;
                service_category: string | null;
                system: string;
              }[]) {
                if (!c.service_category) continue;
                const key = toHankakuDigits(c.service_name);
                const prev = masterByNorm.get(key);
                if (!prev || (SYSTEM_PRIORITY[c.system] ?? 9) < (SYSTEM_PRIORITY[prev.system] ?? 9)) {
                  masterByNorm.set(key, {
                    units: c.units,
                    kind: c.service_category,
                    system: c.system,
                  });
                }
              }
            }

            // 実績の office_id → 事業所番号 (給付管理行の officeNumber と照合するため)
            const visitOfficeIds = [
              ...new Set(visits.map((v) => v.office_id).filter((x): x is string => !!x)),
            ];
            const officeNoById = new Map<string, string>();
            for (const idChunk of chunkArray(visitOfficeIds, IN_CHUNK_SIZE)) {
              const { data: offRows, error: oe2 } = await supabase
                .from("offices")
                .select("id, business_number")
                .in("id", idChunk);
              if (oe2) throw new Error(`サービス事業所番号の取得に失敗: ${oe2.message}`);
              for (const o of (offRows ?? []) as { id: string; business_number: string | null }[]) {
                if (o.business_number) officeNoById.set(o.id, o.business_number);
              }
            }

            for (const v of visits) {
              const m = masterByNorm.get(toHankakuDigits(v.service_type));
              if (!m) continue; // 単位数マスタ未一致の実績は按分根拠に使わない
              const arr = dailyActualsByUser.get(v.user_id) ?? [];
              arr.push({
                date: v.visit_date,
                serviceKindCode: m.kind,
                officeNumber: v.office_id ? officeNoById.get(v.office_id) ?? null : null,
                units: m.units,
              });
              dailyActualsByUser.set(v.user_id, arr);
            }
          }

          const kyufuUsers: KyufuKanriUser[] = users
            .filter((u) => rowsByUser.has(u.user_id))
            .map((u) => ({
              userName: u.user_name,
              insurerNumber: u.insurer_number ?? "",
              insuredNumber: u.insured_number ?? "",
              birthDate: u.birth_date,
              gender: u.gender,
              careLevel: u.care_level,
              limitStart: u.certStart,
              limitEnd: u.certEnd,
              limitUnits: u.limitUnits,
              sakuseiKubun: kubunByUser.get(u.user_id) ?? "1",
              // 月途中の保険者変更 (転居)。分割材料 (splitSegments + 日別実績) が
              // 揃っていれば builder 側で保険者別に票を分割、無ければ従来 warning。
              midMonthInsurerChange: u.midMonthInsurerChange,
              careManagerNumber: u.careManagerNumber, // 介護支援専門員番号 (8222 終端行)
              splitSegments: splitSegmentsByUser.get(u.user_id) ?? null,
              dailyActuals: dailyActualsByUser.get(u.user_id) ?? [],
              lines: (rowsByUser.get(u.user_id) ?? []).map((r) => ({
                // 提供事業所番号: 居宅の給付管理票は提供事業所が他社 (訪問介護/通所/
                // 福祉用具 等) なので offices (自社) には無い。provider_number を直接持てば
                // それを最優先。無い場合のみ自社 name 解決にフォールバック。
                officeNumber:
                  (r.provider_number ?? "").trim() ||
                  (r.provider_name ? officeNoByName.get(r.provider_name) ?? "" : ""),
                // サービス種類コードは CSV 由来の実コード (72=認知症通所, 78=地域密着通所
                // 等 マップに無い/旧コードと異なる種別あり) を最優先。無ければ名称から解決。
                serviceKindCode:
                  (r.service_kind_code ?? "").trim() ||
                  SERVICE_KIND_CODE[r.service_type] ||
                  "",
                plannedUnits: r.planned_units ?? 0,
                label: `${r.service_type}${r.provider_name ? ` (${r.provider_name})` : ""}`,
              })),
            }));
          const missingBenefit = users.length - kyufuUsers.length;
          if (missingBenefit > 0) {
            warnings.push(
              `[給付管理票 R${oy - 2018}/${om}] 給付管理データの無い利用者 ${missingBenefit} 名は給付管理票に含まれません`,
            );
          }
          if (kyufuUsers.length > 0) {
            const f1 = buildKyufuKanriFile(kyufuUsers, opts);
            warnings.push(...f1.warnings.map((w) => `[給付管理票 R${oy - 2018}/${om}${labelSuffix}] ${w}`));
            files.push({
              content: f1.content,
              fileName: fname(f1.fileName),
              label: `給付管理票 R${oy - 2018}/${om}${labelSuffix}`,
              count: f1.dataRecordCount,
            });
          }
        }
      };

      // 提供月ごとに 要介護(43) / 要支援(46) へパーティションして生成
      for (const [mKey, group] of [...byMonth.entries()].sort()) {
        const [oy, om] = mKey.split("-").map((n) => Number(n));
        if (!oy || !om) continue;
        const kaigoG = group.filter((d) => !isYobo(d));
        const yoboG = group.filter((d) => isYobo(d));
        if (kaigoG.length > 0) await buildForGroup(mKey, oy, om, kaigoG, officeNumber ?? "", "");
        if (yoboG.length > 0) {
          if (yoboNumber) {
            await buildForGroup(mKey, oy, om, yoboG, yoboNumber, " 予防");
          } else {
            warnings.push(
              `[予防 R${oy - 2018}/${om}] 要支援 ${yoboG.length}名 (${yoboG.map((d) => d.row.user_name).join("、")}) は介護予防支援(46)の事業所番号が未登録のため出力できません。事業所マスタで46番号を登録してください`,
            );
          }
        }
      }

      if (draftRows.length > 0) {
        warnings.push(`未確定レセプト ${draftRows.length} 件は伝送から除外しました`);
      }

      if (warnings.length > 0) {
        const list = warnings.slice(0, 12).join("\n・");
        const ok = window.confirm(
          `以下の項目が不足しています (伝送ソフトの取込チェックでエラーになる可能性があります):\n\n・${list}${warnings.length > 12 ? `\n…他 ${warnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
        );
        if (!ok) return;
      }

      for (const f of files) downloadSjis(f);
      toast.success(
        `伝送ファイル ${files.length} 本を出力しました: ` +
          files.map((f) => `${f.fileName} (${f.label} ${f.count} 件)`).join(" / "),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  // ── 確認用 CSV (Excel で内容確認する用の明細一覧。伝送形式ではない) ──
  const exportCsv = () => {
    const ym = `${year}${String(month).padStart(2, "0")}`;
    const header = [
      "提供年月",
      "保険者番号",
      "被保険者番号",
      "利用者名",
      "要介護度",
      "サービス内容",
      "サービスコード",
      "単位数",
      "回数",
      "合計単位数",
      "保険請求額",
      "状態",
    ];
    const lines: string[] = [header.join(",")];
    for (const d of targets) {
      const r = d.row;
      const rowYm = d.origMonthKey.replace("-", "");
      const state = d.isReSeikyu
        ? d.reasons?.henrei
          ? "返戻(再請求)"
          : "月遅れ(再請求)"
        : "当月";
      for (const l of r.lines) {
        lines.push(
          [
            rowYm,
            r.insurer_number ?? "",
            r.insured_number ?? "",
            `"${r.user_name}"`,
            r.care_level ?? "",
            `"${l.name}"`,
            l.code,
            l.units,
            l.count,
            r.totalUnits,
            r.insuranceAmount,
            state,
          ].join(","),
        );
      }
    }
    // Excel 互換のため BOM 付き UTF-8
    const blob = new Blob(["﻿" + lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kyotaku_kokuho_seikyu_${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const allChecked =
    checked.size === displayRows.length && displayRows.length > 0;

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── 左: かな行フィルター ── */}
      <SeikyuKanaSidebar />

      {/* ── 中央: ツールバー + テーブル + フッタ ── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* ツールバー (伝送ファイル / 確認用CSV) */}
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <SeikyuMonthNav />
          <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">国保請求分</span>
          <span className="text-xs text-gray-500">{displayRows.length} 件</span>
          <div className="ml-auto flex items-center gap-2">
            {/* 審査結果取込 (返戻/支払決定/増減表) — 国保連からの通知ファイルを取り込む */}
            <ShinsaKekkaImport
              officeId={officeId}
              tenantId={tenantId}
              officeNumber={officeNumber}
              onNavigateMonth={onMonthChange}
              onApplied={() => {
                loadStatus();
                loadReRows();
              }}
            />
            <button
              type="button"
              onClick={exportCsv}
              disabled={displayRows.length === 0}
              title="Excel で内容確認する用の明細 CSV (伝送形式ではない)"
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download size={13} />確認用CSV
            </button>
            <button
              type="button"
              onClick={exportDensou}
              disabled={displayRows.length === 0 || exporting}
              title="国保中央会 伝送通信ソフト取込用の正式形式 (給付管理票 8211/8221 + 計画費請求 7111/8121、Shift_JIS) を出力"
              className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Send size={13} />
              )}
              伝送ファイル ({targets.length}件)
            </button>
          </div>
        </div>

        {/* 除外・再請求の案内 */}
        {!loading && (excludedCount > 0 || reRows.length > 0) && (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-amber-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              {excludedCount > 0 && (
                <>当月分のうち月遅れ・返戻フラグの {excludedCount} 件は伝送対象から除外しています。</>
              )}
              {reRows.length > 0 && (
                <>過去月の再請求 {reRows.length} 件を合流しています (元提供月のファイルとして出力)。</>
              )}
            </span>
          </div>
        )}

        {/* 月途中の保険者変更 (転居) 警告 */}
        {!loading && insurerChangeRows.length > 0 && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-xs text-red-800">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">
                保険者が月内で変わっている利用者が {insurerChangeRows.length} 名います
              </span>
              {" — "}
              {insurerChangeRows
                .map((d) => `${d.row.user_name} (${describeInsurerChange(d.row.midMonthInsurerChange!)})`)
                .join(" / ")}
              。給付管理票・明細書の提出先を確認してください
              (給付管理票 8221 は境界日が判定できる場合、保険者別の票に分割して出力します。
              計画費 8121 と、境界日が判定できない場合の給付管理票は月末時点の保険者番号・被保険者番号で 1 本です)。
            </span>
          </div>
        )}

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-2 shrink-0 flex items-start gap-2 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={22} className="animate-spin text-indigo-400" />
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {/* ヘッダー行 */}
              <div className={`${GRID_COLS} border-b border-gray-300 bg-gray-100 text-xs font-semibold text-gray-600 sticky top-0 z-10`}>
                <div className="px-1 py-2 flex items-center justify-center">
                  <button
                    onClick={toggleAll}
                    title="全選択"
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                      allChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                    }`}
                  >
                    {allChecked && (
                      <span className="text-white text-[8px] font-bold leading-none">✓</span>
                    )}
                  </button>
                </div>
                <div className="px-2 py-2 border-l border-gray-200">提供年月</div>
                <div className="px-2 py-2 border-l border-gray-200">保険者番号</div>
                <div className="px-2 py-2 border-l border-gray-200">被保険者番号</div>
                <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
                <div className="px-2 py-2 border-l border-gray-200">要介護度</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">単位数</div>
                <div className="px-2 py-2 border-l border-gray-200 text-right">保険請求額</div>
                <div className="px-2 py-2 border-l border-gray-200 text-center">状態</div>
                <div className="px-2 py-2 border-l border-gray-200 text-center" title="給付管理票情報作成区分 (8221 項5)">給管作成区分</div>
              </div>

              {displayRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">
                  対象月の請求対象がありません
                </p>
              ) : displayRows.map((d, idx) => {
                const r = d.row;
                const isChecked = checked.has(d.key);
                const [oy, om] = d.origMonthKey.split("-").map((n) => Number(n));
                return (
                  <div
                    key={d.key}
                    onClick={() => toggle(d.key)}
                    className={`${GRID_COLS} border-b border-gray-100 text-xs cursor-pointer transition-colors ${
                      isChecked
                        ? "bg-indigo-50"
                        : idx % 2 === 0
                        ? "bg-white hover:bg-gray-50"
                        : "bg-gray-50/50 hover:bg-gray-100"
                    }`}
                  >
                    <div className="px-1 py-2 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => toggle(d.key)}
                        className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                          isChecked ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                        }`}
                      >
                        {isChecked && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                      </button>
                    </div>
                    <div className={`px-2 py-2 border-l border-gray-100 text-gray-500 ${d.isReSeikyu ? "bg-yellow-100" : ""}`}>
                      R{oy - 2018}/{om}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                      {r.insurer_number ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">
                      {r.insured_number ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 font-medium text-gray-800 truncate">
                      {r.user_name}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-gray-700">
                      {r.care_level ?? "—"}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono text-gray-700">
                      {r.totalUnits.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-right font-mono font-semibold text-indigo-700">
                      {r.insuranceAmount.toLocaleString()}
                    </div>
                    <div className="px-2 py-2 border-l border-gray-100 text-center">
                      {d.isReSeikyu ? (
                        <span className="text-red-600 font-medium">
                          {d.reasons?.henrei ? "返戻" : "月遅"}再請求
                        </span>
                      ) : r.claimStatus === "draft" ? (
                        <span className="text-yellow-600">未確定</span>
                      ) : (
                        <span className="text-gray-500">当月</span>
                      )}
                    </div>
                    {/* 給付管理票 作成区分 (8221 項5) — 既定: 当月=新規 / 再請求=修正 */}
                    <div className="px-1 py-1.5 border-l border-gray-100 text-center" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={effectiveKubun(d)}
                        onChange={(e) =>
                          setKubunOverride((prev) => {
                            const next = new Map(prev);
                            next.set(d.key, e.target.value as KyufuKanriKubun);
                            return next;
                          })
                        }
                        title="給付管理票情報作成区分 (1=新規 / 2=修正 / 3=取消)。伝送ファイルの 8221 項5 と 8211 総括票の件数に反映"
                        className={`w-full text-[11px] border border-gray-300 rounded px-0.5 py-0.5 bg-white ${effectiveKubun(d) !== "1" ? "text-red-600" : "text-gray-600"}`}
                      >
                        {(Object.keys(KYUFU_KANRI_KUBUN_LABELS) as KyufuKanriKubun[]).map((k) => (
                          <option key={k} value={k}>
                            {KYUFU_KANRI_KUBUN_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── フッター合計 ── */}
            <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-1.5">
                <span>合計件数 <strong className="font-mono">{targets.length.toLocaleString()}</strong></span>
                <span>
                  出力対象{" "}
                  <strong className="font-mono">
                    {checked.size > 0 ? `チェック ${checked.size} 件` : "全件"}
                  </strong>
                </span>
              </div>
              <div className="border border-gray-300 rounded bg-white px-2 py-1.5 grid grid-cols-3 gap-x-4 gap-y-1">
                <span>合計単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                <span>保険請求額 <strong className="font-mono text-indigo-700">¥{totalInsurance.toLocaleString()}</strong></span>
                <span>利用者負担額 <strong className="font-mono">¥0</strong> (10割給付)</span>
              </div>
              <p className="mt-1.5 text-[10px] text-gray-400">
                ※ チェックで出力対象を絞込 (未チェック時は全件)。「伝送ファイル」は国保中央会
                伝送通信ソフト取込用の正式形式 (給付管理票 8211/8221 + 計画費請求 7111/8121 / Shift_JIS)。
                提供月ごとに 1 ファイルセットで出力し、未確定レセプトは除外されます。
                初回は伝送ソフトの取込チェックで内容を確認してください。「確認用CSV」は Excel 閲覧用。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
