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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Loader2, Save, IdCard } from "lucide-react";

const inputCls =
  "rounded border border-gray-300 px-2 py-1 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

export type FormState = {
  municipality: string;
  beneficiary_number: string;
  issue_date: string;   // 交付年月日
  valid_from: string;   // 支給決定期間 開始
  valid_until: string;  // 支給決定期間 終了
  shikyu_amount_text: string;
  shikyu_hours: string; // 入力用 (時間)。保存時に分へ変換
  self_payment_limit: string;
  seiho_flag: boolean;
  notes: string;        // 備考
};

const EMPTY: FormState = {
  municipality: "千葉市",
  beneficiary_number: "",
  issue_date: "",
  valid_from: "",
  valid_until: "",
  shikyu_amount_text: "",
  shikyu_hours: "",
  self_payment_limit: "0",
  seiho_flag: false,
  notes: "",
};

// 拡張列 (issue_date/valid_until) が未適用(42703) の環境ではこれらを落として動く
const BASE_CERT_COLS =
  "municipality, beneficiary_number, shikyu_amount_text, shikyu_minutes, self_payment_limit, seiho_flag";
const EXT_CERT_COLS = `${BASE_CERT_COLS}, issue_date, valid_from, valid_until, notes`;

export type ChiikiCertData = {
  available: boolean;
  extCols: boolean;
  muniOptions: string[];
  form: FormState;
};

const EMPTY_DATA: ChiikiCertData = { available: true, extCols: true, muniOptions: ["千葉市"], form: EMPTY };

/**
 * 地域生活支援受給者証セクションのデータを取得。page.tsx (server) / content (client) の
 * 両方から同じロジックで呼べるよう、supabase client を引数で受け取る形に切り出している。
 */
export async function loadChiikiCertData(
  supabase: SupabaseClient,
  userId: string,
): Promise<ChiikiCertData> {
  // 拡張列込みで取得。未適用(42703)なら基本列のみで再取得し extCols=false に
  type CertRow = {
    municipality: string | null;
    beneficiary_number: string | null;
    shikyu_amount_text: string | null;
    shikyu_minutes: number | null;
    self_payment_limit: number | null;
    seiho_flag: boolean | null;
    issue_date?: string | null;
    valid_from?: string | null;
    valid_until?: string | null;
    notes?: string | null;
  };
  let hasExt = true;
  let certRes = await supabase
    .from("chiiki_recipient_certs")
    .select(EXT_CERT_COLS)
    .eq("client_id", userId)
    .limit(1)
    .returns<CertRow[]>();
  if (certRes.error?.code === "42703") {
    hasExt = false;
    certRes = await supabase
      .from("chiiki_recipient_certs")
      .select(BASE_CERT_COLS)
      .eq("client_id", userId)
      .limit(1)
      .returns<CertRow[]>();
  }
  if (certRes.error) {
    // テーブル未適用 (migration 前) はセクションごと非表示
    if (certRes.error.code === "42P01" || certRes.error.code === "PGRST205") {
      return { ...EMPTY_DATA, available: false };
    }
    throw new Error("地域生活支援 受給者証の読込に失敗: " + certRes.error.message);
  }
  const muniRes = await supabase
    .from("kaigo_service_codes")
    .select("municipality")
    .eq("system", "地域生活支援")
    .not("municipality", "is", null)
    .limit(2000);
  const muniSet = new Set<string>(["千葉市"]);
  for (const r of (muniRes.data ?? []) as { municipality: string | null }[]) {
    if (r.municipality) muniSet.add(r.municipality);
  }
  const muniOptions = [...muniSet].sort();
  const row = certRes.data?.[0] as
    | {
        municipality: string | null;
        beneficiary_number: string | null;
        shikyu_amount_text: string | null;
        shikyu_minutes: number | null;
        self_payment_limit: number | null;
        seiho_flag: boolean | null;
        issue_date?: string | null;
        valid_from?: string | null;
        valid_until?: string | null;
        notes?: string | null;
      }
    | undefined;
  const form: FormState = row
    ? {
        municipality: row.municipality ?? "千葉市",
        beneficiary_number: row.beneficiary_number ?? "",
        issue_date: row.issue_date ?? "",
        valid_from: row.valid_from ?? "",
        valid_until: row.valid_until ?? "",
        shikyu_amount_text: row.shikyu_amount_text ?? "",
        shikyu_hours: row.shikyu_minutes != null ? String(row.shikyu_minutes / 60) : "",
        self_payment_limit: String(row.self_payment_limit ?? 0),
        seiho_flag: row.seiho_flag ?? false,
        notes: row.notes ?? "",
      }
    : EMPTY;
  return { available: true, extCols: hasExt, muniOptions, form };
}

export function ChiikiCertSection({
  userId,
  disabilityRecipientNumber,
  initialData = null,
}: {
  userId: string;
  /** 障害福祉サービス受給者証の番号 (同番号のことが多いのでコピー補助に使う) */
  disabilityRecipientNumber?: string | null;
  initialData?: ChiikiCertData | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const init = initialData ?? EMPTY_DATA;
  const [available, setAvailable] = useState(init.available); // chiiki_recipient_certs 未適用環境では非表示
  // 拡張列 (交付日/支給決定期間終了/備考) が DB 未適用なら false → 保存対象から除外
  const [extCols, setExtCols] = useState(init.extCols);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [muniOptions, setMuniOptions] = useState<string[]>(init.muniOptions);
  const [f, setF] = useState<FormState>(init.form);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadChiikiCertData(supabase, userId);
      setAvailable(data.available);
      setExtCols(data.extCols);
      setMuniOptions(data.muniOptions);
      setF(data.form);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "地域生活支援 受給者証の読込に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [supabase, userId]);

  // 初回 mount は server から渡された initialData をそのまま使う。userId が (remount 無しで)
  // 切り替わった場合は再取得する。
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (initialData) return;
    }
    load();
  }, [load, userId, initialData]);

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
        // 拡張列 (交付日/支給決定期間/備考) は DB 適用済のときだけ含める
        ...(extCols
          ? {
              issue_date: f.issue_date || null,
              valid_from: f.valid_from || null,
              valid_until: f.valid_until || null,
              notes: f.notes || null,
            }
          : {}),
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
    setSaving(false);
    if (e2) {
      console.error("旧市町村行の削除に失敗:", e2.message);
      toast.warning(`保存はできましたが、旧市町村の重複データの掃除に失敗しました: ${e2.message}`);
    } else {
      toast.success("地域生活支援 受給者証を保存しました");
    }
    await checkExistingServices(municipality);
  };

  if (!available) return null;

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <h3 className="mb-1 flex items-center gap-1.5 border-b pb-2 text-sm font-bold text-gray-800">
        <IdCard size={15} className="text-violet-600" />
        地域生活支援 受給者証 (市町村事業)
        {!loading && !extCols && (
          <span
            className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700"
            title="migrations/chiiki_recipient_certs_v2_period.sql を適用すると 交付日・支給決定期間・備考 を保存できます"
          >
            期間・交付日は SQL未適用
          </span>
        )}
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
            <label className="mb-0.5 block text-[11px] text-gray-500">交付年月日</label>
            <input
              type="date"
              value={f.issue_date}
              onChange={(e) => set("issue_date", e.target.value)}
              disabled={!extCols}
              className={`${inputCls} disabled:opacity-50`}
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[11px] text-gray-500">支給決定期間</label>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={f.valid_from}
                onChange={(e) => set("valid_from", e.target.value)}
                disabled={!extCols}
                className={`${inputCls} disabled:opacity-50`}
              />
              <span className="text-xs text-gray-500">〜</span>
              <input
                type="date"
                value={f.valid_until}
                onChange={(e) => set("valid_until", e.target.value)}
                disabled={!extCols}
                className={`${inputCls} disabled:opacity-50`}
              />
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
          <div className="min-w-[200px] flex-1">
            <label className="mb-0.5 block text-[11px] text-gray-500">備考</label>
            <input
              value={f.notes}
              onChange={(e) => set("notes", e.target.value)}
              disabled={!extCols}
              className={`${inputCls} w-full disabled:opacity-50`}
            />
          </div>
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
