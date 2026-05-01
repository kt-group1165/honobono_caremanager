"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { differenceInYears, parseISO, format } from "date-fns";
import { User, Download, Upload, Loader2 } from "lucide-react";
import { UserSidebar } from "@/components/users/user-sidebar";
import type { KaigoUser } from "@/types/database";

/**
 * 利用者詳細画面の共有レイアウト
 * - 左: UserSidebar（利用者一覧・縦長）
 * - 右: 利用者ヘッダー + 2大タブ（基本情報 / 介護保険）+ サブタブ + children
 */

type SubTab = { label: string; href: string };

const BASIC_TABS: SubTab[] = [
  { label: "基本情報", href: "" },
  { label: "親族・関係者", href: "/family" },
  { label: "既往歴", href: "/history" },
  { label: "ADL", href: "/adl" },
  { label: "健康管理", href: "/health" },
];

const INSURANCE_TABS: SubTab[] = [
  { label: "介護認定", href: "/care-cert" },
  { label: "医療保険", href: "/medical" },
];

const DISABILITY_TABS: SubTab[] = [
  { label: "障害情報", href: "/disability" },
];

type MainTab = "basic" | "insurance" | "disability";

const STATUS_LABELS: Record<string, string> = {
  active: "在籍中",
  inactive: "退所",
  deceased: "死亡",
};

export default function UserDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const id = params?.id;
  const supabase = createClient();

  const [user, setUser] = useState<KaigoUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hasDisabilityService, setHasDisabilityService] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("kaigo_users")
        .select("*")
        .eq("id", id)
        .single();
      if (!cancelled) {
        setUser(data as KaigoUser | null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, supabase]);

  // 「障害」タブを表示するかどうか:
  // 訪問介護事業所のサービス種別で「居宅介護」「重度訪問介護」「同行援護」のいずれかがアクティブな場合のみ
  // pathname 変更時に再評価することで、サブタブ切替えのタイミングで反映される
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("kaigo_user_office_services")
        .select("home_care_categories, is_active")
        .eq("user_id", id);
      if (cancelled) return;
      const TRIGGER = ["居宅介護", "重度訪問介護", "同行援護"];
      const has = (data || []).some(
        (row: { home_care_categories: unknown; is_active: boolean }) => {
          if (!row.is_active) return false;
          const cats = Array.isArray(row.home_care_categories)
            ? row.home_care_categories
            : [];
          return cats.some(
            (c: { category?: string; active?: boolean }) =>
              !!c?.active && TRIGGER.includes(c?.category ?? "")
          );
        }
      );
      setHasDisabilityService(has);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, pathname, supabase]);

  // サイドバーで別の利用者を選んだらルートを切り替え
  const handleSelectUser = (newId: string) => {
    if (newId === id) return;
    // 現在のサブタブを維持して遷移
    const suffix = id && pathname ? pathname.slice(`/users/${id}`.length) : "";
    router.push(`/users/${newId}${suffix}`);
  };

  // ── CSV出力 ────────────────────────────────────────────────────────────────
  const CSV_COLUMNS = [
    "id",
    "name",
    "name_kana",
    "gender",
    "birth_date",
    "blood_type",
    "postal_code",
    "address",
    "phone",
    "mobile_phone",
    "email",
    "emergency_contact_name",
    "emergency_contact_phone",
    "admission_date",
    "status",
    "notes",
  ] as const;

  const escapeCsv = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const { data, error } = await supabase
        .from("kaigo_users")
        .select(CSV_COLUMNS.join(","))
        .order("name_kana", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as Record<string, unknown>[];

      const header = CSV_COLUMNS.join(",");
      const lines = rows.map((r) =>
        CSV_COLUMNS.map((c) => escapeCsv(r[c])).join(",")
      );
      const csv = "\uFEFF" + [header, ...lines].join("\r\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `利用者一覧_${format(new Date(), "yyyyMMdd")}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`${rows.length}件の利用者情報を出力しました`);
    } catch (err: unknown) {
      toast.error(
        "CSV出力に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setExporting(false);
    }
  };

  // ── CSV取込 ────────────────────────────────────────────────────────────────
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          result.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
    }
    result.push(current);
    return result;
  };

  const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    setImporting(true);
    try {
      const buf = await file.arrayBuffer();
      let text = "";
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder("shift-jis").decode(buf);
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        toast.error("CSVファイルが空またはヘッダーのみです");
        return;
      }

      const headerCells = parseCSVLine(lines[0]).map((c) => c.trim());
      const requiredCols = ["name", "name_kana", "gender", "birth_date"];
      const missing = requiredCols.filter((c) => !headerCells.includes(c));
      if (missing.length > 0) {
        toast.error(`必須カラムがありません: ${missing.join(", ")}`);
        return;
      }

      type UserRow = Partial<Record<(typeof CSV_COLUMNS)[number], string>>;
      const rowsToUpsert: UserRow[] = [];
      const errors: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cells = parseCSVLine(lines[i]);
        const row: UserRow = {};
        headerCells.forEach((col, idx) => {
          if ((CSV_COLUMNS as readonly string[]).includes(col)) {
            const v = cells[idx]?.trim() ?? "";
            (row as Record<string, string>)[col] = v;
          }
        });
        // バリデーション
        if (!row.name) {
          errors.push(`${i + 1}行目: 氏名がありません`);
          continue;
        }
        if (!row.name_kana) {
          errors.push(`${i + 1}行目: フリガナがありません`);
          continue;
        }
        if (row.gender && row.gender !== "男" && row.gender !== "女") {
          errors.push(`${i + 1}行目: 性別は「男」または「女」で指定してください`);
          continue;
        }
        if (!row.birth_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.birth_date)) {
          errors.push(`${i + 1}行目: 生年月日を YYYY-MM-DD 形式で指定してください`);
          continue;
        }
        rowsToUpsert.push(row);
      }

      if (rowsToUpsert.length === 0) {
        toast.error(
          `インポートできる行がありません${errors.length > 0 ? "\n" + errors.slice(0, 3).join("\n") : ""}`
        );
        return;
      }

      // id 列があれば upsert (update)、無ければ insert
      const insertRows: UserRow[] = [];
      const updateRows: UserRow[] = [];
      for (const row of rowsToUpsert) {
        if (row.id) updateRows.push(row);
        else insertRows.push(row);
      }

      let inserted = 0;
      let updated = 0;

      if (insertRows.length > 0) {
        // id を除外して新規登録
        const payload = insertRows.map((r) => {
          const copy = { ...r };
          delete copy.id;
          // 空文字列は null に（日付系）
          Object.keys(copy).forEach((k) => {
            if ((copy as Record<string, string>)[k] === "") {
              (copy as Record<string, unknown>)[k] = null;
            }
          });
          return copy;
        });
        const { error, data } = await supabase
          .from("kaigo_users")
          .insert(payload)
          .select("id");
        if (error) throw error;
        inserted = data?.length ?? 0;
      }

      if (updateRows.length > 0) {
        for (const row of updateRows) {
          const { id: rowId, ...rest } = row;
          const payload: Record<string, unknown> = { ...rest };
          Object.keys(payload).forEach((k) => {
            if (payload[k] === "") payload[k] = null;
          });
          const { error } = await supabase
            .from("kaigo_users")
            .update(payload)
            .eq("id", rowId!);
          if (!error) updated++;
        }
      }

      const errorSummary = errors.length > 0 ? `（${errors.length}件エラー）` : "";
      toast.success(
        `取込完了: 新規${inserted}件 / 更新${updated}件${errorSummary}`
      );
      // 自動再読込のため現在のユーザーを再取得
      if (id) {
        const { data } = await supabase
          .from("kaigo_users")
          .select("*")
          .eq("id", id)
          .single();
        setUser(data as KaigoUser | null);
      }
      // サイドバーはリロードが必要
      router.refresh();
    } catch (err: unknown) {
      toast.error(
        "CSV取込に失敗しました: " +
          (err instanceof Error ? err.message : String(err))
      );
    } finally {
      setImporting(false);
    }
  };

  if (!id) return null;

  const baseHref = `/users/${id}`;

  // 現在どのサブタブにいるかを判定
  const currentSubHref = (() => {
    const suffix = pathname.slice(baseHref.length); // "", "/care-cert", etc.
    return suffix;
  })();

  // 現在選択されているメイン分類を判定
  const activeMainTab: MainTab = DISABILITY_TABS.some((t) => t.href === currentSubHref)
    ? "disability"
    : INSURANCE_TABS.some((t) => t.href === currentSubHref)
      ? "insurance"
      : "basic";

  const currentSubs =
    activeMainTab === "basic"
      ? BASIC_TABS
      : activeMainTab === "insurance"
        ? INSURANCE_TABS
        : DISABILITY_TABS;

  return (
    <div className="flex h-full -m-6">
      <UserSidebar selectedUserId={id} onSelectUser={handleSelectUser} />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="space-y-4">
          {/* CSV入出力ツールバー */}
          <div className="flex items-center justify-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleImportCSV}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="CSVから利用者情報を取り込み（id列があれば更新、なければ新規登録）"
            >
              {importing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Upload size={12} />
              )}
              CSV取込
            </button>
            <button
              onClick={handleExportCSV}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              title="全利用者情報をCSVで出力"
            >
              {exporting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              CSV出力
            </button>
          </div>

          {/* 利用者ヘッダー */}
          <div className="rounded-lg border bg-white p-5 shadow-sm">
            {loading ? (
              <div className="h-14 animate-pulse rounded bg-gray-100" />
            ) : user ? (
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
                    <User size={28} className="text-blue-600" />
                  </div>
                  <div>
                    <h1 className="text-xl font-bold text-gray-900">{user.name}</h1>
                    <p className="text-sm text-gray-500">{user.name_kana}</p>
                    <div className="mt-1 flex items-center gap-2 text-sm text-gray-600">
                      <span>{user.gender}</span>
                      <span>·</span>
                      <span>{differenceInYears(new Date(), parseISO(user.birth_date))}歳</span>
                      <span>·</span>
                      <span>{format(parseISO(user.birth_date), "yyyy年M月d日")} 生</span>
                    </div>
                  </div>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    user.status === "active"
                      ? "bg-green-100 text-green-800"
                      : user.status === "deceased"
                        ? "bg-red-100 text-red-700"
                        : "bg-gray-100 text-gray-600"
                  }`}
                >
                  {STATUS_LABELS[user.status] ?? user.status}
                </span>
              </div>
            ) : (
              <p className="text-sm text-gray-400">利用者情報を取得できませんでした</p>
            )}
          </div>

          {/* 2大タブ */}
          <div className="flex gap-1 border-b border-gray-200">
            {([
              { id: "basic" as const, label: "基本情報", defaultHref: "" },
              { id: "insurance" as const, label: "介護保険", defaultHref: "/care-cert" },
              ...(hasDisabilityService || activeMainTab === "disability"
                ? [{ id: "disability" as const, label: "障害", defaultHref: "/disability" }]
                : []),
            ]).map((main) => {
              const isActive = activeMainTab === main.id;
              return (
                <Link
                  key={main.id}
                  href={baseHref + main.defaultHref}
                  className={`rounded-t-lg px-5 py-2.5 text-sm font-semibold transition-colors ${
                    isActive
                      ? "bg-white text-blue-700 border border-gray-200 border-b-white -mb-px shadow-sm"
                      : "bg-gray-50 text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {main.label}
                </Link>
              );
            })}
          </div>

          {/* サブタブ */}
          <div className="border-b bg-white rounded-t-lg shadow-sm overflow-x-auto -mt-4 pt-1">
            <nav className="flex min-w-max">
              {currentSubs.map((tab) => {
                const isActive = tab.href === currentSubHref;
                return (
                  <Link
                    key={tab.href}
                    href={baseHref + tab.href}
                    className={`px-4 py-2.5 text-[13px] font-medium whitespace-nowrap border-b-2 transition-colors ${
                      isActive
                        ? "border-blue-600 text-blue-600"
                        : "border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300"
                    }`}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* 各サブページのコンテンツ */}
          {children}
        </div>
      </div>
    </div>
  );
}
