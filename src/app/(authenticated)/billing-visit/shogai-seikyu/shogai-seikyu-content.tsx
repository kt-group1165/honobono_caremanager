"use client";

/**
 * 障害請求 — 障害福祉サービスの月次請求集計 + 国保連 CSV
 *
 * 左: 利用者一覧 (受給者証番号 / 名前 / 区分 / 総単位数 / 給付費請求額 / 負担額)
 * 右: 明細 (サービス種類 / コード / 単位数 / 回数)
 * 出力: 国保連請求 CSV (J121 明細書 相当の項目)
 */

import { useMemo, useState, useEffect, useCallback } from "react";
import { Loader2, Accessibility, AlertCircle, Download, FileDown } from "lucide-react";
import Encoding from "encoding-japanese";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { MonthNav } from "../_shared/month-nav";
import {
  aggregateMonthlyShogaiSeikyu,
  buildShogaiSeikyuCsv,
  type ShogaiSeikyuRow,
} from "@/lib/shogai-seikyu/aggregate";
import {
  buildShogaiDensou,
  type ShogaiDensouUser,
  type ShogaiDensouVisit,
  type ShogaiDensouKanriLine,
} from "@/lib/shogai-densou/build";

export function ShogaiSeikyuContent() {
  const supabase = useMemo(() => createClient(), []);
  const { currentOffice, loading: btLoading } = useBusinessType();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState<ShogaiSeikyuRow[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let unitPrice: number | undefined;
      if (currentOffice) {
        const { data: o } = await supabase
          .from("offices")
          .select("unit_price")
          .eq("id", currentOffice.id)
          .maybeSingle();
        unitPrice = (o as { unit_price?: number } | null)?.unit_price;
      }
      const result = await aggregateMonthlyShogaiSeikyu(supabase, {
        year,
        month,
        unitPrice,
      });
      setRows(result.rows);
      setRecordCount(result.recordCount);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOffice, year, month]);

  useEffect(() => {
    if (btLoading) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount/月変更時の fetch
    load();
  }, [btLoading, load]);

  const selected = rows.find((r) => r.user_id === selectedUserId) ?? rows[0] ?? null;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalBenefit = rows.reduce((s, r) => s + r.benefitAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);

  const exportCsv = () => {
    const csv = buildShogaiSeikyuCsv(rows, year, month);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shogai_seikyu_${year}${String(month).padStart(2, "0")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ─── 電子請求受付システム向け 伝送ファイル (J11 / J61 / J41) ────────────────
  const [densouLoading, setDensouLoading] = useState(false);

  const downloadSjis = (f: { content: string; fileName: string }) => {
    const sjis = Encoding.convert(Encoding.stringToCode(f.content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = f.fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleDensouExport = async () => {
    if (rows.length === 0) return;
    setDensouLoading(true);
    try {
      // 1) 事業所番号・単価・地域区分
      const { data: o, error: oe } = await supabase
        .from("offices")
        .select("business_number, unit_price, area_category")
        .eq("id", currentOffice?.id ?? "")
        .maybeSingle();
      if (oe) throw new Error("事業所情報取得失敗: " + oe.message);
      const officeNumber = ((o?.business_number ?? "") as string).trim();
      const unitPrice = (o?.unit_price ?? 10) as number;
      const areaCategory = (o?.area_category ?? null) as string | null;

      // 2) 月内の確定実績 (実績記録票 J611 用の明細)
      const monthStr = `${year}-${String(month).padStart(2, "0")}`;
      const daysInMonth = new Date(year, month, 0).getDate();
      const visitsByClient = new Map<string, ShogaiDensouVisit[]>();
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("shogai_service_records")
          .select(
            "client_id, service_date, start_time, end_time, duration_minutes, service_category, service_code",
          )
          .eq("status", "confirmed")
          .gte("service_date", `${monthStr}-01`)
          .lte("service_date", `${monthStr}-${String(daysInMonth).padStart(2, "0")}`)
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error("実績取得失敗: " + error.message);
        const recs = (data ?? []) as {
          client_id: string;
          service_date: string;
          start_time: string | null;
          end_time: string | null;
          duration_minutes: number | null;
          service_category: string | null;
          service_code: string | null;
        }[];
        for (const rec of recs) {
          if (!visitsByClient.has(rec.client_id)) visitsByClient.set(rec.client_id, []);
          visitsByClient.get(rec.client_id)!.push({
            date: rec.service_date,
            startTime: rec.start_time,
            endTime: rec.end_time,
            durationMinutes: rec.duration_minutes,
            category: rec.service_category,
            serviceCode: rec.service_code,
          });
        }
        if (recs.length < PAGE) break;
        offset += PAGE;
      }

      // 3) 受給者証の契約支給量 (契約情報レコード J121-05 用)
      const ids = rows.map((r) => r.user_id);
      const contractByClient = new Map<
        string,
        { text: string | null; start: string | null; entry: string | null }
      >();
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const { data, error } = await supabase
          .from("shougai_certifications")
          .select(
            "client_id, contract_amount_text, contract_start_date, contract_entry_number, certification_start_date",
          )
          .in("client_id", chunk)
          .order("certification_start_date", { ascending: false });
        if (error) throw new Error("受給者証取得失敗: " + error.message);
        for (const c of (data ?? []) as {
          client_id: string;
          contract_amount_text: string | null;
          contract_start_date: string | null;
          contract_entry_number: string | null;
        }[]) {
          if (!contractByClient.has(c.client_id)) {
            contractByClient.set(c.client_id, {
              text: c.contract_amount_text,
              start: c.contract_start_date,
              entry: c.contract_entry_number,
            });
          }
        }
      }

      // 4) 自事業所上限管理の関係事業所一覧 (上限管理結果票 J411 用)
      const selfIds = rows
        .filter((r) => r.jogenKanriKubun === "自事業所")
        .map((r) => r.user_id);
      const linesByClient = new Map<string, ShogaiDensouKanriLine[]>();
      if (selfIds.length > 0) {
        const { data, error } = await supabase
          .from("shogai_jogen_kanri_results")
          .select("client_id, office_lines")
          .eq("target_month", monthStr)
          .in("client_id", selfIds);
        if (error) throw new Error("上限管理結果取得失敗: " + error.message);
        for (const k of (data ?? []) as {
          client_id: string;
          office_lines: ShogaiDensouKanriLine[];
        }[]) {
          if (Array.isArray(k.office_lines) && k.office_lines.length > 0) {
            linesByClient.set(k.client_id, k.office_lines);
          }
        }
      }

      // 5) 組み立て → 生成 → ダウンロード
      const users: ShogaiDensouUser[] = rows.map((r) => {
        const contract = contractByClient.get(r.user_id);
        return {
          row: r,
          visits: visitsByClient.get(r.user_id) ?? [],
          contractAmountText: contract?.text ?? null,
          contractStartDate: contract?.start ?? null,
          contractEntryNumber: contract?.entry ?? null,
          jogenOfficeLines: linesByClient.get(r.user_id) ?? null,
        };
      });
      const result = buildShogaiDensou(users, {
        officeNumber,
        year,
        month,
        unitPrice,
        areaCategory,
      });
      if (result.warnings.length > 0) {
        const ok = window.confirm(
          "以下の確認事項があります:\n\n・" +
            result.warnings.join("\n・") +
            "\n\nこのまま出力しますか？",
        );
        if (!ok) return;
      }
      downloadSjis(result.seikyuFile);
      downloadSjis(result.jissekiFile);
      if (result.jogenFile) downloadSjis(result.jogenFile);
    } catch (e) {
      alert(
        "伝送ファイルの生成に失敗しました: " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setDensouLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Accessibility size={20} className="text-violet-600" />
            障害請求
          </h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {currentOffice?.name ?? ""} — 障害福祉サービス実績 (確定) の月次集計と国保連請求 CSV
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MonthNav
            year={year}
            month={month}
            onChange={(y, m) => {
              setYear(y);
              setMonth(m);
            }}
          />
          <button
            type="button"
            disabled={rows.length === 0}
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
            title="内容確認用の明細 CSV を出力"
          >
            <Download size={14} />
            確認用CSV
          </button>
          <button
            type="button"
            disabled={rows.length === 0 || densouLoading}
            onClick={handleDensouExport}
            className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            title="電子請求受付システム向け伝送ファイル (請求書・明細書 J11 / 実績記録票 J61 / 上限管理結果票 J41) を出力"
          >
            {densouLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <FileDown size={14} />
            )}
            伝送ファイル
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading || btLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 size={20} className="mr-2 animate-spin" />
          集計中...
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-gray-50 p-12 text-center text-sm text-gray-500">
          対象月の実績 (確定) がありません。障害福祉 → サービス提供実績 で記録を確定してください。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* 左: 利用者一覧 */}
          <div className="lg:col-span-3 overflow-hidden rounded-lg border bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-600">
                <tr>
                  <th className="px-3 py-2">受給者証番号</th>
                  <th className="px-3 py-2">利用者名</th>
                  <th className="px-3 py-2">区分</th>
                  <th className="px-3 py-2 text-right">総単位数</th>
                  <th className="px-3 py-2 text-right">給付費請求額</th>
                  <th className="px-3 py-2 text-right">利用者負担</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr
                    key={r.user_id}
                    onClick={() => setSelectedUserId(r.user_id)}
                    className={
                      "cursor-pointer transition-colors " +
                      (selected?.user_id === r.user_id
                        ? "bg-violet-50"
                        : "hover:bg-gray-50")
                    }
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.beneficiary_number ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {r.user_name}
                      {r.seiho && (
                        <span className="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[9px] text-amber-700 ring-1 ring-amber-200">
                          生保
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{r.support_level ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.totalUnits.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-violet-700">
                      {r.benefitAmount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.userAmount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-300 bg-gray-50 font-bold">
                <tr>
                  <td className="px-3 py-2 text-xs text-gray-500" colSpan={3}>
                    合計 {rows.length} 名 / 実績 {recordCount} 件
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totalUnits.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-violet-700">
                    {totalBenefit.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {totalUser.toLocaleString()}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* 右: 明細 */}
          <div className="lg:col-span-2 rounded-lg border bg-white shadow-sm">
            <header className="border-b bg-gray-50 px-4 py-2 text-sm font-bold text-gray-800">
              明細情報 {selected ? `— ${selected.user_name}` : ""}
            </header>
            {selected ? (
              <div className="p-3">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-[10px] text-gray-500">
                    <tr>
                      <th className="px-2 py-1">サービス</th>
                      <th className="px-2 py-1">コード</th>
                      <th className="px-2 py-1 text-right">単位数</th>
                      <th className="px-2 py-1 text-right">回数</th>
                      <th className="px-2 py-1 text-right">小計</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selected.details.map((d, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1.5">
                          {d.service_type}
                          {d.service_category && (
                            <span className="ml-1 text-[9px] text-gray-400">
                              {d.service_category}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[10px]">
                          {d.service_code ?? "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {d.unit_per.toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{d.count}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                          {d.units.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="mt-4 space-y-1 rounded border bg-gray-50 p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">合計単位数</span>
                    <span className="font-bold tabular-nums">
                      {selected.totalUnits.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">地域単価</span>
                    <span className="tabular-nums">
                      {selected.unitPrice.toFixed(2)} 円/単位
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">総費用額</span>
                    <span className="tabular-nums">
                      ¥{selected.totalAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">
                      負担上限月額 {selected.seiho ? "(生保 = 負担なし)" : ""}
                    </span>
                    <span className="tabular-nums">
                      ¥{selected.self_payment_limit.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">利用者負担額</span>
                    <span className="font-bold tabular-nums">
                      ¥{selected.userAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between text-violet-700">
                    <span className="font-bold">介護給付費請求額</span>
                    <span className="font-bold tabular-nums">
                      ¥{selected.benefitAmount.toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* 上限額管理 (ほのぼのmore 上限管理事業所の登録に相当) */}
                <JogenKanriSection
                  key={`${selected.user_id}-${year}-${month}`}
                  row={selected}
                  year={year}
                  month={month}
                  onSaved={load}
                />
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-gray-400">
                左の一覧から利用者を選択
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-[11px] text-gray-400">
        ※ 「請求CSV」は国保連 介護給付費・訓練等給付費等明細書 (J121) 相当の項目を
        持つ明細 CSV。伝送ソフトの固定長 interface 仕様には取込仕様確定後に対応。
        上限管理の設定 (管理事業所の登録) は 利用者管理 → 受給者証 で行います。
      </p>
    </div>
  );
}

// ─── 利用者負担上限額管理 (月次の管理結果入力) ────────────────────────────────
function JogenKanriSection({
  row,
  year,
  month,
  onSaved,
}: {
  row: ShogaiSeikyuRow;
  year: number;
  month: number;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [result, setResult] = useState<string>(row.kanriResult != null ? String(row.kanriResult) : "");
  const [amount, setAmount] = useState<string>(row.kanriResultAmount != null ? String(row.kanriResultAmount) : "");
  const [saving, setSaving] = useState(false);

  if (row.jogenKanriKubun === "なし") {
    return (
      <div className="mt-3 rounded border border-dashed bg-gray-50 px-3 py-2 text-[11px] text-gray-400">
        上限額管理: 対象外 (受給者証で管理事業所を設定すると月次の管理結果を入力できます)
      </div>
    );
  }

  // 自事業所が管理者の場合は調整計算 + 結果票作成 (別コンポーネント)
  if (row.jogenKanriKubun === "自事業所") {
    return <JogenKanriSelfSection row={row} year={year} month={month} onSaved={onSaved} />;
  }

  const save = async () => {
    setSaving(true);
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;
    const { error } = await supabase.from("shogai_jogen_kanri_results").upsert(
      {
        client_id: row.user_id,
        target_month: monthStr,
        kanri_result: result ? parseInt(result, 10) : null,
        kanri_result_amount: amount !== "" ? parseInt(amount, 10) : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    setSaving(false);
    if (error) {
      alert("上限管理結果の保存に失敗しました: " + error.message);
      return;
    }
    onSaved();
  };

  return (
    <div className="mt-3 rounded border border-violet-200 bg-violet-50/50 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-bold text-violet-800">利用者負担上限額管理</span>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
          {row.jogenKanriKubun}が管理
        </span>
      </div>
      {row.jogenKanriKubun === "他事業所" && (
        <p className="text-[10px] text-gray-500">
          管理事業所: {row.jogenKanriOfficeName ?? "未設定"}
          {row.jogenKanriOfficeNumber ? ` (${row.jogenKanriOfficeNumber})` : ""}
          — 管理結果票を受領したら下に入力してください
        </p>
      )}
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">管理結果区分</label>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-xs focus:border-violet-500 focus:outline-none"
          >
            <option value="">未入力</option>
            <option value="1">1: 管理事業所で充当 (他は負担なし)</option>
            <option value="2">2: 合算が上限以下 (調整なし)</option>
            <option value="3">3: 管理結果票のとおり調整</option>
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-gray-500">調整後負担額</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={result === "2" || result === ""}
            placeholder="円"
            className="w-24 rounded border px-2 py-1.5 text-right text-xs tabular-nums focus:border-violet-500 focus:outline-none disabled:bg-gray-100"
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
      <p className="text-[10px] text-gray-400">
        区分 1・3 は調整後負担額が利用者負担額・給付費請求額に反映されます。
      </p>
    </div>
  );
}

// ─── 自事業所が上限管理者の場合: 調整計算 + 結果票 (上限管理編 3-1/3-2) ────────
interface KanriOfficeLine {
  office_number: string;
  office_name: string;
  total_amount: number;
  user_amount: number;
  adjusted_amount: number;
  is_self: boolean;
}

function JogenKanriSelfSection({
  row,
  year,
  month,
  onSaved,
}: {
  row: ShogaiSeikyuRow;
  year: number;
  month: number;
  onSaved: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const limit = row.self_payment_limit;
  // 調整前の自事業所 利用者負担 (上限管理結果の反映前の値を再計算)
  const selfPre = row.seiho
    ? 0
    : Math.min(Math.floor(row.totalAmount * 0.1), limit > 0 ? limit : Number.MAX_SAFE_INTEGER);

  const [lines, setLines] = useState<KanriOfficeLine[]>([]);
  const [result, setResult] = useState<number | null>(row.kanriResult);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [newNo, setNewNo] = useState("");
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newTotal, setNewTotal] = useState("");

  // 保存済みの関係事業所一覧を読み込み (無ければ自事業所行のみで初期化)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("shogai_jogen_kanri_results")
        .select("office_lines, kanri_result")
        .eq("client_id", row.user_id)
        .eq("target_month", monthStr)
        .maybeSingle();
      if (cancelled) return;
      const saved = ((data?.office_lines ?? []) as KanriOfficeLine[]) ?? [];
      if (saved.length > 0) {
        // 自事業所行は最新の請求集計値で更新
        setLines(
          saved.map((l) =>
            l.is_self
              ? { ...l, total_amount: row.totalAmount, user_amount: selfPre }
              : l,
          ),
        );
        setResult((data?.kanri_result as number | null) ?? null);
      } else {
        setLines([
          {
            office_number: "",
            office_name: "(自事業所)",
            total_amount: row.totalAmount,
            user_amount: selfPre,
            adjusted_amount: selfPre,
            is_self: true,
          },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 対象 (利用者×月) 切替時のみ再読込
  }, [row.user_id, monthStr]);

  const addLine = () => {
    if (!newName.trim()) {
      alert("事業所名を入力してください");
      return;
    }
    const amt = parseInt(newAmount, 10) || 0;
    const tot = parseInt(newTotal, 10) || 0;
    setLines((prev) => [
      ...prev,
      {
        office_number: newNo.trim(),
        office_name: newName.trim(),
        total_amount: tot,
        user_amount: amt,
        adjusted_amount: amt,
        is_self: false,
      },
    ]);
    setNewNo("");
    setNewName("");
    setNewAmount("");
    setNewTotal("");
  };

  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  // 他事業所行の総費用額をインライン編集 (J411 明細 9 / 管理結果3 で必須)
  const setLineTotal = (i: number, v: string) =>
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, total_amount: parseInt(v, 10) || 0 } : l)),
    );

  // 調整計算: 合算 ≤ 上限 → 区分2 / 超過 → 管理事業所 (自) 優先充当で配分
  const calc = () => {
    const sum = lines.reduce((s, l) => s + l.user_amount, 0);
    if (limit <= 0 || sum <= limit) {
      setLines((prev) => prev.map((l) => ({ ...l, adjusted_amount: l.user_amount })));
      setResult(2);
      return;
    }
    let remain = limit;
    const next = lines.map((l) => ({ ...l }));
    for (const l of next.filter((x) => x.is_self)) {
      l.adjusted_amount = Math.min(l.user_amount, remain);
      remain -= l.adjusted_amount;
    }
    const others = next.filter((x) => !x.is_self).sort((a, b) => b.user_amount - a.user_amount);
    for (const l of others) {
      l.adjusted_amount = Math.min(l.user_amount, remain);
      remain -= l.adjusted_amount;
    }
    setLines(next);
    setResult(others.every((l) => l.adjusted_amount === 0) ? 1 : 3);
  };

  const save = async () => {
    if (result == null) {
      alert("先に「調整計算」を実行してください");
      return;
    }
    setSaving(true);
    const self = lines.find((l) => l.is_self);
    const { error } = await supabase.from("shogai_jogen_kanri_results").upsert(
      {
        client_id: row.user_id,
        target_month: monthStr,
        kanri_result: result,
        kanri_result_amount: self?.adjusted_amount ?? null,
        office_lines: lines,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,target_month" },
    );
    setSaving(false);
    if (error) {
      alert("保存に失敗しました: " + error.message);
      return;
    }
    onSaved();
  };

  const doPrint = () => {
    setPrinting(true);
    setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 100);
  };

  const sumUser = lines.reduce((s, l) => s + l.user_amount, 0);
  const sumAdj = lines.reduce((s, l) => s + l.adjusted_amount, 0);
  const sumTotal = lines.reduce((s, l) => s + l.total_amount, 0);

  return (
    <div className="mt-3 rounded border border-violet-200 bg-violet-50/50 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-bold text-violet-800">利用者負担上限額管理 (当事業所が管理者)</span>
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
          上限月額 ¥{limit.toLocaleString()}
        </span>
      </div>

      <table className="w-full text-[11px]">
        <thead className="text-left text-[10px] text-gray-500">
          <tr>
            <th className="py-0.5">事業所</th>
            <th className="py-0.5 text-right">総費用額</th>
            <th className="py-0.5 text-right">利用者負担額</th>
            <th className="py-0.5 text-right">管理結果後</th>
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-violet-100">
          {lines.map((l, i) => (
            <tr key={i} className={l.is_self ? "font-semibold" : ""}>
              <td className="py-1">
                {l.office_name}
                {l.office_number && (
                  <span className="ml-1 font-mono text-[9px] text-gray-400">{l.office_number}</span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">
                {l.is_self ? (
                  `¥${l.total_amount.toLocaleString()}`
                ) : (
                  <input
                    type="number"
                    value={l.total_amount || ""}
                    onChange={(e) => setLineTotal(i, e.target.value)}
                    placeholder="0"
                    className="w-20 rounded border px-1 py-0.5 text-right tabular-nums focus:border-violet-500 focus:outline-none"
                  />
                )}
              </td>
              <td className="py-1 text-right tabular-nums">¥{l.user_amount.toLocaleString()}</td>
              <td className="py-1 text-right tabular-nums text-violet-700">
                ¥{l.adjusted_amount.toLocaleString()}
              </td>
              <td className="py-1 text-center">
                {!l.is_self && (
                  <button
                    onClick={() => removeLine(i)}
                    className="text-gray-300 hover:text-red-500"
                    title="削除"
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
          <tr className="border-t border-violet-200 font-bold">
            <td className="py-1">合算</td>
            <td className="py-1 text-right tabular-nums">¥{sumTotal.toLocaleString()}</td>
            <td className={`py-1 text-right tabular-nums ${limit > 0 && sumUser > limit ? "text-red-600" : ""}`}>
              ¥{sumUser.toLocaleString()}
            </td>
            <td className="py-1 text-right tabular-nums">¥{sumAdj.toLocaleString()}</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div className="grid grid-cols-[90px_1fr_80px_80px_auto] items-center gap-1.5">
        <input
          value={newNo}
          onChange={(e) => setNewNo(e.target.value)}
          placeholder="事業所番号"
          className="rounded border px-2 py-1.5 font-mono focus:border-violet-500 focus:outline-none"
        />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="関係事業所名"
          className="rounded border px-2 py-1.5 focus:border-violet-500 focus:outline-none"
        />
        <input
          type="number"
          value={newTotal}
          onChange={(e) => setNewTotal(e.target.value)}
          placeholder="総費用額"
          className="rounded border px-2 py-1.5 text-right tabular-nums focus:border-violet-500 focus:outline-none"
        />
        <input
          type="number"
          value={newAmount}
          onChange={(e) => setNewAmount(e.target.value)}
          placeholder="負担額"
          className="rounded border px-2 py-1.5 text-right tabular-nums focus:border-violet-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={addLine}
          className="rounded border border-violet-300 bg-white px-2.5 py-1.5 font-medium text-violet-700 hover:bg-violet-50"
        >
          追加
        </button>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-gray-500">
          {result != null
            ? `管理結果区分: ${result} (${result === 1 ? "管理事業所で充当" : result === 2 ? "調整なし" : "結果票のとおり調整"})`
            : "未計算"}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={calc}
            className="rounded border border-violet-300 bg-white px-3 py-1.5 font-medium text-violet-700 hover:bg-violet-50"
          >
            調整計算
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存 (請求に反映)"}
          </button>
          <button
            type="button"
            onClick={doPrint}
            disabled={result == null}
            className="rounded border border-violet-300 bg-white px-3 py-1.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
          >
            結果票印刷
          </button>
        </div>
      </div>

      {/* 印刷: 利用者負担上限額管理結果票 */}
      {printing && (
        <div className="fixed inset-0 hidden bg-white p-8 text-black print:block">
          <h1 className="mb-4 text-center text-lg font-bold tracking-widest">
            利用者負担上限額管理結果票
          </h1>
          <div className="mb-1 text-right text-xs">
            令和{year - 2018}年{month}月分
          </div>
          <table className="mb-3 w-full border-collapse text-xs">
            <tbody>
              <tr>
                <td className="w-28 border border-black bg-gray-100 px-2 py-1">受給者証番号</td>
                <td className="border border-black px-2 py-1 font-mono">{row.beneficiary_number ?? ""}</td>
                <td className="w-40 border border-black bg-gray-100 px-2 py-1">支給決定障害者等氏名</td>
                <td className="border border-black px-2 py-1">{row.user_name}</td>
              </tr>
              <tr>
                <td className="border border-black bg-gray-100 px-2 py-1">利用者負担上限月額</td>
                <td className="border border-black px-2 py-1 tabular-nums">¥{limit.toLocaleString()}</td>
                <td className="border border-black bg-gray-100 px-2 py-1">管理結果区分</td>
                <td className="border border-black px-2 py-1">{result ?? ""}</td>
              </tr>
            </tbody>
          </table>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-black px-2 py-1">項番</th>
                <th className="border border-black px-2 py-1">事業所番号</th>
                <th className="border border-black px-2 py-1">事業所名称</th>
                <th className="border border-black px-2 py-1 text-right">総費用額</th>
                <th className="border border-black px-2 py-1 text-right">利用者負担額</th>
                <th className="border border-black px-2 py-1 text-right">管理結果後利用者負担額</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="border border-black px-2 py-1 text-center">{i + 1}</td>
                  <td className="border border-black px-2 py-1 font-mono">{l.office_number}</td>
                  <td className="border border-black px-2 py-1">
                    {l.office_name}
                    {l.is_self ? " (上限額管理事業所)" : ""}
                  </td>
                  <td className="border border-black px-2 py-1 text-right tabular-nums">
                    ¥{l.total_amount.toLocaleString()}
                  </td>
                  <td className="border border-black px-2 py-1 text-right tabular-nums">
                    ¥{l.user_amount.toLocaleString()}
                  </td>
                  <td className="border border-black px-2 py-1 text-right tabular-nums">
                    ¥{l.adjusted_amount.toLocaleString()}
                  </td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="border border-black px-2 py-1 text-center" colSpan={3}>
                  合計
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">
                  ¥{sumTotal.toLocaleString()}
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">
                  ¥{sumUser.toLocaleString()}
                </td>
                <td className="border border-black px-2 py-1 text-right tabular-nums">
                  ¥{sumAdj.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
