"use client";

/**
 * 地域生活支援 受給者証マスタ (移動支援・訪問入浴[障害])
 *
 * 自事業所の利用者ごとに、受給者証番号・契約支給量・負担上限月額を登録する。
 * idou-billing (帳票の受給者証番号・契約支給量・負担額) と idou-records
 * (支給量超過警告の閾値) がこれを参照する。テーブル: chiiki_recipient_certs。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useBusinessType } from "@/lib/business-type-context";
import { toast } from "sonner";
import { Loader2, Save, IdCard } from "lucide-react";

type Client = { id: string; name: string; furigana: string | null };
type Cert = {
  client_id: string;
  municipality: string;
  beneficiary_number: string;
  shikyu_amount_text: string;
  shikyu_hours: string; // 入力用 (時間)。保存時に分へ変換
  self_payment_limit: string;
  seiho_flag: boolean;
};

const emptyCert = (clientId: string): Cert => ({
  client_id: clientId,
  municipality: "千葉市",
  beneficiary_number: "",
  shikyu_amount_text: "",
  shikyu_hours: "",
  self_payment_limit: "0",
  seiho_flag: false,
});

// 保存後の確認モーダル: 既に登録済みのサービスと市町村の整合を確認
type ConfirmState = {
  clientName: string;
  municipality: string;
  rows: { date: string; code: string; name: string; valid: boolean }[];
};

export function IdouCertsContent() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { currentOffice, currentOfficeId } = useBusinessType();
  const [clients, setClients] = useState<Client[]>([]);
  const [certs, setCerts] = useState<Map<string, Cert>>(new Map());
  const [muniOptions, setMuniOptions] = useState<string[]>(["千葉市"]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const load = useCallback(async () => {
    if (!currentOfficeId) return;
    setLoading(true);
    try {
      const { data: assigns } = await supabase
        .from("client_office_assignments").select("client_id").eq("office_id", currentOfficeId);
      const ids = Array.from(new Set((assigns ?? []).map((a: { client_id: string }) => a.client_id)));
      const [clientsRes, certRes, muniRes] = await Promise.all([
        ids.length
          ? supabase.from("clients").select("id, name, furigana").in("id", ids).is("deleted_at", null).order("furigana")
          : Promise.resolve({ data: [], error: null }),
        ids.length
          ? supabase.from("chiiki_recipient_certs")
              .select("client_id, municipality, beneficiary_number, shikyu_amount_text, shikyu_minutes, self_payment_limit, seiho_flag")
              .in("client_id", ids)
          : Promise.resolve({ data: [], error: null }),
        // 登録済み地域生活支援コードの市町村一覧 (選択肢)
        supabase.from("kaigo_service_codes").select("municipality").eq("system", "地域生活支援").not("municipality", "is", null).limit(2000),
      ]);
      const cl = (clientsRes.data ?? []) as Client[];
      setClients(cl);
      const muniSet = new Set<string>(["千葉市"]);
      for (const r of (muniRes.data ?? []) as { municipality: string | null }[]) if (r.municipality) muniSet.add(r.municipality);
      setMuniOptions([...muniSet].sort());
      const m = new Map<string, Cert>();
      for (const c of cl) m.set(c.id, emptyCert(c.id));
      for (const r of (certRes.data ?? []) as {
        client_id: string; municipality: string | null; beneficiary_number: string | null; shikyu_amount_text: string | null;
        shikyu_minutes: number | null; self_payment_limit: number | null; seiho_flag: boolean | null;
      }[]) {
        m.set(r.client_id, {
          client_id: r.client_id,
          municipality: r.municipality ?? "千葉市",
          beneficiary_number: r.beneficiary_number ?? "",
          shikyu_amount_text: r.shikyu_amount_text ?? "",
          shikyu_hours: r.shikyu_minutes != null ? String(r.shikyu_minutes / 60) : "",
          self_payment_limit: String(r.self_payment_limit ?? 0),
          seiho_flag: r.seiho_flag ?? false,
        });
      }
      setCerts(m);
    } catch (e) {
      toast.error("受給者証の読込に失敗: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }, [supabase, currentOfficeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所切替時の fetch
    load();
  }, [load]);

  const patch = (cid: string, k: keyof Cert, v: string | boolean) =>
    setCerts((prev) => {
      const next = new Map(prev);
      const cur = next.get(cid) ?? emptyCert(cid);
      next.set(cid, { ...cur, [k]: v });
      return next;
    });

  const save = async (cid: string) => {
    const c = certs.get(cid);
    if (!c) return;
    setSavingId(cid);
    const hours = c.shikyu_hours.trim() === "" ? null : Math.round(Number(c.shikyu_hours) * 60);
    const { error } = await supabase.from("chiiki_recipient_certs").upsert(
      {
        client_id: cid,
        municipality: c.municipality || "千葉市",
        tenant_id: currentOffice?.tenant_id ?? "kt-group",
        beneficiary_number: c.beneficiary_number || null,
        shikyu_amount_text: c.shikyu_amount_text || null,
        shikyu_minutes: hours,
        self_payment_limit: Number(c.self_payment_limit) || 0,
        seiho_flag: c.seiho_flag,
      },
      { onConflict: "client_id,municipality" },
    );
    if (error) { setSavingId(null); toast.error("保存に失敗: " + error.message); return; }
    // 同一利用者は1市町村。市町村を変更した場合、旧市町村の重複行を掃除
    await supabase.from("chiiki_recipient_certs").delete()
      .eq("client_id", cid).neq("municipality", c.municipality || "千葉市");
    setSavingId(null);
    toast.success("保存しました");
    // 既に登録済みのサービスがあれば、登録した市町村との整合を確認
    await checkExistingServices(cid, c.municipality || "千葉市");
  };

  // 保存した受給者証の市町村に対し、既存の移動支援記録のコードが有効か確認
  const checkExistingServices = async (cid: string, municipality: string) => {
    const [recRes, codeRes] = await Promise.all([
      supabase.from("kaigo_idou_shien_records")
        .select("service_date, service_code")
        .eq("client_id", cid).not("service_code", "is", null)
        .order("service_date", { ascending: false }).limit(200),
      supabase.from("kaigo_service_codes")
        .select("service_code, service_name")
        .eq("system", "地域生活支援").eq("municipality", municipality).limit(2000),
    ]);
    const recs = (recRes.data ?? []) as { service_date: string; service_code: string }[];
    if (recs.length === 0) return; // 既存サービスなし → 確認不要
    const nameByCode = new Map<string, string>();
    for (const c of (codeRes.data ?? []) as { service_code: string; service_name: string }[]) nameByCode.set(c.service_code, c.service_name);
    setConfirm({
      clientName: clients.find((x) => x.id === cid)?.name ?? "",
      municipality,
      rows: recs.map((r) => ({
        date: r.service_date,
        code: r.service_code,
        name: nameByCode.get(r.service_code) ?? "(この市町村のコードに該当なし)",
        valid: nameByCode.has(r.service_code),
      })),
    });
  };

  if (currentOffice && currentOffice.service_type !== "移動支援" && currentOffice.service_type !== "訪問入浴") {
    return (
      <div className="p-6">
        <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-700">
          この画面は地域生活支援給付 (移動支援・訪問入浴) の事業所専用です。
        </p>
      </div>
    );
  }

  const inputCls = "w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm outline-none focus:border-violet-400";

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <IdCard className="text-violet-600" size={22} />
        <h1 className="text-lg font-bold text-gray-800">地域生活支援 受給者証</h1>
        <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-600">千葉市</span>
      </div>
      <p className="mb-4 text-xs text-gray-500">
        受給者証番号・契約支給量・負担上限月額を登録します。請求帳票 (受給者証番号・契約支給量・負担額) と
        記録の支給量警告に反映されます。負担上限は 生保/非課税=0円、課税世帯は上限額 (例 9,300 / 37,200)。
      </p>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin text-gray-300" size={28} /></div>
      ) : clients.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 py-16 text-center text-sm text-gray-400">
          自事業所の利用者がいません
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white shadow-sm">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-3 py-2.5">利用者</th>
                <th className="px-3 py-2.5">市町村</th>
                <th className="px-3 py-2.5">受給者証番号</th>
                <th className="px-3 py-2.5">契約支給量 (印字文)</th>
                <th className="px-3 py-2.5">支給量(時間/月)</th>
                <th className="px-3 py-2.5">負担上限(円)</th>
                <th className="px-3 py-2.5">生保</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((cl) => {
                const c = certs.get(cl.id) ?? emptyCert(cl.id);
                return (
                  <tr key={cl.id} className="border-b border-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-gray-800">{cl.name}</td>
                    <td className="px-3 py-2">
                      <select value={c.municipality} onChange={(e) => patch(cl.id, "municipality", e.target.value)} className={`${inputCls} w-28`}>
                        {muniOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><input value={c.beneficiary_number} onChange={(e) => patch(cl.id, "beneficiary_number", e.target.value)} className={`${inputCls} w-36 font-mono`} /></td>
                    <td className="px-3 py-2"><input value={c.shikyu_amount_text} onChange={(e) => patch(cl.id, "shikyu_amount_text", e.target.value)} placeholder="移動支援 月25時間" className={`${inputCls} w-48`} /></td>
                    <td className="px-3 py-2"><input type="number" step="0.5" value={c.shikyu_hours} onChange={(e) => patch(cl.id, "shikyu_hours", e.target.value)} placeholder="25" className={`${inputCls} w-20`} /></td>
                    <td className="px-3 py-2"><input type="number" value={c.self_payment_limit} onChange={(e) => patch(cl.id, "self_payment_limit", e.target.value)} className={`${inputCls} w-24`} /></td>
                    <td className="px-3 py-2 text-center"><input type="checkbox" checked={c.seiho_flag} onChange={(e) => patch(cl.id, "seiho_flag", e.target.checked)} className="accent-violet-600" /></td>
                    <td className="px-3 py-2">
                      <button onClick={() => save(cl.id)} disabled={savingId === cl.id}
                        className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50">
                        {savingId === cl.id ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}保存
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 保存後の確認: 既に登録済みのサービスと市町村の整合 */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirm(null)}>
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-gray-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-gray-800">登録済みサービスの確認</h3>
              <p className="mt-0.5 text-xs text-gray-500">
                {confirm.clientName} さんには既に地域生活支援のサービスが登録されています。
                受給者証の市町村「<span className="font-medium text-violet-600">{confirm.municipality}</span>」で正しいか確認してください。
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {confirm.rows.some((r) => !r.valid) && (
                <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  ⚠ この市町村のコードに該当しないサービスがあります。暫定で別市町村のコードを追加した可能性があります。市町村が違う場合は上の選択を直して保存し直すか、記録側でコードを選び直してください。
                </p>
              )}
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500">
                    <th className="py-1.5">日付</th><th className="py-1.5">コード</th><th className="py-1.5">サービス名</th>
                  </tr>
                </thead>
                <tbody>
                  {confirm.rows.map((r, i) => (
                    <tr key={i} className={`border-b border-gray-50 ${r.valid ? "" : "bg-amber-50/60"}`}>
                      <td className="py-1.5 whitespace-nowrap">{r.date.slice(5).replace("-", "/")}</td>
                      <td className="py-1.5 font-mono">{r.code}</td>
                      <td className={`py-1.5 ${r.valid ? "text-gray-700" : "font-medium text-amber-700"}`}>{r.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
              <button onClick={() => { setConfirm(null); router.push("/idou-records"); }}
                className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
                記録を修正する
              </button>
              <button onClick={() => setConfirm(null)}
                className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700">
                OK (このまま)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
