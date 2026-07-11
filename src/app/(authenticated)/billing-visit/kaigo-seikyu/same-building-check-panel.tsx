"use client";

/**
 * 同一建物減算チェック パネル (介護請求画面のツールバーから開くモーダル)
 *
 * clients.address の正規化グルーピングで「同一建物らしき集団」を推定し、
 * client_office_assignments.same_building_tier の手動設定と突合する。
 * 提案・警告のみで自動書換はしない (設定変更はサービス提供表画面へリンク)。
 * 制度要件・判定ロジックは src/lib/visit-seikyu/same-building-check.ts 参照。
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Building2, ExternalLink, Loader2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  SAME_BUILDING_REDUCTION,
  type SameBuildingTier,
} from "@/lib/visit-seikyu/same-building";
import {
  runSameBuildingCheck,
  type BuildingMember,
  type SameBuildingCheckResult,
} from "@/lib/visit-seikyu/same-building-check";

const tierLabel = (t: SameBuildingTier | null) =>
  t === null ? "未設定" : SAME_BUILDING_REDUCTION[t].label;

const tierBadgeClass = (t: SameBuildingTier | null) =>
  t === null
    ? "bg-gray-100 text-gray-500"
    : t === "2"
    ? "bg-red-100 text-red-700"
    : t === "3"
    ? "bg-orange-100 text-orange-700"
    : "bg-amber-100 text-amber-700";

function MemberChip({
  m,
  officeId,
}: {
  m: BuildingMember;
  officeId: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 border border-gray-200 rounded bg-white px-1.5 py-0.5">
      <span className="text-gray-800">{m.name}</span>
      <span
        title={tierLabel(m.tier)}
        className={`rounded px-1 text-[10px] font-bold ${tierBadgeClass(m.tier)}`}
      >
        {m.tier === null ? "未設定" : `減算${m.tier}`}
      </span>
      <Link
        href={`/provision-tickets?user=${m.clientId}&office=${officeId}`}
        title="サービス提供表で同一建物減算区分を設定する"
        className="text-indigo-500 hover:text-indigo-700"
      >
        <ExternalLink size={11} />
      </Link>
    </span>
  );
}

export function SameBuildingCheckPanel({
  officeId,
  year,
  month,
  monthUserIds,
  onClose,
}: {
  officeId: string;
  year: number;
  month: number;
  monthUserIds: string[];
  onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [result, setResult] = useState<SameBuildingCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await runSameBuildingCheck(supabase, {
          officeId,
          year,
          month,
          monthUserIds,
        });
        if (!cancelled) setResult(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, officeId, year, month, monthUserIds]);

  const ratioPct = result ? (result.tier3.ratio * 100).toFixed(1) : null;
  const ratioHigh = (result?.tier3.ratio ?? 0) >= 0.9;

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4 print:hidden">
      <div className="bg-white rounded shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col text-[12px]">
        {/* ヘッダー */}
        <div className="border-b border-sky-700 bg-gradient-to-b from-sky-500 to-sky-600 px-3 py-1.5 text-xs font-bold text-white flex items-center gap-2 rounded-t">
          <Building2 size={14} />
          <span>
            同一建物減算チェック — R{year - 2018}/{month} (当月実利用者{" "}
            {monthUserIds.length} 人)
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-sky-100 hover:text-white"
            title="閉じる"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-gray-500">
              <Loader2 size={18} className="animate-spin text-indigo-400" />
              住所グルーピングと前 6 月実績を突合しています…
            </div>
          )}
          {error && (
            <div className="border border-red-200 bg-red-50 rounded px-3 py-2 flex items-start gap-2 text-red-700">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              チェックに失敗しました: {error}
            </div>
          )}

          {!loading && !error && result && (
            <>
              {/* 警告まとめ */}
              {result.warnings.length > 0 && (
                <div className="border border-amber-300 bg-amber-50 rounded px-3 py-2 space-y-0.5 text-amber-800">
                  {result.warnings.map((w) => (
                    <p key={w} className="flex items-start gap-1.5">
                      <AlertCircle size={13} className="mt-0.5 shrink-0" />
                      <span>{w}</span>
                    </p>
                  ))}
                </div>
              )}
              {result.warnings.length === 0 && (
                <div className="border border-emerald-200 bg-emerald-50 rounded px-3 py-2 text-emerald-700">
                  設定と実態の明らかな不整合は見つかりませんでした
                  (下記の推定結果もあわせて確認してください)。
                </div>
              )}

              {/* 減算3 (90% ルール) */}
              <div className="border border-gray-300 rounded">
                <div className="bg-sky-100 border-b border-gray-300 px-2 py-1 font-bold text-gray-700">
                  減算3 (12%) — 同一建物等居住者 90% 以上の判定
                </div>
                <div className="px-3 py-2 space-y-1 text-gray-700">
                  <p>{result.tier3.periodLabel}</p>
                  <p>
                    判定期間の実利用者{" "}
                    <span className="font-mono">{result.tier3.totalUsers}</span> 人中、
                    同一建物等居住者 (減算1/2 設定者){" "}
                    <span className="font-mono">{result.tier3.sameBuildingUsers}</span> 人 ={" "}
                    <span
                      className={`font-mono font-bold ${
                        ratioHigh ? "text-red-600" : "text-emerald-700"
                      }`}
                    >
                      {ratioPct}%
                    </span>
                    {ratioHigh ? " (90% 以上 — 減算3 の対象になりえます)" : " (90% 未満)"}
                  </p>
                  {result.tier3.avgMonthlyVisits !== null && (
                    <p className="text-gray-500">
                      判定期間の月平均延べ訪問回数: 約{" "}
                      {result.tier3.avgMonthlyVisits.toLocaleString()} 回
                    </p>
                  )}
                  {result.tier3.shouldBeTier3.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      <span className="text-red-600 font-bold w-full">
                        減算3 (12%) への変更を確認:
                      </span>
                      {result.tier3.shouldBeTier3.map((m) => (
                        <MemberChip key={m.clientId} m={m} officeId={officeId} />
                      ))}
                    </div>
                  )}
                  {result.tier3.staleTier3.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      <span className="text-red-600 font-bold w-full">
                        減算3 (12%) の見直しを確認 (割合 90% 未満):
                      </span>
                      {result.tier3.staleTier3.map((m) => (
                        <MemberChip key={m.clientId} m={m} officeId={officeId} />
                      ))}
                    </div>
                  )}
                  {result.tier3.notes.map((n) => (
                    <p key={n} className="text-gray-500">
                      ※ {n}
                    </p>
                  ))}
                </div>
              </div>

              {/* 建物グループ */}
              <div className="border border-gray-300 rounded">
                <div className="bg-sky-100 border-b border-gray-300 px-2 py-1 font-bold text-gray-700">
                  同一建物らしき集団 (当月利用者の住所グルーピング)
                </div>
                {result.groups.length === 0 ? (
                  <p className="px-3 py-3 text-gray-400">
                    同一住所 (正規化後) の利用者集団はありません。
                  </p>
                ) : (
                  <div className="divide-y divide-gray-200">
                    {result.groups.map((g) => (
                      <div key={g.key} className="px-3 py-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-gray-800">
                            {g.displayAddress}
                          </span>
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">
                            当月 {g.members.length} 人
                          </span>
                          {g.inconsistent && (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                              設定不一致
                            </span>
                          )}
                          {g.suggestion && (
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-bold text-orange-700">
                              減算{g.suggestion.tier} を確認
                            </span>
                          )}
                        </div>
                        {g.suggestion && (
                          <p className="text-orange-700 mt-0.5">{g.suggestion.reason}</p>
                        )}
                        <div className="flex flex-wrap gap-1 mt-1">
                          {g.members.map((m) => (
                            <MemberChip key={m.clientId} m={m} officeId={officeId} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 住所未登録 */}
              {result.noAddressMembers.length > 0 && (
                <div className="border border-gray-300 rounded">
                  <div className="bg-sky-100 border-b border-gray-300 px-2 py-1 font-bold text-gray-700">
                    住所未登録 (建物推定の対象外)
                  </div>
                  <div className="px-3 py-2 flex flex-wrap gap-1">
                    {result.noAddressMembers.map((m) => (
                      <MemberChip key={m.clientId} m={m} officeId={officeId} />
                    ))}
                  </div>
                </div>
              )}

              {/* 免責・注記 */}
              <div className="text-gray-500 space-y-0.5">
                <p>
                  ※ 住所文字列の単純な正規化 (全角半角・空白・ハイフン・末尾号室) による推定です。
                  表記ゆれ (漢数字・建物名の省略等) で別グループになる / 番地が同じ別建物を
                  同一と誤推定することがあります。
                </p>
                <p>
                  ※ 事業所と同一敷地内・隣接する建物 (減算1・人数不問) かどうかは住所からは
                  判定できません。減算2 (50 人以上) の正確な判定は日ごと平均 (小数点以下切捨て)、
                  減算3 は届出 (前期 9/15・後期 3/15 まで) と「正当な理由」の確認が必要です。
                </p>
                <p>
                  ※ このチェックは提案・警告のみで設定の自動変更はしません。変更は各利用者の
                  サービス提供表画面 (リンク先) の「同一建物減算」セレクタで行ってください。
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
