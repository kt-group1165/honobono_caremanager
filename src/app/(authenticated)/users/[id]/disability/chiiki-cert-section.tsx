"use client";

/**
 * 地域生活支援 (市町村事業) 受給者証セクション
 *
 * 旧 /idou-certs (独立ページ) を利用者詳細の障害福祉タブに統合 (2026-07-15 user 要望)。
 * 実物の受給者証は障害福祉サービス受給者証と同じ冊子に併記されることが多いが、
 * 番号・支給量は障害福祉 (自立支援給付) と異なり得るため、データは専用ストア
 * (chiiki_recipient_certs) のまま。idou-billing (帳票の受給者証番号・契約支給量・
 * 負担額) と idou-records (支給量超過警告の閾値) がこれを参照する。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Loader2, Save, IdCard } from "lucide-react";

const inputCls =
  "rounded border border-gray-300 px-2 py-1 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

type FormState = {
  municipality: string;
  beneficiary_number: string;
  shikyu_amount_text: string;
  shikyu_hours: string; // 入力用 (時間)。保存時に分へ変換
  self_payment_limit: string;
  seiho_flag: boolean;
};

const EMPTY: FormState = {
  municipality: "千葉市",
  beneficiary_number: "",
  shikyu_amount_text: "",
  shikyu_hours: "",
  self_payment_limit: "0",
  seiho_flag: false,
};

export function ChiikiCertSection({
  userId,
  disabilityRecipientNumber,
}: {
  userId: string;
  /** 障害福祉サービス受給者証の番号 (同番号のことが多いのでコピー補助に使う) */
  disabilityRecipientNumber?: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [available, setAvailable] = useState(true); // chiiki_recipient_certs 未適用環境では非表示
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [muniOptions, setMuniOptions] = useState<string[]>(["千葉市"]);
  const [f, setF] = useState<FormState>(EMPTY);

  const load = useCallback(async () => {
    setLoading(true);
    const [certRes, muniRes] = await Promise.all([
      supabase
        .from("chiiki_recipient_certs")
        .select("municipality, beneficiary_number, shikyu_amount_text, shikyu_minutes, self_payment_limit, seiho_flag")
        .eq("client_id", userId)
        .limit(1),
      supabase
        .from("kaigo_service_codes")
        .select("municipality")
        .eq("system", "地域生活支援")
        .not("municipality", "is", null)
        .limit(2000),
    ]);
    if (certRes.error) {
      // テーブル未適用 (migration 前) はセクションごと非表示
      if (certRes.error.code === "42P01" || certRes.error.code === "PGRST205") {
        setAvailable(false);
      } else {
        toast.error("地域生活支援 受給者証の読込に失敗: " + certRes.error.message);
      }
      setLoading(false);
      return;
    }
    const muniSet = new Set<string>(["千葉市"]);
    for (const r of (muniRes.data ?? []) as { municipality: string | null }[]) {
      if (r.municipality) muniSet.add(r.municipality);
    }
    setMuniOptions([...muniSet].sort());
    const row = certRes.data?.[0] as
      | {
          municipality: string | null;
          beneficiary_number: string | null;
          shikyu_amount_text: string | null;
          shikyu_minutes: number | null;
          self_payment_limit: number | null;
          seiho_flag: boolean | null;
        }
      | undefined;
    if (row) {
      setF({
        municipality: row.municipality ?? "千葉市",
        beneficiary_number: row.beneficiary_number ?? "",
        shikyu_amount_text: row.shikyu_amount_text ?? "",
        shikyu_hours: row.shikyu_minutes != null ? String(row.shikyu_minutes / 60) : "",
        self_payment_limit: String(row.self_payment_limit ?? 0),
        seiho_flag: row.seiho_flag ?? false,
      });
    }
    setLoading(false);
  }, [supabase, userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount 時の fetch
    load();
  }, [load]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  // 保存後: 既存の移動支援記録のコードが、登録した市町村のコード表に有るか確認 (警告のみ)
  const checkExistingServices = async (municipality: string) => {
    const [recRes, codeRes] = await Promise.all([
      supabase
        .from("kaigo_idou_shien_records")
        .select("service_code")
        .eq("client_id", userId)
        .not("service_code", "is", null)
        .limit(200),
      supabase
        .from("kaigo_service_codes")
        .select("service_code")
        .eq("system", "地域生活支援")
        .eq("municipality", municipality)
        .limit(2000),
    ]);
    const recs = (recRes.data ?? []) as { service_code: string }[];
    if (recs.length === 0) return;
    const valid = new Set(((codeRes.data ?? []) as { service_code: string }[]).map((c) => c.service_code));
    const bad = recs.filter((r) => !valid.has(r.service_code));
    if (bad.length > 0) {
      toast.warning(
        `既存の移動支援記録 ${bad.length} 件が市町村「${municipality}」のコード表に該当しません。市町村の選択か記録側のコードを確認してください`,
        { duration: 8000 },
      );
    }
  };

  const save = async () => {
    setSaving(true);
    const municipality = f.municipality || "千葉市";
    const hours = f.shikyu_hours.trim() === "" ? null : Math.round(Number(f.shikyu_hours) * 60);
    const { error } = await supabase.from("chiiki_recipient_certs").upsert(
      {
        client_id: userId,
        municipality,
        tenant_id: "kt-group",
        beneficiary_number: f.beneficiary_number || null,
        shikyu_amount_text: f.shikyu_amount_text || null,
        shikyu_minutes: hours,
        self_payment_limit: Number(f.self_payment_limit) || 0,
        seiho_flag: f.seiho_flag,
      },
      { onConflict: "client_id,municipality" },
    );
    if (error) {
      setSaving(false);
      toast.error("保存に失敗: " + error.message);
      return;
    }
    // 同一利用者は1市町村。市町村を変更した場合、旧市町村の重複行を掃除
    const { error: e2 } = await supabase
      .from("chiiki_recipient_certs")
      .delete()
      .eq("client_id", userId)
      .neq("municipality", municipality);
    if (e2) console.error("旧市町村行の削除に失敗:", e2.message);
    setSaving(false);
    toast.success("地域生活支援 受給者証を保存しました");
    await checkExistingServices(municipality);
  };

  if (!available) return null;

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <h3 className="mb-1 flex items-center gap-1.5 border-b pb-2 text-sm font-bold text-gray-800">
        <IdCard size={15} className="text-violet-600" />
        地域生活支援 受給者証 (市町村事業)
      </h3>
      <p className="mb-3 text-[11px] text-gray-500">
        移動支援・訪問入浴 (地域生活支援給付) の請求帳票と支給量超過警告に反映されます。番号・支給量は
        上の障害福祉サービス受給者証と異なる場合があるため別管理です (同番号のことも多い)。
        負担上限は 生保/非課税=0円、課税世帯は上限額 (例 9,300 / 37,200)。
      </p>
      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="animate-spin text-gray-300" size={20} />
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-500">市町村</label>
            <select value={f.municipality} onChange={(e) => set("municipality", e.target.value)} className={`${inputCls} w-28`}>
              {muniOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-500">受給者証番号</label>
            <div className="flex items-center gap-1">
              <input
                value={f.beneficiary_number}
                onChange={(e) => set("beneficiary_number", e.target.value)}
                className={`${inputCls} w-36 font-mono`}
              />
              {disabilityRecipientNumber && f.beneficiary_number !== disabilityRecipientNumber && (
                <button
                  type="button"
                  onClick={() => set("beneficiary_number", disabilityRecipientNumber)}
                  className="rounded border border-violet-200 bg-violet-50 px-1.5 py-1 text-[10px] text-violet-700 hover:bg-violet-100"
                  title={`障害福祉サービス受給者証の番号 (${disabilityRecipientNumber}) をコピー`}
                >
                  障害福祉と同番号
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-500">契約支給量 (帳票印字文)</label>
            <input
              value={f.shikyu_amount_text}
              onChange={(e) => set("shikyu_amount_text", e.target.value)}
              placeholder="移動支援 月25時間"
              className={`${inputCls} w-48`}
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-500">支給量 (時間/月)</label>
            <input
              type="number"
              step="0.5"
              value={f.shikyu_hours}
              onChange={(e) => set("shikyu_hours", e.target.value)}
              placeholder="25"
              className={`${inputCls} w-20`}
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-500">負担上限 (円)</label>
            <input
              type="number"
              value={f.self_payment_limit}
              onChange={(e) => set("self_payment_limit", e.target.value)}
              className={`${inputCls} w-24`}
            />
          </div>
          <label className="flex items-center gap-1 pb-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={f.seiho_flag}
              onChange={(e) => set("seiho_flag", e.target.checked)}
              className="accent-violet-600"
            />
            生活保護
          </label>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}保存
          </button>
        </div>
      )}
    </div>
  );
}
