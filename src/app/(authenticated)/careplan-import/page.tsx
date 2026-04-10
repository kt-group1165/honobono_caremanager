"use client";

import { useState, useRef, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
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
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImportedFile {
  id: string;
  name: string;
  type: "user-info" | "care-plan-1" | "care-plan-2" | "care-plan-3" | "table-6" | "table-7" | "unknown";
  label: string;
  rows: string[][];
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

function parseCarePlan2(rows: string[][]): Record<string, any> {
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

function parseCarePlan3(rows: string[][]): Record<string, any> {
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [existingUsers, setExistingUsers] = useState<ExistingUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");

  // Load existing users
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from("kaigo_users").select("id, name, name_kana").eq("status", "active").order("name_kana");
      setExistingUsers(data || []);
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

      // 自動マッチ: 名前で検索
      if (!userId && detectedName) {
        const { data } = await supabase
          .from("kaigo_users")
          .select("id, name")
          .eq("name", detectedName)
          .eq("status", "active")
          .limit(1);
        if (data && data.length > 0) {
          userId = data[0].id;
          toast.info(`利用者「${detectedName}」に自動紐付けしました`);
        }
      }

      // 利用者基本情報CSVがあり、マッチしなければ新規作成
      if (!userId && userInfoFile && detectedName) {
        const info = userInfoFile.parsed;
        const { data: newUser, error } = await supabase
          .from("kaigo_users")
          .insert({
            name: info.name,
            name_kana: info.name_kana || "",
            gender: info.gender || "男",
            birth_date: info.birth_date || "2000-01-01",
            address: info.address || "",
            phone: info.phone || "",
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
        <h1 className="text-2xl font-bold text-gray-900">ケアプラン取込</h1>
        <p className="mt-1 text-sm text-gray-500">
          居宅介護支援事業所から受け取ったCSVファイル（ケアプランデータ連携 標準様式）を取り込みます
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
