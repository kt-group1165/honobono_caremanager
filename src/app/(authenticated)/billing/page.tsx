"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import {
  Receipt,
  Plus,
  Filter,
  RefreshCw,
  Loader2,
  TrendingUp,
  Wallet,
  CreditCard,
  Download,
} from "lucide-react";
import { format } from "date-fns";
import { ja } from "date-fns/locale";

interface BillingRecord {
  id: string;
  user_id: string;
  billing_month: string;
  service_type: string;
  total_units: number;
  unit_price: number;
  total_amount: number;
  insurance_amount: number;
  copay_amount: number;
  status: "draft" | "submitted" | "paid";
  created_at: string;
  updated_at: string;
  // PostgREST embed: kaigo_billing_records.user_id → clients (FK redirect 済)
  clients?: { name: string };
}

const STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  submitted: "請求済",
  paid: "入金済",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  submitted: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
};

function formatAmount(amount: number): string {
  return amount.toLocaleString("ja-JP") + "円";
}

function formatMonth(yyyyMm: string): string {
  if (!yyyyMm) return "—";
  try {
    const [y, m] = yyyyMm.split("-");
    return `${y}年${parseInt(m, 10)}月`;
  } catch {
    return yyyyMm;
  }
}

function getCurrentMonth(): string {
  return format(new Date(), "yyyy-MM");
}

// 訪問系サービス種別→国保連サービス種類コード
const SERVICE_TYPE_TO_KOKUHO_CODE: Record<string, string> = {
  訪問介護: "11",
  訪問入浴介護: "12",
  訪問看護: "13",
  訪問リハビリ: "14",
  訪問リハビリテーション: "14",
  通所介護: "15",
  通所リハビリ: "16",
  通所リハビリテーション: "16",
  福祉用具貸与: "17",
  居宅療養管理指導: "31",
  短期入所生活介護: "21",
  短期入所療養介護: "22",
  定期巡回: "73",
  夜間対応型訪問介護: "72",
};

// サービス種別→代表サービス項目コード（Phase1簡易版）
const SERVICE_TYPE_TO_ITEM_CODE: Record<string, string> = {
  訪問介護: "1111",           // 身体介護1
  訪問入浴介護: "1211",
  訪問看護: "1311",
  訪問リハビリ: "1411",
  訪問リハビリテーション: "1411",
  通所介護: "1511",
  通所リハビリ: "1611",
  通所リハビリテーション: "1611",
  福祉用具貸与: "1711",
  居宅療養管理指導: "3111",
};

// 要介護度→コード変換
function careLevelToCode(careLevel: string): string {
  const map: Record<string, string> = {
    要支援1: "12", 要支援2: "13",
    要介護1: "21", 要介護2: "22", 要介護3: "23",
    要介護4: "24", 要介護5: "25",
  };
  return map[careLevel] ?? "00";
}

// 地域区分→コード変換
function areaCategoryToCode(area: string): number {
  const map: Record<string, number> = {
    "1級地": 1, "2級地": 2, "3級地": 3, "4級地": 4,
    "5級地": 5, "6級地": 6, "7級地": 7, "その他": 8,
  };
  return map[area] ?? 8;
}

export default function BillingPage() {
  const supabase = createClient();
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMonth, setFilterMonth] = useState(getCurrentMonth());
  const [filterStatus, setFilterStatus] = useState("");

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      // PostgREST embed: kaigo_billing_records.user_id → clients (FK redirect 済)
      let query = supabase
        .from("kaigo_billing_records")
        .select("*, clients(name)")
        .order("billing_month", { ascending: false })
        .order("created_at", { ascending: false });

      if (filterMonth) query = query.eq("billing_month", filterMonth);
      if (filterStatus) query = query.eq("status", filterStatus);

      const { data, error } = await query.limit(500);
      if (error) throw error;
      setRecords(data || []);
    } catch (err: unknown) {
      toast.error(
        "請求データの取得に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, filterMonth, filterStatus]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    fetchRecords();
  }, [fetchRecords]);

  const summary = records.reduce(
    (acc, r) => ({
      total_amount: acc.total_amount + (r.total_amount || 0),
      insurance_amount: acc.insurance_amount + (r.insurance_amount || 0),
      copay_amount: acc.copay_amount + (r.copay_amount || 0),
    }),
    { total_amount: 0, insurance_amount: 0, copay_amount: 0 }
  );

  const handleStatusChange = async (
    id: string,
    newStatus: "draft" | "submitted" | "paid"
  ) => {
    try {
      const { error } = await supabase
        .from("kaigo_billing_records")
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      toast.success("ステータスを更新しました");
      fetchRecords();
    } catch (err: unknown) {
      toast.error(
        "更新に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  };

  // ── 国保連伝送用 固定長テキスト出力 ──────────────────────────────────
  const handleKokuhoExport = async () => {
    // 確定済み（下書き以外）のみ対象
    const confirmed = records.filter((r) => r.status !== "draft");
    if (confirmed.length === 0) {
      toast.error("確定済みの請求データがありません。ステータスを「請求済」以上に変更してください。");
      return;
    }
    if (!filterMonth) {
      toast.error("請求月を指定してください");
      return;
    }

    try {
      // 1. 自事業所設定（共通マスタ offices、kaigo-app の自事業所だけ取得）
      const { data: officeData } = await supabase
        .from("offices")
        .select("business_number, area_category, unit_price")
        .eq("app_type", "kaigo-app")
        .limit(1)
        .maybeSingle();
      const providerNumber = officeData?.business_number ?? "0000000000";
      const unitPrice = Number(officeData?.unit_price ?? 10);
      const areaCode = areaCategoryToCode(officeData?.area_category ?? "その他");

      // 2. 利用者情報（生年月日・性別） — clients から取得
      const userIds = [...new Set(confirmed.map((r) => r.user_id))];
      const { data: usersData } = await supabase
        .from("clients")
        .select("id, name, birth_date, gender")
        .in("id", userIds);
      const userInfoMap = new Map<
        string,
        { name: string; birth_date: string | null; gender: string | null }
      >();
      for (const u of usersData || []) {
        userInfoMap.set(u.id, {
          name: u.name ?? "",
          birth_date: u.birth_date ?? null,
          gender: u.gender ?? null,
        });
      }

      // 3. 認定情報（client_insurance_records、カラム名は新スキーマ）
      //   user_id → client_id, start_date → certification_start_date, end_date → certification_end_date
      const { data: certs } = await supabase
        .from("client_insurance_records")
        .select("client_id, care_level, insurer_number, insured_number, certification_start_date, certification_end_date")
        .in("client_id", userIds)
        .order("certification_date", { ascending: false });
      const certMap = new Map<
        string,
        {
          care_level: string;
          insurer_number: string | null;
          insured_number: string | null;
          start_date: string | null;
          end_date: string | null;
        }
      >();
      for (const cert of certs || []) {
        if (!certMap.has(cert.client_id)) {
          certMap.set(cert.client_id, {
            care_level: cert.care_level,
            insurer_number: cert.insurer_number ?? null,
            insured_number: cert.insured_number ?? null,
            start_date: cert.certification_start_date ?? null,
            end_date: cert.certification_end_date ?? null,
          });
        }
      }

      // 4. Dynamic import
      const { downloadHomeCareFile } = await import("@/lib/kokuho-renkei");
      const serviceYearMonth = filterMonth.replace("-", "");

      // 5. service_type ごとにグルーピング
      const byServiceType = new Map<string, BillingRecord[]>();
      for (const r of confirmed) {
        const code = SERVICE_TYPE_TO_KOKUHO_CODE[r.service_type];
        if (!code) continue; // マッピング無しはスキップ
        if (!byServiceType.has(code)) byServiceType.set(code, []);
        byServiceType.get(code)!.push(r);
      }

      if (byServiceType.size === 0) {
        toast.error("国保連コードに対応したサービス種別がありません");
        return;
      }

      // 6. 各サービス種別コードごとにファイル生成
      let fileCount = 0;
      for (const [serviceTypeCode, group] of byServiceType) {
        const homeCareClaims = group.map((r) => {
          const user = userInfoMap.get(r.user_id);
          const cert = certMap.get(r.user_id);
          const insuredNumber = cert?.insured_number ?? "";
          const insurerNumber = cert?.insurer_number ?? "";
          const careLevelCode = careLevelToCode(cert?.care_level ?? "");
          const birthDate = (user?.birth_date ?? "").replace(/-/g, "") || "19500101";
          const genderCode: "1" | "2" = user?.gender === "女" ? "2" : "1";
          const itemCode = SERVICE_TYPE_TO_ITEM_CODE[r.service_type] ?? "0000";

          return {
            base: {
              exchangeId: "7131",
              serviceYearMonth,
              providerNumber,
              serviceTypeCode,
              areaCode,
              insuredNumber,
              userName: user?.name ?? "",
              birthDate,
              gender: genderCode,
              careLevelCode,
              certStartDate: (cert?.start_date ?? "20240401").replace(/-/g, ""),
              certEndDate: (cert?.end_date ?? "20270331").replace(/-/g, ""),
              insurerNumber,
              totalUnits: r.total_units,
            },
            services: [
              {
                serviceItemCode: itemCode,
                units: r.total_units,
                count: 1,
                serviceUnits: r.total_units,
                note: r.service_type,
              },
            ],
            shukei: {
              actualDays: 1,
              plannedUnits: r.total_units,
              limitManagementUnits: r.total_units,
              nonLimitUnits: 0,
              benefitUnits: r.total_units,
              unitPrice,
              totalCost: r.total_amount,
              insuranceClaim: r.insurance_amount,
              userCopay: r.copay_amount,
            },
          };
        });

        downloadHomeCareFile({
          serviceYearMonth,
          providerNumber,
          serviceTypeCode,
          areaCode,
          unitPrice,
          claims: homeCareClaims,
        });
        fileCount++;
      }

      toast.success(
        `${fileCount}件の国保連伝送用ファイルを出力しました（${confirmed.length}レセプト）`
      );
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("伝送用ファイルの出力に失敗しました: " + msg);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="text-blue-600" size={24} />
          <h1 className="text-xl font-bold text-gray-900">請求管理</h1>
          <span className="ml-2 rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-600">
            {records.length}件
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchRecords}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} />
            更新
          </button>
          <button
            onClick={handleKokuhoExport}
            disabled={records.filter((r) => r.status !== "draft").length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
            title="確定済み請求データから国保連伝送用ファイル（固定長テキスト・Shift-JIS）を出力"
          >
            <Download size={14} />
            国保連伝送用
          </button>
          <Link
            href="/billing/create"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={16} />
            請求データ作成
          </Link>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <TrendingUp size={15} className="text-blue-500" />
            請求合計
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.total_amount)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Wallet size={15} className="text-green-500" />
            保険請求額
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.insurance_amount)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <CreditCard size={15} className="text-orange-500" />
            利用者負担合計
          </div>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(summary.copay_amount)}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium text-gray-700">
          <Filter size={15} />
          絞り込み
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">請求月</label>
            <input
              type="month"
              value={filterMonth}
              onChange={(e) => setFilterMonth(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">ステータス</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded-lg border px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">すべて</option>
              <option value="draft">下書き</option>
              <option value="submitted">請求済</option>
              <option value="paid">入金済</option>
            </select>
          </div>
          {(filterMonth || filterStatus) && (
            <div className="flex items-end">
              <button
                onClick={() => {
                  setFilterMonth(getCurrentMonth());
                  setFilterStatus("");
                }}
                className="text-xs text-blue-600 hover:underline pb-1.5"
              >
                リセット
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : records.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            <Receipt size={40} className="mx-auto mb-3 opacity-20" />
            <p>請求データがありません</p>
            {filterMonth && (
              <p className="mt-1 text-xs text-gray-400">
                {formatMonth(filterMonth)}のデータはまだ作成されていません
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    利用者
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    請求月
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">
                    サービス種別
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    単位数
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    請求額
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    保険分
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">
                    自己負担
                  </th>
                  <th className="px-4 py-3 text-center font-medium text-gray-600">
                    ステータス
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {records.map((record) => (
                  <tr
                    key={record.id}
                    className="hover:bg-gray-50 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {record.clients?.name || "—"}
                    </td>
                    <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                      {formatMonth(record.billing_month)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                        {record.service_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {(record.total_units || 0).toLocaleString("ja-JP")}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {formatAmount(record.total_amount || 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-700">
                      {formatAmount(record.insurance_amount || 0)}
                    </td>
                    <td className="px-4 py-3 text-right text-orange-700">
                      {formatAmount(record.copay_amount || 0)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <select
                        value={record.status}
                        onChange={(e) =>
                          handleStatusChange(
                            record.id,
                            e.target.value as "draft" | "submitted" | "paid"
                          )
                        }
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium cursor-pointer border-0 focus:outline-none focus:ring-2 focus:ring-blue-500 ${STATUS_COLORS[record.status]}`}
                      >
                        {Object.entries(STATUS_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t bg-gray-50">
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-3 text-sm font-medium text-gray-600"
                  >
                    合計 ({records.length}件)
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">
                    {formatAmount(summary.total_amount)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-green-700">
                    {formatAmount(summary.insurance_amount)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-orange-700">
                    {formatAmount(summary.copay_amount)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Navigation Links */}
      <div className="flex gap-4 text-sm">
        <Link
          href="/billing/history"
          className="text-blue-600 hover:underline flex items-center gap-1"
        >
          <TrendingUp size={14} />
          請求履歴・月次集計
        </Link>
      </div>
    </div>
  );
}
