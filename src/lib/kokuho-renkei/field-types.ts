/**
 * フィールド定義型と組み立てユーティリティ
 *
 * 各レコード種別は FieldDef[] の配列で定義し、buildRecord() でレコード文字列を生成する。
 * これにより仕様書のレコードレイアウトを表形式で宣言的に記述できる。
 */

import { padAN, padN, padSignedN, padZen, sjisByteLength } from "./encoding";

export type FieldType = "AN" | "N" | "ZEN" | "SIGNED_N";

export interface FieldDef {
  name: string;           // フィールド名（可読性のため）
  type: FieldType;        // データ型
  length: number;         // バイト長（固定長）
  fixed?: string;         // 固定値（"7111"などの識別番号）
  required?: boolean;     // 必須かどうか（現状は警告出さず許容）
}

/**
 * フィールド定義配列と値オブジェクトから固定長レコード文字列を生成する
 * @param fields フィールド定義配列
 * @param values 値オブジェクト（keyはFieldDef.name）
 */
export function buildRecord(fields: FieldDef[], values: Record<string, unknown>): string {
  let result = "";
  for (const field of fields) {
    const raw = field.fixed ?? values[field.name];
    result += formatField(field, raw);
  }
  return result;
}

/**
 * 単一フィールドを整形
 */
export function formatField(field: FieldDef, value: unknown): string {
  const strValue = value === null || value === undefined ? "" : String(value);
  switch (field.type) {
    case "AN":
      return padAN(strValue, field.length);
    case "N":
      return padN(strValue, field.length);
    case "ZEN":
      return padZen(strValue, field.length);
    case "SIGNED_N":
      return padSignedN(strValue, field.length);
    default:
      return padAN(strValue, field.length);
  }
}

/**
 * レコードの総バイト長を計算
 */
export function totalRecordLength(fields: FieldDef[]): number {
  return fields.reduce((sum, f) => sum + f.length, 0);
}

/**
 * 生成されたレコードが定義通りのバイト長か検証
 */
export function validateRecordLength(record: string, fields: FieldDef[]): boolean {
  const actual = sjisByteLength(record);
  const expected = totalRecordLength(fields);
  return actual === expected;
}
