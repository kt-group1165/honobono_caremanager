"use client";

import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Search, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import { useLocalStorage } from "@/lib/use-local-storage";
import {
  ServiceCategoryBadge,
  type ServiceCategoryValue,
} from "@/components/shared/service-category-badge";
import {
  getHospitalizationMap,
  isCurrentlyHospitalized,
  type HospitalizationPeriod,
} from "@/lib/hospitalization";

// 利用者一覧表示用の最小スキーマ（共通マスタ clients の subset）
// service_category は migration 未適用環境で undefined になりうる
interface ClientRow {
  id: string;
  name: string;
  furigana: string | null;
  status: string;
  service_category?: ServiceCategoryValue;
}

// 介護/障害/両方 の絞り込みモード
//   all     = すべて
//   kaigo   = 介護のみ (= 'kaigo' | undefined (legacy 互換))
//   shougai = 障害のみ (= 'shougai')
//   both    = 両方利用のみ (= 'both')
// 利用者が単一の介護専用テナントの場合、初期は all。
type CategoryFilter = "all" | "kaigo" | "shougai" | "both";
const CATEGORY_FILTER_KEY = "kaigo.user_category_filter";
function parseCategoryFilter(raw: string | null): CategoryFilter {
  if (raw === "kaigo" || raw === "shougai" || raw === "both" || raw === "all") return raw;
  return "all";
}

interface UserSidebarProps {
  // Both props omitted → URL mode (?user=<id> driven via search params)
  // Both props provided → explicit mode (used by users/[id]/layout where id is in path)
  selectedUserId?: string | null;
  onSelectUser?: (userId: string) => void;
}

// ── 警告バッジ (ほのぼの準拠) ──────────────────────────────────────────────
// 未申請 / 認定切れ / 更新◯日 / 保険未登録 / 入院中 を名前の右に小バッジ表示。
// 「未実績」「未記録」は負荷が読めないためスコープ外 (2026-07 総点検)。

/** 最新認定 (certification_start_date 降順の先頭) の要約 */
interface LatestCert {
  care_level: string | null;
  certification_end_date: string | null;
}

/** バッジ用にまとめて fetch した参照データ。取得失敗時は null (= バッジ非表示で続行) */
interface BadgeData {
  latestCert: Map<string, LatestCert>;
  hasInsurance: Set<string>;
  hospitalization: Map<string, HospitalizationPeriod[]>;
}

interface WarnBadge {
  /** 正方形バッジに出す 1 文字 (ほのぼの流の「未」等) */
  short: string;
  /** ホバー時に出す full ラベル */
  label: string;
  cls: string;
  title: string;
}

/** 認定更新の警告を出す残日数しきい値 */
const CERT_RENEWAL_WARN_DAYS = 60;

/** ローカル TZ の今日 (YYYY-MM-DD) */
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function computeWarnBadges(
  clientId: string,
  data: BadgeData,
  today: string,
): WarnBadge[] {
  const out: WarnBadge[] = [];
  const cert = data.latestCert.get(clientId);
  if (cert) {
    if (cert.care_level === "申請中") {
      out.push({
        short: "未",
        label: "未申請",
        cls: "bg-yellow-100 text-yellow-800 border-yellow-300",
        title: "未申請: 最新の認定が申請中です",
      });
    }
    const end = cert.certification_end_date;
    if (end) {
      if (end < today) {
        out.push({
          short: "切",
          label: "認定切れ",
          cls: "bg-red-100 text-red-700 border-red-300",
          title: `認定切れ: 認定有効期間が終了しています (〜${end})`,
        });
      } else {
        const days = Math.ceil(
          (Date.parse(end) - Date.parse(today)) / 86_400_000,
        );
        if (days <= CERT_RENEWAL_WARN_DAYS) {
          out.push({
            short: "更",
            label: `更新${days}日`,
            cls: "bg-amber-100 text-amber-800 border-amber-300",
            title: `更新間近: 認定有効期間の終了まで ${days} 日です (〜${end})`,
          });
        }
      }
    }
  }
  if (!data.hasInsurance.has(clientId)) {
    out.push({
      short: "保",
      label: "保険未登録",
      cls: "bg-gray-100 text-gray-500 border-gray-300",
      title: "保険未登録: 介護保険情報が未登録です",
    });
  }
  if (isCurrentlyHospitalized(data.hospitalization.get(clientId), today)) {
    out.push({
      short: "院",
      label: "入院中",
      cls: "bg-purple-100 text-purple-700 border-purple-300",
      title: "入院中: 現在入院中です",
    });
  }
  return out;
}

const FILTER_KEY = "kaigo.user_filter_mode";
const URL_PARAM = "user";

// useSearchParams は Suspense 境界配下に必須 (CSR bailout 回避)
// 利用側が Suspense を毎回張らずに済むよう、本体側で内蔵する
export function UserSidebar(props: UserSidebarProps = {}) {
  return (
    <Suspense fallback={<UserSidebarFallback />}>
      <UserSidebarInner {...props} />
    </Suspense>
  );
}

function UserSidebarFallback() {
  return (
    <div className="flex h-full w-36 flex-col border-r bg-white">
      <div className="border-b p-2 space-y-1.5 h-[58px]" />
      <div className="flex-1 overflow-y-auto p-3 text-center text-xs text-gray-400">
        読込中...
      </div>
    </div>
  );
}

function UserSidebarInner(props: UserSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL mode is active when explicit props are not provided
  const explicit = props.selectedUserId !== undefined && props.onSelectUser !== undefined;
  const urlSelectedUserId = searchParams.get(URL_PARAM);
  const selectedUserId = explicit ? (props.selectedUserId ?? null) : urlSelectedUserId;

  const handleSelectUser = useCallback(
    (id: string) => {
      if (explicit) {
        props.onSelectUser?.(id);
        return;
      }
      const next = new URLSearchParams(searchParams.toString());
      next.set(URL_PARAM, id);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [explicit, props, searchParams, router, pathname]
  );

  const [users, setUsers] = useState<ClientRow[]>([]);
  const [officeUserIds, setOfficeUserIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);
  const { currentOfficeId } = useBusinessType();

  // 表示モード: all (全利用者) / office (自事業所の利用者のみ)
  // useLocalStorage で SSR-safe に hydrate (setState-in-effect 不要)
  const [filterMode, setFilterMode] = useLocalStorage<"all" | "office">(
    FILTER_KEY,
    "office",
    (raw) => (raw === "all" ? "all" : "office"),
  );

  // 介護/障害/両方 絞り込み
  const [categoryFilter, setCategoryFilter] = useLocalStorage<CategoryFilter>(
    CATEGORY_FILTER_KEY,
    "all",
    parseCategoryFilter,
  );

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    // Supabase の db.max_rows（デフォルト 1000）対策で、
    // 自事業所モードでは「先に assignments を取得 → .in('id', [...])」で
    // 限定 fetch する。これにより 1000 件超のテナントでも漏れなく
    // 自事業所に紐付く利用者が表示される。
    // 全利用者モードは max_rows までで切れるが UX 上許容。
    if (filterMode === "office" && currentOfficeId) {
      // 1) 自事業所の現役 assignments から client_id を取得
      //    PostgREST default 1000 行制限を超えるテナント向けに page-loop で全件取得
      const PAGE = 1000;
      const assignsAll: { client_id: string }[] = [];
      let from = 0;
      while (true) {
        const { data: assigns } = await supabase
          .from("client_office_assignments")
          .select("client_id")
          .eq("office_id", currentOfficeId)
          .is("end_date", null)
          .range(from, from + PAGE - 1);
        if (!assigns || assigns.length === 0) break;
        assignsAll.push(...(assigns as { client_id: string }[]));
        if (assigns.length < PAGE) break;
        from += PAGE;
      }
      const clientIds = Array.from(
        new Set<string>(assignsAll.map((a) => a.client_id))
      );

      if (clientIds.length === 0) {
        setUsers([]);
        setOfficeUserIds(new Set());
        setLoading(false);
        return;
      }

      // 2) その client_id 群だけ clients を fetch
      // is_facility = false: 法人/事業所エントリ（包括支援センター等）を除外
      const { data } = await supabase
        .from("clients")
        // service_category 列は Phase Shougai-1 migration 適用後のみ存在。
        // migration 未適用環境では select 失敗を防ぐため "*" で取得し、
        // 未定義時は undefined のまま (フィルタ default 'all' で全件表示) として扱う。
        .select("*")
        .in("id", clientIds)
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { ascending: true, nullsFirst: false });
      setUsers((data || []) as ClientRow[]);
      setOfficeUserIds(new Set<string>(clientIds));
    } else {
      // 全利用者モード: 通常の clients 取得（最大 db.max_rows まで）
      // is_facility = false: 法人/事業所エントリを除外
      const { data } = await supabase
        .from("clients")
        // service_category 列は Phase Shougai-1 migration 適用後のみ存在。
        // migration 未適用環境では select 失敗を防ぐため "*" で取得し、
        // 未定義時は undefined のまま (フィルタ default 'all' で全件表示) として扱う。
        .select("*")
        .eq("status", "active")
        .eq("is_facility", false)
        .is("deleted_at", null)
        .order("furigana", { ascending: true, nullsFirst: false })
        .range(0, 9999);
      setUsers((data || []) as ClientRow[]);

      // モード切替時のチラつき防止に officeUserIds も並行取得
      if (currentOfficeId) {
        // PostgREST default 1000 行制限対策で page-loop
        const PAGE2 = 1000;
        const svcAll: { client_id: string }[] = [];
        let from2 = 0;
        while (true) {
          const { data: svc } = await supabase
            .from("client_office_assignments")
            .select("client_id")
            .eq("office_id", currentOfficeId)
            .is("end_date", null)
            .range(from2, from2 + PAGE2 - 1);
          if (!svc || svc.length === 0) break;
          svcAll.push(...(svc as { client_id: string }[]));
          if (svc.length < PAGE2) break;
          from2 += PAGE2;
        }
        const set = new Set<string>(svcAll.map((s) => s.client_id));
        setOfficeUserIds(set);
      } else {
        setOfficeUserIds(new Set());
      }
    }
    setLoading(false);
  }, [supabase, currentOfficeId, filterMode]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // ── 警告バッジ用の参照データ (利用者一覧の確定後に 1 回だけまとめて fetch) ──
  // UserSidebar は多画面で共有されるため、per-user の個別 fetch はしない。
  // 失敗時はバッジ無しで一覧表示を続行する (console.warn のみ)。
  const [badgeData, setBadgeData] = useState<BadgeData | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ids = users.map((u) => u.id);
    if (ids.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 一覧が空になったらバッジ情報もクリア (derived reset)
      setBadgeData(null);
      return;
    }
    (async () => {
      try {
        // 1) 介護保険: 最新認定 (start 降順の先頭) + 登録有無。IN 50 件 chunk + page-loop
        const IN_CHUNK = 50;
        const PAGE = 1000;
        const latestCert = new Map<string, LatestCert>();
        const hasInsurance = new Set<string>();
        for (let i = 0; i < ids.length; i += IN_CHUNK) {
          const chunk = ids.slice(i, i + IN_CHUNK);
          let offset = 0;
          while (true) {
            const { data, error } = await supabase
              .from("client_insurance_records")
              .select("client_id, care_level, certification_end_date")
              .in("client_id", chunk)
              .order("client_id", { ascending: true })
              .order("certification_start_date", { ascending: false, nullsFirst: false })
              .range(offset, offset + PAGE - 1);
            if (error) throw new Error(error.message);
            const rows = (data ?? []) as Array<{
              client_id: string;
              care_level: string | null;
              certification_end_date: string | null;
            }>;
            for (const r of rows) {
              hasInsurance.add(r.client_id);
              if (!latestCert.has(r.client_id)) {
                latestCert.set(r.client_id, {
                  care_level: r.care_level,
                  certification_end_date: r.certification_end_date,
                });
              }
            }
            if (rows.length < PAGE) break;
            offset += PAGE;
          }
        }
        // 2) 入退院 (共有ヘルパー。テーブル未作成は空 Map で続行)
        const hospitalization = await getHospitalizationMap(supabase, ids);
        if (!cancelled) setBadgeData({ latestCert, hasInsurance, hospitalization });
      } catch (err) {
        console.warn(
          "利用者バッジ情報の取得に失敗 (バッジ無しで続行):",
          err instanceof Error ? err.message : err,
        );
        if (!cancelled) setBadgeData(null);
      }
    })();
    return () => { cancelled = true; };
  }, [users, supabase]);

  const today = useMemo(() => localToday(), []);

  const filtered = useMemo(() => {
    let list = users;
    if (filterMode === "office" && currentOfficeId) {
      list = list.filter((u) => officeUserIds.has(u.id));
    }
    // 介護/障害/両方 絞り込み
    //   kaigo:   service_category in ('kaigo','both') OR undefined (legacy 互換)
    //   shougai: service_category in ('shougai','both')
    //   both:    service_category === 'both'
    if (categoryFilter !== "all") {
      list = list.filter((u) => {
        const c = u.service_category;
        if (categoryFilter === "kaigo") return c == null || c === "kaigo" || c === "both";
        if (categoryFilter === "shougai") return c === "shougai" || c === "both";
        return c === "both";
      });
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((u) =>
        u.name.toLowerCase().includes(q) || (u.furigana ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [users, search, filterMode, currentOfficeId, officeUserIds, categoryFilter]);

  // Auto-select 1st visible user when nothing selected (URL mode のみ)
  // 明示モード (users/[id]/layout) は URL の path 側で id が決まるので auto-select 不要
  useEffect(() => {
    if (explicit) return;
    if (loading) return;
    if (selectedUserId) return;
    if (filtered.length === 0) return;
    handleSelectUser(filtered[0].id);
  }, [explicit, loading, selectedUserId, filtered, handleSelectUser]);

  // setFilterMode が localStorage 書き込み込みなので setMode は alias
  const setMode = setFilterMode;

  return (
    <div className="flex h-full w-36 flex-col border-r bg-white">
      <div className="border-b p-2 space-y-1.5">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="利用者検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border bg-gray-50 py-1.5 pl-7 pr-2 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        {/* フィルタ切替 */}
        <div className="flex rounded-md border overflow-hidden text-[10px] font-medium">
          <button
            onClick={() => setMode("office")}
            className={cn(
              "flex-1 py-1 transition-colors",
              filterMode === "office" ? "bg-blue-600 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"
            )}
          >
            自事業所
          </button>
          <button
            onClick={() => setMode("all")}
            className={cn(
              "flex-1 py-1 transition-colors",
              filterMode === "all" ? "bg-blue-600 text-white" : "bg-gray-50 text-gray-500 hover:bg-gray-100"
            )}
          >
            全利用者
          </button>
        </div>
        {/* 制度区分フィルタ (Phase Shougai-1) */}
        <div className="flex rounded-md border overflow-hidden text-[10px] font-medium">
          {([
            { key: "all" as const, label: "全種別" },
            { key: "kaigo" as const, label: "介護" },
            { key: "shougai" as const, label: "障害" },
            { key: "both" as const, label: "両方" },
          ]).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setCategoryFilter(opt.key)}
              className={cn(
                "flex-1 py-1 transition-colors",
                categoryFilter === opt.key
                  ? "bg-violet-600 text-white"
                  : "bg-gray-50 text-gray-500 hover:bg-gray-100"
              )}
              title={
                opt.key === "all" ? "すべての利用者"
                : opt.key === "kaigo" ? "介護保険利用者 (両方利用を含む)"
                : opt.key === "shougai" ? "障害福祉利用者 (両方利用を含む)"
                : "介護保険と障害福祉を両方利用する利用者のみ"
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-center text-xs text-gray-400">読込中...</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-center text-xs text-gray-400">
            {filterMode === "office" ? "自事業所の利用者なし" : "該当なし"}
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((user) => {
              const warnBadges = badgeData
                ? computeWarnBadges(user.id, badgeData, today)
                : [];
              return (
                <li key={user.id}>
                  <button
                    onClick={() => handleSelectUser(user.id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                      selectedUserId === user.id
                        ? "bg-blue-50 text-blue-700 font-medium border-r-2 border-blue-600"
                        : "text-gray-700 hover:bg-gray-50"
                    )}
                  >
                    <User size={14} className="shrink-0 text-gray-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                        <span className="truncate text-sm leading-tight">{user.name}</span>
                        <ServiceCategoryBadge category={user.service_category} size="xs" />
                        {warnBadges.map((b) => (
                          <span
                            key={b.label}
                            title={b.title}
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[10px] font-bold leading-none",
                              b.cls,
                            )}
                          >
                            {b.short}
                          </span>
                        ))}
                      </div>
                      <div className="truncate text-[10px] text-gray-400 leading-tight">{user.furigana ?? ""}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="border-t px-3 py-1.5 text-[10px] text-gray-400">
        {filtered.length}名
      </div>
    </div>
  );
}
