"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  FileText,
  User,
  CalendarDays,
  Info,
  Loader2,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ja } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProvisionUser {
  user_id: string;
  user_name: string;
  user_name_kana: string | null;
  care_level: string | null;
  latest_period_start: string | null;
  latest_period_end: string | null;
  document_id: string | null;
  document_status: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  try {
    return format(parseISO(dateStr), "yyyy年M月d日", { locale: ja });
  } catch {
    return dateStr;
  }
}

function careLevel(level: string | null): string {
  if (!level) return "—";
  return level;
}

const STATUS_LABELS: Record<string, { label: string; bg: string; text: string }> = {
  draft: { label: "下書き", bg: "bg-gray-100", text: "text-gray-600" },
  confirmed: { label: "確認済", bg: "bg-green-100", text: "text-green-700" },
  sent: { label: "送付済", bg: "bg-blue-100", text: "text-blue-700" },
  received: { label: "受領済", bg: "bg-teal-100", text: "text-teal-700" },
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProvisionConfirmPage() {
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<ProvisionUser[]>([]);

  const fetchData = async () => {
    setLoading(true);

    // Fetch active users with provision sheet data
    // We join kaigo_users -> kaigo_report_documents (type = service-usage) for the latest
    const { data: userData, error: userError } = await supabase
      .from("kaigo_users")
      .select("id, name, name_kana, care_level, status")
      .eq("status", "active")
      .order("name_kana");

    if (userError) {
      toast.error("利用者情報の取得に失敗しました");
      setLoading(false);
      return;
    }

    if (!userData || userData.length === 0) {
      setUsers([]);
      setLoading(false);
      return;
    }

    // Try to fetch latest report documents for these users
    const userIds = userData.map((u: any) => u.id);
    const { data: docData } = await supabase
      .from("kaigo_report_documents")
      .select("id, user_id, period_start, period_end, status, document_type")
      .in("user_id", userIds)
      .in("document_type", ["service-usage", "provision-sheet"])
      .order("period_start", { ascending: false });

    // Map: latest doc per user
    const docByUser: Record<string, any> = {};
    for (const doc of docData || []) {
      if (!docByUser[doc.user_id]) {
        docByUser[doc.user_id] = doc;
      }
    }

    const mapped: ProvisionUser[] = userData.map((u: any) => {
      const doc = docByUser[u.id] ?? null;
      return {
        user_id: u.id,
        user_name: u.name,
        user_name_kana: u.name_kana,
        care_level: u.care_level,
        latest_period_start: doc?.period_start ?? null,
        latest_period_end: doc?.period_end ?? null,
        document_id: doc?.id ?? null,
        document_status: doc?.status ?? null,
      };
    });

    setUsers(mapped);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withDoc = users.filter((u) => u.document_id);
  const withoutDoc = users.filter((u) => !u.document_id);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">提供票確認</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            ケアマネジャーから受領した提供票・サービス利用票を確認します
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          更新
        </button>
      </div>

      {/* Info banner */}
      <div className="mx-6 mt-4 flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-blue-500" />
        <div className="text-xs text-blue-700 leading-relaxed">
          <strong className="font-semibold">提供票とは</strong> —
          ケアマネジャーが作成し、訪問介護事業所に送付するサービス利用計画の書類です。
          月ごとの訪問予定日・時間・サービス内容が記載されています。
          受領した提供票はシステムに登録し、実績と照合してください。
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            <Loader2 size={20} className="animate-spin mr-2" />
            読込中...
          </div>
        ) : users.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-400">
            <div className="text-center">
              <User size={32} className="mx-auto mb-2 text-gray-300" />
              <p>登録された利用者がいません</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Users with provision data */}
            {withDoc.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-800">
                  <FileText size={14} className="text-green-600" />
                  提供票登録済み
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                    {withDoc.length}名
                  </span>
                </h2>
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">利用者名</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">要介護度</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">対象期間</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">ステータス</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {withDoc.map((u) => {
                        const statusInfo = u.document_status
                          ? STATUS_LABELS[u.document_status] ?? { label: u.document_status, bg: "bg-gray-100", text: "text-gray-600" }
                          : null;
                        return (
                          <tr key={u.user_id} className="hover:bg-gray-50 transition-colors">
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-blue-600">
                                  <User size={13} />
                                </div>
                                <div>
                                  <p className="font-medium text-gray-900">{u.user_name}</p>
                                  {u.user_name_kana && (
                                    <p className="text-[11px] text-gray-400">{u.user_name_kana}</p>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-gray-700">{careLevel(u.care_level)}</td>
                            <td className="px-4 py-3">
                              <span className="flex items-center gap-1 text-xs text-gray-600">
                                <CalendarDays size={11} className="text-gray-400" />
                                {formatDate(u.latest_period_start)}
                                {" 〜 "}
                                {formatDate(u.latest_period_end)}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {statusInfo && (
                                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusInfo.bg} ${statusInfo.text}`}>
                                  {statusInfo.label}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <a
                                href={`/reports/service-usage?userId=${u.user_id}&docId=${u.document_id}`}
                                className="inline-flex items-center gap-1 rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
                              >
                                <ExternalLink size={11} />
                                確認
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Users without provision data */}
            {withoutDoc.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-gray-800">
                  <FileText size={14} className="text-gray-400" />
                  提供票未登録
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                    {withoutDoc.length}名
                  </span>
                </h2>
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-gray-50">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">利用者名</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">要介護度</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {withoutDoc.map((u) => (
                        <tr key={u.user_id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                                <User size={13} />
                              </div>
                              <div>
                                <p className="font-medium text-gray-900">{u.user_name}</p>
                                {u.user_name_kana && (
                                  <p className="text-[11px] text-gray-400">{u.user_name_kana}</p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-700">{careLevel(u.care_level)}</td>
                          <td className="px-4 py-3">
                            <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700">
                              提供票待ち
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Footer note */}
      <div className="border-t bg-white px-6 py-3 text-xs text-gray-400">
        提供票データは「帳票作成 → サービス利用票・提供票」から登録・編集できます。
        ケアプランデータ連携（標準仕様）への対応は今後のアップデートで追加予定です。
      </div>
    </div>
  );
}
