"use client"

import * as React from "react"
import { Search, X } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServiceCode {
  code: string
  name: string
  units: number
  category: string        // e.g. "11"
  category_name: string   // e.g. "訪問介護"
  type: "基本" | "加算" | string
}

interface ServiceSelectorProps {
  open: boolean
  onClose: () => void
  onSelect: (service: {
    code: string
    name: string
    units: number
    category: string
    categoryName: string
  }) => void
  /**
   * 制度区分フィルタ。
   * - "介護" (デフォルト): 介護保険サービス
   * - "障害": 障害福祉サービス
   * - "総合事業": 介護予防・日常生活支援総合事業
   * provision-tickets / reports / shift-management は全て介護保険なので未指定 = "介護"。
   */
  system?: "介護" | "障害" | "総合事業"
  /**
   * 予定の開始/終了時間 (HH:MM)。指定時のみ「候補のみ」チェックが表示される。
   * チェック ON で「該当時間 (= end - start 分) に収まるサービス」だけが残る。
   */
  startTime?: string
  endTime?: string
}

// ─── 時間レンジ判定 (service_name から所要分を推定) ─────────────────────────

/**
 * service_name から所要時間レンジ [minMin, maxMin] (両端含む) を推定。
 * 対応パターン:
 *   ・介護 訪問介護:
 *       身体介護０１              → [0,  20)
 *       身体介護０２ / 身体介護１ → [20, 30)
 *       身体介護２               → [30, 60)
 *       身体介護N (N≥3)          → [(N-1)*30, N*30)  例: ３=60-90 / ４=90-120
 *       生活援助１               → [20, 45)
 *       生活援助２               → [45, ∞)
 *       生活援助３               → [70, ∞)
 *   ・障害 居宅介護等: X.Y時間表記 (0.5刻み)
 *       身体日/早朝/夜/深 X.Y   → ((X.Y - 0.5)*60, X.Y*60]   例: 1.0 = (30, 60]
 *       家事/通院/乗降/重訪 など同じパターン
 *   ・上記いずれにも該当しない (加算・地域区分・処遇改善 等) → null
 * null は「時間概念なし」を意味し、候補フィルタ ON 時は非表示扱い。
 */
function parseServiceDurationMinutes(name: string): { min: number; max: number } | null {
  const toAscii = (s: string) =>
    s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));

  // 身体介護N (介護保険)
  const taido = name.match(/^身体介護\s*([０-９0-9]+)/);
  if (taido) {
    const raw = toAscii(taido[1]);
    if (raw === "01") return { min: 0, max: 20 };
    if (raw === "02") return { min: 20, max: 30 };
    const n = parseInt(raw, 10);
    if (n === 1) return { min: 20, max: 30 };
    if (n === 2) return { min: 30, max: 60 };
    if (n >= 3) return { min: (n - 1) * 30, max: n * 30 };
  }

  // 生活援助N (介護保険)
  const seikatsu = name.match(/^生活援助\s*([０-９0-9]+)/);
  if (seikatsu) {
    const n = parseInt(toAscii(seikatsu[1]), 10);
    if (n === 1) return { min: 20, max: 45 };
    if (n === 2) return { min: 45, max: 9999 };
    if (n === 3) return { min: 70, max: 9999 };
  }

  // X.Y時間 (障害 居宅介護等: 身体日/早朝/夜/深/家事/通院/乗降/重訪 etc)
  // 名前に 0.5刻みの 10進数 (＝「N.M」) があれば、それが上限時間。
  const shogai = name.match(/([０-９0-9]+)[．.]([０-９0-9]+)/);
  if (shogai) {
    const intPart = toAscii(shogai[1]);
    const decPart = toAscii(shogai[2]);
    const hours = parseFloat(`${intPart}.${decPart}`);
    if (!isNaN(hours) && hours > 0 && hours <= 24) {
      const maxMin = Math.round(hours * 60);
      const minMin = Math.max(0, Math.round((hours - 0.5) * 60));
      return { min: minMin, max: maxMin };
    }
  }

  return null;
}

/** "HH:MM" 2 つから所要時間 (分) を計算。不正なら null。 */
function calcDurationMinutes(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => !Number.isFinite(n))) return null;
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : null;
}

// ─── 時間帯 (zone) 判定 ────────────────────────────────────────────────────

type TimeZone = "日中" | "早朝" | "夜間" | "深夜";

/** "HH:MM" → 時間帯 4 区分 (なお 22:00-翌6:00 が深夜、6:00-8:00 が早朝)。 */
function classifyStartTimeZone(start?: string): TimeZone | null {
  if (!start) return null;
  const m = start.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  if (mins < 6 * 60 || mins >= 22 * 60) return "深夜";   // 22:00〜翌6:00
  if (mins < 8 * 60) return "早朝";                       //  6:00〜 8:00
  if (mins < 18 * 60) return "日中";                      //  8:00〜18:00
  return "夜間";                                          // 18:00〜22:00
}

/**
 * service_name から時間帯を判定。
 *   ・障害 居宅介護等の prefix 形式:
 *       (身体|家事|通院|乗降|重訪|行援|同行|重包) + (日|早|夜|深) + N.M
 *   ・介護 訪問介護等の suffix 形式:
 *       本体名 + (・夜 | ・深) ※ 早朝専用コードは存在せず「・夜」が早朝も兼ねる
 *   どれにも該当しなければ "日中" を返す (≒ 通常時間帯)。
 */
function parseServiceTimeZone(name: string): TimeZone {
  // 障害 prefix
  const prefix = name.match(/^(?:身体|家事|通院|乗降|重訪|行援|同行|重包)(日|早|夜|深)/);
  if (prefix) {
    switch (prefix[1]) {
      case "日": return "日中";
      case "早": return "早朝";
      case "夜": return "夜間";
      case "深": return "深夜";
    }
  }
  // 介護 suffix (深 を先にチェック)
  if (name.includes("・深")) return "深夜";
  if (name.includes("・夜")) return "夜間";
  return "日中";
}

/**
 * slot の時間帯と service の時間帯が一致するか。
 * 介護保険・総合事業は「早朝専用コード」がなく早朝も「・夜」コードを使うため、
 * 早朝 slot → 夜間 サービス への match を許容する。障害福祉は 4 区分独立。
 */
function timeZoneMatches(slot: TimeZone, svc: TimeZone, system: "介護" | "障害" | "総合事業"): boolean {
  if (slot === svc) return true;
  if (system !== "障害" && slot === "早朝" && svc === "夜間") return true;
  return false;
}

// ─── Category definitions ─────────────────────────────────────────────────────

const CATEGORIES = [
  { code: "11", name: "訪問介護" },
  { code: "13", name: "訪問看護" },
  { code: "14", name: "訪問リハ" },
  { code: "15", name: "通所介護" },
  { code: "16", name: "通所リハ" },
  { code: "17", name: "福祉用具貸与" },
  { code: "21", name: "短期入所" },
  { code: "43", name: "居宅介護支援" },
] as const

// ─── Component ────────────────────────────────────────────────────────────────

// 外側 wrapper: open=false 時は null を返して内側を unmount。
// → 内側 state (query / activeCategory) は次の open で fresh init される (reset effect 不要)
export function ServiceSelector(props: ServiceSelectorProps) {
  if (!props.open) return null
  return <ServiceSelectorInner {...props} />
}

function ServiceSelectorInner({ onClose, onSelect, system = "介護", startTime, endTime }: Omit<ServiceSelectorProps, "open">) {
  const [services, setServices] = React.useState<ServiceCode[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeCategory, setActiveCategory] = React.useState<string>(CATEGORIES[0].code)
  const [query, setQuery] = React.useState("")
  // 「候補のみ」: 時間範囲が指定されたときだけ意味を持つ。デフォルトは ON にして
  // よくある使い方 (「この時間枠で取れるサービス何？」) を素直に満たす。
  const durationMinutes = React.useMemo(() => calcDurationMinutes(startTime, endTime), [startTime, endTime])
  const [candidateOnly, setCandidateOnly] = React.useState<boolean>(durationMinutes !== null)
  // start/end が変わるたびに「該当時間が定義された場合は候補モードを ON 復帰」
  React.useEffect(() => {
    if (durationMinutes !== null) setCandidateOnly(true)
  }, [durationMinutes])

  // ── Fetch on mount (modal-on-click pattern: open になった瞬間にこの component が mount) ──
  React.useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setLoading(true)
    setError(null)

    async function fetchServices() {
      try {
        const supabase = createClient()
        // 介護 / 障害 / 総合事業 の同居テーブル → system でフィルタ必須
        //   さもないと service_category=11 が介護(訪問介護) と 障害(居宅介護) で重複表示される
        // 有効期間: 今日時点で有効なコードのみ (valid_until=NULL は無期限有効)
        const today = new Date().toISOString().slice(0, 10)
        const { data, error: fetchError } = await supabase
          .from("kaigo_service_codes")
          .select("service_code, service_name, units, service_category, service_category_name, calculation_type")
          .eq("system", system)
          .lte("valid_from", today)
          .or(`valid_until.is.null,valid_until.gte.${today}`)
          .order("service_code", { ascending: true })

        if (cancelled) return
        if (fetchError) throw fetchError
        setServices(((data ?? []) as Record<string, unknown>[]).map((d) => ({
          code: String(d.service_code ?? ""),
          name: String(d.service_name ?? ""),
          units: Number(d.units ?? 0),
          category: String(d.service_category ?? ""),
          category_name: String(d.service_category_name ?? ""),
          type: String(d.calculation_type ?? "基本"),
        })))
      } catch (err) {
        if (!cancelled) setError("サービスコードの取得に失敗しました。")
        console.error(err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchServices()
    return () => { cancelled = true }
  }, [system])

  // ── Escape key ───────────────────────────────────────────────────────────────
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // ── Body scroll lock ─────────────────────────────────────────────────────────
  React.useEffect(() => {
    document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = "" }
  }, [])

  // 開始時刻 → 時間帯 (日中/早朝/夜間/深夜)
  const slotZone = React.useMemo(() => classifyStartTimeZone(startTime), [startTime])

  // ── Filtered list ────────────────────────────────────────────────────────────
  const filtered = React.useMemo(() => {
    const lowerQuery = query.toLowerCase()
    // 福祉用具貸与 (17) は時間帯/所要時間の概念なし → candidate filter 適用しない
    const hasTimeConcept = activeCategory !== "17"
    const applyCandidate = candidateOnly && durationMinutes !== null && hasTimeConcept
    return services.filter((s) => {
      const matchCategory = s.category === activeCategory
      if (!matchCategory) return false
      if (applyCandidate) {
        // 1) 所要時間レンジで絞る
        const range = parseServiceDurationMinutes(s.name)
        if (!range) return false
        if (durationMinutes < range.min || durationMinutes >= range.max) return false
        // 2) 時間帯 (夜/深/早朝/日中) で絞る
        if (slotZone) {
          const svcZone = parseServiceTimeZone(s.name)
          if (!timeZoneMatches(slotZone, svcZone, system)) return false
        }
      }
      if (!lowerQuery) return true
      return (
        s.code.toLowerCase().includes(lowerQuery) ||
        s.name.toLowerCase().includes(lowerQuery)
      )
    })
  }, [services, activeCategory, query, candidateOnly, durationMinutes, slotZone, system])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-50 bg-black/60"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="サービスコード選択"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex flex-col bg-white rounded-lg shadow-xl max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <h2 className="text-base font-semibold text-gray-900">サービスコード選択</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Category tabs */}
        <div className="shrink-0 overflow-x-auto border-b bg-gray-50">
          <div className="flex gap-1 px-3 py-2 min-w-max">
            {CATEGORIES.map(({ code, name }) => (
              <button
                key={code}
                type="button"
                onClick={() => {
                  setActiveCategory(code)
                  setQuery("")
                }}
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  activeCategory === code
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-600 hover:bg-gray-200 hover:text-gray-900"
                )}
              >
                {name}
                <span className={cn(
                  "ml-1 text-xs",
                  activeCategory === code ? "text-blue-100" : "text-gray-400"
                )}>
                  ({code})
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="shrink-0 px-4 py-3 border-b space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="サービス名またはコードで検索..."
              className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {durationMinutes !== null && (
            <label className="flex items-center gap-2 text-sm text-gray-700 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={candidateOnly}
                onChange={(e) => setCandidateOnly(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              候補のみ表示
              <span className="text-xs text-gray-500">
                ({startTime}〜{endTime} = {durationMinutes}分
                {slotZone && (
                  <>
                    {" / "}
                    <span className={cn(
                      "font-medium",
                      slotZone === "深夜" ? "text-indigo-600" :
                      slotZone === "夜間" ? "text-purple-600" :
                      slotZone === "早朝" ? "text-amber-600" : "text-gray-600"
                    )}>
                      {slotZone}帯
                    </span>
                  </>
                )}
                )
              </span>
            </label>
          )}
        </div>

        {/* Service list */}
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: "400px" }}>
          {loading && (
            <div className="flex items-center justify-center py-12 text-sm text-gray-500">
              読み込み中...
            </div>
          )}

          {error && !loading && (
            <div className="flex items-center justify-center py-12 text-sm text-red-500">
              {error}
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div className="flex items-center justify-center py-12 text-sm text-gray-400">
              該当するサービスコードが見つかりません。
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 w-28">
                    サービスコード
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    サービス名称
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 w-24">
                    単位数
                  </th>
                  <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 w-16">
                    区分
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((service) => (
                  <ServiceRow
                    key={service.code}
                    service={service}
                    onSelect={() => {
                      onSelect({
                        code: service.code,
                        name: service.name,
                        units: service.units,
                        category: service.category,
                        categoryName: service.category_name,
                      })
                      onClose()
                    }}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t bg-gray-50">
          <span className="text-xs text-gray-400">
            {!loading && !error ? `${filtered.length} 件` : ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </>
  )
}

// ─── Service row (memoized) ────────────────────────────────────────────────────

interface ServiceRowProps {
  service: ServiceCode
  onSelect: () => void
}

const ServiceRow = React.memo(function ServiceRow({ service, onSelect }: ServiceRowProps) {
  const isKihon = service.type === "基本"

  return (
    <tr
      onClick={onSelect}
      className="cursor-pointer hover:bg-blue-50 transition-colors"
    >
      <td className="px-4 py-2.5">
        <span className="font-mono text-xs tracking-wider text-gray-700">
          {service.code}
        </span>
      </td>
      <td className="px-4 py-2.5 text-gray-900 text-sm leading-snug">
        {service.name}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        <span className="text-gray-900 font-medium">{service.units.toLocaleString()}</span>
        <span className="text-gray-400 text-xs ml-0.5">単位</span>
      </td>
      <td className="px-4 py-2.5 text-center">
        <Badge
          variant={isKihon ? "default" : "secondary"}
          className={cn(
            "text-xs",
            isKihon
              ? "bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-100"
              : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-50"
          )}
        >
          {service.type || "—"}
        </Badge>
      </td>
    </tr>
  )
})
