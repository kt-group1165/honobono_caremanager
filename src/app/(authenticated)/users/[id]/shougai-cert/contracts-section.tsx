"use client";

/**
 * 契約支給量 (shogai_contracts) の編集。
 *
 * ── これは何か ────────────────────────────────────────────────────────
 *   受給者証の「事業者記入欄」に転記する、**自事業所が契約した分**の支給量。
 *   市町村が決めた支給量 (受給者証の支給量欄 = shikyuryo_details) のうち、
 *   何時間ぶんを当事業所で受けるかを決定サービスコードごとに書く。
 *   他事業所と分け合う場合はその一部になる。
 *
 *   国保連伝送では **契約情報レコード (J121-05)** に出る:
 *     決定サービスコード / 契約支給量 / 契約開始日・終了日 / 事業者記入欄番号
 *
 * ── なぜ画面が要るか ──────────────────────────────────────────────────
 *   664 件すべて ほのぼのの伝送から取り込んだもので、人が入れる手段が無かった。
 *   ほのぼのを止めると新規契約・更新を登録できなくなる。
 *   さらに **重度訪問介護の段 (Ⅰ/Ⅱ/Ⅲ) はここの決定サービスコードで決まる**
 *   (121000→Ⅰ / 122000→Ⅱ / 123000→Ⅲ)。誤ると単位数が変わるため確認手段が要る。
 *
 * ── 他事業所ぶんも読み取り専用で見せる ────────────────────────────────
 *   事業者記入欄の番号は受給者証の紙を事業所が順番に埋めていくので、
 *   何番が空いているかを知るには他事業所の行が見えている必要がある。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Plus, Printer, Save, Trash2, X } from "lucide-react";
import { useBusinessType } from "@/lib/business-type-context";
import { DECISION_CODES, defaultUnitOf } from "@/lib/shogai-densou/contracts";
import {
  ShogaiKeiyakuHoukokuPrintSheet,
  type ShogaiKeiyakuEntry,
} from "@/app/(authenticated)/billing/forms/_shogai-meisai";

interface Row {
  id: string;
  client_id: string;
  office_id: string | null;
  decision_code: string;
  /** 支給量 ×100 (整数3桁+小数2桁)。32時間30分 = 3250 */
  amount_x100: number;
  amount_unit: string | null;
  entry_number: number | null;
  start_date: string | null;
  end_date: string | null;
  reason: string | null;
  notes: string | null;
}

interface Draft {
  decision_code: string;
  hours: string;
  minutes: string;
  count: string;
  entry_number: string;
  start_date: string;
  end_date: string;
  reason: string;
}

const EMPTY_DRAFT: Draft = {
  decision_code: "111000",
  hours: "",
  minutes: "",
  count: "",
  entry_number: "1",
  start_date: "",
  end_date: "",
  reason: "新規契約",
};

/** 支給量 ×100 → 表示文字列 */
function fmtAmount(x100: number, unit: string | null): string {
  if (unit === "回") return `${x100 / 100}回`;
  const h = Math.floor(x100 / 100);
  const m = Math.round(x100 % 100);
  return `${h}時間${String(m).padStart(2, "0")}分`;
}

/** 時間+分 / 回 → ×100 の整数。「3 桁 + 小数 2 桁」なので分はそのまま下 2 桁 */
function toX100(d: Draft, unit: "時間" | "日" | "回"): number | null {
  if (unit === "回") {
    const n = Number(d.count);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  const h = Number(d.hours || 0);
  const m = Number(d.minutes || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || m < 0 || m > 59) return null;
  return h * 100 + m;
}

export function ContractsSection({ userId }: { userId: string }) {
  const supabase = createClient();
  const { currentOffice } = useBusinessType();
  const [rows, setRows] = useState<Row[]>([]);
  const [officeNames, setOfficeNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  /** 報告対象年月 (YYYY-MM)。様式は「その月に起きた契約の変更」を報告するもの */
  const [reportMonth, setReportMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  /** 提出日。既定は操作日。手で変えられる */
  const [reportDate, setReportDate] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [printEntry, setPrintEntry] = useState<ShogaiKeiyakuEntry | null>(null);
  const [printOffice, setPrintOffice] = useState<{
    name: string | null;
    number: string | null;
    postal: string | null;
    address: string | null;
    representative: string | null;
  }>({ name: null, number: null, postal: null, address: null, representative: null });

  // ⚠ 先頭で setState しないこと。effect から同期的に呼ぶと
  //   react-hooks/set-state-in-effect に引っかかる (初期値が loading=true なので不要)
  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("shogai_contracts")
      .select(
        "id, client_id, office_id, decision_code, amount_x100, amount_unit, entry_number, start_date, end_date, reason, notes",
      )
      .eq("client_id", userId)
      .order("start_date", { ascending: false, nullsFirst: false });
    if (error) {
      // migration 未適用 (42P01) はカードごと隠す。それ以外は握らず知らせる
      if (error.code === "42P01" || error.code === "PGRST205") {
        setUnavailable(true);
      } else {
        toast.error(`契約支給量の取得に失敗: ${error.message}`);
      }
      setLoading(false);
      return;
    }
    const list = (data ?? []) as Row[];
    setRows(list);
    const ids = Array.from(new Set(list.map((r) => r.office_id).filter(Boolean))) as string[];
    if (ids.length) {
      const { data: offs } = await supabase.from("offices").select("id, name").in("id", ids);
      setOfficeNames(new Map((offs ?? []).map((o: { id: string; name: string }) => [o.id, o.name])));
    }
    setLoading(false);
  }, [supabase, userId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount 時の fetch
    void load();
  }, [load]);

  const mine = useMemo(
    () => rows.filter((r) => currentOffice && r.office_id === currentOffice.id),
    [rows, currentOffice],
  );
  const others = useMemo(
    () => rows.filter((r) => !currentOffice || r.office_id !== currentOffice.id),
    [rows, currentOffice],
  );
  /** 既に使われている記入欄番号 (自他問わず。紙は 1 枚なので重複させない) */
  const usedEntries = useMemo(
    () =>
      rows
        .filter((r) => r.id !== editingId && r.entry_number != null)
        .map((r) => r.entry_number as number),
    [rows, editingId],
  );

  const startNew = () => {
    setEditingId("new");
    const next = Math.max(0, ...rows.map((r) => r.entry_number ?? 0)) + 1;
    setDraft({ ...EMPTY_DRAFT, entry_number: String(next) });
  };

  const startEdit = (r: Row) => {
    setEditingId(r.id);
    const unit = (r.amount_unit as "時間" | "日" | "回") ?? defaultUnitOf(r.decision_code);
    setDraft({
      decision_code: r.decision_code,
      hours: unit === "回" ? "" : String(Math.floor(r.amount_x100 / 100)),
      minutes: unit === "回" ? "" : String(Math.round(r.amount_x100 % 100)),
      count: unit === "回" ? String(r.amount_x100 / 100) : "",
      entry_number: r.entry_number != null ? String(r.entry_number) : "",
      start_date: r.start_date ?? "",
      end_date: r.end_date ?? "",
      reason: r.reason ?? "",
    });
  };

  const save = async () => {
    if (!currentOffice) {
      toast.error("事業所が特定できないため保存できません");
      return;
    }
    const unit = defaultUnitOf(draft.decision_code);
    const x100 = toX100(draft, unit);
    if (x100 == null) {
      toast.error("支給量の入力が正しくありません (分は 0〜59)");
      return;
    }
    if (!draft.start_date) {
      toast.error("契約開始日は必須です (伝送の契約情報レコードに出ます)");
      return;
    }
    if (draft.end_date && draft.end_date < draft.start_date) {
      toast.error("契約終了日が開始日より前になっています");
      return;
    }
    const entry = draft.entry_number === "" ? null : Number(draft.entry_number);
    if (entry != null && (!Number.isInteger(entry) || entry < 1)) {
      toast.error("事業者記入欄の番号は 1 以上の整数です");
      return;
    }
    setSaving(true);
    const payload = {
      tenant_id: "kt-group",
      client_id: userId,
      office_id: currentOffice.id,
      decision_code: draft.decision_code,
      amount_x100: x100,
      amount_unit: unit,
      entry_number: entry,
      start_date: draft.start_date,
      end_date: draft.end_date || null,
      reason: draft.reason || null,
    };
    const { error } =
      editingId === "new"
        ? await supabase.from("shogai_contracts").insert(payload)
        : await supabase.from("shogai_contracts").update(payload).eq("id", editingId!);
    setSaving(false);
    if (error) {
      toast.error(`保存に失敗: ${error.message}`);
      return;
    }
    toast.success("契約支給量を保存しました");
    setEditingId(null);
    await load();
  };

  /**
   * 契約内容報告書 (様式第26号) をこの利用者ぶん 1 枚だけ印刷する。
   * 障害請求画面からも出せるが、契約を編集した直後にその場で出せるほうが自然なため
   * ここにも置く。出す内容は同じコンポーネント (ShogaiKeiyakuHoukokuPrintSheet)。
   */
  const printReport = async () => {
    if (rows.length === 0) {
      toast.error("契約が登録されていないため報告書を出せません");
      return;
    }
    setPrinting(true);
    try {
      const [certRes, clientRes, officeRes] = await Promise.all([
        supabase
          .from("shougai_certifications")
          .select("beneficiary_number, insurer_municipality, holder_name_kana, certification_start_date")
          .eq("client_id", userId)
          .order("certification_start_date", { ascending: false, nullsFirst: false })
          .limit(1),
        supabase.from("clients").select("name").eq("id", userId).maybeSingle(),
        currentOffice
          ? supabase
              .from("offices")
              .select("name, shogai_business_number, business_number, postal_code, address, representative_name")
              .eq("id", currentOffice.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (certRes.error) throw new Error(`受給者証の取得に失敗: ${certRes.error.message}`);
      if (clientRes.error) throw new Error(`利用者の取得に失敗: ${clientRes.error.message}`);
      if (officeRes.error) throw new Error(`事業所の取得に失敗: ${officeRes.error.message}`);
      const cert = (certRes.data ?? [])[0] as
        | { beneficiary_number: string | null; insurer_municipality: string | null; holder_name_kana: string | null }
        | undefined;
      const off = officeRes.data as {
        name?: string | null;
        shogai_business_number?: string | null;
        business_number?: string | null;
        postal_code?: string | null;
        address?: string | null;
        representative_name?: string | null;
      } | null;

      // 自事業所の契約だけを報告する (他事業所ぶんは相手が出す)
      const ym = reportMonth;
      const [ry, rm] = ym.split("-").map(Number);
      const first = `${ym}-01`;
      const last = `${ym}-${String(new Date(ry, rm, 0).getDate()).padStart(2, "0")}`;
      setPrintEntry({
        clientId: userId,
        userName: (clientRes.data as { name?: string } | null)?.name ?? "",
        beneficiaryNumber: cert?.beneficiary_number ?? null,
        municipality: cert?.insurer_municipality ?? null,
        contracts: mine as unknown as ShogaiKeiyakuEntry["contracts"],
        startedIds: mine
          .filter((c) => c.start_date && c.start_date >= first && c.start_date <= last)
          .map((c) => c.id),
        endedIds: mine
          .filter((c) => c.end_date && c.end_date >= first && c.end_date <= last)
          .map((c) => c.id),
        holderNameKana: cert?.holder_name_kana ?? null,
        legacyAmountText: null,
      });
      setPrintOffice({
        name: off?.name ?? currentOffice?.name ?? null,
        number: (off?.shogai_business_number ?? off?.business_number ?? null) || null,
        postal: off?.postal_code ?? null,
        address: off?.address ?? null,
        representative: off?.representative_name ?? null,
      });
      setTimeout(() => {
        window.print();
        setPrintEntry(null);
      }, 120);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPrinting(false);
    }
  };

  const remove = async (r: Row) => {
    if (
      !confirm(
        `${DECISION_CODES[r.decision_code] ?? r.decision_code} ${fmtAmount(r.amount_x100, r.amount_unit)} を削除します。\n伝送の契約情報レコードから消えます。よろしいですか。`,
      )
    )
      return;
    const { error } = await supabase.from("shogai_contracts").delete().eq("id", r.id);
    if (error) {
      toast.error(`削除に失敗: ${error.message}`);
      return;
    }
    toast.success("削除しました");
    await load();
  };

  if (unavailable) return null;

  const unit = defaultUnitOf(draft.decision_code);
  const isJuho = /^12[123]000$/.test(draft.decision_code);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">契約支給量 (事業者記入欄)</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            受給者証の事業者記入欄に転記する、当事業所が契約した分。伝送の契約情報レコードに出ます
          </p>
        </div>
        {editingId === null && (
          <div className="flex items-center gap-2">
            <input
              type="month"
              value={reportMonth}
              onChange={(e) => setReportMonth(e.target.value)}
              title="報告対象年月。この月に契約日・終了日がある契約だけが報告書に出ます"
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              title="提出日。既定は本日"
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void printReport()}
              disabled={printing || rows.length === 0}
              title="この利用者の契約内容報告書 (様式第26号) を印刷します"
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Printer className="h-4 w-4" />
              契約報告書
            </button>
          <button
            type="button"
            onClick={startNew}
            disabled={!currentOffice}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            追加
          </button>
          </div>
        )}
      </div>

      {/* 印刷 view: 契約内容報告書 (様式第26号)。画面には出さず印刷時だけ出す */}
      {printEntry && (
        <div className="hidden print:block">
          <ShogaiKeiyakuHoukokuPrintSheet
            entry={printEntry}
            officeName={printOffice.name}
            officeNumber={printOffice.number}
            officePostalCode={printOffice.postal}
            officeAddress={printOffice.address}
            officeRepresentative={printOffice.representative}
            reportDate={reportDate}
          />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">読み込み中…</p>
      ) : (
        <>
          {mine.length === 0 && editingId === null && (
            <p className="text-sm text-gray-500">
              自事業所の契約がまだ登録されていません。
              {others.length > 0 && " (他事業所の契約は下に表示しています)"}
            </p>
          )}

          {mine.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-1.5 pr-2 font-medium">決定サービスコード</th>
                  <th className="py-1.5 pr-2 font-medium">契約支給量</th>
                  <th className="py-1.5 pr-2 font-medium">記入欄</th>
                  <th className="py-1.5 pr-2 font-medium">契約期間</th>
                  <th className="py-1.5 pr-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 last:border-0">
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <span className="font-mono text-xs text-gray-500">{r.decision_code}</span>{" "}
                      <span className="text-gray-900">
                        {DECISION_CODES[r.decision_code] ?? "(不明なコード)"}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap text-gray-900">
                      {fmtAmount(r.amount_x100, r.amount_unit)}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap text-gray-900">
                      {r.entry_number ?? "—"}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap text-gray-700">
                      {r.start_date ?? "—"}〜{r.end_date ?? ""}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => startEdit(r)}
                        className="rounded px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(r)}
                        className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="inline h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {editingId !== null && (
            <div className="mt-3 rounded-md border border-blue-200 bg-blue-50/40 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="text-xs text-gray-600">
                  決定サービスコード
                  <select
                    value={draft.decision_code}
                    onChange={(e) => setDraft({ ...draft, decision_code: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  >
                    {Object.entries(DECISION_CODES).map(([code, label]) => (
                      <option key={code} value={code}>
                        {code} {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs text-gray-600">
                  契約支給量
                  <span className="mt-1 flex items-center gap-1">
                    {unit === "回" ? (
                      <>
                        <input
                          type="number"
                          min={0}
                          value={draft.count}
                          onChange={(e) => setDraft({ ...draft, count: e.target.value })}
                          className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span className="text-sm text-gray-600">回</span>
                      </>
                    ) : (
                      <>
                        <input
                          type="number"
                          min={0}
                          value={draft.hours}
                          onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
                          className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span className="text-sm text-gray-600">時間</span>
                        <input
                          type="number"
                          min={0}
                          max={59}
                          value={draft.minutes}
                          onChange={(e) => setDraft({ ...draft, minutes: e.target.value })}
                          className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span className="text-sm text-gray-600">分</span>
                      </>
                    )}
                  </span>
                </label>

                <label className="text-xs text-gray-600">
                  事業者記入欄 番号
                  <input
                    type="number"
                    min={1}
                    value={draft.entry_number}
                    onChange={(e) => setDraft({ ...draft, entry_number: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  {usedEntries.length > 0 && (
                    <span className="mt-0.5 block text-[11px] text-gray-500">
                      使用済: {usedEntries.sort((a, b) => a - b).join(", ")}
                    </span>
                  )}
                  {draft.entry_number !== "" &&
                    usedEntries.includes(Number(draft.entry_number)) && (
                      <span className="mt-0.5 block text-[11px] text-amber-700">
                        この番号は既に使われています
                      </span>
                    )}
                </label>

                <label className="text-xs text-gray-600">
                  契約開始日
                  <input
                    type="date"
                    value={draft.start_date}
                    onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-gray-600">
                  契約終了日 (空 = 継続中)
                  <input
                    type="date"
                    value={draft.end_date}
                    onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-gray-600">
                  事由
                  <input
                    type="text"
                    value={draft.reason}
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    placeholder="新規契約 / 契約変更 など"
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </label>
              </div>

              {isJuho && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800 ring-1 ring-amber-200">
                  重度訪問介護は<b>このコードで報酬の段が決まります</b>。
                  121000 = サービス費Ⅰ / 122000 = Ⅱ / 123000 = Ⅲ で単位数が違うため、
                  受給者証の記載どおりに選んでください。
                </p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <X className="h-4 w-4" />
                  取消
                </button>
              </div>
            </div>
          )}

          {others.length > 0 && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <p className="mb-1.5 text-xs font-medium text-gray-500">
                他事業所の契約 (参照のみ — 記入欄の番号が重ならないように)
              </p>
              <ul className="space-y-0.5 text-xs text-gray-600">
                {others.map((r) => (
                  <li key={r.id} className="whitespace-nowrap">
                    <span className="text-gray-400">
                      {r.office_id ? (officeNames.get(r.office_id) ?? "他事業所") : "事業所未設定"}
                    </span>{" "}
                    {DECISION_CODES[r.decision_code] ?? r.decision_code}{" "}
                    {fmtAmount(r.amount_x100, r.amount_unit)}
                    {r.entry_number != null ? ` / 記入欄 ${r.entry_number}` : ""}
                    {r.start_date ? ` / ${r.start_date}〜${r.end_date ?? ""}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
