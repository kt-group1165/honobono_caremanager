"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Printer, Loader2, FileText, Plus, Save, CheckCircle, Clock,
  Pencil, CalendarDays, Trash2,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";
import { toast } from "sonner";
import { CARE_REPORT_CONFIG, type CareReportConfig } from "./care-report-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CareReportDoc = {
  id: string;
  user_id: string;
  report_type: string;
  title: string;
  report_month: string | null;
  content: Record<string, unknown>;
  status: "draft" | "completed";
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtJaYear(ym: string | null | undefined): string {
  if (!ym) return "　　年　月";
  try {
    const d = parseISO(ym + (ym.length === 7 ? "-01" : ""));
    return format(d, "yyyy年M月", { locale: ja });
  } catch {
    return ym;
  }
}

function todayJa(): string {
  return format(new Date(), "yyyy年M月d日", { locale: ja });
}

// ---------------------------------------------------------------------------
// 課題整理総括表 データモデル
// ---------------------------------------------------------------------------

type KadaiRow = {
  // ② 現在の状況（生活全般の項目）
  item: string;
  // ①自立を阻害する要因（心身の状態・環境等）
  factor: string;
  // ③要因（背景・要因）
  cause: string;
  // ④改善/維持の可能性
  possibility: string; // 改善 / 維持 / 悪化
  // ⑤見通し
  outlook: string;
  // ⑥生活課題（ニーズ）
  need: string;
};

type KadaiContent = {
  created_date: string;
  // 冒頭: 自立した日常生活の阻害要因（心身の状態、環境等）
  overall_factors: string;
  // 利用者及び家族の生活に対する意向
  intention: string;
  rows: KadaiRow[];
  remarks: string;
};

const KADAI_DEFAULT_ITEMS = [
  "移動", "食事", "排泄", "入浴・清潔保持", "着脱・整容",
  "服薬", "コミュニケーション", "認知", "行動・心理症状",
  "健康管理", "家事", "社会参加・対人関係", "住環境", "介護力・家族",
];

function emptyKadaiRow(item = ""): KadaiRow {
  return { item, factor: "", cause: "", possibility: "", outlook: "", need: "" };
}

function defaultKadaiContent(): KadaiContent {
  return {
    created_date: todayJa(),
    overall_factors: "",
    intention: "",
    rows: KADAI_DEFAULT_ITEMS.map((i) => emptyKadaiRow(i)),
    remarks: "",
  };
}

// ---------------------------------------------------------------------------
// 評価表 データモデル
// ---------------------------------------------------------------------------

type HyoukaRow = {
  service_type: string; // サービス種別
  provider: string; // 事業所
  goal: string; // 短期目標
  period: string; // 期間
  achievement: string; // 達成状況（達成 / 一部達成 / 未達成）
  evaluation: string; // 評価・所見
  policy: string; // 今後の方針（継続 / 変更 / 終了）
};

type HyoukaContent = {
  created_date: string;
  meeting_date: string; // サービス担当者会議 開催日
  overall_evaluation: string; // 総合的な評価
  rows: HyoukaRow[];
  remarks: string;
};

function emptyHyoukaRow(): HyoukaRow {
  return {
    service_type: "", provider: "", goal: "", period: "",
    achievement: "", evaluation: "", policy: "",
  };
}

function defaultHyoukaContent(): HyoukaContent {
  return {
    created_date: todayJa(),
    meeting_date: "",
    overall_evaluation: "",
    rows: [emptyHyoukaRow(), emptyHyoukaRow(), emptyHyoukaRow()],
    remarks: "",
  };
}

// ---------------------------------------------------------------------------
// 汎用入力 UI
// ---------------------------------------------------------------------------

function TextInput({ value, onChange, className = "" }: {
  value: string; onChange: (v: string) => void; className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${className}`}
    />
  );
}

function TextArea({ value, onChange, rows = 2, className = "" }: {
  value: string; onChange: (v: string) => void; rows?: number; className?: string;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${className}`}
    />
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-500">{label}</label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 課題整理総括表 — 入力フォーム
// ---------------------------------------------------------------------------

function KadaiEditForm({ content, onChange }: {
  content: KadaiContent; onChange: (c: KadaiContent) => void;
}) {
  const setRow = (idx: number, patch: Partial<KadaiRow>) => {
    const rows = content.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange({ ...content, rows });
  };
  const addRow = () => onChange({ ...content, rows: [...content.rows, emptyKadaiRow()] });
  const removeRow = (idx: number) =>
    onChange({ ...content, rows: content.rows.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <LabeledField label="作成日">
          <TextInput value={content.created_date} onChange={(v) => onChange({ ...content, created_date: v })} />
        </LabeledField>
        <LabeledField label="利用者及び家族の生活に対する意向">
          <TextArea value={content.intention} onChange={(v) => onChange({ ...content, intention: v })} />
        </LabeledField>
      </div>

      <LabeledField label="① 自立した日常生活の阻害要因（心身の状態、環境等）">
        <TextArea rows={3} value={content.overall_factors} onChange={(v) => onChange({ ...content, overall_factors: v })} />
      </LabeledField>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">生活全般の状況と課題</span>
          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            <Plus size={12} /> 行を追加
          </button>
        </div>
        <div className="space-y-3">
          {content.rows.map((row, idx) => (
            <div key={idx} className="rounded-lg border bg-white p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-medium text-gray-400">#{idx + 1}</span>
                <TextInput value={row.item} onChange={(v) => setRow(idx, { item: v })} className="max-w-xs" />
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  className="ml-auto text-gray-300 hover:text-red-500"
                  title="この行を削除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <LabeledField label="② 現在の状況（要因）">
                  <TextArea value={row.factor} onChange={(v) => setRow(idx, { factor: v })} />
                </LabeledField>
                <LabeledField label="③ 要因・背景">
                  <TextArea value={row.cause} onChange={(v) => setRow(idx, { cause: v })} />
                </LabeledField>
                <LabeledField label="④ 改善/維持の可能性">
                  <select
                    value={row.possibility}
                    onChange={(e) => setRow(idx, { possibility: e.target.value })}
                    className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">-- 選択 --</option>
                    <option value="改善">改善</option>
                    <option value="維持">維持</option>
                    <option value="悪化">悪化</option>
                  </select>
                </LabeledField>
                <LabeledField label="⑤ 見通し">
                  <TextArea value={row.outlook} onChange={(v) => setRow(idx, { outlook: v })} />
                </LabeledField>
                <div className="md:col-span-2">
                  <LabeledField label="⑥ 生活課題（ニーズ）">
                    <TextArea value={row.need} onChange={(v) => setRow(idx, { need: v })} />
                  </LabeledField>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <LabeledField label="備考">
        <TextArea value={content.remarks} onChange={(v) => onChange({ ...content, remarks: v })} />
      </LabeledField>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 課題整理総括表 — 印刷ビュー
// ---------------------------------------------------------------------------

function KadaiPrintView({ content, clientName }: { content: KadaiContent; clientName: string | null }) {
  return (
    <div id="print-area" className="bg-white text-black" style={{ fontSize: "9pt" }}>
      <div className="mb-2 text-center text-base font-bold">課題整理総括表</div>
      <table className="w-full border-collapse" style={{ borderColor: "#000" }}>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1 font-medium" style={{ width: "12%" }}>利用者名</td>
            <td className="border border-black px-2 py-1" style={{ width: "48%" }}>{clientName ?? "　"}</td>
            <td className="border border-black px-2 py-1 font-medium" style={{ width: "12%" }}>作成日</td>
            <td className="border border-black px-2 py-1">{content.created_date || "　"}</td>
          </tr>
          <tr>
            <td className="border border-black px-2 py-1 font-medium">利用者及び家族の<br />生活に対する意向</td>
            <td className="border border-black px-2 py-1" colSpan={3} style={{ whiteSpace: "pre-wrap" }}>{content.intention || "　"}</td>
          </tr>
          <tr>
            <td className="border border-black px-2 py-1 font-medium">① 自立した日常生活の<br />阻害要因</td>
            <td className="border border-black px-2 py-1" colSpan={3} style={{ whiteSpace: "pre-wrap" }}>{content.overall_factors || "　"}</td>
          </tr>
        </tbody>
      </table>

      <table className="mt-2 w-full border-collapse" style={{ borderColor: "#000" }}>
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1" style={{ width: "12%" }}>状況の項目</th>
            <th className="border border-black px-1 py-1" style={{ width: "20%" }}>② 現在の状況（要因）</th>
            <th className="border border-black px-1 py-1" style={{ width: "18%" }}>③ 要因・背景</th>
            <th className="border border-black px-1 py-1" style={{ width: "8%" }}>④ 改善/維持</th>
            <th className="border border-black px-1 py-1" style={{ width: "20%" }}>⑤ 見通し</th>
            <th className="border border-black px-1 py-1" style={{ width: "22%" }}>⑥ 生活課題（ニーズ）</th>
          </tr>
        </thead>
        <tbody>
          {content.rows.map((row, idx) => (
            <tr key={idx}>
              <td className="border border-black px-1 py-1">{row.item || "　"}</td>
              <td className="border border-black px-1 py-1" style={{ whiteSpace: "pre-wrap" }}>{row.factor || "　"}</td>
              <td className="border border-black px-1 py-1" style={{ whiteSpace: "pre-wrap" }}>{row.cause || "　"}</td>
              <td className="border border-black px-1 py-1 text-center">{row.possibility || "　"}</td>
              <td className="border border-black px-1 py-1" style={{ whiteSpace: "pre-wrap" }}>{row.outlook || "　"}</td>
              <td className="border border-black px-1 py-1" style={{ whiteSpace: "pre-wrap" }}>{row.need || "　"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {content.remarks && (
        <table className="mt-2 w-full border-collapse" style={{ borderColor: "#000" }}>
          <tbody>
            <tr>
              <td className="border border-black px-2 py-1 font-medium" style={{ width: "12%" }}>備考</td>
              <td className="border border-black px-2 py-1" style={{ whiteSpace: "pre-wrap" }}>{content.remarks}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 評価表 — 入力フォーム
// ---------------------------------------------------------------------------

function HyoukaEditForm({ content, onChange }: {
  content: HyoukaContent; onChange: (c: HyoukaContent) => void;
}) {
  const setRow = (idx: number, patch: Partial<HyoukaRow>) => {
    const rows = content.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange({ ...content, rows });
  };
  const addRow = () => onChange({ ...content, rows: [...content.rows, emptyHyoukaRow()] });
  const removeRow = (idx: number) =>
    onChange({ ...content, rows: content.rows.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <LabeledField label="作成日">
          <TextInput value={content.created_date} onChange={(v) => onChange({ ...content, created_date: v })} />
        </LabeledField>
        <LabeledField label="サービス担当者会議 開催日">
          <TextInput value={content.meeting_date} onChange={(v) => onChange({ ...content, meeting_date: v })} />
        </LabeledField>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-600">サービスごとの目標達成状況・評価</span>
          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            <Plus size={12} /> 行を追加
          </button>
        </div>
        <div className="space-y-3">
          {content.rows.map((row, idx) => (
            <div key={idx} className="rounded-lg border bg-white p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-medium text-gray-400">#{idx + 1}</span>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  className="ml-auto text-gray-300 hover:text-red-500"
                  title="この行を削除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <LabeledField label="サービス種別">
                  <TextInput value={row.service_type} onChange={(v) => setRow(idx, { service_type: v })} />
                </LabeledField>
                <LabeledField label="事業所">
                  <TextInput value={row.provider} onChange={(v) => setRow(idx, { provider: v })} />
                </LabeledField>
                <div className="md:col-span-2">
                  <LabeledField label="短期目標">
                    <TextArea value={row.goal} onChange={(v) => setRow(idx, { goal: v })} />
                  </LabeledField>
                </div>
                <LabeledField label="期間">
                  <TextInput value={row.period} onChange={(v) => setRow(idx, { period: v })} />
                </LabeledField>
                <LabeledField label="達成状況">
                  <select
                    value={row.achievement}
                    onChange={(e) => setRow(idx, { achievement: e.target.value })}
                    className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">-- 選択 --</option>
                    <option value="達成">達成</option>
                    <option value="一部達成">一部達成</option>
                    <option value="未達成">未達成</option>
                  </select>
                </LabeledField>
                <div className="md:col-span-2">
                  <LabeledField label="評価・所見">
                    <TextArea value={row.evaluation} onChange={(v) => setRow(idx, { evaluation: v })} />
                  </LabeledField>
                </div>
                <LabeledField label="今後の方針">
                  <select
                    value={row.policy}
                    onChange={(e) => setRow(idx, { policy: e.target.value })}
                    className="rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">-- 選択 --</option>
                    <option value="継続">継続</option>
                    <option value="変更">変更</option>
                    <option value="終了">終了</option>
                  </select>
                </LabeledField>
              </div>
            </div>
          ))}
        </div>
      </div>

      <LabeledField label="総合的な評価">
        <TextArea rows={3} value={content.overall_evaluation} onChange={(v) => onChange({ ...content, overall_evaluation: v })} />
      </LabeledField>
      <LabeledField label="備考">
        <TextArea value={content.remarks} onChange={(v) => onChange({ ...content, remarks: v })} />
      </LabeledField>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 評価表 — 印刷ビュー
// ---------------------------------------------------------------------------

function HyoukaPrintView({ content, clientName, reportMonth }: {
  content: HyoukaContent; clientName: string | null; reportMonth: string | null;
}) {
  return (
    <div id="print-area" className="bg-white text-black" style={{ fontSize: "9pt" }}>
      <div className="mb-2 text-center text-base font-bold">評価表</div>
      <table className="w-full border-collapse" style={{ borderColor: "#000" }}>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1 font-medium" style={{ width: "12%" }}>利用者名</td>
            <td className="border border-black px-2 py-1" style={{ width: "38%" }}>{clientName ?? "　"}</td>
            <td className="border border-black px-2 py-1 font-medium" style={{ width: "12%" }}>対象月</td>
            <td className="border border-black px-2 py-1" style={{ width: "38%" }}>{reportMonth ? fmtJaYear(reportMonth) : "　"}</td>
          </tr>
          <tr>
            <td className="border border-black px-2 py-1 font-medium">作成日</td>
            <td className="border border-black px-2 py-1">{content.created_date || "　"}</td>
            <td className="border border-black px-2 py-1 font-medium">会議開催日</td>
            <td className="border border-black px-2 py-1">{content.meeting_date || "　"}</td>
          </tr>
        </tbody>
      </table>

      <table className="mt-2 w-full border-collapse" style={{ borderColor: "#000" }}>
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black px-1 py-1" style={{ width: "12%" }}>サービス種別</th>
            <th className="border border-black px-1 py-1" style={{ width: "14%" }}>事業所</th>
            <th className="border border-black px-1 py-1" style={{ width: "22%" }}>短期目標</th>
            <th className="border border-black px-1 py-1" style={{ width: "10%" }}>期間</th>
            <th className="border border-black px-1 py-1" style={{ width: "8%" }}>達成状況</th>
            <th className="border border-black px-1 py-1" style={{ width: "24%" }}>評価・所見</th>
            <th className="border border-black px-1 py-1" style={{ width: "10%" }}>今後の方針</th>
          </tr>
        </thead>
        <tbody>
          {content.rows.map((row, idx) => (
            <tr key={idx}>
              <td className="border border-black px-1 py-1">{row.service_type || "　"}</td>
              <td className="border border-black px-1 py-1">{row.provider || "　"}</td>
              <td className="border border-black px-1 py-1" style={{ whiteSpace: "pre-wrap" }}>{row.goal || "　"}</td>
              <td className="border border-black px-1 py-1 text-center">{row.period || "　"}</td>
              <td className="border border-black px-1 py-1 text-center">{row.achievement || "　"}</td>
              <td className="border border-black px-1 py-1" style={{ whiteSpace: "pre-wrap" }}>{row.evaluation || "　"}</td>
              <td className="border border-black px-1 py-1 text-center">{row.policy || "　"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="mt-2 w-full border-collapse" style={{ borderColor: "#000" }}>
        <tbody>
          <tr>
            <td className="border border-black px-2 py-1 font-medium" style={{ width: "12%" }}>総合的な評価</td>
            <td className="border border-black px-2 py-1" style={{ whiteSpace: "pre-wrap" }}>{content.overall_evaluation || "　"}</td>
          </tr>
          {content.remarks && (
            <tr>
              <td className="border border-black px-2 py-1 font-medium">備考</td>
              <td className="border border-black px-2 py-1" style={{ whiteSpace: "pre-wrap" }}>{content.remarks}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print CSS (A4 横 — 既存 reports/[type] の PRINT_STYLE_LANDSCAPE 準拠)
// ---------------------------------------------------------------------------

const PRINT_STYLE_LANDSCAPE = `
@media print {
  body * { visibility: hidden !important; }
  #print-area, #print-area * { visibility: visible !important; }
  #print-area { position: fixed !important; inset: 0 !important; width: 297mm !important; min-height: 210mm !important; padding: 6mm 8mm !important; font-size: 8pt !important; color: #000 !important; background: #fff !important; overflow: visible !important; }
  .no-print { display: none !important; }
  table { border-collapse: collapse !important; }
  td, th { border: 1px solid #000 !important; padding: 1px 2px !important; }
  @page { size: A4 landscape; margin: 0; }
}`;

// ---------------------------------------------------------------------------
// Doc list
// ---------------------------------------------------------------------------

function DocList({ docs, loading, selectedId, onSelect, onNew, newLoading }: {
  docs: CareReportDoc[]; loading: boolean; selectedId: string | null;
  onSelect: (doc: CareReportDoc) => void; onNew: () => void; newLoading: boolean;
}) {
  return (
    <div className="no-print mb-4 rounded-xl border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-semibold text-gray-700">作成済みの帳票</span>
        <button
          onClick={onNew}
          disabled={newLoading}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {newLoading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          新規作成
        </button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-8 text-gray-400">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : docs.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-gray-400">
          帳票がまだありません。「新規作成」から作成してください。
        </div>
      ) : (
        <ul className="divide-y">
          {docs.map((doc) => (
            <li key={doc.id}>
              <button
                onClick={() => onSelect(doc)}
                className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors ${
                  selectedId === doc.id ? "bg-blue-50" : "hover:bg-gray-50"
                }`}
              >
                <FileText size={14} className="shrink-0 text-gray-400" />
                <span className="min-w-0 flex-1 truncate text-gray-800">{doc.title}</span>
                <span className={`shrink-0 flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                  doc.status === "completed" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                }`}>
                  {doc.status === "completed" ? <CheckCircle size={10} /> : <Clock size={10} />}
                  {doc.status === "completed" ? "完成" : "下書き"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Doc editor (共通ツールバー + 種別ごとのフォーム/プレビュー)
// ---------------------------------------------------------------------------

function DocEditor({ doc, config, clientName, onSave, onStatusToggle, onDirtyChange }: {
  doc: CareReportDoc; config: CareReportConfig; clientName: string | null;
  onSave: (content: Record<string, unknown>) => Promise<void>;
  onStatusToggle: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [content, setContent] = useState<Record<string, unknown>>(doc.content ?? {});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const handleChange = useCallback((next: Record<string, unknown>) => {
    setContent(next);
    setDirty(true);
    onDirtyChange(true);
  }, [onDirtyChange]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(content);
      setDirty(false);
      onDirtyChange(false);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    setToggling(true);
    try { await onStatusToggle(); } finally { setToggling(false); }
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm">
      {/* Toolbar */}
      <div className="no-print flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText size={16} className="shrink-0 text-gray-400" />
          <span className="truncate text-sm font-semibold text-gray-800">{doc.title}</span>
          <span className={`ml-1 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            doc.status === "completed" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
          }`}>
            {doc.status === "completed" ? <CheckCircle size={10} /> : <Clock size={10} />}
            {doc.status === "completed" ? "完成" : "下書き"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleToggle}
            disabled={toggling}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {toggling ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
            {doc.status === "completed" ? "下書きに戻す" : "完成にする"}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
              dirty ? "bg-green-600 hover:bg-green-700" : "bg-gray-400"
            }`}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? "保存中..." : dirty ? "保存する" : "保存済み"}
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <Printer size={12} /> 印刷
          </button>
        </div>
      </div>

      {/* Edit form */}
      <div className="no-print border-b bg-gray-50">
        {doc.report_type === "kadai-seiri" ? (
          <KadaiEditForm
            content={{ ...defaultKadaiContent(), ...(content as Partial<KadaiContent>) }}
            onChange={(c) => handleChange(c as unknown as Record<string, unknown>)}
          />
        ) : (
          <HyoukaEditForm
            content={{ ...defaultHyoukaContent(), ...(content as Partial<HyoukaContent>) }}
            onChange={(c) => handleChange(c as unknown as Record<string, unknown>)}
          />
        )}
      </div>

      {/* Print preview */}
      <div className="no-print flex items-center gap-1 px-4 py-2 text-xs text-gray-400">
        <Printer size={11} /> 印刷プレビュー（A4横）
      </div>
      <div className="overflow-x-auto p-4">
        {doc.report_type === "kadai-seiri" ? (
          <KadaiPrintView
            content={{ ...defaultKadaiContent(), ...(content as Partial<KadaiContent>) }}
            clientName={clientName}
          />
        ) : (
          <HyoukaPrintView
            content={{ ...defaultHyoukaContent(), ...(content as Partial<HyoukaContent>) }}
            clientName={clientName}
            reportMonth={doc.report_month}
          />
        )}
      </div>

      {/* config は現状 landscape 固定 (両帳票とも A4横)。参照して未使用 lint を避ける */}
      <span className="hidden">{config.titleJa}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main content
// ---------------------------------------------------------------------------

export function CareReportsContent({ userId, reportType, initialDocs }: {
  userId: string; reportType: string; initialDocs: CareReportDoc[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const config = CARE_REPORT_CONFIG[reportType];

  const [docs, setDocs] = useState<CareReportDoc[]>(initialDocs);
  const [docsLoading, setDocsLoading] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<CareReportDoc | null>(initialDocs[0] ?? null);
  const [newLoading, setNewLoading] = useState(false);
  const [clientName, setClientName] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const monthOptions = useMemo(() => {
    const arr: string[] = [];
    for (let i = -12; i <= 2; i++) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() + i);
      arr.push(format(d, "yyyy-MM"));
    }
    arr.sort((a, b) => b.localeCompare(a));
    return arr;
  }, []);
  const [selectedYearMonth, setSelectedYearMonth] = useState<string>(format(new Date(), "yyyy-MM"));

  // 利用者名 fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("name")
        .eq("id", userId)
        .maybeSingle();
      if (error) {
        console.error("clients fetch failed:", error.message);
        return;
      }
      if (!cancelled) setClientName((data?.name as string | undefined) ?? null);
    })();
    return () => { cancelled = true; };
  }, [supabase, userId]);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_report_documents")
        .select("*")
        .eq("user_id", userId)
        .eq("report_type", reportType)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      const next = (data as CareReportDoc[]) ?? [];
      setDocs(next);
      setSelectedDoc(next[0] ?? null);
    } catch (e) {
      toast.error("帳票一覧の取得に失敗しました");
      console.error(e);
    } finally {
      setDocsLoading(false);
    }
  }, [supabase, userId, reportType]);

  // userId / reportType 切替時に refetch (初回 mount は initialDocs を使うのでスキップ)
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    loadDocs();
  }, [loadDocs]);

  const handleNewDoc = async () => {
    if (!config) return;
    setNewLoading(true);
    try {
      const reportMonth = config.needsPeriod ? selectedYearMonth : null;
      const baseContent = reportType === "kadai-seiri" ? defaultKadaiContent() : defaultHyoukaContent();
      const title = config.needsPeriod
        ? `${config.titleJa}（${fmtJaYear(reportMonth)}）`
        : `${config.titleJa}（${todayJa()}）`;
      const { data, error } = await supabase
        .from("kaigo_report_documents")
        .insert({
          user_id: userId,
          report_type: reportType,
          title,
          report_month: reportMonth,
          care_plan_id: null,
          content: baseContent as unknown as Record<string, unknown>,
          status: "draft",
        })
        .select()
        .single();
      if (error) {
        toast.error("帳票の作成に失敗しました: " + error.message);
        console.error("insert failed:", error.message);
        return;
      }
      toast.success("帳票を新規作成しました");
      const doc = data as CareReportDoc;
      setDocs((prev) => [doc, ...prev]);
      setSelectedDoc(doc);
    } finally {
      setNewLoading(false);
    }
  };

  const handleSelectDoc = useCallback((doc: CareReportDoc) => {
    if (hasUnsavedChanges) {
      if (!window.confirm("保存されていない変更があります。破棄して移動しますか？")) return;
    }
    setSelectedDoc(doc);
    setHasUnsavedChanges(false);
  }, [hasUnsavedChanges]);

  const handleSave = useCallback(async (content: Record<string, unknown>) => {
    if (!selectedDoc) return;
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .update({ content, updated_at: new Date().toISOString() })
      .eq("id", selectedDoc.id)
      .select()
      .single();
    if (error) {
      toast.error("保存に失敗しました: " + error.message);
      console.error("update failed:", error.message);
      throw error;
    }
    toast.success("保存しました");
    const updated = data as CareReportDoc;
    setSelectedDoc(updated);
    setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  }, [selectedDoc, supabase]);

  const handleStatusToggle = useCallback(async () => {
    if (!selectedDoc) return;
    const newStatus = selectedDoc.status === "completed" ? "draft" : "completed";
    const { data, error } = await supabase
      .from("kaigo_report_documents")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", selectedDoc.id)
      .select()
      .single();
    if (error) {
      toast.error("ステータスの変更に失敗しました: " + error.message);
      console.error("status update failed:", error.message);
      return;
    }
    toast.success(newStatus === "completed" ? "完成にしました" : "下書きに戻しました");
    const updated = data as CareReportDoc;
    setSelectedDoc(updated);
    setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
  }, [selectedDoc, supabase]);

  if (!config) return null;

  return (
    <>
      <style>{PRINT_STYLE_LANDSCAPE}</style>
      <div className="flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="no-print mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{config.titleJa}</h1>
            <p className="text-xs text-gray-400">
              {clientName ?? "利用者"} 様
              <span className="ml-2 rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-600">A4横</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/care-reports/${reportType === "kadai-seiri" ? "hyouka" : "kadai-seiri"}?user=${userId}`}
              className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              {reportType === "kadai-seiri" ? "評価表へ" : "課題整理総括表へ"}
            </Link>
          </div>
        </div>

        {/* Month selector (評価表のみ) */}
        {config.needsPeriod && (
          <div className="no-print mb-4 flex items-center gap-3">
            <label className="flex items-center gap-1 text-xs font-medium text-gray-600">
              <CalendarDays size={12} /> 対象月（新規作成時に使用）
            </label>
            <select
              value={selectedYearMonth}
              onChange={(e) => setSelectedYearMonth(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {monthOptions.map((ym) => (
                <option key={ym} value={ym}>{fmtJaYear(ym)}</option>
              ))}
            </select>
          </div>
        )}

        <DocList
          docs={docs}
          loading={docsLoading}
          selectedId={selectedDoc?.id ?? null}
          onSelect={handleSelectDoc}
          onNew={handleNewDoc}
          newLoading={newLoading}
        />

        {selectedDoc && (
          <DocEditor
            key={selectedDoc.id}
            doc={selectedDoc}
            config={config}
            clientName={clientName}
            onSave={handleSave}
            onStatusToggle={handleStatusToggle}
            onDirtyChange={setHasUnsavedChanges}
          />
        )}
      </div>
    </>
  );
}
