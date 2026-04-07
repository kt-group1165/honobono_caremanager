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

export function ServiceSelector({ open, onClose, onSelect }: ServiceSelectorProps) {
  const [services, setServices] = React.useState<ServiceCode[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [activeCategory, setActiveCategory] = React.useState<string>(CATEGORIES[0].code)
  const [query, setQuery] = React.useState("")

  // ── Fetch on open ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!open) return

    let cancelled = false
    setLoading(true)
    setError(null)

    async function fetchServices() {
      try {
        const supabase = createClient()
        const { data, error: fetchError } = await supabase
          .from("kaigo_service_codes")
          .select("service_code, service_name, units, service_category, service_category_name, calculation_type")
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
  }, [open])

  // ── Reset state when closed ──────────────────────────────────────────────────
  React.useEffect(() => {
    if (!open) {
      setQuery("")
      setActiveCategory(CATEGORIES[0].code)
    }
  }, [open])

  // ── Escape key ───────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose])

  // ── Body scroll lock ─────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (open) document.body.style.overflow = "hidden"
    return () => { document.body.style.overflow = "" }
  }, [open])

  // ── Filtered list ────────────────────────────────────────────────────────────
  const filtered = React.useMemo(() => {
    const lowerQuery = query.toLowerCase()
    return services.filter((s) => {
      const matchCategory = s.category === activeCategory
      if (!matchCategory) return false
      if (!lowerQuery) return true
      return (
        s.code.toLowerCase().includes(lowerQuery) ||
        s.name.toLowerCase().includes(lowerQuery)
      )
    })
  }, [services, activeCategory, query])

  if (!open) return null

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
        <div className="shrink-0 px-4 py-3 border-b">
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
