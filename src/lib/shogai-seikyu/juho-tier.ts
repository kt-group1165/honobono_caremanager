/**
 * 重度訪問介護の「段」(サービス費Ⅰ/Ⅱ/Ⅲ) を利用者の支給決定から決める。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 *   重訪の算定コードは同じ所要時間でも 3 段あり、単位数が違う。
 *     121121 重訪Ⅰ日中８．０ = 98 単位
 *     121221 重訪Ⅱ日中８．０ = 92 単位
 *     121321 重訪Ⅲ日中８．０ = 85 単位
 *   どの段で算定するかは **市町村の支給決定**で決まる。事業所が選ぶものではない。
 *
 *     決定サービスコード 121000 重度障害者等包括支援対象者 → Ⅰ
 *     決定サービスコード 122000 障害支援区分6該当者        → Ⅱ
 *     決定サービスコード 123000 その他                    → Ⅲ
 *
 *   ほのぼのの実伝送 (おゆみ野・中央 2026-06) 12 件で例外なくこの対応だった。
 *   支給量内訳のキー (juudo_houmon_houkatsu / kubun6 / sonota) も同じ 3 区分で、
 *   受給者証の別欄から独立に裏が取れる。
 *
 * ── シフトのサービス名は当てにならない ────────────────────────────────
 *   稼働データ (MEISAI) 取込は時刻からコードを引くだけで段を区別する材料が無く、
 *   **全件が「重訪Ⅱ…」で登録されている**。名前の段は情報を持っていないので読まない。
 *   (2026-08-19: 14 名中 7 名がⅠなのに全員Ⅱで登録 → Ⅰの人が過少請求だった)
 *
 * ── 決められないときは推測しない ──────────────────────────────────────
 *   契約も支給量内訳も無い利用者は段が決まらない。既定値で埋めると誤請求になるので
 *   warning を返して呼出側で請求から外す。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { ID_IN_CHUNK } from "@/lib/chunk-parallel";
import { validInMonth } from "@/lib/service-code-valid";

export type JuhoTier = "Ⅰ" | "Ⅱ" | "Ⅲ";

/** 決定サービスコード → 段 */
export const JUHO_DECISION_TIER: Record<string, JuhoTier> = {
  "121000": "Ⅰ", // 重度訪問介護 重度障害者等包括支援対象者
  "122000": "Ⅱ", // 重度訪問介護 障害支援区分6該当者
  "123000": "Ⅲ", // 重度訪問介護 その他
};

/** 支給量内訳キー → 段 (受給者証の支給量欄。契約とは独立した裏取り) */
export const JUHO_SHIKYURYO_TIER: Record<string, JuhoTier> = {
  juudo_houmon_houkatsu: "Ⅰ",
  juudo_houmon_kubun6: "Ⅱ",
  juudo_houmon_sonota: "Ⅲ",
};

export interface JuhoCode {
  code: string;
  name: string;
  units: number;
}

export interface JuhoTierMaps {
  /** 段を外した素の名前 ("日中８．０") → 段ごとのコード */
  byBase: Map<string, Partial<Record<JuhoTier, JuhoCode>>>;
  /** コード → { base, tier } */
  byCode: Map<string, { base: string; tier: JuhoTier }>;
}

/** NFC 正規化した名前から段と素の名前を切り出す。重訪でなければ null */
function splitTier(name: string): { tier: JuhoTier; base: string } | null {
  // ⚠ NFKC だと「Ⅱ」が "II" に分解されて一致しなくなる。NFC を使うこと
  const m = /^重訪(Ⅰ|Ⅱ|Ⅲ)(.*)$/.exec((name ?? "").normalize("NFC"));
  return m ? { tier: m[1] as JuhoTier, base: m[2] } : null;
}

/** 対象月に有効な重訪コードを段ごとに引けるようにする */
export async function loadJuhoTierMaps(
  supabase: SupabaseClient,
  year: number,
  month: number,
): Promise<JuhoTierMaps> {
  const byBase = new Map<string, Partial<Record<JuhoTier, JuhoCode>>>();
  const byCode = new Map<string, { base: string; tier: JuhoTier }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await validInMonth(
      supabase
        .from("kaigo_service_codes")
        .select("service_code, service_name, units")
        .eq("system", "障害")
        .like("service_name", "重訪%")
        .order("service_code")
        .range(from, from + 999),
      year,
      month,
    );
    if (error) throw new Error(`重訪コードの取得に失敗: ${error.message}`);
    const rows = (data ?? []) as { service_code: string; service_name: string; units: number }[];
    for (const r of rows) {
      const s = splitTier(r.service_name);
      if (!s) continue; // 重訪移動介護加算 等は段を持たない
      if (byCode.has(r.service_code)) continue; // 世代重複は先勝ち (validInMonth 済)
      byCode.set(r.service_code, { base: s.base, tier: s.tier });
      const slot = byBase.get(s.base) ?? {};
      if (!slot[s.tier]) slot[s.tier] = { code: r.service_code, name: r.service_name, units: r.units };
      byBase.set(s.base, slot);
    }
    if (rows.length < 1000) break;
  }
  return { byBase, byCode };
}

export interface JuhoTierResolution {
  /** client_id → 段 */
  tierByClient: Map<string, JuhoTier>;
  /** 契約と支給量内訳が食い違った / 判定できなかった 等 */
  warnings: string[];
}

/**
 * 利用者ごとの段を、対象月に有効な契約 (shogai_contracts) から決める。
 * 受給者証の支給量内訳 (shougai_certifications.shikyuryo_details) でも裏を取り、
 * 食い違ったら warning を出す (どちらかが古い証拠なので気づけるようにする)。
 *
 * ⚠ 段は市町村の支給決定なので **人単位**。事業所ごとに変わらない。
 *   自事業所の契約が無ければ他事業所の契約行でも判定に使う。
 */
export async function loadJuhoTierByClient(
  supabase: SupabaseClient,
  clientIds: string[],
  year: number,
  month: number,
  opts: { officeId?: string | null } = {},
): Promise<JuhoTierResolution> {
  const monthStr = `${year}-${String(month).padStart(2, "0")}`;
  const first = `${monthStr}-01`;
  const last = `${monthStr}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const tierByClient = new Map<string, JuhoTier>();
  const warnings: string[] = [];
  if (clientIds.length === 0) return { tierByClient, warnings };

  // ── 契約 (決定サービスコード) ──
  interface Con { client_id: string; office_id: string | null; decision_code: string; start_date: string | null; end_date: string | null }
  const contracts: Con[] = [];
  for (let i = 0; i < clientIds.length; i += ID_IN_CHUNK) {
    const { data, error } = await supabase
      .from("shogai_contracts")
      .select("client_id, office_id, decision_code, start_date, end_date")
      .in("client_id", clientIds.slice(i, i + ID_IN_CHUNK))
      .in("decision_code", Object.keys(JUHO_DECISION_TIER));
    if (error) {
      // テーブル未適用 (42P01) は段の判定なし = 呼出側が warning を出す
      if (error.code === "42P01" || error.code === "PGRST205") break;
      throw new Error(`重訪の契約取得に失敗: ${error.message}`);
    }
    contracts.push(...((data ?? []) as Con[]));
  }
  // 対象月に有効な契約だけ (期間で絞る。18歳到達等で決定が切り替わるため必須)
  const inMonth = contracts.filter(
    (c) => (!c.start_date || c.start_date <= last) && (!c.end_date || c.end_date >= first),
  );
  const byClient = new Map<string, Con[]>();
  for (const c of inMonth) {
    const l = byClient.get(c.client_id);
    if (l) l.push(c);
    else byClient.set(c.client_id, [c]);
  }

  // ── 受給者証の支給量内訳 (裏取り) ──
  interface Cert { client_id: string; certification_start_date: string | null; certification_end_date: string | null; shikyuryo_details: Record<string, unknown> | null }
  const certs: Cert[] = [];
  for (let i = 0; i < clientIds.length; i += ID_IN_CHUNK) {
    const { data, error } = await supabase
      .from("shougai_certifications")
      .select("client_id, certification_start_date, certification_end_date, shikyuryo_details")
      .in("client_id", clientIds.slice(i, i + ID_IN_CHUNK));
    if (error) break; // 裏取りは無くても致命的でない
    certs.push(...((data ?? []) as Cert[]));
  }
  const certTier = new Map<string, JuhoTier>();
  for (const c of certs) {
    if (c.certification_start_date && c.certification_start_date > last) continue;
    if (c.certification_end_date && c.certification_end_date < first) continue;
    for (const [k, t] of Object.entries(JUHO_SHIKYURYO_TIER)) {
      if (c.shikyuryo_details?.[k] && !certTier.has(c.client_id)) certTier.set(c.client_id, t);
    }
  }

  for (const cid of new Set(clientIds)) {
    const cons = byClient.get(cid) ?? [];
    // 自事業所の契約を優先。無ければ他事業所の行 (段は人単位なので流用してよい)
    const mine = opts.officeId ? cons.filter((c) => c.office_id === opts.officeId) : [];
    const use = mine.length ? mine : cons;
    const tiers = new Set(use.map((c) => JUHO_DECISION_TIER[c.decision_code]).filter(Boolean));
    const fromCert = certTier.get(cid);

    if (tiers.size > 1) {
      warnings.push(
        `重度訪問介護の決定サービスコードが対象月に複数あります (${[...tiers].join("/")}) — どの段で算定するか決められないため請求から外しました`,
      );
      continue;
    }
    const fromCon = [...tiers][0];
    if (fromCon && fromCert && fromCon !== fromCert) {
      warnings.push(
        `重度訪問介護の段が契約 (${fromCon}) と受給者証の支給量欄 (${fromCert}) で食い違っています — 契約を採用しました。どちらかが古い可能性があります`,
      );
    }
    const tier = fromCon ?? fromCert;
    if (tier) tierByClient.set(cid, tier);
  }
  return { tierByClient, warnings };
}

/**
 * 重訪コードを指定の段に読み替える。
 * @returns 段が同じならそのまま / 読み替え先が無ければ null (呼出側で warning)
 */
export function remapJuhoCode(
  maps: JuhoTierMaps,
  code: string,
  tier: JuhoTier,
): JuhoCode | null {
  const cur = maps.byCode.get(code);
  if (!cur) return null; // 重訪の段付きコードではない (移動介護加算 等) → 対象外
  const slot = maps.byBase.get(cur.base);
  return slot?.[tier] ?? null;
}

/** 段付きの重訪コードかどうか */
export function isJuhoTierCode(maps: JuhoTierMaps, code: string | null | undefined): boolean {
  return !!code && maps.byCode.has(code);
}
