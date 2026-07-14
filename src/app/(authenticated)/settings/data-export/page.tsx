"use client";

// ─── 全データエクスポート ────────────────────────────────────────────────────
// 千葉県補助要綱 (医療情報システム安全管理ガイドラインの移行容易性) 対応:
// 「介護記録等のデータについては CSV/JSON 等、変換が容易なデータ形式で
//   出力・入力できる機能を備えていることが望ましい」への回答 + BCP バックアップ用途。
// 読み取り専用 — このページから DB への書き込みは一切行わない。

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Database, Download, ChevronLeft, ListChecks } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { EXPORT_TABLE_GROUPS, ALL_EXPORT_TABLES } from "@/lib/data-export/tables";
import { countTable, fetchAllRows, type MonthRange } from "@/lib/data-export/runner";
import { rowsToCsv, rowsToJson } from "@/lib/data-export/csv";
import { buildZip, type ZipEntry } from "@/lib/data-export/zip";

type Format = "csv" | "json";
type RangeMode = "all" | "months";
type Phase = "idle" | "counting" | "exporting";

interface Progress {
  done: number;
  total: number;
  current: string;
  rows: number;
}

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportFileName(format: Format): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `kaigo_export_${format}_${stamp}.zip`;
}

export default function DataExportPage() {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(ALL_EXPORT_TABLES.map((t) => t.name)),
  );
  const [format, setFormat] = useState<Format>("csv");
  const [rangeMode, setRangeMode] = useState<RangeMode>("all");
  const [fromMonth, setFromMonth] = useState(currentMonthKey());
  const [toMonth, setToMonth] = useState(currentMonthKey());
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [counted, setCounted] = useState(false);
  const cancelRef = useRef(false);

  const busy = phase !== "idle";

  const range: MonthRange | null = useMemo(() => {
    if (rangeMode !== "months") return null;
    if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) return null;
    return fromMonth <= toMonth ? { from: fromMonth, to: toMonth } : { from: toMonth, to: fromMonth };
  }, [rangeMode, fromMonth, toMonth]);

  const selectedTables = useMemo(
    () => ALL_EXPORT_TABLES.filter((t) => selected.has(t.name)),
    [selected],
  );

  const totalCount = useMemo(
    () => selectedTables.reduce((sum, t) => sum + (counts[t.name] ?? 0), 0),
    [selectedTables, counts],
  );

  const toggleTable = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setCounted(false);
  };

  const toggleGroup = (names: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });
    setCounted(false);
  };

  const invalidateCounts = () => setCounted(false);

  // ─── 件数プレビュー ──────────────────────────────────────────────────────
  const handleCount = async () => {
    if (selectedTables.length === 0) {
      toast.error("テーブルを選択してください");
      return;
    }
    setPhase("counting");
    cancelRef.current = false;
    setErrors({});
    const sb = createClient();
    const nextCounts: Record<string, number> = {};
    const nextErrors: Record<string, string> = {};
    for (let i = 0; i < selectedTables.length; i++) {
      if (cancelRef.current) break;
      const table = selectedTables[i];
      setProgress({ done: i, total: selectedTables.length, current: table.label, rows: 0 });
      const result = await countTable(sb, table, table.filter ? range : null);
      if (result.error !== null) {
        console.error(`件数取得失敗 (${table.name}):`, result.error);
        nextErrors[table.name] = result.error;
      } else {
        nextCounts[table.name] = result.count;
      }
      setCounts({ ...nextCounts });
      setErrors({ ...nextErrors });
    }
    setProgress(null);
    setPhase("idle");
    if (!cancelRef.current) {
      setCounted(true);
      const failed = Object.keys(nextErrors).length;
      if (failed > 0) toast.error(`${failed} テーブルの件数取得に失敗しました`);
      else toast.success("件数を取得しました");
    }
  };

  // ─── エクスポート実行 ────────────────────────────────────────────────────
  const handleExport = async () => {
    if (selectedTables.length === 0) {
      toast.error("テーブルを選択してください");
      return;
    }
    setPhase("exporting");
    cancelRef.current = false;
    setErrors({});
    const sb = createClient();
    const encoder = new TextEncoder();
    const entries: ZipEntry[] = [];
    const nextErrors: Record<string, string> = {};
    const manifest: {
      exported_at: string;
      app: string;
      format: Format;
      range: MonthRange | null;
      tables: { name: string; label: string; rows: number; range_applied: boolean }[];
    } = {
      exported_at: new Date().toISOString(),
      app: "kaigo-app",
      format,
      range,
      tables: [],
    };

    for (let i = 0; i < selectedTables.length; i++) {
      if (cancelRef.current) {
        setPhase("idle");
        setProgress(null);
        toast.info("エクスポートを中止しました");
        return;
      }
      const table = selectedTables[i];
      setProgress({ done: i, total: selectedTables.length, current: table.label, rows: 0 });
      const appliedRange = table.filter ? range : null;
      const result = await fetchAllRows(sb, table, appliedRange, (fetched) => {
        setProgress({ done: i, total: selectedTables.length, current: table.label, rows: fetched });
      });
      if (result.rows === null) {
        console.error(`取得失敗 (${table.name}):`, result.error);
        nextErrors[table.name] = result.error;
        setErrors({ ...nextErrors });
        continue; // 失敗テーブルはスキップして続行 (最後にまとめて表示)
      }
      const content = format === "csv" ? rowsToCsv(result.rows) : rowsToJson(result.rows);
      entries.push({ name: `${table.name}.${format}`, data: encoder.encode(content) });
      manifest.tables.push({
        name: table.name,
        label: table.label,
        rows: result.rows.length,
        range_applied: appliedRange !== null,
      });
      setCounts((prev) => ({ ...prev, [table.name]: result.rows.length }));
    }

    const failed = Object.keys(nextErrors).length;
    if (entries.length === 0) {
      setPhase("idle");
      setProgress(null);
      toast.error("すべてのテーブルの取得に失敗したため、出力しませんでした");
      return;
    }

    try {
      entries.push({
        name: "_export_manifest.json",
        data: encoder.encode(JSON.stringify(manifest, null, 2)),
      });
      const zip = buildZip(entries);
      downloadBlob(zip, exportFileName(format));
      const totalRows = manifest.tables.reduce((s, t) => s + t.rows, 0);
      if (failed > 0) {
        toast.warning(`${entries.length - 1} テーブル (${totalRows.toLocaleString()} 行) を出力。${failed} テーブルは失敗しました`);
      } else {
        toast.success(`${entries.length - 1} テーブル (${totalRows.toLocaleString()} 行) を ZIP に出力しました`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("ZIP 生成失敗:", message);
      toast.error(`ZIP 生成に失敗しました: ${message}`);
    } finally {
      setPhase("idle");
      setProgress(null);
      setCounted(true);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div>
        <Link href="/settings" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-2">
          <ChevronLeft size={14} /> 設定に戻る
        </Link>
        <div className="flex items-center gap-2">
          <Database size={22} className="text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">データエクスポート</h1>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          介護記録等の全データをテーブルごとに CSV (UTF-8 BOM・Excel 互換) または JSON で出力し、1 つの ZIP にまとめてダウンロードします。
          読み取り専用の機能です (データは変更されません)。
        </p>
        <p className="mt-1 text-xs text-gray-400">
          医療情報システム安全管理ガイドラインの「移行容易性」(変換が容易なデータ形式での出力) への対応、および BCP バックアップ用途。
        </p>
      </div>

      {/* 出力設定 */}
      <div className="rounded-lg border bg-white p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-gray-900">出力設定</h2>
        <div className="flex flex-wrap gap-6">
          {/* 形式 */}
          <fieldset disabled={busy}>
            <legend className="text-sm font-medium text-gray-700 mb-1.5">ファイル形式</legend>
            <div className="flex gap-3">
              {(["csv", "json"] as const).map((f) => (
                <label key={f} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border cursor-pointer text-sm ${format === f ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                  <input
                    type="radio"
                    name="format"
                    checked={format === f}
                    onChange={() => setFormat(f)}
                    className="accent-blue-600"
                  />
                  {f === "csv" ? "CSV (Excel 互換)" : "JSON"}
                </label>
              ))}
            </div>
          </fieldset>

          {/* 対象期間 */}
          <fieldset disabled={busy}>
            <legend className="text-sm font-medium text-gray-700 mb-1.5">対象期間</legend>
            <div className="flex items-center gap-3 flex-wrap">
              <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border cursor-pointer text-sm ${rangeMode === "all" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                <input
                  type="radio"
                  name="rangeMode"
                  checked={rangeMode === "all"}
                  onChange={() => { setRangeMode("all"); invalidateCounts(); }}
                  className="accent-blue-600"
                />
                全件
              </label>
              <label className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border cursor-pointer text-sm ${rangeMode === "months" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                <input
                  type="radio"
                  name="rangeMode"
                  checked={rangeMode === "months"}
                  onChange={() => { setRangeMode("months"); invalidateCounts(); }}
                  className="accent-blue-600"
                />
                月範囲指定
              </label>
              {rangeMode === "months" && (
                <span className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input
                    type="month"
                    value={fromMonth}
                    onChange={(e) => { setFromMonth(e.target.value); invalidateCounts(); }}
                    className="rounded-md border px-2 py-1 text-sm"
                  />
                  〜
                  <input
                    type="month"
                    value={toMonth}
                    onChange={(e) => { setToMonth(e.target.value); invalidateCounts(); }}
                    className="rounded-md border px-2 py-1 text-sm"
                  />
                </span>
              )}
            </div>
            {rangeMode === "months" && (
              <p className="mt-1.5 text-xs text-gray-400">
                月範囲は「月」印のテーブル (訪問記録・請求など日付/対象月を持つもの) にのみ適用されます。それ以外のテーブルは常に全件出力です。
              </p>
            )}
          </fieldset>
        </div>
      </div>

      {/* テーブル選択 */}
      <div className="rounded-lg border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-900">
            対象テーブル <span className="text-sm font-normal text-gray-500">({selectedTables.length} / {ALL_EXPORT_TABLES.length})</span>
          </h2>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() => toggleGroup(ALL_EXPORT_TABLES.map((t) => t.name), true)}
              className="px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              全選択
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => toggleGroup(ALL_EXPORT_TABLES.map((t) => t.name), false)}
              className="px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              全解除
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {EXPORT_TABLE_GROUPS.map((group) => {
            const names = group.tables.map((t) => t.name);
            const selectedInGroup = names.filter((n) => selected.has(n)).length;
            return (
              <section key={group.group}>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={selectedInGroup === names.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedInGroup > 0 && selectedInGroup < names.length;
                      }}
                      onChange={(e) => toggleGroup(names, e.target.checked)}
                      className="accent-blue-600"
                    />
                    {group.group}
                    <span className="font-normal text-gray-400">({selectedInGroup}/{names.length})</span>
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
                  {group.tables.map((t) => (
                    <label key={t.name} className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer min-w-0 py-0.5">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selected.has(t.name)}
                        onChange={() => toggleTable(t.name)}
                        className="accent-blue-600 shrink-0"
                      />
                      <span className="truncate" title={t.name}>{t.label}</span>
                      {t.filter && (
                        <span className="shrink-0 text-[10px] leading-none px-1 py-0.5 rounded bg-blue-50 text-blue-500 border border-blue-100">月</span>
                      )}
                      {errors[t.name] ? (
                        <span className="ml-auto shrink-0 text-[10px] text-red-500" title={errors[t.name]}>失敗</span>
                      ) : counts[t.name] !== undefined ? (
                        <span className="ml-auto shrink-0 text-xs text-gray-400 tabular-nums">{counts[t.name].toLocaleString()} 行</span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <p className="mt-4 pt-3 border-t text-[11px] text-gray-400 leading-relaxed">
          ※ 国の標準サービスコードマスタ (kaigo_service_codes / shogai_service_codes、計 23 万行超の公開マスタ) と認証トークン類 (招待・端末承認など) はエクスポート対象外です。
        </p>
      </div>

      {/* 実行 */}
      <div className="rounded-lg border bg-white p-5 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCount}
            disabled={busy || selectedTables.length === 0}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ListChecks size={16} />
            {phase === "counting" ? "件数取得中..." : "件数プレビュー"}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={busy || selectedTables.length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={16} />
            {phase === "exporting" ? "エクスポート中..." : "エクスポート実行 (ZIP)"}
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => { cancelRef.current = true; }}
              className="inline-flex items-center rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              中止
            </button>
          )}
          {counted && !busy && (
            <span className="text-sm text-gray-500">
              合計 <span className="font-semibold text-gray-800 tabular-nums">{totalCount.toLocaleString()}</span> 行
            </span>
          )}
        </div>

        {/* 進捗 */}
        {progress && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-gray-500">
              <span>
                {progress.done + 1} / {progress.total} テーブル: {progress.current}
                {phase === "exporting" && progress.rows > 0 && (
                  <span className="tabular-nums"> ({progress.rows.toLocaleString()} 行取得)</span>
                )}
              </span>
              <span className="tabular-nums">{Math.floor((progress.done / progress.total) * 100)}%</span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* エラー一覧 */}
        {Object.keys(errors).length > 0 && !busy && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3">
            <p className="text-xs font-semibold text-red-700 mb-1">取得に失敗したテーブル</p>
            <ul className="text-xs text-red-600 space-y-0.5">
              {Object.entries(errors).map(([name, message]) => (
                <li key={name}>
                  <span className="font-mono">{name}</span>: {message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
