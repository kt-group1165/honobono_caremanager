// 他社法人マスタ (partner_companies) + 公表データ (care_offices_opendata) 共有ヘルパー
// - master/care-offices と master/providers の両画面から使う
// - DB 未適用 (partner_companies_v1.sql 未実行) でもクラッシュさせない
//   graceful degradation を isMissingPartnerSchemaError で判定する

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/keiei-bunseki";

/** care_offices_opendata (厚労省 情報公表 CSV) の 1 行 */
export interface OpendataOffice {
  office_number: string;
  name: string;
  name_kana: string | null;
  service_type: string | null;
  address: string | null;
  address_detail: string | null;
  phone_number: string | null;
  fax_number: string | null;
  corp_name: string | null;
  corp_number: string | null;
}

/**
 * table/列/リレーション未作成系のエラーコードか。
 * keiei-bunseki の isMissingSchemaError (42P01/42703/PGRST204/PGRST205) に加え、
 * embed のリレーション未検出 (PGRST200 = FK が無い) も「未適用」扱いにする。
 */
export function isMissingPartnerSchemaError(code: string | null | undefined): boolean {
  return isMissingSchemaError(code) || code === "PGRST200";
}

/** 事業所名の正規化 (空白・全角空白除去)。同名重複の警告判定に使う */
export function normalizeOfficeName(name: string): string {
  return name.replace(/[\s　]/g, "");
}

const OPENDATA_COLUMNS =
  "office_number, name, name_kana, service_type, address, address_detail, phone_number, fax_number, corp_name, corp_number";

/**
 * 公表データ検索。query が数字のみなら事業所番号の前方一致、それ以外は名称の部分一致。
 * opendata テーブル未作成でもエラーにせず missingSchema=true で返す。
 */
export async function searchOpendataOffices(
  supabase: SupabaseClient,
  query: string,
  serviceType: { eq?: string; neq?: string },
): Promise<{ rows: OpendataOffice[]; missingSchema: boolean; error: string | null }> {
  const q = query.trim();
  if (!q) return { rows: [], missingSchema: false, error: null };

  let builder = supabase
    .from("care_offices_opendata")
    .select(OPENDATA_COLUMNS)
    .order("name")
    .limit(30);
  if (serviceType.eq) builder = builder.eq("service_type", serviceType.eq);
  if (serviceType.neq) builder = builder.neq("service_type", serviceType.neq);
  builder = /^\d+$/.test(q)
    ? builder.ilike("office_number", `${q}%`)
    : builder.ilike("name", `%${q}%`);

  const { data, error } = await builder;
  if (error) {
    if (isMissingPartnerSchemaError(error.code)) {
      return { rows: [], missingSchema: true, error: null };
    }
    return { rows: [], missingSchema: false, error: error.message };
  }
  return { rows: (data ?? []) as unknown as OpendataOffice[], missingSchema: false, error: null };
}

export interface PartnerUpsertResult {
  /** partner_companies.id (missingSchema 時は null = 連携スキップ) */
  id: string | null;
  /** partner_companies 未適用 (graceful degradation で連携スキップ) */
  missingSchema: boolean;
  error: string | null;
}

/**
 * 法人番号が国税庁の 13 桁形式として妥当か。
 * opendata には Excel 経由で "3.04E+12" のような指数表記に壊れた corp_number が
 * 混在している (2026-07-14 監査: 1,600/1,602 件が壊れ) ため、
 * corp_number は必ずこれで検証してから名寄せキーに使うこと。
 */
export function isValidCorpNumber(v: string | null | undefined): v is string {
  return !!v && /^\d{13}$/.test(v);
}

/**
 * partner_companies への find-or-create。
 * 名寄せキー: ①法人番号 (13 桁として妥当な場合のみ) → ②法人名 (trim 一致)。
 * 番号が壊れている opendata でも法人名で名寄せでき、後日正しい番号付きで
 * 再取込された場合は既存行 (番号 null) に番号を補完する。
 * (select → insert 方式。23505 race は再 select)
 */
export async function upsertPartnerCompany(
  supabase: SupabaseClient,
  corpNumber: string | null,
  corpName: string | null,
): Promise<PartnerUpsertResult> {
  const validNumber = isValidCorpNumber(corpNumber) ? corpNumber : null;
  const name = corpName?.trim() || null;
  if (!validNumber && !name) return { id: null, missingSchema: false, error: null };

  // ① 法人番号で検索
  if (validNumber) {
    const { data: byNum, error: numErr } = await supabase
      .from("partner_companies")
      .select("id")
      .eq("corp_number", validNumber)
      .maybeSingle();
    if (numErr) {
      if (isMissingPartnerSchemaError(numErr.code)) {
        return { id: null, missingSchema: true, error: null };
      }
      return { id: null, missingSchema: false, error: numErr.message };
    }
    if (byNum?.id) return { id: byNum.id as string, missingSchema: false, error: null };
  }

  // ② 法人名で検索
  if (name) {
    const { data: byName, error: nameErr } = await supabase
      .from("partner_companies")
      .select("id, corp_number")
      .eq("name", name)
      .limit(1);
    if (nameErr) {
      if (isMissingPartnerSchemaError(nameErr.code)) {
        return { id: null, missingSchema: true, error: null };
      }
      return { id: null, missingSchema: false, error: nameErr.message };
    }
    const hit = byName?.[0];
    if (hit?.id) {
      if (validNumber && !hit.corp_number) {
        // 名前で先に作られた行に正しい法人番号を補完 (失敗しても連携自体は続行)
        const { error: fillErr } = await supabase
          .from("partner_companies")
          .update({ corp_number: validNumber, updated_at: new Date().toISOString() })
          .eq("id", hit.id);
        if (fillErr) console.error("corp_number 補完に失敗:", fillErr.message);
      }
      return { id: hit.id as string, missingSchema: false, error: null };
    }
  }

  // ③ 新規作成
  const { data: inserted, error: insErr } = await supabase
    .from("partner_companies")
    .insert({
      corp_number: validNumber,
      name: name ?? `法人番号 ${validNumber}`,
      source: "opendata",
    })
    .select("id")
    .single();
  if (insErr) {
    if (isMissingPartnerSchemaError(insErr.code)) {
      return { id: null, missingSchema: true, error: null };
    }
    if (insErr.code === "23505" && validNumber) {
      // 同時登録 race → 再取得
      const { data: raced, error: reErr } = await supabase
        .from("partner_companies")
        .select("id")
        .eq("corp_number", validNumber)
        .maybeSingle();
      if (reErr || !raced?.id) {
        return { id: null, missingSchema: false, error: reErr?.message ?? insErr.message };
      }
      return { id: raced.id as string, missingSchema: false, error: null };
    }
    return { id: null, missingSchema: false, error: insErr.message };
  }
  return { id: (inserted?.id as string) ?? null, missingSchema: false, error: null };
}
