"use client";

// 公表データ (care_offices_opendata) 検索パネル
// - master/care-offices と master/providers の新規登録フォームで共用
// - <form> の中に置かれる場合があるため、button は全て type="button"、
//   input の Enter は preventDefault して検索を実行する (親 form の submit を防ぐ)

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Search, Loader2, Database } from "lucide-react";
import { searchOpendataOffices, type OpendataOffice } from "./partner-companies";

export function OpendataSearch({
  serviceType,
  onSelect,
  emptyMessage = "該当する事業所が見つかりません",
}: {
  /** opendata の service_type フィルタ (eq: 限定 / neq: 除外) */
  serviceType: { eq?: string; neq?: string };
  onSelect: (office: OpendataOffice) => void;
  /** 検索 0 件時のメッセージ */
  emptyMessage?: string;
}) {
  const supabase = createClient();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpendataOffice[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [missingSchema, setMissingSchema] = useState(false);

  const handleSearch = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    try {
      const { rows, missingSchema: missing, error } = await searchOpendataOffices(
        supabase,
        query,
        serviceType,
      );
      if (error) {
        console.error("care_offices_opendata search failed:", error);
        toast.error(`公表データの検索に失敗しました: ${error}`);
        return;
      }
      setMissingSchema(missing);
      setResults(rows);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-700">
        <Database size={13} className="text-blue-500" />
        公表データから検索 (厚労省 介護サービス情報公表システム)
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSearch();
            }
          }}
          className="flex-1 rounded-lg border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="事業所名 または 事業所番号で検索"
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 transition-colors"
        >
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          検索
        </button>
      </div>

      {missingSchema && (
        <p className="mt-2 text-xs text-amber-600">
          公表データが未取込のため検索できません。手入力で登録してください。
        </p>
      )}

      {searched && !missingSchema && results.length === 0 && (
        <p className="mt-2 text-xs text-gray-500">{emptyMessage}</p>
      )}

      {results.length > 0 && (
        <ul className="mt-2 max-h-60 divide-y overflow-y-auto rounded-lg border">
          {results.map((r) => (
            <li key={`${r.office_number}-${r.service_type ?? ""}`}>
              <button
                type="button"
                onClick={() => onSelect(r)}
                className="w-full px-3 py-2 text-left hover:bg-blue-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800">{r.name}</span>
                  {r.service_type && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                      {r.service_type}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  <span className="font-mono">{r.office_number}</span>
                  {r.corp_name && <span className="ml-2">{r.corp_name}</span>}
                  {r.address && <span className="ml-2">{r.address}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
