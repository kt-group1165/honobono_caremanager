"use client";

import { useRef, useState, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Plus,
  Edit2,
  Trash2,
  Search,
  X,
  Save,
  Loader2,
  Tag,
  Upload,
  Download,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServiceCode {
  id: string;
  service_category: string;
  service_category_name: string;
  service_code: string;
  service_name: string;
  units: number;
  unit_type: string;
  calculation_type: "基本" | "加算" | "減算";
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type FormData = Omit<ServiceCode, "id" | "created_at" | "updated_at">;

// CSV import 行 (検証済 = upsert 可能 / 検証失敗 = error 含む)
interface ServiceCodeImportRow {
  service_category: string;
  service_category_name: string;
  service_code: string;
  service_name: string;
  units: number;
  unit_type: string;
  calculation_type: "基本" | "加算" | "減算";
  valid_from: string | null;
  valid_until: string | null;
  notes: string | null;
  // 検証 / メタ
  rowIndex: number;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// 在宅系 サービス種類区分 (令和6年度報酬改定 に基づく)
// ─ 居宅サービス ─
//   11 訪問介護 / 12 訪問入浴介護 / 13 訪問看護 / 14 訪問リハ
//   15 通所介護 / 16 通所リハ
//   17 福祉用具貸与 / 18 特定福祉用具販売
//   21 短期入所生活介護 / 22 短期入所療養介護(老健) / 24 短期入所療養介護(医療院)
//   31 居宅療養管理指導 / 32 定期巡回・随時対応型訪問介護看護
//   33 夜間対応型訪問介護 / 36 認知症対応型通所介護 / 37 小規模多機能型居宅介護
//   38 認知症対応型共同生活介護 / 73 看護小規模多機能型居宅介護
// ─ 居宅介護支援 / 介護予防支援 ─
//   43 居宅介護支援 / 46 介護予防支援
const SERVICE_CATEGORIES: { value: string; label: string }[] = [
  { value: "11", label: "11:訪問介護" },
  { value: "12", label: "12:訪問入浴介護" },
  { value: "13", label: "13:訪問看護" },
  { value: "14", label: "14:訪問リハ" },
  { value: "15", label: "15:通所介護" },
  { value: "16", label: "16:通所リハ" },
  { value: "17", label: "17:福祉用具貸与" },
  { value: "18", label: "18:特定福祉用具販売" },
  { value: "21", label: "21:短期入所生活介護" },
  { value: "22", label: "22:短期入所療養介護(老健)" },
  { value: "24", label: "24:短期入所療養介護(医療院)" },
  { value: "31", label: "31:居宅療養管理指導" },
  { value: "32", label: "32:定期巡回・随時対応型訪問介護看護" },
  { value: "33", label: "33:夜間対応型訪問介護" },
  { value: "36", label: "36:認知症対応型通所介護" },
  { value: "37", label: "37:小規模多機能型居宅介護" },
  { value: "38", label: "38:認知症対応型共同生活介護" },
  { value: "43", label: "43:居宅介護支援" },
  { value: "46", label: "46:介護予防支援" },
  { value: "73", label: "73:看護小規模多機能型居宅介護" },
];

const CATEGORY_NAMES: Record<string, string> = {
  "11": "訪問介護",
  "12": "訪問入浴介護",
  "13": "訪問看護",
  "14": "訪問リハビリテーション",
  "15": "通所介護",
  "16": "通所リハビリテーション",
  "17": "福祉用具貸与",
  "18": "特定福祉用具販売",
  "21": "短期入所生活介護",
  "22": "短期入所療養介護(老健)",
  "24": "短期入所療養介護(医療院)",
  "31": "居宅療養管理指導",
  "32": "定期巡回・随時対応型訪問介護看護",
  "33": "夜間対応型訪問介護",
  "36": "認知症対応型通所介護",
  "37": "小規模多機能型居宅介護",
  "38": "認知症対応型共同生活介護",
  "43": "居宅介護支援",
  "46": "介護予防支援",
  "73": "看護小規模多機能型居宅介護",
};

const UNIT_TYPES = ["1回につき", "1日につき", "1月につき"];
const CALCULATION_TYPES = ["基本", "加算", "減算"] as const;

const CALC_TYPE_COLORS: Record<string, string> = {
  基本: "bg-blue-100 text-blue-700",
  加算: "bg-green-100 text-green-700",
  減算: "bg-red-100 text-red-700",
};

const EMPTY_FORM: FormData = {
  service_category: "",
  service_category_name: "",
  service_code: "",
  service_name: "",
  units: 0,
  unit_type: "1回につき",
  calculation_type: "基本",
  valid_from: null,
  valid_until: null,
  notes: null,
};

// ─── Component ────────────────────────────────────────────────────────────────

export function ServiceCodesContent({
  initialRecords,
}: {
  initialRecords: ServiceCode[];
}) {
  const supabase = useMemo(() => createClient(), []);

  const [records, setRecords] = useState<ServiceCode[]>(initialRecords);
  const [loading, setLoading] = useState(false);
  const [filterCategory, setFilterCategory] = useState("");
  const [filterCalcType, setFilterCalcType] = useState("");
  const [searchText, setSearchText] = useState("");
  const [filterActiveAt, setFilterActiveAt] = useState<string>(""); // "" = 全件, "YYYY-MM-DD" = その日付で有効な行のみ

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // CSV import
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    rows: ServiceCodeImportRow[];
    fileName: string;
    errors: string[];
  } | null>(null);
  const [importMode, setImportMode] = useState<"upsert" | "skip-existing">("upsert");
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);

  // ─── Data fetch (refetch after CRUD) ────────────────────────────────────────

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      // PostgREST default 1000 行制限を避けるため page-loop で全件取得
      const PAGE = 1000;
      const all: ServiceCode[] = [];
      let from = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("kaigo_service_codes")
          .select("*")
          .order("service_category", { ascending: true })
          .order("service_code", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as ServiceCode[];
        all.push(...rows);
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      setRecords(all);
    } catch (err: unknown) {
      toast.error(
        "データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  // ─── In-memory filtering (records は全件、filter は client 側) ───────────────

  const displayed = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return records.filter((r) => {
      if (filterCategory && r.service_category !== filterCategory) return false;
      if (filterCalcType && r.calculation_type !== filterCalcType) return false;
      if (q && !r.service_code.toLowerCase().includes(q) && !r.service_name.toLowerCase().includes(q)) return false;
      // 適用日フィルタ: 指定日に有効な行のみ (valid_from <= D AND (valid_until IS NULL OR valid_until >= D))
      if (filterActiveAt) {
        if (r.valid_from && r.valid_from > filterActiveAt) return false;
        if (r.valid_until && r.valid_until < filterActiveAt) return false;
      }
      return true;
    });
  }, [records, filterCategory, filterCalcType, searchText, filterActiveAt]);

  // ─── Form helpers ────────────────────────────────────────────────────────────

  function openCreate() {
    setEditingId(null);
    setFormData(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(record: ServiceCode) {
    setEditingId(record.id);
    setFormData({
      service_category: record.service_category,
      service_category_name: record.service_category_name,
      service_code: record.service_code,
      service_name: record.service_name,
      units: record.units,
      unit_type: record.unit_type,
      calculation_type: record.calculation_type,
      valid_from: record.valid_from,
      valid_until: record.valid_until,
      notes: record.notes,
    });
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingId(null);
    setFormData(EMPTY_FORM);
  }

  function handleCategoryChange(value: string) {
    setFormData((prev) => ({
      ...prev,
      service_category: value,
      service_category_name: CATEGORY_NAMES[value] ?? "",
    }));
  }

  function setField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!formData.service_category) {
      toast.error("サービス種類を選択してください");
      return;
    }
    if (!formData.service_code.trim()) {
      toast.error("サービスコードを入力してください");
      return;
    }
    // サービスコードは 6 桁の英数字 (大文字、I/O/Q を除く) — 厚労省の表記に準拠
    if (!/^[0-9A-HJ-NPR-Z]{6}$/.test(formData.service_code.trim())) {
      toast.error("サービスコードは6桁の英数字 (大文字、I/O/Q 不可) で入力してください");
      return;
    }
    if (!formData.service_name.trim()) {
      toast.error("サービス名称を入力してください");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...formData,
        service_code: formData.service_code.trim(),
        service_name: formData.service_name.trim(),
        notes: formData.notes?.trim() || null,
        valid_from: formData.valid_from || null,
        valid_until: formData.valid_until || null,
      };

      if (editingId) {
        const { error } = await supabase
          .from("kaigo_service_codes")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
        toast.success("サービスコードを更新しました");
      } else {
        const { error } = await supabase
          .from("kaigo_service_codes")
          .insert(payload);
        if (error) throw error;
        toast.success("サービスコードを登録しました");
      }

      closeDialog();
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "保存に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setSaving(false);
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("kaigo_service_codes")
        .delete()
        .eq("id", deleteId);
      if (error) throw error;
      toast.success("サービスコードを削除しました");
      setDeleteId(null);
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "削除に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setDeleting(false);
    }
  }

  // ─── CSV Export ──────────────────────────────────────────────────────────────

  const handleCsvExport = useCallback(() => {
    if (records.length === 0) {
      toast.error("出力するデータがありません");
      return;
    }
    const headers = [
      "service_category",
      "service_category_name",
      "service_code",
      "service_name",
      "units",
      "unit_type",
      "calculation_type",
      "valid_from",
      "valid_until",
      "notes",
    ];
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const lines = [headers.join(",")];
    for (const r of records) {
      lines.push(
        [
          r.service_category,
          r.service_category_name,
          r.service_code,
          r.service_name,
          r.units,
          r.unit_type,
          r.calculation_type,
          r.valid_from ?? "",
          r.valid_until ?? "",
          r.notes ?? "",
        ]
          .map(escape)
          .join(","),
      );
    }
    const bom = "﻿";
    const blob = new Blob([bom + lines.join("\r\n") + "\r\n"], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kaigo_service_codes_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`CSV を出力しました (${records.length} 件)`);
  }, [records]);

  // ─── CSV Import ──────────────────────────────────────────────────────────────

  const handleCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (csvFileRef.current) csvFileRef.current.value = "";

    try {
      const buf = await file.arrayBuffer();
      // 最初に UTF-8、ダメなら Shift-JIS で再 decode
      let text = "";
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        try {
          text = new TextDecoder("shift-jis").decode(buf);
        } catch {
          text = new TextDecoder("utf-8").decode(buf);
        }
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        toast.error("CSV の行数が不足しています (ヘッダー + 1行以上必要)");
        return;
      }

      // CSV parser (RFC 4180 風: 二重引用符対応)
      const parseLine = (line: string): string[] => {
        const out: string[] = [];
        let cur = "";
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQ) {
            if (ch === '"' && line[i + 1] === '"') {
              cur += '"';
              i++;
            } else if (ch === '"') {
              inQ = false;
            } else {
              cur += ch;
            }
          } else {
            if (ch === '"') inQ = true;
            else if (ch === ",") {
              out.push(cur);
              cur = "";
            } else cur += ch;
          }
        }
        out.push(cur);
        return out;
      };

      const headerCols = parseLine(lines[0]).map((s) => s.trim().toLowerCase());
      const idx = (name: string) => headerCols.indexOf(name);
      const iCat = idx("service_category");
      const iCatName = idx("service_category_name");
      const iCode = idx("service_code");
      const iName = idx("service_name");
      const iUnits = idx("units");
      const iUnitType = idx("unit_type");
      const iCalcType = idx("calculation_type");
      const iValidFrom = idx("valid_from");
      const iValidUntil = idx("valid_until");
      const iNotes = idx("notes");
      if (iCat < 0 || iCode < 0 || iName < 0) {
        toast.error(
          "CSV ヘッダーに service_category / service_code / service_name が必要です",
        );
        return;
      }

      const rows: ServiceCodeImportRow[] = [];
      const errors: string[] = [];
      for (let li = 1; li < lines.length; li++) {
        const cols = parseLine(lines[li]);
        const cat = (cols[iCat] ?? "").trim();
        const code = (cols[iCode] ?? "").trim();
        const name = (cols[iName] ?? "").trim();
        const catName =
          iCatName >= 0 && cols[iCatName]?.trim()
            ? cols[iCatName].trim()
            : (CATEGORY_NAMES[cat] ?? cat);
        const unitsRaw = iUnits >= 0 ? (cols[iUnits] ?? "").trim() : "0";
        const units = Number(unitsRaw) || 0;
        const unitType =
          iUnitType >= 0 && cols[iUnitType]?.trim() ? cols[iUnitType].trim() : "1回につき";
        const calcRaw =
          iCalcType >= 0 && cols[iCalcType]?.trim() ? cols[iCalcType].trim() : "基本";
        const calc: ServiceCodeImportRow["calculation_type"] =
          calcRaw === "加算" || calcRaw === "減算" ? calcRaw : "基本";
        const validFrom =
          iValidFrom >= 0 && cols[iValidFrom]?.trim() ? cols[iValidFrom].trim() : null;
        const validUntil =
          iValidUntil >= 0 && cols[iValidUntil]?.trim() ? cols[iValidUntil].trim() : null;
        const notes = iNotes >= 0 && cols[iNotes]?.trim() ? cols[iNotes].trim() : null;

        const row: ServiceCodeImportRow = {
          service_category: cat,
          service_category_name: catName,
          service_code: code,
          service_name: name,
          units,
          unit_type: unitType,
          calculation_type: calc,
          valid_from: validFrom,
          valid_until: validUntil,
          notes,
          rowIndex: li + 1, // 表示用の 1-indexed (header = 1, first data = 2)
        };

        // 検証
        if (!cat) row.error = "service_category が空";
        else if (!code) row.error = "service_code が空";
        else if (!/^[0-9A-HJ-NPR-Z]{6}$/.test(code))
          row.error = `service_code 形式不正: "${code}"`;
        else if (!name) row.error = "service_name が空";

        if (row.error) errors.push(`行 ${row.rowIndex}: ${row.error}`);
        rows.push(row);
      }

      setImportPreview({ rows, fileName: file.name, errors });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("CSV の読込に失敗: " + msg);
    }
  };

  const handleConfirmImport = async () => {
    if (!importPreview) return;
    const valid = importPreview.rows.filter((r) => !r.error);
    if (valid.length === 0) {
      toast.error("取り込める行がありません (全て検証エラー)");
      return;
    }
    setImporting(true);
    setImportProgress({ done: 0, total: valid.length });
    try {
      // バッチ size 200 で分割 upsert / insert
      const BATCH = 200;
      let done = 0;
      for (let i = 0; i < valid.length; i += BATCH) {
        const batch = valid.slice(i, i + BATCH).map((r) => ({
          service_category: r.service_category,
          service_category_name: r.service_category_name,
          service_code: r.service_code,
          service_name: r.service_name,
          units: r.units,
          unit_type: r.unit_type,
          calculation_type: r.calculation_type,
          valid_from: r.valid_from,
          valid_until: r.valid_until,
          notes: r.notes,
        }));
        // 複合 unique (service_code, valid_from) で UPSERT。
        // 同じ service_code でも valid_from が違えば別行として履歴保持される。
        // valid_from が CSV で空の場合は DB の DEFAULT ('2024-06-01') が入る。
        if (importMode === "upsert") {
          const { error } = await supabase
            .from("kaigo_service_codes")
            .upsert(batch, { onConflict: "service_code,valid_from" });
          if (error) throw error;
        } else {
          // skip-existing: 同 (service_code, valid_from) が既にあれば INSERT を skip
          const { error } = await supabase
            .from("kaigo_service_codes")
            .upsert(batch, { onConflict: "service_code,valid_from", ignoreDuplicates: true });
          if (error) throw error;
        }
        done += batch.length;
        setImportProgress({ done, total: valid.length });
      }
      const errCount = importPreview.rows.length - valid.length;
      toast.success(
        `CSV 取込完了: ${valid.length} 件 ${importMode === "upsert" ? "(既存上書き)" : "(既存スキップ)"}` +
          (errCount > 0 ? ` / 検証エラー ${errCount} 件` : ""),
      );
      setImportPreview(null);
      await fetchRecords();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("取込に失敗: " + msg);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Tag className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800">
                サービスコードマスタ
              </h1>
              <p className="text-sm text-gray-500">介護サービスコードの管理</p>
            </div>
            <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
              {displayed.length}件
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={csvFileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleCsvFile}
            />
            <button
              onClick={() => csvFileRef.current?.click()}
              disabled={importing}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="厚労省サービスコード表 CSV を取り込み (service_code を主キーに UPSERT)"
            >
              <Upload className="w-4 h-4" />
              CSV取込
            </button>
            <button
              onClick={handleCsvExport}
              disabled={records.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="現在のマスタを CSV で出力"
            >
              <Download className="w-4 h-4" />
              CSV出力
            </button>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              新規登録
            </button>
          </div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Service category */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">全て（種類）</option>
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>

          {/* Calculation type */}
          <select
            value={filterCalcType}
            onChange={(e) => setFilterCalcType(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="">全て（区分）</option>
            {CALCULATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {/* 適用日フィルタ */}
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-gray-500 whitespace-nowrap">適用日</label>
            <input
              type="date"
              value={filterActiveAt}
              onChange={(e) => setFilterActiveAt(e.target.value)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              title="この日付に有効なコードのみ表示"
            />
            <button
              type="button"
              onClick={() => setFilterActiveAt(new Date().toISOString().split("T")[0])}
              className="text-xs text-indigo-600 hover:underline"
              title="本日有効なコードのみ表示"
            >
              本日
            </button>
            {filterActiveAt && (
              <button
                type="button"
                onClick={() => setFilterActiveAt("")}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                クリア
              </button>
            )}
          </div>

          {/* Text search */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="コード・名称で検索..."
              className="w-full text-sm border border-gray-300 rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            {searchText && (
              <button
                onClick={() => setSearchText("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="px-6 py-4">
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mr-2" />
              <span className="text-gray-500 text-sm">読み込み中...</span>
            </div>
          ) : displayed.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Tag className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">データがありません</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      サービス種類
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      サービスコード
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">
                      サービス名称
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      単位数
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      算定単位
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      区分
                    </th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      適用期間
                    </th>
                    <th className="text-center px-4 py-3 font-medium text-gray-600 whitespace-nowrap">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {displayed.map((record) => (
                    <tr
                      key={record.id}
                      className="hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                          {record.service_category}
                        </span>
                        <span className="ml-1.5 text-gray-600 text-xs">
                          {record.service_category_name}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono whitespace-nowrap">
                        {record.service_code}
                      </td>
                      <td className="px-4 py-3 text-gray-800">
                        {record.service_name}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800 whitespace-nowrap">
                        {record.units.toLocaleString("ja-JP")}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {record.unit_type}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            CALC_TYPE_COLORS[record.calculation_type] ??
                            "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {record.calculation_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                        {record.valid_from ? (
                          <>
                            <span>{record.valid_from.replace(/-/g, "/")}</span>
                            <span className="mx-1 text-gray-400">〜</span>
                            <span className={record.valid_until ? "" : "text-gray-400"}>
                              {record.valid_until ? record.valid_until.replace(/-/g, "/") : "現行"}
                            </span>
                          </>
                        ) : (
                          <span className="text-gray-400">未設定</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openEdit(record)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            title="編集"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setDeleteId(record.id)}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                            title="削除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── CRUD Dialog ── */}
      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closeDialog}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Dialog header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-800">
                {editingId
                  ? "サービスコード編集"
                  : "サービスコード新規登録"}
              </h2>
              <button
                onClick={closeDialog}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Dialog body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {/* Row: service_category */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービス種類
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <select
                    value={formData.service_category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="">選択してください</option>
                    {SERVICE_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービス種類名
                  </label>
                  <input
                    type="text"
                    value={formData.service_category_name}
                    readOnly
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-gray-50 text-gray-500 cursor-not-allowed"
                    placeholder="種類を選択すると自動入力"
                  />
                </div>
              </div>

              {/* Row: service_code / service_name */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービスコード（6桁）
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.service_code}
                    onChange={(e) => setField("service_code", e.target.value)}
                    maxLength={6}
                    placeholder="例: 111111"
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    サービス名称
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.service_name}
                    onChange={(e) => setField("service_name", e.target.value)}
                    placeholder="例: 身体介護1"
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Row: units / unit_type / calculation_type */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    単位数
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={formData.units}
                    onChange={(e) =>
                      setField("units", Number(e.target.value))
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    算定単位
                  </label>
                  <select
                    value={formData.unit_type}
                    onChange={(e) => setField("unit_type", e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    {UNIT_TYPES.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    区分
                  </label>
                  <select
                    value={formData.calculation_type}
                    onChange={(e) =>
                      setField(
                        "calculation_type",
                        e.target.value as "基本" | "加算" | "減算"
                      )
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    {CALCULATION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Row: valid_from / valid_until */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    適用開始日
                  </label>
                  <input
                    type="date"
                    value={formData.valid_from ?? ""}
                    onChange={(e) =>
                      setField("valid_from", e.target.value || null)
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    適用終了日
                  </label>
                  <input
                    type="date"
                    value={formData.valid_until ?? ""}
                    onChange={(e) =>
                      setField("valid_until", e.target.value || null)
                    }
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* notes */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  備考
                </label>
                <textarea
                  value={formData.notes ?? ""}
                  onChange={(e) =>
                    setField("notes", e.target.value || null)
                  }
                  rows={3}
                  placeholder="備考・説明など"
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Dialog footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
              <button
                onClick={closeDialog}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {editingId ? "更新する" : "登録する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CSV import preview modal ── */}
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !importing && setImportPreview(null)}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-800">
                CSV取込プレビュー — {importPreview.fileName}
              </h2>
              <button
                onClick={() => !importing && setImportPreview(null)}
                disabled={importing}
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-blue-50 px-3 py-2">
                  <div className="text-[11px] text-gray-500">取込対象</div>
                  <div className="text-base font-bold text-blue-700">
                    {importPreview.rows.filter((r) => !r.error).length} 件
                  </div>
                </div>
                <div className="rounded-lg bg-red-50 px-3 py-2">
                  <div className="text-[11px] text-gray-500">検証エラー</div>
                  <div className="text-base font-bold text-red-700">
                    {importPreview.errors.length} 件
                  </div>
                </div>
                <div className="rounded-lg bg-gray-50 px-3 py-2">
                  <div className="text-[11px] text-gray-500">合計行数</div>
                  <div className="text-base font-bold text-gray-700">
                    {importPreview.rows.length} 件
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="mb-2 text-xs font-semibold text-gray-700">
                  既存コード (service_code) との重複時の挙動
                </div>
                <div className="flex gap-3 text-xs">
                  <label
                    className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                      importMode === "upsert"
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={importMode === "upsert"}
                      onChange={() => setImportMode("upsert")}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <div className="font-semibold text-gray-800">既存を上書き (UPSERT)</div>
                      <div className="text-gray-500">単位数や名称の更新に最適</div>
                    </div>
                  </label>
                  <label
                    className={`flex flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                      importMode === "skip-existing"
                        ? "border-indigo-400 bg-indigo-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="radio"
                      checked={importMode === "skip-existing"}
                      onChange={() => setImportMode("skip-existing")}
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <div className="font-semibold text-gray-800">既存を保持 (新規のみ追加)</div>
                      <div className="text-gray-500">手動編集を残したい場合</div>
                    </div>
                  </label>
                </div>
              </div>

              {importPreview.errors.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <div className="mb-1 text-xs font-semibold text-red-700">
                    検証エラー (取込からスキップされる行)
                  </div>
                  <ul className="max-h-32 overflow-y-auto space-y-0.5">
                    {importPreview.errors.slice(0, 50).map((e, i) => (
                      <li key={i} className="text-[11px] text-red-600">
                        ・{e}
                      </li>
                    ))}
                    {importPreview.errors.length > 50 && (
                      <li className="text-[11px] text-red-500 italic">
                        ... ほか {importPreview.errors.length - 50} 件
                      </li>
                    )}
                  </ul>
                </div>
              )}

              <div className="rounded-lg border border-gray-200 overflow-hidden">
                <div className="px-3 py-2 text-xs font-semibold text-gray-700 bg-gray-50 border-b">
                  プレビュー (先頭 20 行)
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1 font-medium text-gray-600">種別</th>
                        <th className="text-left px-2 py-1 font-medium text-gray-600">コード</th>
                        <th className="text-left px-2 py-1 font-medium text-gray-600">名称</th>
                        <th className="text-right px-2 py-1 font-medium text-gray-600">単位</th>
                        <th className="text-left px-2 py-1 font-medium text-gray-600">区分</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.slice(0, 20).map((r) => (
                        <tr
                          key={r.rowIndex}
                          className={`border-t ${r.error ? "bg-red-50" : ""}`}
                        >
                          <td className="px-2 py-1 font-mono text-gray-700">
                            {r.service_category}
                          </td>
                          <td className="px-2 py-1 font-mono text-gray-700">
                            {r.service_code}
                          </td>
                          <td className="px-2 py-1 text-gray-800 truncate max-w-[200px]">
                            {r.service_name}
                          </td>
                          <td className="px-2 py-1 text-right text-gray-700">
                            {r.units}
                          </td>
                          <td className="px-2 py-1 text-gray-700">
                            {r.calculation_type}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
                <strong>CSV 形式:</strong> ヘッダー行に
                <code className="mx-1 px-1 bg-white rounded">
                  service_category, service_code, service_name, units, unit_type, calculation_type
                </code>
                を含めてください (
                <code className="mx-1 px-1 bg-white rounded">service_category_name</code>,{" "}
                <code className="mx-1 px-1 bg-white rounded">valid_from</code>,{" "}
                <code className="mx-1 px-1 bg-white rounded">valid_until</code>,{" "}
                <code className="mx-1 px-1 bg-white rounded">notes</code> は任意)。
                文字コードは UTF-8 / Shift-JIS どちらでも可。
              </div>

              {importProgress && (
                <div className="rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
                  取込中... {importProgress.done} / {importProgress.total} 件
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
              <button
                onClick={() => !importing && setImportPreview(null)}
                disabled={importing}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleConfirmImport}
                disabled={
                  importing ||
                  importPreview.rows.filter((r) => !r.error).length === 0
                }
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {importing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4" />
                )}
                {importPreview.rows.filter((r) => !r.error).length} 件 取込確定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm dialog ── */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteId(null)}
          />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-2">
              削除の確認
            </h2>
            <p className="text-sm text-gray-600 mb-6">
              このサービスコードを削除してもよろしいですか？この操作は取り消せません。
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
