"use client";

/**
 * サービスコードマスタ CSV取込 (世代管理) ダイアログ
 *
 * 既存の「CSV取込」(UPSERT 経路) とは完全に独立した追加コンポーネント。
 *   - 形式: ①総合事業 単位数表標準マスタ (国保連統一CSV) / ②汎用 (列マッピング手動)
 *   - 適用開始月 (valid_from) 必須。既存現行世代は「旧世代クローズ+世代追加」or「スキップ」
 *   - プレビュー (新規/世代追加/スキップ/警告) → 確定 の 2 段
 *   - 取込単位で import_batch_id を記録 → 「取込履歴」タブから取込単位の取り消しが可能
 *     (INSERT 行の DELETE + クローズした旧世代の valid_until 復元)
 *
 * 事前に migrations/service_code_import_batch.sql の適用が必要
 * (未適用の場合はバナー表示 + 確定ボタン無効化)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  AlertTriangle,
  FileUp,
  History,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  type ExistingGeneration,
  type GenericMapping,
  type ImportPlan,
  type ImportServiceSystem,
  type ParseOutcome,
  GENERIC_TARGET_FIELDS,
  decodeCsvBuffer,
  monthToValidFrom,
  parseCsvText,
  parseGeneric,
  parseSougouStandard,
  planImport,
} from "@/lib/service-code-import";

// ─── Types ────────────────────────────────────────────────────────────────────

type ImportFormat = "sougou_standard" | "generic";

interface ImportBatchRecord {
  id: string;
  file_name: string;
  format: string;
  system: string;
  valid_from: string;
  close_mode: string;
  inserted_count: number;
  closed_count: number;
  skipped_count: number;
  closed_rows: { id: string; service_code: string; prev_valid_until: string | null }[];
  status: "applied" | "reverted";
  reverted_at: string | null;
  notes: string | null;
  created_at: string;
}

const SYSTEMS: ImportServiceSystem[] = ["介護", "障害", "総合事業", "独自"];

const FORMAT_LABELS: Record<string, string> = {
  sougou_standard: "総合事業 単位数表標準マスタ",
  generic: "汎用 (列マッピング)",
};

const EMPTY_MAPPING: Record<keyof GenericMapping, string> = {
  code: "",
  name: "",
  units: "",
  category: "",
  categoryName: "",
  unitType: "",
  calcType: "",
  notes: "",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ServiceCodeImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  /** 取込確定 / 取消 完了後にマスタ一覧を再 fetch させる */
  onImported: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [tab, setTab] = useState<"import" | "history">("import");
  // null = 確認中 / false = migrations/service_code_import_batch.sql 未適用
  const [schemaReady, setSchemaReady] = useState<boolean | null>(null);

  // ── file ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rawRows, setRawRows] = useState<string[][] | null>(null);
  // ファイル読込ごとに増える id (プレビュー鮮度キーに使う)
  const [fileId, setFileId] = useState(0);

  // ── 共通オプション ──
  const [format, setFormat] = useState<ImportFormat>("sougou_standard");
  const [validFromMonth, setValidFromMonth] = useState(""); // "YYYY-MM"
  const [closeMode, setCloseMode] = useState<"revise" | "skip">("revise");
  const [batchMemo, setBatchMemo] = useState("");

  // ── ①総合事業 標準マスタ オプション ──
  const [insurerFilter, setInsurerFilter] = useState("");
  const [currentOnly, setCurrentOnly] = useState(true);
  const [codePrefix, setCodePrefix] = useState("");
  const [municipalityLabel, setMunicipalityLabel] = useState("");

  // ── ②汎用 オプション ──
  const [genericSystem, setGenericSystem] = useState<ImportServiceSystem>("介護");
  const [hasHeader, setHasHeader] = useState(true);
  // 手動で選び直した列のみ保持 (未指定はヘッダーからの自動推定を使う)
  const [mappingOverride, setMappingOverride] = useState<
    Partial<Record<keyof GenericMapping, string>>
  >({});

  // ── プレビュー / 実行 ──
  // plan は「作成時点の入力キー」とセットで保持し、入力が変わったら自動的に無効化する
  const [planState, setPlanState] = useState<{
    key: string;
    plan: ImportPlan;
  } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{
    phase: string;
    done: number;
    total: number;
  } | null>(null);
  const [doneSummary, setDoneSummary] = useState<string | null>(null);

  // ── 履歴 ──
  const [history, setHistory] = useState<ImportBatchRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [revertTarget, setRevertTarget] = useState<ImportBatchRecord | null>(null);
  const [reverting, setReverting] = useState(false);

  const targetSystem: ImportServiceSystem =
    format === "sougou_standard" ? "総合事業" : genericSystem;

  // ── 履歴 load ──────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from("kaigo_service_code_import_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    setHistoryLoading(false);
    if (error) {
      // schema 未適用時はバナーで案内済みなので toast は出さない
      setHistory([]);
      return;
    }
    setHistory((data ?? []) as ImportBatchRecord[]);
  }, [supabase]);

  // ── schema 確認 (SQL 未適用検知) + 初回履歴 load ───────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { error: e1 } = await supabase
        .from("kaigo_service_code_import_batches")
        .select("id")
        .limit(1);
      const { error: e2 } = await supabase
        .from("kaigo_service_codes")
        .select("import_batch_id")
        .limit(1);
      if (cancelled) return;
      const ready = !e1 && !e2;
      setSchemaReady(ready);
      if (ready) await loadHistory();
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, loadHistory]);

  // ── file 読込 ──────────────────────────────────────────────────────────────
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileRef.current) fileRef.current.value = "";
    try {
      const buf = await file.arrayBuffer();
      const text = decodeCsvBuffer(buf);
      const rows = parseCsvText(text);
      if (rows.length === 0) {
        toast.error("CSV にデータ行がありません");
        return;
      }
      setRawRows(rows);
      setFileName(file.name);
      setFileId((n) => n + 1);
      setDoneSummary(null);
      setInsurerFilter("");
      setMappingOverride({});
    } catch (err) {
      toast.error(
        "CSV の読込に失敗: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  // ── ②汎用: ヘッダーからマッピング自動推定 (手動選択 = mappingOverride が優先) ──
  const autoGuessMapping = useMemo<Record<keyof GenericMapping, string>>(() => {
    if (!rawRows || !hasHeader) return EMPTY_MAPPING;
    const headers = rawRows[0].map((h) => h.trim().toLowerCase());
    const find = (...pats: RegExp[]): string => {
      for (const p of pats) {
        const i = headers.findIndex((h) => p.test(h));
        if (i >= 0) return String(i);
      }
      return "";
    };
    return {
      code: find(/^service_code$/, /項目コード/, /コード/),
      name: find(/^service_name$/, /サービス名|名称/),
      units: find(/^units$/, /単位数/),
      category: find(/^service_category$/, /種類コード|サービス種類$/),
      categoryName: find(/^service_category_name$/, /種類名/),
      unitType: find(/^unit_type$/, /算定単位/),
      calcType: find(/^calculation_type$/, /^区分$/),
      notes: find(/^notes$/, /備考/),
    };
  }, [rawRows, hasHeader]);

  const mapping: Record<keyof GenericMapping, string> = useMemo(
    () => ({ ...autoGuessMapping, ...mappingOverride }),
    [autoGuessMapping, mappingOverride],
  );

  // ── パース (純ロジック / オプション変更で再計算) ──────────────────────────
  const genericMapping: GenericMapping | null = useMemo(() => {
    const p = (v: string): number | null => (v === "" ? null : Number(v));
    const code = p(mapping.code);
    const name = p(mapping.name);
    const units = p(mapping.units);
    if (code == null || name == null || units == null) return null;
    return {
      code,
      name,
      units,
      category: p(mapping.category),
      categoryName: p(mapping.categoryName),
      unitType: p(mapping.unitType),
      calcType: p(mapping.calcType),
      notes: p(mapping.notes),
    };
  }, [mapping]);

  const parseOutcome: ParseOutcome | null = useMemo(() => {
    if (!rawRows) return null;
    if (format === "sougou_standard") {
      return parseSougouStandard(rawRows, {
        insurerFilter,
        currentOnly,
        targetMonth: validFromMonth.replace("-", ""),
        codePrefix: codePrefix.trim(),
        municipalityLabel: municipalityLabel.trim(),
      });
    }
    if (!genericMapping) return null;
    return parseGeneric(rawRows, genericMapping, {
      system: genericSystem,
      hasHeader,
      codePrefix: codePrefix.trim(),
    });
  }, [
    rawRows,
    format,
    insurerFilter,
    currentOnly,
    validFromMonth,
    codePrefix,
    municipalityLabel,
    genericMapping,
    genericSystem,
    hasHeader,
  ]);

  // プレビュー鮮度キー: 入力が 1 つでも変わると planState と一致しなくなり自動無効化
  const planKey = useMemo(
    () =>
      JSON.stringify([
        fileId,
        format,
        insurerFilter,
        currentOnly,
        codePrefix,
        municipalityLabel,
        genericSystem,
        hasHeader,
        mapping,
        validFromMonth,
        closeMode,
      ]),
    [
      fileId,
      format,
      insurerFilter,
      currentOnly,
      codePrefix,
      municipalityLabel,
      genericSystem,
      hasHeader,
      mapping,
      validFromMonth,
      closeMode,
    ],
  );
  const plan: ImportPlan | null =
    planState && planState.key === planKey ? planState.plan : null;

  // 列選択肢 (②汎用)
  const columnOptions = useMemo(() => {
    if (!rawRows) return [];
    const maxCols = rawRows
      .slice(0, 50)
      .reduce((m, r) => Math.max(m, r.length), 0);
    const header = hasHeader ? rawRows[0] : null;
    const sample = rawRows[hasHeader ? 1 : 0];
    return Array.from({ length: maxCols }, (_, i) => {
      const h = header?.[i]?.trim();
      const s = sample?.[i]?.trim();
      const hint = h || s || "";
      return {
        value: String(i),
        label: `列${i + 1}${hint ? `: ${hint.slice(0, 14)}` : ""}`,
      };
    });
  }, [rawRows, hasHeader]);

  // ── プレビュー作成 (既存世代と照合) ────────────────────────────────────────
  const buildPlan = async () => {
    if (!parseOutcome || parseOutcome.candidates.length === 0) {
      toast.error("取込対象行がありません (ファイルと形式・マッピングを確認)");
      return;
    }
    const validFrom = monthToValidFrom(validFromMonth);
    if (!validFrom) {
      toast.error("適用開始月を指定してください");
      return;
    }
    setPlanning(true);
    try {
      const codes = [...new Set(parseOutcome.candidates.map((c) => c.service_code))];
      const existing: ExistingGeneration[] = [];
      const CHUNK = 100;
      for (let i = 0; i < codes.length; i += CHUNK) {
        const { data, error } = await supabase
          .from("kaigo_service_codes")
          .select("id, service_code, valid_from, valid_until")
          .eq("system", targetSystem)
          .in("service_code", codes.slice(i, i + CHUNK));
        if (error) {
          toast.error("既存世代の照合に失敗: " + error.message);
          return;
        }
        existing.push(...((data ?? []) as ExistingGeneration[]));
      }
      setPlanState({
        key: planKey,
        plan: planImport(parseOutcome.candidates, existing, validFrom, closeMode),
      });
      setDoneSummary(null);
    } finally {
      setPlanning(false);
    }
  };

  // ── 取込確定 ───────────────────────────────────────────────────────────────
  const executeImport = async () => {
    if (!plan) return;
    const validFrom = monthToValidFrom(validFromMonth);
    if (!validFrom) return;
    if (schemaReady !== true) {
      toast.error(
        "migrations/service_code_import_batch.sql が未適用のため取込できません",
      );
      return;
    }
    const inserts = [...plan.newInserts, ...plan.revisionInserts];
    if (inserts.length === 0) {
      toast.error("取込対象がありません (全てスキップ)");
      return;
    }
    setImporting(true);
    try {
      const batchId = crypto.randomUUID();

      // 1. バッチ記録を先に作成 (途中失敗でも「取り消す」で巻き戻せるように)
      const { error: bErr } = await supabase
        .from("kaigo_service_code_import_batches")
        .insert({
          id: batchId,
          file_name: fileName,
          format,
          system: targetSystem,
          valid_from: validFrom,
          close_mode: closeMode,
          inserted_count: inserts.length,
          closed_count: plan.closes.length,
          skipped_count: plan.skips.length,
          closed_rows: plan.closes,
          notes: batchMemo.trim() || null,
        });
      if (bErr) {
        toast.error("取込バッチの記録に失敗: " + bErr.message);
        return;
      }

      // 2. 新世代 INSERT (50件 chunk / import_batch_id 付き)
      const CHUNK = 50;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const batch = inserts.slice(i, i + CHUNK).map((c) => ({
          system: targetSystem,
          service_category: c.service_category,
          service_category_name: c.service_category_name,
          service_code: c.service_code,
          service_name: c.service_name,
          units: c.units,
          unit_type: c.unit_type,
          calculation_type: c.calculation_type,
          valid_from: validFrom,
          valid_until: null,
          notes: c.notes,
          import_batch_id: batchId,
        }));
        const { error } = await supabase.from("kaigo_service_codes").insert(batch);
        if (error) {
          toast.error(
            `INSERT 失敗 (${i + 1}〜${i + batch.length} 件目): ${error.message} — 取込履歴の「取り消す」で巻き戻せます`,
          );
          void loadHistory();
          return;
        }
        setProgress({
          phase: "新世代 INSERT",
          done: Math.min(i + CHUNK, inserts.length),
          total: inserts.length,
        });
      }

      // 3. 旧世代クローズ (valid_until = 適用前月末)
      const closeIds = plan.closes.map((c) => c.id);
      for (let i = 0; i < closeIds.length; i += CHUNK) {
        const ids = closeIds.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("kaigo_service_codes")
          .update({ valid_until: plan.closeDate })
          .in("id", ids);
        if (error) {
          toast.error(
            `旧世代クローズ失敗: ${error.message} — 取込履歴の「取り消す」で巻き戻せます`,
          );
          void loadHistory();
          return;
        }
        setProgress({
          phase: "旧世代クローズ",
          done: Math.min(i + CHUNK, closeIds.length),
          total: closeIds.length,
        });
      }

      const summary = `新規 ${plan.newInserts.length} 件 / 世代追加 ${plan.revisionInserts.length} 件 / 旧世代クローズ ${plan.closes.length} 件 / スキップ ${plan.skips.length} 件`;
      toast.success(`取込完了: ${summary}`);
      setDoneSummary(summary);
      setPlanState(null);
      onImported();
      void loadHistory();
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  // ── 取込の取り消し ─────────────────────────────────────────────────────────
  const revertBatch = async (batch: ImportBatchRecord) => {
    setReverting(true);
    try {
      // 1. この取込で INSERT した行を削除
      const { error: delErr } = await supabase
        .from("kaigo_service_codes")
        .delete()
        .eq("import_batch_id", batch.id);
      if (delErr) {
        toast.error("取消 (INSERT 行の削除) に失敗: " + delErr.message);
        return;
      }
      // 2. クローズした旧世代の valid_until を復元 (prev 値ごとに UPDATE)
      const groups = new Map<string, { prev: string | null; ids: string[] }>();
      for (const c of batch.closed_rows ?? []) {
        const key = c.prev_valid_until ?? "__null__";
        const g = groups.get(key) ?? { prev: c.prev_valid_until ?? null, ids: [] };
        g.ids.push(c.id);
        groups.set(key, g);
      }
      for (const { prev, ids } of groups.values()) {
        for (let i = 0; i < ids.length; i += 50) {
          const { error } = await supabase
            .from("kaigo_service_codes")
            .update({ valid_until: prev })
            .in("id", ids.slice(i, i + 50));
          if (error) {
            toast.error("取消 (旧世代の復元) に失敗: " + error.message);
            return;
          }
        }
      }
      // 3. バッチを reverted に
      const { error: uErr } = await supabase
        .from("kaigo_service_code_import_batches")
        .update({ status: "reverted", reverted_at: new Date().toISOString() })
        .eq("id", batch.id);
      if (uErr) {
        toast.error("取消状態の記録に失敗: " + uErr.message);
        return;
      }
      toast.success(
        `取込を取り消しました (削除 ${batch.inserted_count} 件 / 旧世代復元 ${(batch.closed_rows ?? []).length} 件)`,
      );
      setRevertTarget(null);
      onImported();
      await loadHistory();
    } finally {
      setReverting(false);
    }
  };

  const busy = importing || reverting;

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => !busy && onClose()}
      />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col">
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-4">
            <h2 className="text-base font-semibold text-gray-800">
              CSV取込 (世代管理)
            </h2>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
              <button
                onClick={() => setTab("import")}
                className={`px-3 py-1.5 flex items-center gap-1 ${
                  tab === "import"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                取込
              </button>
              <button
                onClick={() => setTab("history")}
                className={`px-3 py-1.5 flex items-center gap-1 border-l border-gray-200 ${
                  tab === "history"
                    ? "bg-indigo-600 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                <History className="w-3.5 h-3.5" />
                取込履歴
              </button>
            </div>
          </div>
          <button
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── schema 未適用バナー ── */}
        {schemaReady === false && (
          <div className="mx-6 mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <strong>migrations/service_code_import_batch.sql が未適用です。</strong>
              Supabase SQL Editor で適用するまで取込の確定・取り消しはできません
              (プレビューまでは可能)。
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {tab === "import" ? (
            <>
              {/* ── 1. 形式 + ファイル ── */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                <div className="text-xs font-semibold text-gray-700">
                  1. 取込形式とファイル
                </div>
                <div className="flex gap-3 text-xs">
                  <label
                    className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                      format === "sougou_standard"
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={format === "sougou_standard"}
                      onChange={() => setFormat("sougou_standard")}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <div className="font-semibold text-gray-800">
                        ① 総合事業 単位数表標準マスタ
                      </div>
                      <div className="text-gray-500">
                        国保中央会統一 CSV (ヘッダー無し 19 項目)。市町村公表ファイルをそのまま
                      </div>
                    </div>
                  </label>
                  <label
                    className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                      format === "generic"
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={format === "generic"}
                      onChange={() => setFormat("generic")}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <div className="font-semibold text-gray-800">
                        ② 汎用 (列マッピング手動)
                      </div>
                      <div className="text-gray-500">
                        コード/名称/単位数 等の列をプルダウンで対応付け
                      </div>
                    </div>
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,.txt"
                    className="hidden"
                    onChange={handleFile}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-xs font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    <FileUp className="w-4 h-4" />
                    CSV を選択 (Shift_JIS / UTF-8 自動判定)
                  </button>
                  {fileName && rawRows && (
                    <span className="text-xs text-gray-600">
                      {fileName}{" "}
                      <span className="text-gray-400">({rawRows.length} 行)</span>
                    </span>
                  )}
                </div>
              </div>

              {/* ── 2. 形式別オプション ── */}
              {rawRows && format === "sougou_standard" && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                  <div className="text-xs font-semibold text-gray-700">
                    2. 標準マスタ オプション (system は「総合事業」固定)
                  </div>
                  <div className="flex flex-wrap items-end gap-3 text-xs">
                    <div>
                      <label className="block text-[11px] text-gray-600 mb-1">
                        保険者番号
                      </label>
                      <select
                        value={insurerFilter}
                        onChange={(e) => setInsurerFilter(e.target.value)}
                        className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                      >
                        <option value="">全て</option>
                        {Object.entries(parseOutcome?.insurerCounts ?? {})
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([num, n]) => (
                            <option key={num} value={num}>
                              {num} ({n} 行)
                            </option>
                          ))}
                      </select>
                    </div>
                    <label className="flex items-center gap-1.5 pb-1.5">
                      <input
                        type="checkbox"
                        checked={currentOnly}
                        onChange={(e) => setCurrentOnly(e.target.checked)}
                        className="accent-indigo-500"
                      />
                      現行行のみ (適用終了年月=999999)
                    </label>
                    <div>
                      <label className="block text-[11px] text-gray-600 mb-1">
                        コード接頭辞 (市町村区別用・任意)
                      </label>
                      <input
                        type="text"
                        value={codePrefix}
                        onChange={(e) => setCodePrefix(e.target.value)}
                        placeholder="例: K_"
                        className="w-24 text-xs border border-gray-300 rounded px-2 py-1.5 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-gray-600 mb-1">
                        自治体名 (任意・種類名/備考に付記)
                      </label>
                      <input
                        type="text"
                        value={municipalityLabel}
                        onChange={(e) => setMunicipalityLabel(e.target.value)}
                        placeholder="例: 木更津市"
                        className="w-36 text-xs border border-gray-300 rounded px-2 py-1.5"
                      />
                    </div>
                  </div>
                  {!currentOnly && (
                    <div className="text-[11px] text-gray-500">
                      ※ 現行行のみ OFF: 下で指定する適用開始月の時点で有効な行を取り込みます
                    </div>
                  )}
                </div>
              )}

              {rawRows && format === "generic" && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                  <div className="text-xs font-semibold text-gray-700">
                    2. 汎用 オプション (列マッピング)
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <div className="flex gap-1.5">
                      {SYSTEMS.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setGenericSystem(s)}
                          className={`px-2.5 py-1 rounded-lg border ${
                            genericSystem === s
                              ? "border-indigo-400 bg-indigo-50 text-indigo-700 font-semibold"
                              : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={hasHeader}
                        onChange={(e) => setHasHeader(e.target.checked)}
                        className="accent-indigo-500"
                      />
                      1 行目はヘッダー
                    </label>
                    <div className="flex items-center gap-1.5">
                      <label className="text-[11px] text-gray-600">接頭辞</label>
                      <input
                        type="text"
                        value={codePrefix}
                        onChange={(e) => setCodePrefix(e.target.value)}
                        placeholder="任意"
                        className="w-20 text-xs border border-gray-300 rounded px-2 py-1 font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {GENERIC_TARGET_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label className="block text-[11px] text-gray-600 mb-0.5">
                          {f.label}
                          {f.required && <span className="text-red-500 ml-0.5">*</span>}
                        </label>
                        <select
                          value={mapping[f.key]}
                          onChange={(e) =>
                            setMappingOverride((prev) => ({
                              ...prev,
                              [f.key]: e.target.value,
                            }))
                          }
                          className="w-full text-xs border border-gray-300 rounded px-1.5 py-1.5 bg-white"
                        >
                          <option value="">
                            {f.required ? "選択してください" : "(未使用)"}
                          </option>
                          {columnOptions.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    ※ 種類が未指定の場合はコード先頭 2 桁、区分が未指定の場合は名称から自動判定
                    (加算/減算/基本) します
                  </div>
                </div>
              )}

              {/* ── 3. 適用開始月 + 世代の扱い ── */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                <div className="text-xs font-semibold text-amber-800">
                  3. 適用開始月 (valid_from) と既存現行世代の扱い
                </div>
                <div className="flex flex-wrap items-end gap-3 text-xs">
                  <div>
                    <label className="block text-[11px] text-gray-600 mb-1">
                      適用開始月 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="month"
                      value={validFromMonth}
                      onChange={(e) => setValidFromMonth(e.target.value)}
                      className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                    />
                  </div>
                  <div className="text-[11px] text-amber-700 pb-1.5">
                    valid_from = 指定月の 1 日 / 旧世代クローズ時の valid_until = 適用前月末
                  </div>
                </div>
                <div className="flex gap-3 text-xs">
                  <label
                    className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 bg-white ${
                      closeMode === "revise"
                        ? "border-indigo-400 ring-1 ring-indigo-200"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={closeMode === "revise"}
                      onChange={() => setCloseMode("revise")}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <div className="font-semibold text-gray-800">
                        旧世代をクローズして世代追加 (改定)
                      </div>
                      <div className="text-gray-500">
                        現行世代の valid_until を適用前月末に更新し、新世代を INSERT
                      </div>
                    </div>
                  </label>
                  <label
                    className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 bg-white ${
                      closeMode === "skip"
                        ? "border-indigo-400 ring-1 ring-indigo-200"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={closeMode === "skip"}
                      onChange={() => setCloseMode("skip")}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <div className="font-semibold text-gray-800">スキップ</div>
                      <div className="text-gray-500">
                        現行世代がある code は取り込まない (新規 code のみ追加)
                      </div>
                    </div>
                  </label>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-600 mb-1">
                    取込メモ (任意・履歴に記録)
                  </label>
                  <input
                    type="text"
                    value={batchMemo}
                    onChange={(e) => setBatchMemo(e.target.value)}
                    placeholder="例: 木更津市 令和8年6月改定"
                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                  />
                </div>
              </div>

              {/* ── 4. パース結果 ── */}
              {parseOutcome && (
                <div className="rounded-lg border border-gray-200 p-3 space-y-2">
                  <div className="text-xs font-semibold text-gray-700">
                    4. 読取結果 — system:{" "}
                    <span className="text-indigo-700">{targetSystem}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <div className="rounded bg-blue-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">取込候補</div>
                      <div className="font-bold text-blue-700">
                        {parseOutcome.candidates.length} 件
                      </div>
                    </div>
                    <div className="rounded bg-gray-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">データ行</div>
                      <div className="font-bold text-gray-700">
                        {parseOutcome.totalDataRows} 行
                      </div>
                    </div>
                    <div className="rounded bg-gray-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">フィルタ除外</div>
                      <div className="font-bold text-gray-700">
                        {parseOutcome.filteredOutCount} 行
                      </div>
                    </div>
                    <div className="rounded bg-red-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">形式不正</div>
                      <div className="font-bold text-red-700">
                        {parseOutcome.invalidCount} 行
                      </div>
                    </div>
                  </div>
                  {parseOutcome.warnings.length > 0 && (
                    <ul className="rounded border border-amber-200 bg-amber-50 px-3 py-2 space-y-0.5">
                      {parseOutcome.warnings.map((w, i) => (
                        <li key={i} className="text-[11px] text-amber-800">
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  )}
                  {parseOutcome.ignoredColumns.length > 0 && (
                    <div className="text-[11px] text-gray-500">
                      未対応列 (無視):{" "}
                      {parseOutcome.ignoredColumns
                        .map((c) => `列${c.index + 1} ${c.label}`)
                        .join(" / ")}
                    </div>
                  )}
                  <div className="rounded border border-gray-200 overflow-hidden">
                    <div className="px-2 py-1 text-[11px] font-semibold text-gray-600 bg-gray-50 border-b">
                      先頭 15 件
                    </div>
                    <div className="max-h-44 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="text-left px-2 py-1 text-gray-600">種類</th>
                            <th className="text-left px-2 py-1 text-gray-600">コード</th>
                            <th className="text-left px-2 py-1 text-gray-600">名称</th>
                            <th className="text-right px-2 py-1 text-gray-600">単位数</th>
                            <th className="text-left px-2 py-1 text-gray-600">算定単位</th>
                            <th className="text-left px-2 py-1 text-gray-600">区分</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parseOutcome.candidates.slice(0, 15).map((c) => (
                            <tr key={`${c.service_code}-${c.rowIndex}`} className="border-t">
                              <td className="px-2 py-1 font-mono">{c.service_category}</td>
                              <td className="px-2 py-1 font-mono">{c.service_code}</td>
                              <td className="px-2 py-1 truncate max-w-[240px]">
                                {c.service_name}
                              </td>
                              <td className="px-2 py-1 text-right">{c.units}</td>
                              <td className="px-2 py-1">{c.unit_type}</td>
                              <td className="px-2 py-1">{c.calculation_type}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {!plan && (
                    <button
                      onClick={buildPlan}
                      disabled={planning || parseOutcome.candidates.length === 0}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {planning ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4" />
                      )}
                      プレビュー作成 (既存世代と照合)
                    </button>
                  )}
                </div>
              )}

              {/* ── 5. プレビュー (取込計画) ── */}
              {plan && (
                <div className="rounded-lg border-2 border-indigo-200 p-3 space-y-2">
                  <div className="text-xs font-semibold text-indigo-800">
                    5. 取込プレビュー — 確定するまで DB は変更されません
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-xs">
                    <div className="rounded bg-blue-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">新規</div>
                      <div className="font-bold text-blue-700">
                        {plan.newInserts.length} 件
                      </div>
                    </div>
                    <div className="rounded bg-emerald-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">世代追加 (改定)</div>
                      <div className="font-bold text-emerald-700">
                        {plan.revisionInserts.length} 件
                      </div>
                    </div>
                    <div className="rounded bg-amber-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">
                        旧世代クローズ (→{plan.closeDate})
                      </div>
                      <div className="font-bold text-amber-700">
                        {plan.closes.length} 件
                      </div>
                    </div>
                    <div className="rounded bg-gray-50 px-2 py-1.5">
                      <div className="text-[10px] text-gray-500">スキップ</div>
                      <div className="font-bold text-gray-700">
                        {plan.skips.length} 件
                      </div>
                    </div>
                  </div>
                  {plan.skips.length > 0 && (
                    <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 max-h-32 overflow-y-auto">
                      <div className="text-[11px] font-semibold text-gray-600 mb-1">
                        スキップ理由 (先頭 30 件)
                      </div>
                      {plan.skips.slice(0, 30).map((s, i) => (
                        <div key={i} className="text-[11px] text-gray-600">
                          ・{s.service_code} {s.service_name.slice(0, 24)} — {s.reason}
                        </div>
                      ))}
                      {plan.skips.length > 30 && (
                        <div className="text-[11px] text-gray-400 italic">
                          ... ほか {plan.skips.length - 30} 件
                        </div>
                      )}
                    </div>
                  )}
                  {progress && (
                    <div className="rounded bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
                      {progress.phase} 中... {progress.done} / {progress.total} 件
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={executeImport}
                      disabled={
                        importing ||
                        schemaReady !== true ||
                        plan.newInserts.length + plan.revisionInserts.length === 0
                      }
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {importing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Upload className="w-4 h-4" />
                      )}
                      {plan.newInserts.length + plan.revisionInserts.length} 件 取込確定
                    </button>
                    <button
                      onClick={() => setPlanState(null)}
                      disabled={importing}
                      className="px-3 py-2 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                    >
                      設定に戻る
                    </button>
                    {schemaReady !== true && (
                      <span className="text-[11px] text-amber-700">
                        SQL 未適用のため確定不可
                      </span>
                    )}
                  </div>
                </div>
              )}

              {doneSummary && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                  取込完了: {doneSummary} — 取り消す場合は「取込履歴」タブから実行できます
                </div>
              )}
            </>
          ) : (
            /* ── 取込履歴タブ ── */
            <div className="space-y-2">
              {historyLoading ? (
                <div className="flex items-center justify-center py-10 text-gray-400 text-sm">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  読み込み中...
                </div>
              ) : history.length === 0 ? (
                <div className="py-10 text-center text-sm text-gray-400">
                  取込履歴はありません
                </div>
              ) : (
                history.map((b) => (
                  <div
                    key={b.id}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      b.status === "reverted"
                        ? "border-gray-200 bg-gray-50 opacity-70"
                        : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-800 truncate">
                            {b.file_name}
                          </span>
                          <span className="shrink-0 rounded bg-indigo-50 text-indigo-700 px-1.5 py-0.5 text-[10px]">
                            {FORMAT_LABELS[b.format] ?? b.format}
                          </span>
                          <span className="shrink-0 rounded bg-gray-100 text-gray-600 px-1.5 py-0.5 text-[10px]">
                            {b.system}
                          </span>
                          {b.status === "reverted" && (
                            <span className="shrink-0 rounded bg-red-50 text-red-600 px-1.5 py-0.5 text-[10px]">
                              取消済 (
                              {b.reverted_at
                                ? new Date(b.reverted_at).toLocaleString("ja-JP")
                                : ""}
                              )
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-gray-500">
                          {new Date(b.created_at).toLocaleString("ja-JP")} / 適用開始{" "}
                          {b.valid_from} / INSERT {b.inserted_count} 件 / クローズ{" "}
                          {b.closed_count} 件 / スキップ {b.skipped_count} 件
                          {b.notes ? ` / ${b.notes}` : ""}
                        </div>
                      </div>
                      {b.status === "applied" && (
                        <button
                          onClick={() => setRevertTarget(b)}
                          disabled={busy}
                          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          この取込を取り消す
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
          <button
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            閉じる
          </button>
        </div>

        {/* ── 取消確認 ── */}
        {revertTarget && (
          <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/30 rounded-2xl"
              onClick={() => !reverting && setRevertTarget(null)}
            />
            <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-2">
                取込の取り消し
              </h3>
              <p className="text-xs text-gray-600 mb-1">
                {revertTarget.file_name} ({new Date(revertTarget.created_at).toLocaleString("ja-JP")})
              </p>
              <ul className="text-xs text-gray-600 mb-4 list-disc list-inside space-y-0.5">
                <li>この取込で INSERT した {revertTarget.inserted_count} 件を削除</li>
                <li>
                  クローズした旧世代 {(revertTarget.closed_rows ?? []).length} 件の
                  valid_until を復元
                </li>
              </ul>
              <p className="text-[11px] text-amber-700 mb-4">
                ※ 取込後に手動編集した行も対象になります (削除 / valid_until 上書き)
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setRevertTarget(null)}
                  disabled={reverting}
                  className="px-3 py-1.5 text-xs text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={() => revertBatch(revertTarget)}
                  disabled={reverting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {reverting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5" />
                  )}
                  取り消す
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
