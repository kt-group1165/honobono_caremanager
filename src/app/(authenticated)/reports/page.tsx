"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  User,
  FileText,
  ClipboardList,
  CalendarDays,
  BookOpen,
  Download,
  Loader2,
  ChevronRight,
  X,
} from "lucide-react";
import {
  generateUserInfoCSV,
  generateCarePlan1CSV,
  generateCarePlan2CSV,
  generateCarePlan3CSV,
  generateTable7CSV,
  downloadCSV,
  generateTimestamp,
} from "@/lib/careplan-csv-export";
import type { UserData, OfficeData } from "@/lib/careplan-csv-export";

type ReportCard = {
  type: string;
  titleJa: string;
  titleEn: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
};

const REPORT_CARDS: ReportCard[] = [
  // 全ての帳票はケアマネ業務メニューから直接アクセスする方針:
  //   - フェースシート (face-sheet) [削除予定]
  //   - 居宅サービス計画書 第1表/第2表/第3表 → ケアマネ業務 > 計画書
  //   - 居宅介護支援経過 第5表 → ケアマネ業務 > 支援経過
  //   - 利用票・提供票 → ケアマネ業務 > 利用・提供票
  //   - サービス利用票別表 第7表 → ケアマネ業務 > 利用票別表
  //   - 会議録 第4表 → ケアマネ業務 > 会議録
];

// ─── CSV Export types ─────────────────────────────────────────────────────────

interface KaigoUser {
  id: string;
  name: string;
  name_kana: string;
  birth_date?: string;
  gender?: string;
  address?: string;
  phone?: string;
}

const CSV_TABLES = [
  { key: "user-info", label: "利用者基本情報", reportType: null },
  { key: "care-plan-1", label: "第1表（居宅サービス計画書）", reportType: "care-plan-1" },
  { key: "care-plan-2", label: "第2表（サービス内容）", reportType: "care-plan-2" },
  { key: "care-plan-3", label: "第3表（週間計画）", reportType: "care-plan-3" },
  { key: "service-usage-detail", label: "第7表（利用票別表）", reportType: "service-usage-detail" },
];

export default function ReportsPage() {
  const supabase = createClient();
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [users, setUsers] = useState<KaigoUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [officeInfo, setOfficeInfo] = useState<OfficeData | null>(null);

  useEffect(() => {
    const load = async () => {
      const [userRes, officeRes] = await Promise.all([
        supabase.from("clients").select("id, name, name_kana:furigana, birth_date, gender, address, phone").eq("status", "active").eq("is_facility", false).is("deleted_at", null).order("furigana", { nullsFirst: false }),
        // 共通マスタ offices, kaigo-app の自事業所だけ。PostgREST 列エイリアスで旧フィールド名維持
        supabase.from("offices").select("provider_number:business_number, office_name:name").eq("app_type", "kaigo-app").limit(1).single(),
      ]);
      setUsers(userRes.data || []);
      if (officeRes.data) setOfficeInfo(officeRes.data as OfficeData);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCsvExportAll = async () => {
    if (!selectedUserId) {
      toast.error("利用者を選択してください");
      return;
    }
    setExporting(true);

    try {
      const user = users.find((u) => u.id === selectedUserId);
      if (!user) throw new Error("利用者が見つかりません");

      const userData: UserData = {
        name: user.name,
        name_kana: user.name_kana,
        birth_date: user.birth_date,
        gender: user.gender,
        address: user.address,
        phone: user.phone,
      };
      const office = officeInfo ?? {};
      const ts = generateTimestamp();
      const provNo = office.provider_number ?? "0000000000";
      let count = 0;

      // 利用者基本情報
      const userCsv = generateUserInfoCSV(userData, office);
      downloadCSV(userCsv, `UPKHON_${provNo}_43_${ts}.csv`);
      count++;

      // 帳票データ取得
      const { data: docs } = await supabase
        .from("kaigo_report_documents")
        .select("report_type, content")
        .eq("user_id", selectedUserId)
        .order("created_at", { ascending: false });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-typed value (CSV row / DB row / component prop widening)
      const docMap: Record<string, any> = {};
      for (const doc of docs ?? []) {
        if (!docMap[doc.report_type]) {
          docMap[doc.report_type] = doc.content;
        }
      }

      // 第1表
      if (docMap["care-plan-1"]) {
        const csv = generateCarePlan1CSV(docMap["care-plan-1"], userData, office);
        downloadCSV(csv, `UP1KYO_${provNo}_43_${ts}.csv`);
        count++;
      }

      // 第2表
      if (docMap["care-plan-2"]) {
        const csv = generateCarePlan2CSV(docMap["care-plan-2"], userData, office);
        downloadCSV(csv, `UP2KYO_${provNo}_43_${ts}.csv`);
        count++;
      }

      // 第3表
      if (docMap["care-plan-3"]) {
        const csv = generateCarePlan3CSV(docMap["care-plan-3"], userData, office);
        downloadCSV(csv, `UP3KYO_${provNo}_43_${ts}.csv`);
        count++;
      }

      // 第7表
      if (docMap["service-usage-detail"]) {
        const csv = generateTable7CSV(docMap["service-usage-detail"], userData, office);
        downloadCSV(csv, `DLTBET_${provNo}_43_${ts}.csv`);
        count++;
      }

      if (count > 0) {
        toast.success(`${count}件のCSVファイルを出力しました`);
      } else {
        toast.info("利用者基本情報のみ出力しました。帳票データを先に作成してください。");
      }
    } catch (err) {
      console.error(err);
      toast.error("CSV出力に失敗しました");
    } finally {
      setExporting(false);
      setShowCsvModal(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">帳票作成</h1>
          <p className="mt-1 text-sm text-gray-500">
            各種公式帳票・書類を作成・印刷できます
          </p>
        </div>
        <button
          onClick={() => setShowCsvModal(true)}
          className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700 transition-colors"
        >
          <Download size={16} />
          CSV一括出力（標準様式）
        </button>
      </div>

      {/* Report Cards Grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {REPORT_CARDS.map((card) => (
          <div
            key={card.type}
            className={`flex flex-col rounded-xl border bg-white shadow-sm hover:shadow-md transition-shadow overflow-hidden ${card.borderColor}`}
          >
            <div className={`flex items-center gap-4 p-5 ${card.bgColor}`}>
              <div className={`shrink-0 ${card.color}`}>{card.icon}</div>
              <div className="min-w-0">
                <h2 className="font-bold text-gray-900 leading-tight">
                  {card.titleJa}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">{card.titleEn}</p>
              </div>
            </div>
            <div className="flex flex-1 flex-col justify-between p-5 pt-4">
              <p className="text-sm text-gray-600 leading-relaxed">
                {card.description}
              </p>
              <Link
                href={`/reports/${card.type}`}
                className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white transition-colors ${
                  card.type === "face-sheet"
                    ? "bg-blue-600 hover:bg-blue-700"
                    : card.type === "care-plan-1"
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : card.type === "care-plan-2"
                        ? "bg-violet-600 hover:bg-violet-700"
                        : card.type === "care-plan-3"
                          ? "bg-cyan-600 hover:bg-cyan-700"
                          : card.type === "support-progress"
                            ? "bg-indigo-600 hover:bg-indigo-700"
                            : card.type === "service-usage"
                              ? "bg-orange-600 hover:bg-orange-700"
                              : card.type === "service-usage-detail"
                                ? "bg-cyan-600 hover:bg-cyan-700"
                                : "bg-gray-600 hover:bg-gray-700"
                }`}
              >
                <FileText size={15} />
                帳票を作成する
              </Link>
            </div>
          </div>
        ))}
      </div>

      {/* Info note */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600">
        <strong className="font-medium text-gray-800">使い方: </strong>
        帳票の種類を選択し、利用者・対象期間を指定すると帳票がプレビュー表示されます。
        ブラウザの印刷機能またはページ内の印刷ボタンからA4用紙に印刷してください。
      </div>

      {/* CSV Export Modal */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-semibold text-gray-900">
                <Download size={18} className="inline mr-2 text-green-600" />
                CSV一括出力（ケアプランデータ連携 標準様式）
              </h2>
              <button onClick={() => setShowCsvModal(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">利用者</label>
                <select
                  value={selectedUserId ?? ""}
                  onChange={(e) => setSelectedUserId(e.target.value || null)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">-- 利用者を選択 --</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}（{u.name_kana}）</option>
                  ))}
                </select>
              </div>

              <div className="rounded-lg border bg-gray-50 p-3">
                <p className="text-xs font-medium text-gray-600 mb-2">出力対象ファイル</p>
                <ul className="space-y-1 text-xs text-gray-600">
                  {CSV_TABLES.map((t) => (
                    <li key={t.key} className="flex items-center gap-2">
                      <span className="w-4 h-4 rounded bg-green-100 text-green-600 flex items-center justify-center text-[10px] font-bold">✓</span>
                      {t.label}
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-gray-400 mt-2">
                  ※ 各帳票は事前に「帳票を作成する」で保存されている必要があります
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button onClick={() => setShowCsvModal(false)} className="rounded-lg border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                キャンセル
              </button>
              <button
                onClick={handleCsvExportAll}
                disabled={exporting || !selectedUserId}
                className="flex items-center gap-1 rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
              >
                {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                一括出力
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
