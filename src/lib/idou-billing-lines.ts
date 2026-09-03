/**
 * 千葉市 地域生活支援給付 様式13 明細書の行組み立て。
 *
 *   ⚠ 2026-09-03 に idou-billing-content.tsx (client component) から切り出した。
 *     client component の中にあると **テストから呼べず、検証できなかった**。
 *     実際、切り出す前は「加算が 1 行も出ない」不具合が入ったまま気づけていなかった
 *     (様式3-1 実績記録票は 初回加算を ○ で印字するのに、様式13 明細書には載らない)。
 *
 *   制度: migrations/_if_idou_shien_chiba.txt (千葉市 R6.4.1)
 *     初回加算       218単位 **月1回限度**   移動1=024701 / 移動2=027701
 *     緊急時対応加算 109単位 **月2回限度**   ★ 身体介護有りのみ 024801
 *     2人目従業者    単位は同額 (×100%) で別コード (千葉市コード表は 単独/・2人 が連番)
 */

export type IdouLineSource = {
  client_id: string;
  service_code: string | null;
  staff_count: number;
  with_body_care: boolean;
  addon_shokai: boolean;
  addon_kinkyu: boolean;
};
export type BathLineSource = { client_id: string; service_code: string | null };
export type CodeInfoEntry = { name: string; unit: number };
export type MeisaiLine = { code: string; name: string; unit: number; count: number; total: number };

/** 初回加算 (移動1 / 移動2) と 緊急時対応加算 のコード */
export const IDOU_ADDON_CODES = {
  shokaiBody: "024701",
  shokaiNoBody: "027701",
  kinkyu: "024801",
} as const;

/** 緊急時対応加算の月間限度 (千葉市 R6.4.1) */
export const KINKYU_MONTHLY_LIMIT = 2;

/** 2人目従業者コード = base+1 (単位は同額) */
export function secondPersonCode(
  base: string,
  codeInfo: Map<string, CodeInfoEntry>,
): { code: string; name: string; unit: number } {
  const code = String(Number(base) + 1).padStart(6, "0");
  const info = codeInfo.get(base);
  return { code, name: (info?.name ?? base) + "・2人", unit: info?.unit ?? 0 };
}

/**
 * 利用者ごとの明細行を組み立てる。
 * @returns client_id → 明細行 (同一コードは 回数・単位数を合算)
 */
export function buildIdouMeisaiLines(
  idouRows: IdouLineSource[],
  bathRows: BathLineSource[],
  codeInfo: Map<string, CodeInfoEntry>,
): Map<string, MeisaiLine[]> {
  const map = new Map<string, MeisaiLine[]>();
  const addLine = (clientId: string, code: string, name: string, unit: number) => {
    let lines = map.get(clientId);
    if (!lines) { lines = []; map.set(clientId, lines); }
    const ex = lines.find((l) => l.code === code);
    if (ex) { ex.count += 1; ex.total += unit; }
    else lines.push({ code, name, unit, count: 1, total: unit });
  };
  const addByCode = (clientId: string, code: string | null) => {
    if (!code) return;
    const info = codeInfo.get(code);
    addLine(clientId, code, info?.name ?? code, info?.unit ?? 0);
  };

  // 加算は **回数制**なので、日ごとではなく利用者ごとに集計してから行にする
  //   (時間から決まらないので resolveIdouCode は加算を扱わない。足すのはここの責任)
  const shokaiBody = new Map<string, boolean>(); // 初回加算あり → 身体介護の有無
  const kinkyuCount = new Map<string, number>();

  for (const r of idouRows) {
    addByCode(r.client_id, r.service_code);
    if (r.staff_count === 2 && r.service_code) {
      const s = secondPersonCode(r.service_code, codeInfo);
      addLine(r.client_id, s.code, s.name, s.unit);
    }
    if (r.addon_shokai && !shokaiBody.has(r.client_id)) shokaiBody.set(r.client_id, r.with_body_care);
    // ⚠ 緊急時対応加算は **身体介護有りのみ**。身体なしの回は数えない
    if (r.addon_kinkyu && r.with_body_care) {
      kinkyuCount.set(r.client_id, (kinkyuCount.get(r.client_id) ?? 0) + 1);
    }
  }

  // 初回加算 **月1回限度**
  for (const [clientId, body] of shokaiBody) {
    const code = body ? IDOU_ADDON_CODES.shokaiBody : IDOU_ADDON_CODES.shokaiNoBody;
    const info = codeInfo.get(code);
    addLine(clientId, code, info?.name ?? code, info?.unit ?? 0);
  }
  // 緊急時対応加算 **月2回限度**
  for (const [clientId, n] of kinkyuCount) {
    const info = codeInfo.get(IDOU_ADDON_CODES.kinkyu);
    for (let i = 0; i < Math.min(n, KINKYU_MONTHLY_LIMIT); i++) {
      addLine(clientId, IDOU_ADDON_CODES.kinkyu, info?.name ?? IDOU_ADDON_CODES.kinkyu, info?.unit ?? 0);
    }
  }

  for (const b of bathRows) addByCode(b.client_id, b.service_code);
  return map;
}
