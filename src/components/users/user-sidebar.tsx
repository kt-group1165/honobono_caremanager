"use client";

import { Suspense, useState, useEffect, useMemo, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Search, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBusinessType } from "@/lib/business-type-context";
import { useLocalStorage } from "@/lib/use-local-storage";
import { confirmNav } from "@/lib/nav-guard";
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
  care_level?: string | null;
  service_category?: ServiceCategoryValue;
}

// 介護/障害/両方 の絞り込みモード
//   all     = すべて
//   kaigo   = 介護保険利用者 (両方利用を含む)
//   shougai = 障害福祉利用者 (両方利用を含む)
//   both    = 介護・障害の両方を利用
// 判定は clients.service_category ではなく実データから行う (下記 shougaiIds / isKaigo)。
// service_category 列は未適用環境が多く、依存すると「障害」で全員消える事故が起きるため。
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
  /** 明示モードでも未選択時に先頭の利用者を自動選択する (provision-tickets 等の
   *  client shell 用。users/[id]/layout は path 側で id が決まるので指定しない) */
  autoSelectFirst?: boolean;
}

// ── 警告バッジ (ほのぼの準拠: 利用者管理編 p.19) ──────────────────────────
// ほのぼのの利用者リストと同じ 3 種を名前の右に小バッジ表示:
//   未 = 利用制度の証憑 (介護保険の認定 / 障害の受給者証) が現在有効でない
//   申 = 申請中 (介護: care_level or certification_status / 障害: is_applying)
//   認 = 有効な証憑の終了まで CERT_RENEWAL_WARN_DAYS 日未満
// 加えて独自の 院 (入院中)。
// ほのぼのは NEXT (介護) と More (障害) で別システムだが本システムは統合のため、
// 利用者が使う制度 (= 実レコードの有無で判定) 側だけをチェックし、両方利用者は
// 同一文字を 1 バッジに統合して tooltip で内訳を示す。制度の識別は隣の
// ServiceCategoryBadge が担う。
// 「最新 1 件」ではなく全履歴で判定する。認定更新レコードは未来の開始日で
// INSERT されるため、start 降順の先頭だけ見ると更新申請中に「未」が誤発火する。
// 「未実績」「未記録」は負荷が読めないためスコープ外 (2026-07 総点検)。

/** 介護保険 認定レコードの要約 (1 利用者 = 履歴複数件) */
interface CertRow {
  care_level: string | null;
  certification_status: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
}

/** 障害福祉 受給者証レコードの要約 (1 利用者 = 履歴複数件) */
interface ShougaiCertRow {
  support_level: string | null;
  is_applying: boolean | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
}

/** 制度 1 つ分の証憑状態 */
interface SeidoState {
  /** レコードが 1 件でもある = その制度の利用者とみなす */
  used: boolean;
  pending: boolean;
  valid: boolean;
  /** valid 時の終了日と残日数 (終了日なしは null) */
  end: string | null;
  daysLeft: number | null;
}

/** バッジ用にまとめて fetch した参照データ。取得失敗時は null (= バッジ非表示で続行) */
interface BadgeData {
  certs: Map<string, CertRow[]>;
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

/** 「認」を出す残日数しきい値 (ほのぼの初期値は 1 ヶ月。更新申請が可能になる 60 日前に設定) */
const CERT_RENEWAL_WARN_DAYS = 60;

/** ローカル TZ の今日 (YYYY-MM-DD) */
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 介護保険: 全履歴から今日時点の証憑状態を求める */
function evalKaigoCerts(certs: CertRow[], today: string): SeidoState {
  // 今日有効な認定 (要支援/要介護、有効期間が今日を含む)。複数あれば終了日が最も先のもの
  let valid: CertRow | null = null;
  // 申請中レコード (新規 or 更新)。終了日が過去のものは stale として無視
  let pending = false;
  for (const c of certs) {
    const { care_level: level, certification_start_date: start, certification_end_date: end } = c;
    if (level === "申請中" || c.certification_status === "申請中") {
      if (!end || end >= today) pending = true;
      continue;
    }
    if (
      !!level &&
      level !== "非該当" &&
      (!start || start <= today) &&
      (!end || end >= today)
    ) {
      if (!valid || (valid.certification_end_date ?? "9999") < (end ?? "9999")) {
        valid = c;
      }
    }
  }
  const end = valid?.certification_end_date ?? null;
  return {
    used: certs.length > 0,
    pending,
    valid: !!valid,
    end,
    daysLeft: end ? Math.ceil((Date.parse(end) - Date.parse(today)) / 86_400_000) : null,
  };
}

/** 障害福祉: 受給者証の全履歴から今日時点の証憑状態を求める */
function evalShougaiCerts(certs: ShougaiCertRow[], today: string): SeidoState {
  let valid: ShougaiCertRow | null = null;
  let pending = false;
  for (const c of certs) {
    const { certification_start_date: start, certification_end_date: end } = c;
    if (c.is_applying) {
      if (!end || end >= today) pending = true;
      continue;
    }
    if (
      c.support_level !== "非該当" &&
      (!start || start <= today) &&
      (!end || end >= today)
    ) {
      if (!valid || (valid.certification_end_date ?? "9999") < (end ?? "9999")) {
        valid = c;
      }
    }
  }
  const end = valid?.certification_end_date ?? null;
  return {
    used: certs.length > 0,
    pending,
    valid: !!valid,
    end,
    daysLeft: end ? Math.ceil((Date.parse(end) - Date.parse(today)) / 86_400_000) : null,
  };
}

function computeWarnBadges(
  clientId: string,
  data: BadgeData,
  shougaiCerts: Map<string, ShougaiCertRow[]>,
  today: string,
): WarnBadge[] {
  const out: WarnBadge[] = [];
  const k = evalKaigoCerts(data.certs.get(clientId) ?? [], today);
  const s = evalShougaiCerts(shougaiCerts.get(clientId) ?? [], today);

  // 申 = いずれかの制度で申請中
  if (k.pending || s.pending) {
    const parts = [
      ...(k.pending ? ["介護保険の認定"] : []),
      ...(s.pending ? ["受給者証"] : []),
    ];
    out.push({
      short: "申",
      label: "申請中",
      cls: "bg-blue-100 text-blue-800 border-blue-300",
      title: `申請中: ${parts.join("・")}を申請中です`,
    });
  }

  // 未 = 利用制度の証憑が現在有効でない (申請中はカバー済みなので除く)。
  // どちらの制度のレコードも無い完全新規も 未
  const kaigoMissing = k.used && !k.valid && !k.pending;
  const shougaiMissing = s.used && !s.valid && !s.pending;
  const nothing = !k.used && !s.used;
  if (kaigoMissing || shougaiMissing || nothing) {
    const title = nothing
      ? "認定なし: 介護保険・受給者証とも未登録です"
      : `認定なし: ${[
          ...(kaigoMissing ? ["有効な介護保険の認定"] : []),
          ...(shougaiMissing ? ["有効な受給者証"] : []),
        ].join("・")}がありません`;
    out.push({
      short: "未",
      label: "認定なし",
      cls: "bg-yellow-100 text-yellow-800 border-yellow-300",
      title,
    });
  }

  // 認 = 有効な証憑の終了が近い (両制度あれば残日数が短い方をラベルに)
  const nearParts: string[] = [];
  let minDays: number | null = null;
  if (k.valid && k.daysLeft !== null && k.daysLeft <= CERT_RENEWAL_WARN_DAYS) {
    nearParts.push(`介護認定 〜${k.end} (残${k.daysLeft}日)`);
    minDays = k.daysLeft;
  }
  if (s.valid && s.daysLeft !== null && s.daysLeft <= CERT_RENEWAL_WARN_DAYS) {
    nearParts.push(`受給者証 〜${s.end} (残${s.daysLeft}日)`);
    minDays = minDays === null ? s.daysLeft : Math.min(minDays, s.daysLeft);
  }
  if (nearParts.length > 0) {
    out.push({
      short: "認",
      label: `認定終了${minDays}日前`,
      cls: "bg-amber-100 text-amber-800 border-amber-300",
      title: `認定終了間近: ${nearParts.join(" / ")}`,
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
      // 未保存離脱ガード (提供表等が registerNavGuard 登録時のみ確認)
      if (!confirmNav()) return;
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
        const certs = new Map<string, CertRow[]>();
        const hasInsurance = new Set<string>();
        for (let i = 0; i < ids.length; i += IN_CHUNK) {
          const chunk = ids.slice(i, i + IN_CHUNK);
          let offset = 0;
          while (true) {
            const { data, error } = await supabase
              .from("client_insurance_records")
              .select("client_id, care_level, certification_status, certification_start_date, certification_end_date")
              .in("client_id", chunk)
              .order("client_id", { ascending: true })
              .order("certification_start_date", { ascending: false, nullsFirst: false })
              .range(offset, offset + PAGE - 1);
            if (error) throw new Error(error.message);
            const rows = (data ?? []) as Array<CertRow & { client_id: string }>;
            for (const r of rows) {
              hasInsurance.add(r.client_id);
              const list = certs.get(r.client_id);
              if (list) list.push(r);
              else certs.set(r.client_id, [r]);
            }
            if (rows.length < PAGE) break;
            offset += PAGE;
          }
        }
        // 2) 入退院 (共有ヘルパー。テーブル未作成は空 Map で続行)
        const hospitalization = await getHospitalizationMap(supabase, ids);
        if (!cancelled) setBadgeData({ certs, hasInsurance, hospitalization });
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

  // ── 障害福祉 受給者証 (制度区分フィルタ + 警告バッジで共用) ──────────────
  // clients.service_category 列には依存しない (未作成環境で「障害」選択時に
  // 全員消える事故の元)。受給者証 (shougai_certifications) を持つ利用者を障害と判定。
  // テーブル未作成 (42P01/PGRST205) や取得失敗は空 Map (= 障害該当なし) で続行。
  const [shougaiCerts, setShougaiCerts] = useState<Map<string, ShougaiCertRow[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const ids = users.map((u) => u.id);
    if (ids.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 一覧が空なら障害判定もクリア (derived reset)
      setShougaiCerts(new Map());
      return;
    }
    (async () => {
      try {
        const IN_CHUNK = 50;
        const PAGE = 1000;
        const found = new Map<string, ShougaiCertRow[]>();
        for (let i = 0; i < ids.length; i += IN_CHUNK) {
          const chunk = ids.slice(i, i + IN_CHUNK);
          let offset = 0;
          while (true) {
            const { data, error } = await supabase
              .from("shougai_certifications")
              .select("client_id, support_level, is_applying, certification_start_date, certification_end_date")
              .in("client_id", chunk)
              .range(offset, offset + PAGE - 1);
            if (error) {
              // テーブル未作成は空 Map で続行 (それ以外も同様に握らず warn)
              throw new Error(error.message);
            }
            const rows = (data ?? []) as Array<ShougaiCertRow & { client_id: string }>;
            for (const r of rows) {
              const list = found.get(r.client_id);
              if (list) list.push(r);
              else found.set(r.client_id, [r]);
            }
            if (rows.length < PAGE) break;
            offset += PAGE;
          }
        }
        if (!cancelled) setShougaiCerts(found);
      } catch (err) {
        console.warn(
          "障害受給者証の取得に失敗 (制度区分フィルタは介護扱いで続行):",
          err instanceof Error ? err.message : err,
        );
        if (!cancelled) setShougaiCerts(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [users, supabase]);

  // 受給者証を 1 件でも持つ利用者 = 障害福祉利用者
  const shougaiIds = useMemo(() => new Set(shougaiCerts.keys()), [shougaiCerts]);

  const today = useMemo(() => localToday(), []);

  const filtered = useMemo(() => {
    let list = users;
    if (filterMode === "office" && currentOfficeId) {
      list = list.filter((u) => officeUserIds.has(u.id));
    }
    // 介護/障害/両方 絞り込み (実データ判定。clients.service_category には依存しない)
    //   障害 = 受給者証あり (shougaiIds)
    //   介護 = 介護保険あり (care_level あり or client_insurance_records あり)
    //   both = 介護 かつ 障害
    if (categoryFilter !== "all") {
      const hasInsurance = badgeData?.hasInsurance;
      list = list.filter((u) => {
        const isShougai = shougaiIds.has(u.id);
        const isKaigo = !!u.care_level || (hasInsurance?.has(u.id) ?? false);
        if (categoryFilter === "kaigo") return isKaigo;
        if (categoryFilter === "shougai") return isShougai;
        return isKaigo && isShougai; // both
      });
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((u) =>
        u.name.toLowerCase().includes(q) || (u.furigana ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [users, search, filterMode, currentOfficeId, officeUserIds, categoryFilter, shougaiIds, badgeData]);

  // Auto-select 1st visible user when nothing selected (URL mode + autoSelectFirst 指定時)
  // 明示モード (users/[id]/layout) は URL の path 側で id が決まるので auto-select 不要だが、
  // provision-tickets 等の client shell は autoSelectFirst で opt-in できる
  useEffect(() => {
    if (explicit && !props.autoSelectFirst) return;
    if (loading) return;
    if (selectedUserId) return;
    if (filtered.length === 0) return;
    handleSelectUser(filtered[0].id);
  }, [explicit, props.autoSelectFirst, loading, selectedUserId, filtered, handleSelectUser]);

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
            {categoryFilter === "shougai"
              ? "障害福祉の利用者なし"
              : categoryFilter === "both"
              ? "介護・障害を両方利用する利用者なし"
              : filterMode === "office"
              ? "自事業所の利用者なし"
              : "該当なし"}
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((user) => {
              const warnBadges = badgeData
                ? computeWarnBadges(user.id, badgeData, shougaiCerts, today)
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
