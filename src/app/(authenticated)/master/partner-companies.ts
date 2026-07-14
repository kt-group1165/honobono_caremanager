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
 * 法人番号で partner_companies に upsert 相当を行い id を返す。
 * corp_number の UNIQUE は partial index (WHERE corp_number IS NOT NULL) のため、
 * PostgREST の on_conflict (ON CONFLICT (corp_number)) では arbiter に一致せず
 * 42P10 になる。そこで select → insert (+ 23505 race は再 select) で実装する。
 */
export async function upsertPartnerCompany(
  supabase: SupabaseClient,
  corpNumber: string,
  corpName: string | null,
): Promise<PartnerUpsertResult> {
  const { data: existing, error: selErr } = await supabase
    .from("partner_companies")
    .select("id")
    .eq("corp_number", corpNumber)
    .maybeSingle();
  if (selErr) {
    if (isMissingPartnerSchemaError(selErr.code)) {
      return { id: null, missingSchema: true, error: null };
    }
    return { id: null, missingSchema: false, error: selErr.message };
  }
  if (existing?.id) return { id: existing.id as string, missingSchema: false, error: null };

  const { data: inserted, error: insErr } = await supabase
    .from("partner_companies")
    .insert({
      corp_number: corpNumber,
      name: corpName?.trim() || `法人番号 ${corpNumber}`,
      source: "opendata",
    })
    .select("id")
    .single();
  if (insErr) {
    if (isMissingPartnerSchemaError(insErr.code)) {
      return { id: null, missingSchema: true, error: null };
    }
    if (insErr.code === "23505") {
      // 同時登録 race → 再取得
      const { data: raced, error: reErr } = await supabase
        .from("partner_companies")
        .select("id")
        .eq("corp_number", corpNumber)
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
