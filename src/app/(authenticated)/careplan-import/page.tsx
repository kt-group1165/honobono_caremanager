"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import Encoding from "encoding-japanese";
import {
  Upload,
  FileText,
  Check,
  AlertTriangle,
  User,
  ClipboardList,
  CalendarDays,
  Loader2,
  X,
  FileDown,
  ChevronLeft,
  ChevronRight,
  FileUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getMaxUserNumber } from "@kt/shared/user-number";
import { resolveCertForMonth, monthRange } from "@/lib/cert-for-month";
import {
  buildJissekiCsv,
  type JissekiUser,
  type JissekiVisit,
} from "@/lib/careplan-v4/build-jisseki";
import {
  parseCsv,
  detectRiyouhyouKind,
  parseTable6Plan,
  parseTable7Betsu,
  aggregatePlanUnits,
  type Table6PlanRecord,
  type PlanUnitAgg,
} from "@/lib/careplan-v4/parse-riyouhyou";
import { validInMonth } from "@/lib/service-code-valid";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImportedFile {
  id: string;
  name: string;
  type: "user-info" | "care-plan-1" | "care-plan-2" | "care-plan-3" | "table-6" | "table-7" | "unknown";
  label: string;
  rows: string[][];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
  parsed: Record<string, any>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { result.push(current); current = ""; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

function detectFileType(filename: string, rows: string[][]): ImportedFile["type"] {
  const fn = filename.toUpperCase();
  if (fn.includes("UPKHON") || fn.includes("利用者基本")) return "user-info";
  if (fn.includes("UP1KYO") || fn.includes("計画書1") || fn.includes("第1表")) return "care-plan-1";
  if (fn.includes("UP2KYO") || fn.includes("計画書2") || fn.includes("第2表")) return "care-plan-2";
  if (fn.includes("UP3KYO") || fn.includes("計画書3") || fn.includes("第3表")) return "care-plan-3";
  if (fn.includes("DLTPLAN") || fn.includes("DLTJSK") || fn.includes("第6表") || fn.includes("利用票")) return "table-6";
  if (fn.includes("DLTBET") || fn.includes("第7表") || fn.includes("別表")) return "table-7";

  // ファイル名でわからなければ内容から推定
  if (rows.length > 0) {
    const cols = rows[0].length;
    if (cols >= 40) return "table-6"; // 日別フラグ含む長い行
    if (cols >= 15 && rows.some((r) => r[10]?.includes("目標") || r[6]?.includes("課題"))) return "care-plan-2";
  }
  return "unknown";
}

function getTypeLabel(type: ImportedFile["type"]): string {
  switch (type) {
    case "user-info": return "利用者基本情報";
    case "care-plan-1": return "第1表（居宅サービス計画書）";
    case "care-plan-2": return "第2表（サービス内容）";
    case "care-plan-3": return "第3表（週間計画）";
    case "table-6": return "第6表（サービス利用票）";
    case "table-7": return "第7表（利用票別表）";
    default: return "不明";
  }
}

function getTypeIcon(type: ImportedFile["type"]) {
  switch (type) {
    case "user-info": return User;
    case "care-plan-1": return FileText;
    case "care-plan-2": return ClipboardList;
    case "care-plan-3": return CalendarDays;
    case "table-6": return CalendarDays;
    case "table-7": return FileText;
    default: return FileText;
  }
}

// Parse specific CSV types
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
function parseUserInfo(rows: string[][]): Record<string, any> {
  if (rows.length === 0) return {};
  const r = rows[0];
  return {
    insurer_no: r[1] ?? "",
    insured_no: r[2] ?? "",
    name: r[3] ?? "",
    name_kana: r[4] ?? "",
    birth_date: r[5] ? `${r[5].slice(0, 4)}-${r[5].slice(4, 6)}-${r[5].slice(6, 8)}` : "",
    gender: r[6] === "1" ? "男" : r[6] === "2" ? "女" : "",
    phone: r[7] ?? "",
    address: r[8] ?? "",
    care_level: r[9] ?? "",
    provider_code: r[13] ?? "",
    provider_name: r[14] ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
function parseCarePlan1(rows: string[][]): Record<string, any> {
  if (rows.length === 0) return {};
  const r = rows[0];
  return {
    creation_date: r[3] ?? "",
    plan_type: r[4] === "1" ? "初回" : r[4] === "2" ? "紹介" : "継続",
    care_level: r[6] ?? "",
    provider_code: r[10] ?? "",
    provider_name: r[11] ?? "",
    creator_name: r[12] ?? "",
    issue_analysis: r[13] ?? "",
    review_opinion: r[14] ?? "",
    overall_policy: r[15] ?? "",
    living_support_reason: r[16] ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
function parseCarePlan2(rows: string[][]): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
  const services: Record<string, any>[] = [];
  for (const r of rows) {
    services.push({
      needs: r[5] ?? "",
      long_term_goal: r[6] ?? "",
      long_term_period: r[7] ?? "",
      short_term_goal: r[8] ?? "",
      short_term_period: r[9] ?? "",
      content: r[10] ?? "",
      insurance_flag: r[11] === "1" ? "○" : "×",
      type: r[12] ?? "",
      provider: r[13] ?? "",
      frequency: r[14] ?? "",
      period: r[15] ?? "",
    });
  }
  return { services };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
function parseCarePlan3(rows: string[][]): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
  const schedule: Record<string, any>[] = [];
  for (const r of rows) {
    schedule.push({
      service: r[4] ?? "",
      day_of_week: r[5] ?? "",
      start_time: r[6] ?? "",
      end_time: r[7] ?? "",
      daily_activities: r[8] ?? "",
      other_services: r[9] ?? "",
    });
  }
  return { schedule };
}

// ─── Main Page ────────────────────────────────────────────────────────────────

interface ExistingUser {
  id: string;
  name: string;
  name_kana: string;
}

export default function CareplanImportPage() {
  const supabase = createClient();
  const { currentOffice } = useBusinessType();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [existingUsers, setExistingUsers] = useState<ExistingUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");

  // Load existing users
  useEffect(() => {
    const load = async () => {
      // PostgREST default 1000 行制限対策で page-loop
      const PAGE = 1000;
      const all: ExistingUser[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("clients")
          .select("id, name, name_kana:furigana")
          .eq("status", "active")
          .eq("is_facility", false)
          .order("furigana")
          .range(from, from + PAGE - 1);
        if (error) break;
        if (!data || data.length === 0) break;
        all.push(...(data as ExistingUser[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setExistingUsers(all);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── File upload handler ───────────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    const fileList = Array.from(uploadedFiles);
    // Reset input after capturing files
    setTimeout(() => { if (fileRef.current) fileRef.current.value = ""; }, 0);

    const newFiles: ImportedFile[] = [];

    for (const file of fileList) {
      try {
        // Shift-JIS / UTF-8 両対応で読み込み
        const buf = await file.arrayBuffer();
        let text = "";
        try {
          // まずShift-JIS(cp932)で試す
          const decoder = new TextDecoder("shift-jis");
          text = decoder.decode(buf);
        } catch {
          // 失敗したらUTF-8
          text = new TextDecoder("utf-8").decode(buf);
        }
        // BOM除去
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

        const lines = text.split(/\r?\n/).filter((l) => l.trim());

        if (lines.length === 0) {
          toast.error(`${file.name}: データが空です`);
          continue;
        }

        // ヘッダー行判定
        const firstLine = lines[0] ?? "";
        const isHeader = !firstLine.match(/^\d/) && !firstLine.startsWith('"2');
        const dataLines = isHeader ? lines.slice(1) : lines;

        const rows = dataLines.map(parseCSVLine);
        const type = detectFileType(file.name, rows);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
        let parsed: Record<string, any> = {};
        switch (type) {
          case "user-info": parsed = parseUserInfo(rows); break;
          case "care-plan-1": parsed = parseCarePlan1(rows); break;
          case "care-plan-2": parsed = parseCarePlan2(rows); break;
          case "care-plan-3": parsed = parseCarePlan3(rows); break;
          default: parsed = { rowCount: rows.length };
        }

        newFiles.push({
          id: Math.random().toString(36).slice(2),
          name: file.name,
          type,
          label: getTypeLabel(type),
          rows,
          parsed,
        });
      } catch (err) {
        console.error(err);
        toast.error(`${file.name} の読み込みに失敗しました`);
      }
    }

    setFiles((prev) => [...prev, ...newFiles]);
    if (newFiles.length > 0) {
      toast.success(`${newFiles.length}件のCSVを読み込みました`);
    } else {
      toast.error("CSVファイルを読み込めませんでした。ファイル形式を確認してください。");
    }
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  // ── Save imported data ────────────────────────────────────────────────────
  const handleSaveAll = async () => {
    if (files.length === 0) return;
    setSaving(true);

    try {
      let savedCount = 0;

      // 利用者を特定: ドロップダウン > 基本情報CSV > 他CSVの被保険者番号/名前
      let userId: string | null = selectedUserId || null;

      // 全CSVから被保険者番号・利用者名を抽出
      let detectedInsuredNo = "";
      let detectedName = "";
      const userInfoFile = files.find((f) => f.type === "user-info");
      if (userInfoFile) {
        detectedInsuredNo = userInfoFile.parsed.insured_no ?? "";
        detectedName = userInfoFile.parsed.name ?? "";
      }
      // 利用者基本情報がなくても、他CSVの先頭行から被保険者番号を取得
      if (!detectedInsuredNo) {
        for (const f of files) {
          if (f.rows.length > 0 && f.rows[0].length >= 3) {
            const candidate = f.rows[0][2]?.trim(); // 多くのCSVで3列目が被保険者番号
            if (candidate && candidate.length >= 8 && /^[HhＨ]?\d+$/.test(candidate)) {
              detectedInsuredNo = candidate;
              break;
            }
          }
        }
      }

      // 自動マッチ: 名前で検索（法人エントリは除外）
      if (!userId && detectedName) {
        const { data } = await supabase
          .from("clients")
          .select("id, name")
          .eq("name", detectedName)
          .eq("status", "active")
          .eq("is_facility", false)
          .limit(1);
        if (data && data.length > 0) {
          userId = data[0].id;
          toast.info(`利用者「${detectedName}」に自動紐付けしました`);
        }
      }

      // 利用者基本情報CSVがあり、マッチしなければ新規作成
      if (!userId && userInfoFile && detectedName) {
        if (!currentOffice?.tenant_id) {
          toast.error("自事業所が選択されていないため、新規利用者を登録できません。サイドバーの事業所セレクタで選択してください。");
          setSaving(false);
          return;
        }
        const info = userInfoFile.parsed;
        // user_number 採番（tenant 単位 max+1）。@kt/shared 共通 util。
        const userNumber = String((await getMaxUserNumber(supabase, currentOffice.tenant_id)) + 1);

        // 共通マスタ clients への INSERT。
        // カラム名対応: name_kana → furigana / phone はそのまま
        const { data: newUser, error } = await supabase
          .from("clients")
          .insert({
            tenant_id: currentOffice.tenant_id,
            user_number: userNumber,
            name: info.name,
            furigana: info.name_kana || "",
            gender: info.gender || "男",
            birth_date: info.birth_date || "2000-01-01",
            address: info.address || null,
            phone: info.phone || null,
            status: "active",
            is_facility: false,
            is_provisional: false,
          })
          .select("id")
          .single();
        if (error) throw error;
        userId = newUser.id;
        toast.success(`利用者「${info.name}」を新規登録しました`);
        savedCount++;
      }

      if (!userId) {
        toast.error("利用者を特定できませんでした。ドロップダウンから選択してください。");
        setSaving(false);
        return;
      }

      // ケアプランデータを保存 (kaigo_report_documentsに保存)
      for (const file of files) {
        if (file.type === "user-info") continue;
        if (file.type === "unknown") continue;

        const reportTypeMap: Record<string, string> = {
          "care-plan-1": "care-plan-1",
          "care-plan-2": "care-plan-2",
          "care-plan-3": "care-plan-3",
          "table-6": "service-usage",
          "table-7": "service-usage-detail",
        };

        const reportType = reportTypeMap[file.type];
        if (!reportType) continue;

        // 既存の帳票を確認
        const { data: existing } = await supabase
          .from("kaigo_report_documents")
          .select("id")
          .eq("user_id", userId)
          .eq("report_type", reportType)
          .limit(1);

        if (existing && existing.length > 0) {
          // 更新
          await supabase
            .from("kaigo_report_documents")
            .update({ content: file.parsed, status: "draft" })
            .eq("id", existing[0].id);
        } else {
          // 新規作成
          await supabase
            .from("kaigo_report_documents")
            .insert({
              user_id: userId,
              report_type: reportType,
              title: file.label,
              content: file.parsed,
              status: "draft",
            });
        }
        savedCount++;
      }

      toast.success(`${savedCount}件のデータを保存しました`);
      setFiles([]);
    } catch (err) {
      console.error(err);
      toast.error("保存に失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">ケアプラン連携</h1>
        <p className="mt-1 text-sm text-gray-500">
          居宅介護支援事業所から受け取ったCSVファイル（ケアプランデータ連携 標準様式）を取り込み、また実績情報（第6表）をエクスポートします
        </p>
      </div>

      {/* 実績エクスポート (ケアプランデータ連携 V4 第6表/実績) */}
      <JissekiExportSection />

      {/* 利用票取込 (ケアプランデータ連携 V4 第6表/計画 + 第7表/別表) */}
      <RiyouhyouImportSection />

      <div className="border-t border-gray-200 pt-6">
        <h2 className="text-lg font-semibold text-gray-900">ケアプラン取込</h2>
        <p className="mt-1 text-sm text-gray-500">
          居宅介護支援事業所から受け取ったCSVファイルを取り込みます
        </p>
      </div>

      {/* Upload area */}
      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />
      <div
        className="rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-8 text-center hover:border-blue-400 hover:bg-blue-50/30 transition-colors cursor-pointer"
        onClick={() => fileRef.current?.click()}
      >
        <Upload size={40} className="mx-auto mb-3 text-gray-400" />
        <p className="text-sm font-medium text-gray-700">
          CSVファイルをクリックして選択
        </p>
        <p className="mt-1 text-xs text-gray-500">
          複数ファイルを同時に選択できます（利用者基本情報、第1表〜第3表、第6表、第7表）
        </p>
      </div>

      {/* Imported files list */}
      {files.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              取込ファイル（{files.length}件）
            </h2>
            <button
              onClick={() => setFiles([])}
              className="text-sm text-gray-500 hover:text-red-500"
            >
              全てクリア
            </button>
          </div>

          {/* 利用者選択（任意：自動特定できない場合に使用） */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <p className="text-sm text-gray-700 font-medium mb-2">
              保存先の利用者（CSVから自動特定しますが、手動で指定も可能です）
            </p>
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="">-- 利用者を選択 --</option>
                {existingUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}（{u.name_kana}）</option>
                ))}
              </select>
            </div>

          <div className="space-y-3">
            {files.map((file) => {
              const Icon = getTypeIcon(file.type);
              const isUnknown = file.type === "unknown";
              return (
                <div
                  key={file.id}
                  className={cn(
                    "rounded-lg border p-4 flex items-start gap-4",
                    isUnknown ? "border-amber-200 bg-amber-50" : "border-gray-200 bg-white"
                  )}
                >
                  <div className={cn(
                    "w-10 h-10 rounded-lg flex items-center justify-center shrink-0",
                    isUnknown ? "bg-amber-100 text-amber-600" : "bg-blue-100 text-blue-600"
                  )}>
                    <Icon size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">{file.label}</span>
                      {isUnknown && (
                        <span className="flex items-center gap-1 text-xs text-amber-600">
                          <AlertTriangle size={12} />種別不明
                        </span>
                      )}
                      {!isUnknown && (
                        <span className="flex items-center gap-1 text-xs text-green-600">
                          <Check size={12} />認識済み
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate">{file.name}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{file.rows.length}行</p>

                    {/* Preview summary */}
                    {file.type === "user-info" && file.parsed.name && (
                      <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-2">
                        利用者: <span className="font-medium">{file.parsed.name}</span>
                        {file.parsed.care_level && <> / {file.parsed.care_level}</>}
                        {file.parsed.provider_name && <> / 居宅: {file.parsed.provider_name}</>}
                      </div>
                    )}
                    {file.type === "care-plan-1" && file.parsed.overall_policy && (
                      <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-2 line-clamp-2">
                        援助方針: {file.parsed.overall_policy}
                      </div>
                    )}
                    {file.type === "care-plan-2" && file.parsed.services && (
                      <div className="mt-2 text-xs text-gray-600 bg-gray-50 rounded p-2">
                        サービス: {file.parsed.services.length}件
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => removeFile(file.id)}
                    className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50"
                  >
                    <X size={16} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Save button */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setFiles([])}
              className="rounded-lg border px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              キャンセル
            </button>
            <button
              onClick={handleSaveAll}
              disabled={saving || files.length === 0}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              取り込んで保存
            </button>
          </div>
        </div>
      )}

      {/* Info */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600">
        <strong className="font-medium text-gray-800">対応ファイル: </strong>
        ケアプランデータ連携システム標準様式（v4.1）のCSVファイルに対応しています。
        利用者基本情報、居宅サービス計画書（第1表〜第3表）、サービス利用票（第6表）、利用票別表（第7表）を取り込みできます。
      </div>
    </div>
  );
}

// ─── 実績エクスポート (ケアプランデータ連携 V4 第6表/実績) ────────────────────
// kaigo_visit_schedule status='completed' を利用者ごと・単月で第6表/実績 CSV に
// 変換し、Shift-JIS で 利用者 1 名 = 1 ファイル ダウンロードする。
// 送信先 (ケアマネ) 事業所番号・サービス種類コードは UI 入力 (未入力可)。

function JissekiExportSection() {
  const supabase = createClient();
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [receiverOfficeNumber, setReceiverOfficeNumber] = useState("");
  const [receiverServiceKind, setReceiverServiceKind] = useState("43"); // 居宅介護支援
  const [exporting, setExporting] = useState(false);

  const prevMonth = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
  };

  // 送信元サービス種類コード: 事業所の service_type から推定 (訪問介護=11 / 訪問入浴=12)
  const senderServiceKind =
    currentOffice?.service_type === "訪問入浴" ? "12" : "11";

  const downloadSjis = (fileName: string, content: string) => {
    const sjis = Encoding.convert(Encoding.stringToCode(content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleExport = useCallback(async () => {
    if (!currentOffice) {
      toast.error("事業所が選択されていません。サイドバーで事業所を選択してください。");
      return;
    }
    setExporting(true);
    try {
      const monthStr = `${year}-${String(month).padStart(2, "0")}`;
      const { from, to } = monthRange(year, month);

      // 送信元事業所番号
      const { data: office, error: oe } = await supabase
        .from("offices")
        .select("name, business_number")
        .eq("id", currentOffice.id)
        .maybeSingle();
      if (oe) {
        toast.error("事業所情報の取得に失敗: " + oe.message);
        return;
      }
      const senderOfficeNumber = ((office?.business_number ?? "") as string).trim();
      const senderOfficeName = (office?.name ?? currentOffice.name ?? "") as string;

      // 1) 当月の確定実績 (status='completed') を自事業所スコープで取得 (page-loop)
      interface SchedRow {
        user_id: string;
        service_type: string;
        visit_date: string;
        start_time: string | null;
        end_time: string | null;
      }
      const PAGE = 1000;
      const schedules: SchedRow[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("kaigo_visit_schedule")
          .select("user_id, service_type, visit_date, start_time, end_time")
          .eq("status", "completed")
          .gte("visit_date", from)
          .lte("visit_date", to)
          .or(`office_id.eq.${currentOffice.id},office_id.is.null`)
          .order("id", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) {
          toast.error("実績の取得に失敗: " + error.message);
          return;
        }
        const rows = (data ?? []) as SchedRow[];
        schedules.push(...rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }

      if (schedules.length === 0) {
        toast.warning(`${monthStr} の確定実績がありません。`);
        return;
      }

      // 2) 利用者ごとに実績を集約
      const visitsByUser = new Map<string, JissekiVisit[]>();
      for (const s of schedules) {
        if (!visitsByUser.has(s.user_id)) visitsByUser.set(s.user_id, []);
        visitsByUser.get(s.user_id)!.push({
          date: s.visit_date,
          serviceType: s.service_type,
          startTime: s.start_time,
          endTime: s.end_time,
        });
      }
      const userIds = Array.from(visitsByUser.keys());

      // 3) 利用者名 (clients)
      const nameById = new Map<string, string>();
      for (let i = 0; i < userIds.length; i += 50) {
        const chunk = userIds.slice(i, i + 50);
        const { data, error } = await supabase
          .from("clients")
          .select("id, name")
          .in("id", chunk);
        if (error) {
          toast.error("利用者情報の取得に失敗: " + error.message);
          return;
        }
        for (const c of (data ?? []) as { id: string; name: string }[]) {
          nameById.set(c.id, c.name);
        }
      }

      // 4) 対象月に有効な認定 (保険者番号 / 被保険者番号 / 担当ケアマネ事業所)
      const certByClient = await resolveCertForMonth(supabase, userIds, year, month);

      // 4.5) care_office_id → care_offices.office_number/name 解決 (直接入力優先)
      const careOfficeIds = Array.from(
        new Set(
          Array.from(certByClient.values())
            .map((v) => v.care_office_id)
            .filter(Boolean) as string[],
        ),
      );
      const careNumberById = new Map<string, string | null>();
      const careNameById = new Map<string, string | null>();
      if (careOfficeIds.length > 0) {
        const { data, error } = await supabase
          .from("care_offices")
          .select("id, office_number, name")
          .in("id", careOfficeIds);
        if (error) {
          toast.error("居宅介護支援事業所の取得に失敗: " + error.message);
          return;
        }
        for (const o of (data ?? []) as {
          id: string;
          office_number: string | null;
          name: string | null;
        }[]) {
          careNumberById.set(o.id, o.office_number);
          careNameById.set(o.id, o.name);
        }
      }

      // 5) 利用者ごとに JissekiUser を組み立て → 利用者 1 名 = 1 ファイルで出力
      //    (出力単位 = 利用者ごと・単月。spec 2.6)
      const receiver = receiverOfficeNumber.trim();
      const recvKind = receiverServiceKind.trim();
      let fileCount = 0;
      let emptyCount = 0;
      const allWarnings = new Set<string>();

      // ふりがな相当が無いため利用者名順で安定化
      const orderedIds = userIds.sort((a, b) =>
        (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b, "ja"),
      );

      for (const uid of orderedIds) {
        const cert = certByClient.get(uid) ?? null;
        const careNumber =
          cert?.care_office_number?.trim() ||
          (cert?.care_office_id
            ? careNumberById.get(cert.care_office_id) ?? null
            : null);
        const careName =
          cert?.care_office_name?.trim() ||
          (cert?.care_office_id
            ? careNameById.get(cert.care_office_id) ?? null
            : null);
        const user: JissekiUser = {
          clientId: uid,
          name: nameById.get(uid) ?? "(利用者不明)",
          insurerNumber: cert?.insurer_number ?? null,
          insuredNumber: cert?.insured_number ?? null,
          careOfficeNumber: careNumber,
          careOfficeName: careName,
          visits: visitsByUser.get(uid) ?? [],
        };

        const result = await buildJissekiCsv(supabase, [user], {
          year,
          month,
          senderOfficeNumber,
          senderServiceKind,
          receiverOfficeNumber: receiver || null,
          receiverServiceKind: recvKind || null,
          senderOfficeName,
        });
        result.warnings.forEach((w) => allWarnings.add(w));
        if (!result.content) {
          emptyCount++;
          continue;
        }
        downloadSjis(result.fileName, result.content);
        fileCount++;
      }

      if (allWarnings.size > 0) {
        // 警告は toast (最大 5 件表示) + console
        const list = Array.from(allWarnings);
        console.warn("[jisseki-export] warnings:", list);
        toast.warning(
          `確認事項が ${list.length} 件あります:\n・` +
            list.slice(0, 5).join("\n・") +
            (list.length > 5 ? `\n… 他 ${list.length - 5} 件 (コンソール参照)` : ""),
        );
      }
      if (fileCount > 0) {
        toast.success(
          `${fileCount} 名分の実績情報 (第6表) を出力しました` +
            (emptyCount > 0 ? ` (連携対象サービスなし ${emptyCount} 名はスキップ)` : ""),
        );
      } else {
        toast.error("出力できる連携対象サービス (介護保険) の実績がありませんでした。");
      }
    } catch (e) {
      console.error(e);
      toast.error(
        "実績エクスポートに失敗: " + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setExporting(false);
    }
  }, [
    supabase,
    currentOffice,
    year,
    month,
    senderServiceKind,
    receiverOfficeNumber,
    receiverServiceKind,
  ]);

  const reiwa = year - 2018;
  const isVisitOffice =
    currentOffice?.service_type === "訪問介護" ||
    currentOffice?.service_type === "訪問看護" ||
    currentOffice?.service_type === "訪問入浴";

  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-600">
          <FileDown size={20} />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">
            実績エクスポート（第6表 / V4）
          </h2>
          <p className="mt-0.5 text-sm text-gray-500">
            当月の確定実績（サービス提供実績）を、ケアプランデータ連携標準仕様 V4 の
            第6表【実績】CSV（Shift-JIS）で出力します。利用者 1 名 = 1 ファイル。
          </p>
        </div>
      </div>

      {!btLoading && !isVisitOffice && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          この機能は訪問系サービス事業所向けです。ヘッダーの事業所切替で訪問介護等の事業所を選択してください。
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-4">
        {/* 対象月 */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            対象月（サービス提供年月）
          </label>
          <div className="inline-flex items-center gap-1 rounded-lg border bg-white px-1 py-0.5">
            <button
              type="button"
              onClick={prevMonth}
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-[90px] text-center text-sm font-bold text-gray-800">
              R{reiwa}/{month}（{year}年{month}月）
            </span>
            <button
              type="button"
              onClick={nextMonth}
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* 送信先 (ケアマネ) 事業所番号 */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            送信先事業所番号（ケアマネ・任意）
          </label>
          <input
            type="text"
            value={receiverOfficeNumber}
            onChange={(e) => setReceiverOfficeNumber(e.target.value)}
            placeholder="10桁（未入力可）"
            inputMode="numeric"
            className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-violet-500 focus:outline-none"
          />
        </div>

        {/* 送信先サービス種類コード */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">
            送信先サービス種類（2桁）
          </label>
          <input
            type="text"
            value={receiverServiceKind}
            onChange={(e) => setReceiverServiceKind(e.target.value)}
            placeholder="43"
            maxLength={2}
            className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-violet-500 focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={exporting || btLoading || !currentOffice}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {exporting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <FileDown size={16} />
          )}
          実績CSVをエクスポート
        </button>
      </div>

      <p className="mt-3 text-xs text-gray-400">
        送信元事業所番号 = 自事業所（事業所管理の事業所番号）／送信元サービス種類 =
        {senderServiceKind}。介護保険サービスのみ出力対象（障害・総合事業は除外）。
      </p>
    </div>
  );
}

// ─── 利用票取込 (ケアプランデータ連携 V4 第6表/計画 + 第7表/別表) ──────────────
// ケアマネから届く UPPLAN (第6表=計画/予定) と UPSIKYU (第7表=別表) の CSV を取込み、
//   - 第6表 → kaigo_visit_schedule に予定 (status='scheduled') を upsert
//   - 第7表 → kaigo_monthly_plan_units に計画単位数 (区分支給限度基準内単位数) を upsert
// する。被保険者番号 → clients.insured_number 突合 (見つからなければ warning でスキップ)。
// プレビュー (件数・対象利用者・突合不可一覧) を出し、確定ボタンで反映する。

interface Riyouhyou6Preview {
  fileName: string;
  targetYm: string; // YYYYMM
  records: Table6PlanRecord[];
}
interface Riyouhyou7Preview {
  fileName: string;
  plans: PlanUnitAgg[];
}

/** 突合済みの 1 予定行 (schedule upsert 用) */
interface ResolvedSchedule {
  clientId: string;
  clientName: string;
  visitDate: string; // ISO
  startTime: string; // HH:MM:SS
  endTime: string; // HH:MM:SS
  serviceType: string; // service_name (逆引き結果)
  serviceCode: string;
}
/** 突合済みの計画単位 (plan units upsert 用) */
interface ResolvedPlanUnit {
  clientId: string;
  clientName: string;
  targetMonth: string; // YYYY-MM-01
  plannedUnits: number;
}

function RiyouhyouImportSection() {
  const supabase = createClient();
  const { currentOffice, loading: btLoading } = useBusinessType();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan6, setPlan6] = useState<Riyouhyou6Preview[]>([]);
  const [betsu7, setBetsu7] = useState<Riyouhyou7Preview[]>([]);
  const [resolvedSchedules, setResolvedSchedules] = useState<ResolvedSchedule[]>([]);
  const [resolvedPlanUnits, setResolvedPlanUnits] = useState<ResolvedPlanUnit[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  const resetPreview = () => {
    setPlan6([]);
    setBetsu7([]);
    setResolvedSchedules([]);
    setResolvedPlanUnits([]);
    setUnmatched([]);
    setWarnings([]);
    setReady(false);
  };

  // ── ファイル選択 → SJIS デコード → パース → プレビュー構築 ───────────────────
  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    setTimeout(() => { if (fileRef.current) fileRef.current.value = ""; }, 0);
    if (!currentOffice) {
      toast.error("事業所が選択されていません。ヘッダーで事業所を選択してください。");
      return;
    }
    setParsing(true);
    resetPreview();
    try {
      const p6: Riyouhyou6Preview[] = [];
      const p7: Riyouhyou7Preview[] = [];
      const warns: string[] = [];

      for (const file of files) {
        const buf = await file.arrayBuffer();
        // Shift-JIS (MS932) → UNICODE
        const text = Encoding.convert(new Uint8Array(buf), {
          to: "UNICODE",
          from: "SJIS",
          type: "string",
        }) as string;
        const rows = parseCsv(text);
        const kind = detectRiyouhyouKind(file.name, rows);
        if (kind === "table-6-plan") {
          const res = parseTable6Plan(rows);
          res.warnings.forEach((w) => warns.push(`${file.name}: ${w}`));
          if (res.targetMonths.length > 1) {
            warns.push(`${file.name}: 複数の対象年月 (${res.targetMonths.join(", ")}) が混在しています`);
          }
          p6.push({ fileName: file.name, targetYm: res.targetMonths[0] ?? "", records: res.records });
        } else if (kind === "table-7-betsu") {
          const res = parseTable7Betsu(rows);
          res.warnings.forEach((w) => warns.push(`${file.name}: ${w}`));
          const senderCode = (currentOffice.business_number ?? "").trim();
          const plans = aggregatePlanUnits(res.records, senderCode || null);
          p7.push({ fileName: file.name, plans });
        } else {
          warns.push(`${file.name}: 第6表(UPPLAN)/第7表(UPSIKYU) と判定できませんでした — スキップ`);
        }
      }

      // ── 突合: 被保険者番号 → clients.insured_number ───────────────────────────
      const insuredNumbers = new Set<string>();
      for (const f of p6) for (const r of f.records) insuredNumbers.add(r.insuredNumber);
      for (const f of p7) for (const pl of f.plans) insuredNumbers.add(pl.insuredNumber);

      // clients.insured_number (キャッシュ列) で突合。無ければ client_insurance_records も参照。
      const clientByInsured = new Map<string, { id: string; name: string }>();
      const insuredList = Array.from(insuredNumbers).filter(Boolean);
      for (let i = 0; i < insuredList.length; i += 50) {
        const chunk = insuredList.slice(i, i + 50);
        const { data, error } = await supabase
          .from("clients")
          .select("id, name, insured_number")
          .in("insured_number", chunk)
          .eq("is_facility", false);
        if (error) {
          toast.error("利用者突合に失敗: " + error.message);
          setParsing(false);
          return;
        }
        for (const c of (data ?? []) as { id: string; name: string; insured_number: string | null }[]) {
          const key = (c.insured_number ?? "").trim();
          if (key && !clientByInsured.has(key)) clientByInsured.set(key, { id: c.id, name: c.name });
        }
      }
      // clients で引けなかった被保険者番号を client_insurance_records で補完
      const stillMissing = insuredList.filter((n) => !clientByInsured.has(n));
      for (let i = 0; i < stillMissing.length; i += 50) {
        const chunk = stillMissing.slice(i, i + 50);
        const { data, error } = await supabase
          .from("client_insurance_records")
          .select("client_id, insured_number")
          .in("insured_number", chunk);
        if (error) {
          // 補完は best-effort。失敗しても続行 (突合不可扱い)
          console.warn("[riyouhyou-import] cert fallback failed:", error.message);
          break;
        }
        const certRows = (data ?? []) as { client_id: string; insured_number: string | null }[];
        const certClientIds = Array.from(new Set(certRows.map((r) => r.client_id)));
        const nameById = new Map<string, string>();
        for (let j = 0; j < certClientIds.length; j += 50) {
          const ids = certClientIds.slice(j, j + 50);
          const { data: cl } = await supabase.from("clients").select("id, name").in("id", ids).eq("is_facility", false);
          for (const c of (cl ?? []) as { id: string; name: string }[]) nameById.set(c.id, c.name);
        }
        for (const rec of certRows) {
          const key = (rec.insured_number ?? "").trim();
          const name = nameById.get(rec.client_id);
          if (key && name && !clientByInsured.has(key)) {
            clientByInsured.set(key, { id: rec.client_id, name });
          }
        }
      }

      // 突合不可の被保険者番号一覧
      const unmatchedSet = new Set<string>();
      for (const n of insuredList) if (!clientByInsured.has(n)) unmatchedSet.add(n);

      // ── サービスコード → service_name 逆引き (第6表の対象月世代で) ───────────────
      // 対象月は第6表の targetYm を使う (複数月あれば月ごとに解決)。
      const codesByMonth = new Map<string, Set<string>>();
      for (const f of p6) {
        for (const r of f.records) {
          const ym = r.targetYm || f.targetYm;
          if (!ym) continue;
          if (!codesByMonth.has(ym)) codesByMonth.set(ym, new Set());
          codesByMonth.get(ym)!.add(r.serviceCode);
        }
      }
      // Map<`${ym}|${code}`, service_name>
      const nameByMonthCode = new Map<string, string>();
      for (const [ym, codes] of codesByMonth) {
        const year = Number(ym.slice(0, 4));
        const mon = Number(ym.slice(4, 6));
        if (!year || !mon) continue;
        const codeList = Array.from(codes);
        for (let i = 0; i < codeList.length; i += 50) {
          const chunk = codeList.slice(i, i + 50);
          const { data, error } = await validInMonth(
            supabase
              .from("kaigo_service_codes")
              .select("service_code, service_name, system")
              .in("service_code", chunk),
            year,
            mon,
          );
          if (error) {
            toast.error("サービスコード逆引きに失敗: " + error.message);
            setParsing(false);
            return;
          }
          // 同コードが複数制度にある場合は介護を優先
          for (const rec of (data ?? []) as { service_code: string; service_name: string; system: string }[]) {
            const key = `${ym}|${rec.service_code}`;
            const prev = nameByMonthCode.get(key);
            if (!prev || rec.system === "介護") nameByMonthCode.set(key, rec.service_name);
          }
        }
      }

      // ── 第6表 → ResolvedSchedule[] ───────────────────────────────────────────
      const schedules: ResolvedSchedule[] = [];
      for (const f of p6) {
        for (const r of f.records) {
          const client = clientByInsured.get(r.insuredNumber);
          if (!client) continue; // 突合不可は unmatched に集約済み
          const ym = r.targetYm || f.targetYm;
          const serviceName = nameByMonthCode.get(`${ym}|${r.serviceCode}`);
          if (!serviceName) {
            warns.push(
              `${client.name}: サービスコード ${r.serviceCode} (${r.serviceDate}) がマスタから引けません — この予定はスキップ`,
            );
            continue;
          }
          // 時刻: 時間表示なし (null) は 00:00 では意味が壊れるため、
          // start/end 双方 null の行は「時刻未指定の予定」として 00:00:00 を入れる。
          const start = r.startTime ? `${r.startTime}:00` : "00:00:00";
          const end = r.endTime ? `${r.endTime}:00` : "00:00:00";
          // サービス回数 > 1 は同一行の複数回。基本 1 訪問 = 1 行なので回数分に展開する。
          const times = Math.max(1, r.count);
          for (let k = 0; k < times; k++) {
            schedules.push({
              clientId: client.id,
              clientName: client.name,
              visitDate: r.serviceDate,
              startTime: start,
              endTime: end,
              serviceType: serviceName,
              serviceCode: r.serviceCode,
            });
          }
        }
      }

      // ── 第7表 → ResolvedPlanUnit[] ───────────────────────────────────────────
      const planUnits: ResolvedPlanUnit[] = [];
      for (const f of p7) {
        for (const pl of f.plans) {
          const client = clientByInsured.get(pl.insuredNumber);
          if (!client) continue;
          if (!/^\d{6}$/.test(pl.targetYm)) {
            warns.push(`${client.name}: 第7表の対象年月が不正 (${pl.targetYm}) — 計画単位をスキップ`);
            continue;
          }
          planUnits.push({
            clientId: client.id,
            clientName: client.name,
            targetMonth: `${pl.targetYm.slice(0, 4)}-${pl.targetYm.slice(4, 6)}-01`,
            plannedUnits: pl.plannedUnits,
          });
        }
      }

      setPlan6(p6);
      setBetsu7(p7);
      setResolvedSchedules(schedules);
      setResolvedPlanUnits(planUnits);
      setUnmatched(Array.from(unmatchedSet));
      setWarnings(warns);
      setReady(p6.length > 0 || p7.length > 0);

      if (p6.length === 0 && p7.length === 0) {
        toast.error("取込対象 (第6表 UPPLAN / 第7表 UPSIKYU) のファイルがありませんでした。");
      } else {
        toast.success(
          `プレビュー作成: 予定 ${schedules.length} 件 / 計画単位 ${planUnits.length} 件` +
            (unmatchedSet.size > 0 ? ` (突合不可 ${unmatchedSet.size} 名)` : ""),
        );
      }
    } catch (err) {
      console.error(err);
      toast.error("取込に失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setParsing(false);
    }
  };

  // ── 確定 → DB 反映 ──────────────────────────────────────────────────────────
  const handleApply = async () => {
    if (!currentOffice) {
      toast.error("事業所が選択されていません。");
      return;
    }
    setApplying(true);
    try {
      let scheduleCount = 0;
      let planCount = 0;

      // 1) 第6表 → kaigo_visit_schedule 予定 upsert
      //    同一 (user_id, visit_date, start_time, service_type) を再取込した際の
      //    重複を防ぐため、対象利用者×対象月の既存 scheduled 行 (自事業所) を先に削除してから INSERT。
      if (resolvedSchedules.length > 0) {
        // 対象 (clientId × YYYY-MM) を収集
        const monthsByClient = new Map<string, Set<string>>();
        for (const s of resolvedSchedules) {
          const ym = s.visitDate.slice(0, 7); // YYYY-MM
          if (!monthsByClient.has(s.clientId)) monthsByClient.set(s.clientId, new Set());
          monthsByClient.get(s.clientId)!.add(ym);
        }
        // 既存の scheduled 予定を対象範囲で削除 (self 事業所 + office_id NULL の未設定分)
        for (const [clientId, months] of monthsByClient) {
          for (const ym of months) {
            const y = Number(ym.slice(0, 4));
            const m = Number(ym.slice(5, 7));
            const from = `${ym}-01`;
            const to = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
            const { error: delErr } = await supabase
              .from("kaigo_visit_schedule")
              .delete()
              .eq("user_id", clientId)
              .eq("status", "scheduled")
              .gte("visit_date", from)
              .lte("visit_date", to)
              .or(`office_id.eq.${currentOffice.id},office_id.is.null`);
            if (delErr) {
              toast.error(`既存予定の削除に失敗 (${clientId}): ${delErr.message}`);
              setApplying(false);
              return;
            }
          }
        }
        // INSERT (office_id 未適用環境では insertVisitSchedules 相当の strip が要るが、
        //  ここでは office_id は必須の運用列として素の insert を使い、error は toast)。
        const payload = resolvedSchedules.map((s) => ({
          user_id: s.clientId,
          visit_date: s.visitDate,
          start_time: s.startTime,
          end_time: s.endTime,
          service_type: s.serviceType,
          status: "scheduled",
          office_id: currentOffice.id,
        }));
        // 500 行ずつ INSERT
        for (let i = 0; i < payload.length; i += 500) {
          const chunk = payload.slice(i, i + 500);
          const { error } = await supabase.from("kaigo_visit_schedule").insert(chunk);
          if (error) {
            toast.error("予定の登録に失敗: " + error.message);
            setApplying(false);
            return;
          }
          scheduleCount += chunk.length;
        }
      }

      // 2) 第7表 → kaigo_monthly_plan_units upsert (client_id, target_month) 一意
      if (resolvedPlanUnits.length > 0) {
        const rows = resolvedPlanUnits.map((p) => ({
          tenant_id: currentOffice.tenant_id,
          client_id: p.clientId,
          target_month: p.targetMonth,
          planned_units: p.plannedUnits,
          source: "careplan",
        }));
        const { error } = await supabase
          .from("kaigo_monthly_plan_units")
          .upsert(rows, { onConflict: "client_id,target_month" });
        if (error) {
          toast.error("計画単位数の登録に失敗: " + error.message);
          setApplying(false);
          return;
        }
        planCount = rows.length;
      }

      toast.success(`反映完了: 予定 ${scheduleCount} 件 / 計画単位 ${planCount} 件`);
      resetPreview();
    } catch (err) {
      console.error(err);
      toast.error("反映に失敗: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setApplying(false);
    }
  };

  // プレビュー用: 対象利用者一覧
  const previewUsers = Array.from(
    new Map(
      [
        ...resolvedSchedules.map((s) => [s.clientId, s.clientName] as const),
        ...resolvedPlanUnits.map((p) => [p.clientId, p.clientName] as const),
      ].map(([id, name]) => [id, name]),
    ).entries(),
  );

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
          <FileUp size={20} />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">利用票取込（第6表・第7表 / V4）</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            ケアマネから届いた サービス利用票（第6表=計画/予定 UPPLAN）と 利用票別表（第7表 UPSIKYU）の
            CSV（Shift-JIS）を取り込み、予定（status=scheduled）と計画単位数に反映します。
            被保険者番号で自事業所の利用者に突合します（突合できない場合はスキップ）。
          </p>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv"
        multiple
        className="hidden"
        onChange={handleFiles}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={parsing || applying || btLoading || !currentOffice}
          className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {parsing ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}
          CSVを選択してプレビュー
        </button>
        {ready && (
          <button
            type="button"
            onClick={resetPreview}
            className="text-sm text-gray-500 hover:text-red-500"
          >
            クリア
          </button>
        )}
      </div>

      {/* プレビュー */}
      {ready && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-3 text-center">
              <div className="text-xs text-gray-500">第6表ファイル</div>
              <div className="text-lg font-bold text-gray-900">{plan6.length}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3 text-center">
              <div className="text-xs text-gray-500">第7表ファイル</div>
              <div className="text-lg font-bold text-gray-900">{betsu7.length}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3 text-center">
              <div className="text-xs text-gray-500">予定 (件)</div>
              <div className="text-lg font-bold text-emerald-700">{resolvedSchedules.length}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3 text-center">
              <div className="text-xs text-gray-500">計画単位 (件)</div>
              <div className="text-lg font-bold text-emerald-700">{resolvedPlanUnits.length}</div>
            </div>
          </div>

          {/* 対象利用者 */}
          {previewUsers.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="mb-1 text-xs font-medium text-gray-600">
                対象利用者 ({previewUsers.length} 名)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {previewUsers.map(([id, name]) => (
                  <span key={id} className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 計画単位数 内訳 */}
          {resolvedPlanUnits.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="mb-1 text-xs font-medium text-gray-600">計画単位数 (区分支給限度基準内・自事業所分)</div>
              <div className="space-y-0.5 text-xs text-gray-700">
                {resolvedPlanUnits.map((p, i) => (
                  <div key={i} className="flex justify-between">
                    <span>{p.clientName}（{p.targetMonth.slice(0, 7)}）</span>
                    <span className="font-mono font-medium">{p.plannedUnits.toLocaleString()} 単位</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 突合不可 */}
          {unmatched.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-amber-800">
                <AlertTriangle size={12} />
                突合できなかった被保険者番号 ({unmatched.length} 件) — スキップします
              </div>
              <div className="flex flex-wrap gap-1.5">
                {unmatched.map((n) => (
                  <span key={n} className="rounded bg-amber-100 px-2 py-0.5 text-xs font-mono text-amber-800">
                    {n}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 警告 */}
          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <div className="mb-1 text-xs font-semibold text-amber-800">確認事項 ({warnings.length})</div>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber-700">
                {warnings.map((w, i) => (
                  <li key={i}>・{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            確定すると、対象利用者×対象月の既存「予定(scheduled)」を自事業所分だけ入れ替え、計画単位数を上書きします。
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={resetPreview}
              className="rounded-lg border px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={applying || (resolvedSchedules.length === 0 && resolvedPlanUnits.length === 0)}
              className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {applying ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              確定して反映
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
