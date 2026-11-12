"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { SharedDocumentRow } from "@/lib/notifications";
import { fetchTargetDoc, type TargetDoc } from "./ImportServiceRecordModal";
import { recordMonthActualUnits, splitInsuranceRecords } from "@/lib/equipment-record-units";
import { EQUIPMENT_IMPORT_SOURCE, planEquipmentImport, isImportRow, type ImportChoice, type MergePlan } from "@/lib/equipment-import-merge";

// ─── 型 ───────────────────────────────────────────────────────────────────────

/**
 * order-app が送信する福祉用具レンタル実績の 1 行 (= 1 用具)。
 * 1 月内に開始/終了が closed なら同月内、月跨ぎなら date_range_start/end が
 * 当月にクリップされて送られてくる。
 */
export type EquipmentRecord = {
  date_range_start: string; // YYYY-MM-DD
  date_range_end: string;   // YYYY-MM-DD
  equipment_name: string;
  tais_code?: string | null;
  /** ★ 円・按分前・1 個あたり (単位ではない。÷10 は src/lib/equipment-record-units.ts) */
  monthly_rental_fee: number;
  category?: string | null;
  /** 数量。null / 0 / 未設定は 1 (order-app 46819a4 から送られる) */
  quantity?: number | null;
  /** orders の生の値 "介護" / "自費" / "特価自費" / null。"介護" だけを入れる。未設定 (古い payload) は従来どおり入れる */
  payment_type?: string | null;
};

/** content.equipment_records に保存する形式 (provider 名等を補完) */
export type StoredEquipmentRecord = EquipmentRecord & {
  provider_name: string;       // 送信元事業所名
  shared_document_id?: string; // traceability
  imported_at?: string;        // ISO timestamp
};

/** kaigo_report_documents.content.services[] の 1 行 (= 福祉用具行) */
export type RentalSvcRow = {
  time: string;
  content: string;
  provider: string;
  planned: boolean[];
  actual: boolean[];
  category: string;
  units?: number;
  manual_units?: number | null;
  /** その月の実額 (date_range から半月按分済み・× 数量)。画面は印で按分しない (src/lib/rental-units.ts) */
  rental_month_actual_units?: number | null;
  rental_period_type?: "1month" | "half_month" | "daily" | null;
  rental_days?: number | null;
  tais_code?: string | null; // 将来 TAIS 表示対応用
  /** ★ 取込が作った行の印 (src/lib/equipment-import-merge.ts)。消してよいのはこの印の行だけ */
  _units_source?: string | null;
  /** 元になった shared_documents の id (種別ごと集約では複数) */
  _shared_document_ids?: string[];
};

type AnySvcRow = {
  time?: string;
  content?: string;
  provider?: string;
  planned?: boolean[];
  actual?: boolean[];
  category?: string;
  units?: number;
  manual_units?: number | null;
  rental_period_type?: "1month" | "half_month" | "daily" | null;
  rental_days?: number | null;
  tais_code?: string | null;
  _units_source?: string | null;
};

/** 福祉用具行の集約モード */
export type AggregationMode = "per_equipment" | "per_category";

// ─── 国 14 種目 mapping (order-app category → 利用票 サービスコード名) ─────────

export const CATEGORY_TO_SERVICE_NAME: Record<string, string> = {
  "車椅子": "車いす貸与",
  "車椅子付属品": "車いす付属品貸与",
  "特殊寝台": "特殊寝台貸与",
  "特殊寝台付属品": "特殊寝台付属品貸与",
  "床ずれ防止用具": "床ずれ防止用具貸与",
  "体位変換器": "体位変換器貸与",
  "手すり": "手すり貸与",
  "スロープ": "スロープ貸与",
  "歩行器": "歩行器貸与",
  "歩行補助つえ": "歩行補助つえ貸与",
  "認知症老人徘徊感知機器": "認知症老人徘徊感知機器貸与",
  "移動用リフト": "移動用リフト貸与",
  "自動排泄処理装置": "自動排泄処理装置貸与",
  "排泄予測支援機器": "排泄予測支援機器貸与",
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function daysInMonth(yearMonth: string): number {
  const m = /^(\d{4})-(\d{1,2})$/.exec(yearMonth);
  if (!m) return 30;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return 30;
  return new Date(y, mo, 0).getDate();
}

function dayOfMonth(date: string, yearMonth: string): number | null {
  if (!date.startsWith(yearMonth + "-")) return null;
  const d = parseInt(date.slice(8, 10), 10);
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  return d;
}

/**
 * 福祉用具レンタル期間 [start, end] から 利用票標準の planned/actual マークを生成。
 * 利用票慣習:
 *   - 月初〜末日 (= 当月通し) → 1日 のみマーク (= 1月扱い)
 *   - 月初〜途中終了 → 1日 + 終了日 をマーク
 *   - 途中開始〜末日 → 開始日 のみマーク
 *   - 途中〜途中 (同月内) → 開始日 + 終了日 をマーク (= 半月扱い)
 */
export function buildMarksFromRange(
  start: string,
  end: string,
  yearMonth: string,
): boolean[] {
  const dim = daysInMonth(yearMonth);
  const marks = Array<boolean>(31).fill(false);
  const startDay = dayOfMonth(start, yearMonth);
  const endDay = dayOfMonth(end, yearMonth);
  const sDay = startDay ?? 1;
  const eDay = endDay ?? dim;
  if (sDay === 1 && eDay === dim) {
    marks[0] = true;
    return marks;
  }
  marks[sDay - 1] = true;
  if (eDay !== sDay && eDay !== dim) {
    marks[eDay - 1] = true;
  }
  return marks;
}

function isRentalRow(s: AnySvcRow): boolean {
  return String(s.category ?? "") === "17";
}

/** 1 用具 = 1 行で生成 (TAIS 対応モード) */
function generateRentalServicesPerEquipment(
  records: StoredEquipmentRecord[],
  yearMonth: string,
): RentalSvcRow[] {
  return records.map((r) => {
    const marks = buildMarksFromRange(r.date_range_start, r.date_range_end, yearMonth);
    return {
      time: "",
      content: r.equipment_name,
      provider: r.provider_name,
      planned: [...marks],
      actual: [...marks],
      category: "17",
      // ★ 単価 (manual_units) ではなく その月の実額。円 ÷10・date_range で半月按分・× 数量
      manual_units: null,
      rental_month_actual_units: recordMonthActualUnits(r, yearMonth),
      tais_code: r.tais_code ?? null,
      _units_source: EQUIPMENT_IMPORT_SOURCE,
      _shared_document_ids: r.shared_document_id ? [r.shared_document_id] : [],
    };
  });
}

/** 種別 × 事業所 で集約して 1 行ずつ生成 (= 従来 利用票慣習) */
function generateRentalServicesPerCategory(
  records: StoredEquipmentRecord[],
  yearMonth: string,
): RentalSvcRow[] {
  const groups = new Map<string, StoredEquipmentRecord[]>();
  for (const r of records) {
    const cat = r.category ?? "未分類";
    const key = `${cat}__${r.provider_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return Array.from(groups.entries()).map(([key, list]) => {
    const [cat, provider] = key.split("__");
    const serviceName = CATEGORY_TO_SERVICE_NAME[cat] ?? `${cat}貸与`;
    // ★ 1 台ずつ その月の実額 (円 ÷10・date_range で半月按分・× 数量) にしてから足す。
    //   印の和集合で按分すると、期間の違う用具が混ざったときに 1 台ごとの期間が失われる
    const totalUnits = list.reduce((s, r) => s + recordMonthActualUnits(r, yearMonth), 0);
    // 各 record の marks を union (= 期間カバー範囲の合算)
    const planned = Array<boolean>(31).fill(false);
    const actual = Array<boolean>(31).fill(false);
    for (const r of list) {
      const marks = buildMarksFromRange(r.date_range_start, r.date_range_end, yearMonth);
      for (let i = 0; i < 31; i++) {
        if (marks[i]) {
          planned[i] = true;
          actual[i] = true;
        }
      }
    }
    return {
      time: "",
      content: serviceName,
      provider,
      planned,
      actual,
      category: "17",
      manual_units: null,
      rental_month_actual_units: totalUnits,
      _units_source: EQUIPMENT_IMPORT_SOURCE,
      _shared_document_ids: [...new Set(list.map((r) => r.shared_document_id).filter((v): v is string => !!v))],
    };
  });
}

/** モード dispatcher。editor のトグルから呼ぶ。 */
export function generateRentalServicesFromRecords(
  records: StoredEquipmentRecord[],
  yearMonth: string,
  mode: AggregationMode,
): RentalSvcRow[] {
  // ★ 介護保険のもの (payment_type === "介護") だけを利用票の行にする。自費・不明は入れない
  //   (equipment_records には全部残す。入れなかった件数は モーダルが表示する)
  const { insured } = splitInsuranceRecords(records);
  return mode === "per_category"
    ? generateRentalServicesPerCategory(insured, yearMonth)
    : generateRentalServicesPerEquipment(insured, yearMonth);
}

// ─── persist ─────────────────────────────────────────────────────────────────

async function persistEquipmentRecords(
  supabase: ReturnType<typeof createClient>,
  target: TargetDoc,
  clientId: string,
  yearMonth: string,
  clientName: string,
  newRecords: StoredEquipmentRecord[],
  mode: AggregationMode,
  importedSharedDocId: string,
  senderName: string,
  choice: ImportChoice | null,
): Promise<MergePlan<AnySvcRow>> {
  // ★ 消してよいのは 取込の印が付いた貸与行だけ (src/lib/equipment-import-merge.ts)。
  //   送信元と同じかもしれない事業所に 印の無い / 他の出どころの貸与行があれば、人が選ぶまで保存しない
  const existing: AnySvcRow[] = Array.isArray(target.content.services)
    ? (target.content.services as AnySvcRow[])
    : [];

  // 既存 equipment_records と new をマージ (equipment_name + provider で同名上書き)
  const prevRecords: StoredEquipmentRecord[] = Array.isArray(target.content.equipment_records)
    ? (target.content.equipment_records as StoredEquipmentRecord[])
    : [];
  const map = new Map<string, StoredEquipmentRecord>();
  for (const r of prevRecords) {
    const key = `${r.equipment_name}__${r.provider_name}`;
    map.set(key, r);
  }
  for (const r of newRecords) {
    const key = `${r.equipment_name}__${r.provider_name}`;
    map.set(key, r); // overwrite
  }
  const mergedEquipmentRecords = Array.from(map.values());

  // 表示用 rental rows をモードに従って生成
  const rentalRows = generateRentalServicesFromRecords(
    mergedEquipmentRecords,
    yearMonth,
    mode,
  );
  const plan = planEquipmentImport<AnySvcRow>(existing, rentalRows, senderName, choice);
  if (plan.status !== "ok") throw new Error("既存の貸与行と重なるかもしれないので、残すか置き換えるかを選んでください");
  const mergedServices: AnySvcRow[] = plan.services;

  // imported_shared_document_ids 維持 + 追加
  const prevImportedIds = Array.isArray(target.content.imported_shared_document_ids)
    ? (target.content.imported_shared_document_ids as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const importedIds = Array.from(new Set([...prevImportedIds, importedSharedDocId]));

  if (target.id) {
    const nextContent = {
      ...target.content,
      services: mergedServices,
      equipment_records: mergedEquipmentRecords,
      rental_aggregation_mode: mode,
      imported_shared_document_ids: importedIds,
    };
    const { error } = await supabase
      .from("kaigo_report_documents")
      .update({ content: nextContent })
      .eq("id", target.id);
    if (error) throw new Error(error.message);
    return plan;
  }
  const newContent: Record<string, unknown> = {
    user_name: clientName,
    year_month: yearMonth,
    services: mergedServices,
    equipment_records: mergedEquipmentRecords,
    rental_aggregation_mode: mode,
    imported_shared_document_ids: importedIds,
  };
  const title = `サービス利用票・提供票（${yearMonth}）`;
  const { error } = await supabase.from("kaigo_report_documents").insert({
    user_id: clientId,
    report_type: "service-usage",
    title,
    report_month: yearMonth,
    content: newContent,
    status: "draft",
  });
  if (error) throw new Error(error.message);
  return plan;
}

// ─── modal ───────────────────────────────────────────────────────────────────

export interface ImportEquipmentRecordModalProps {
  shared: SharedDocumentRow;
  onClose: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function ImportEquipmentRecordModal({
  shared,
  onClose,
  onSuccess,
  onError,
}: ImportEquipmentRecordModalProps) {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [target, setTarget] = useState<TargetDoc | null>(null);
  const [sourceOfficeName, setSourceOfficeName] = useState<string>("");
  // 既存 doc に rental_aggregation_mode があればそれをデフォルトに、無ければ per_equipment
  const [mode, setMode] = useState<AggregationMode>("per_equipment");
  // ★ 既存の貸与行と重なるかもしれないときの選択。★ 既定は作らない (null = 未選択。選ぶまで取り込めない)
  const [choice, setChoice] = useState<ImportChoice | null>(null);

  const extracted = useMemo(() => {
    const payload = (shared.payload ?? {}) as Record<string, unknown>;
    const clientId =
      typeof payload.client_id === "string" ? payload.client_id : shared.client_id;
    const clientName =
      typeof payload.client_name === "string" ? payload.client_name : "";
    const yearMonth =
      typeof payload.year_month === "string" ? payload.year_month : null;
    const incoming: EquipmentRecord[] = Array.isArray(payload.records)
      ? (payload.records as unknown[]).filter(
          (r): r is EquipmentRecord =>
            !!r &&
            typeof r === "object" &&
            typeof (r as { date_range_start?: unknown }).date_range_start === "string" &&
            typeof (r as { date_range_end?: unknown }).date_range_end === "string" &&
            typeof (r as { equipment_name?: unknown }).equipment_name === "string",
        )
      : [];
    const { skipped } = splitInsuranceRecords(incoming);
    return { clientId, clientName, yearMonth, incoming, skipped };
  }, [shared]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const { clientId, yearMonth } = extracted;
        if (!clientId) throw new Error("client_id が payload に含まれていません");
        if (!yearMonth) throw new Error("year_month が payload に含まれていません");
        const [t, srcOfc] = await Promise.all([
          fetchTargetDoc(supabase, clientId, yearMonth),
          supabase
            .from("offices")
            .select("name")
            .eq("id", shared.source_office_id)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        setTarget(t);
        setSourceOfficeName(
          (srcOfc.data as { name?: string } | null)?.name ?? "(送信元事業所)",
        );
        const existingMode = t.content.rental_aggregation_mode;
        if (existingMode === "per_category" || existingMode === "per_equipment") {
          setMode(existingMode);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, extracted, shared.source_office_id]);

  // 既存 rental 行と incoming を equipment_name で diff
  const diff = useMemo(() => {
    if (!target) return null;
    const existing: AnySvcRow[] = Array.isArray(target.content.services)
      ? (target.content.services as AnySvcRow[]).filter((s) => isRentalRow(s))
      : [];
    const existingNames = new Set(existing.map((s) => s.content ?? ""));
    const incomingNames = new Set(extracted.incoming.map((r) => r.equipment_name));
    const added = extracted.incoming.filter((r) => !existingNames.has(r.equipment_name));
    const replaced = extracted.incoming.filter((r) => existingNames.has(r.equipment_name));
    const keepOnly = existing.filter((s) => !incomingNames.has(s.content ?? ""));
    // ★ 消すのは取込の印が付いた行だけ。重なるかもしれない既存行は人が選ぶ (src/lib/equipment-import-merge.ts)
    const allServices: AnySvcRow[] = Array.isArray(target.content.services) ? (target.content.services as AnySvcRow[]) : [];
    const preview = planEquipmentImport<AnySvcRow>(allServices, [], sourceOfficeName, null);
    const oldImport = existing.filter(isImportRow);
    const conflicts = preview.status === "needs_choice" ? preview.conflicts : [];
    const bySource = preview.status === "needs_choice" ? preview.bySource : {};
    return { added, replaced, keepOnly, existing, oldImport, conflicts, bySource, keptOther: preview.keptOtherProviderRows };
  }, [target, extracted.incoming, sourceOfficeName]);

  const handleImport = async () => {
    if (!target || !diff) return;
    if (!extracted.yearMonth || !extracted.clientId) return;
    setSubmitting(true);
    try {
      const nowIso = new Date().toISOString();
      const stored: StoredEquipmentRecord[] = extracted.incoming.map((r) => ({
        ...r,
        provider_name: sourceOfficeName,
        shared_document_id: shared.id,
        imported_at: nowIso,
      }));
      const plan = await persistEquipmentRecords(
        supabase,
        target,
        extracted.clientId,
        extracted.yearMonth,
        extracted.clientName,
        stored,
        mode,
        shared.id,
        sourceOfficeName,
        diff.conflicts.length ? choice : null,
      );
      const modeLabel = mode === "per_equipment" ? "用具ごと" : "種別ごとに集約";
      const sk = extracted.skipped;
      const skippedTotal = sk.自費 + sk.支払区分不明 + sk.その他;
      if (skippedTotal) console.warn("福祉用具の取込: 介護保険でない明細を利用票に入れなかった", sk);
      onSuccess(
        (choice === "keep_existing" && diff.conflicts.length
          ? `既存の貸与行を残し、取込行は足していません (受信した記録だけ保存)`
          : `利用票に取り込みました (${modeLabel}・以前の取込行の置き換え ${plan.status === "ok" ? plan.removedImportRows : 0} 件${plan.status === "ok" && plan.replacedRows ? ` / 既存行の置き換え ${plan.replacedRows} 件` : ""})`) +
          (skippedTotal ? ` ※ 利用票に入れなかった明細 ${skippedTotal} 件 (自費 ${sk.自費} / 支払区分不明 ${sk.支払区分不明}${sk.その他 ? ` / その他 ${sk.その他}` : ""})` : ""),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onError(`取り込みに失敗: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-800">
              利用票・提供票 への取り込み確認 (福祉用具実績)
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              {extracted.clientName || "—"} 様 / {extracted.yearMonth ?? "—"} / 受信{" "}
              {extracted.incoming.length} 件 / 送信元: {sourceOfficeName || "—"}
            </p>
            {extracted.skipped.自費 + extracted.skipped.支払区分不明 + extracted.skipped.その他 > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                介護保険でない明細は利用票に入れません: 自費 {extracted.skipped.自費} 件 / 支払区分不明{" "}
                {extracted.skipped.支払区分不明} 件
                {extracted.skipped.その他 > 0 ? ` / その他 ${extracted.skipped.その他} 件` : ""}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex justify-center py-10 text-gray-500">
              <Loader2 size={20} className="animate-spin mr-2" />
              読み込み中...
            </div>
          ) : errorMsg ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-600">
              {errorMsg}
            </div>
          ) : diff ? (
            <>
              {/* モード選択 */}
              <section className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">
                  利用票への記載モード
                </h4>
                <div className="space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={mode === "per_equipment"}
                      onChange={() => setMode("per_equipment")}
                      className="mt-0.5 accent-blue-600"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-800">
                        用具ごとに 1 行 <span className="text-xs text-blue-600">(TAIS 対応・推奨)</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        各用具を個別の行で記載。TAIS コード対応や同システム事業所間でやり取りする場合に推奨。
                        令和7年4月以降の改正様式に近い。
                      </div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={mode === "per_category"}
                      onChange={() => setMode("per_category")}
                      className="mt-0.5 accent-blue-600"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-800">
                        種別ごとに集約 <span className="text-xs text-gray-500">(従来の利用票慣習)</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        同種別(車いす貸与等)×同事業所 を 1 行に集約。
                        TAIS 対応してない事業所とのやり取りで簡潔にしたい場合に。
                      </div>
                    </div>
                  </label>
                </div>
                <p className="text-[11px] text-gray-500 mt-2 italic">
                  ※ 取り込み後も利用票編集画面で切り替え可 (生データは保持されます)
                </p>
              </section>

              <div className="grid grid-cols-3 gap-2 rounded-md bg-blue-50 p-3 text-xs">
                <div>
                  <div className="text-gray-500">新規追加</div>
                  <div className="text-base font-bold text-blue-700">{diff.added.length} 件</div>
                </div>
                <div>
                  <div className="text-gray-500">同名上書き</div>
                  <div className="text-base font-bold text-amber-700">{diff.replaced.length} 件</div>
                </div>
                <div>
                  <div className="text-gray-500">★ 削除される既存の貸与行</div>
                  <div className="text-base font-bold text-red-700">
                    {diff.oldImport.length + (choice === "replace_existing" ? diff.conflicts.length : 0)} 件
                  </div>
                </div>
              </div>

              <p className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] text-gray-700">
                消えるのは 以前この取込で作った貸与行 ({diff.oldImport.length} 件) だけです。
                別の事業所の貸与行 ({diff.keptOther.length} 件) には触りません。
                「新規追加 / 同名上書き」は 受信した用具名 (商品名) と 既存行のサービス名 (例: 特殊寝台貸与) を比べた参考値で、
                表記が違うためほとんど一致しません。
              </p>

              {diff.conflicts.length > 0 && (
                <section className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs space-y-1.5">
                  <p className="font-semibold text-red-700">
                    ★ 送信元 ({sourceOfficeName}) と同じかもしれない事業所に、取込以外で入った貸与行が {diff.conflicts.length} 件あります。
                    そのまま足すと同じ用具が二重に入るおそれがあります。どちらかを選んでください。
                  </p>
                  <p className="text-[11px] text-red-700">
                    出どころ別: {Object.entries(diff.bySource).map(([k, v]) => `${k} ${v} 件`).join(" / ")}
                  </p>
                  <ul className="text-[11px] text-gray-700 space-y-0.5">
                    {diff.conflicts.map((c, i) => (
                      <li key={`cf-${i}`} className="truncate">・{c.content} @{c.provider || "(事業所名なし)"}</li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="equip-import-choice" checked={choice === "keep_existing"} onChange={() => setChoice("keep_existing")} />
                    既存を残し、取込行は足さない
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="equip-import-choice" checked={choice === "replace_existing"} onChange={() => setChoice("replace_existing")} />
                    既存 ({diff.conflicts.length} 件) を消して取込に置き換える
                  </label>
                </section>
              )}

              {diff.added.length > 0 && (
                <section>
                  <h4 className="text-sm font-semibold text-gray-700 mb-1">新規追加</h4>
                  <ul className="space-y-1">
                    {diff.added.map((r, i) => (
                      <li
                        key={`add-${i}`}
                        className="rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs"
                      >
                        <div className="font-medium text-gray-800 truncate">{r.equipment_name}</div>
                        <div className="text-[11px] text-gray-500">
                          {r.date_range_start} 〜 {r.date_range_end} / ¥
                          {r.monthly_rental_fee.toLocaleString()}
                          {r.category ? ` / ${r.category}` : ""}
                          {r.tais_code ? ` / TAIS:${r.tais_code}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {diff.replaced.length > 0 && (
                <section>
                  <h4 className="text-sm font-semibold text-gray-700 mb-1">同名上書き</h4>
                  <ul className="space-y-1">
                    {diff.replaced.map((r, i) => (
                      <li
                        key={`rep-${i}`}
                        className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs"
                      >
                        <div className="font-medium text-gray-800 truncate">{r.equipment_name}</div>
                        <div className="text-[11px] text-gray-500">
                          {r.date_range_start} 〜 {r.date_range_end} / ¥
                          {r.monthly_rental_fee.toLocaleString()}
                          {r.category ? ` / ${r.category}` : ""}
                          {r.tais_code ? ` / TAIS:${r.tais_code}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {diff.keptOther.length > 0 && (
                <section>
                  <details className="rounded border border-gray-200 bg-gray-50">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-600">
                      別の事業所の貸与行 (触りません) {diff.keptOther.length} 件 — 送信元と同じ事業所の行が紛れていないか確認してください
                    </summary>
                    <ul className="px-3 py-2 space-y-0.5">
                      {diff.keptOther.map((s, i) => (
                        <li key={`keep-${i}`} className="text-[11px] text-gray-600 truncate">
                          ・{s.content} @{s.provider || "(事業所名なし)"}
                        </li>
                      ))}
                    </ul>
                  </details>
                </section>
              )}

              {extracted.incoming.length === 0 && (
                <p className="text-sm text-amber-700">
                  受信した福祉用具レコードが 0 件です。送信元で当月のレンタルが無い可能性があります。
                </p>
              )}
            </>
          ) : null}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-sm text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={loading || submitting || !diff || extracted.incoming.length === 0 || (diff.conflicts.length > 0 && choice == null)}
            className="text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5"
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            取り込み確定 ({extracted.incoming.length} 件)
          </button>
        </div>
      </div>
    </div>
  );
}
