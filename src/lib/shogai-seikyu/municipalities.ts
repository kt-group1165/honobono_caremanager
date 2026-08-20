/**
 * 障害の市町村番号 (支給決定市町村) → 名称・所在地。
 *
 * ── 何に使うか ────────────────────────────────────────────────────────
 *   契約内容報告書 (様式第26号) の提出先 (〒・住所・「〇〇市長　様」) を出すため。
 *   伝送は番号しか使わないので、名称・住所が要るのは紙の帳票だけ。
 *
 * ── どこから来た値か (推測していない) ──────────────────────────────────
 *   番号 → 名称:
 *     受給者証 PDF 取込の JSON (migrations/shougai_import_*.json) の `city` と、
 *     DB の shougai_certifications (beneficiary_number → insurer_municipality) を
 *     受給者証番号で突き合わせて起こした (2026-08-19)。
 *     28 件すべて 1 番号 = 1 名称で候補が割れなかった。
 *   郵便番号・住所:
 *     千葉県 公式「市町村一覧」https://www.pref.chiba.lg.jp/kouhou/ichiran.html
 *     (県が公表する市町村役場の所在地。2026-08-19 取得)
 *
 *   ⚠ 障害の市町村番号は **JIS 5 桁 + modulus10 のチェックデジット**。
 *     介護保険の保険者番号とも、地方公共団体コード (modulus11) とも別物なので
 *     他所の対応表を流用しないこと (feedback_shogai_shichoson_number)。
 *
 *   ⚠ 千葉市の郵便番号は県の一覧が 260-8722 (市役所の大口個別番号)、
 *     ほのぼのの出力は 260-0026 (千葉港の地域番号)。どちらでも届くが、
 *     出典を 1 つに揃えたいので県の公表値を採る。
 *
 *   新しい市町村が出たら、県の一覧を見て 1 行足す。
 *   分からないまま推測で足さない — 提出先を間違えると書類が届かない。
 */

export interface ShogaiMunicipality {
  name: string;
  /** 郵便番号 (ハイフンあり)。「〒」は付けない */
  postalCode: string;
  /** 市町村役場の所在地。県の一覧は都道府県名を含まないので「千葉県」は付けて持つ */
  address: string;
}

export const SHOGAI_MUNICIPALITIES: Record<string, ShogaiMunicipality> = {
  "121004": { name: "千葉市", postalCode: "260-8722", address: "千葉県千葉市中央区千葉港1-1" },
  "122044": { name: "船橋市", postalCode: "273-8501", address: "千葉県船橋市湊町2-10-25" },
  "122069": { name: "木更津市", postalCode: "292-8501", address: "千葉県木更津市富士見1-2-1" },
  "122077": { name: "松戸市", postalCode: "271-8588", address: "千葉県松戸市根本387-5" },
  "122101": { name: "茂原市", postalCode: "297-8511", address: "千葉県茂原市道表1" },
  "122135": { name: "東金市", postalCode: "283-8511", address: "千葉県東金市東岩崎1-1" },
  "122168": { name: "習志野市", postalCode: "275-8601", address: "千葉県習志野市鷺沼2-1-1" },
  "122176": { name: "柏市", postalCode: "277-8505", address: "千葉県柏市柏5-10-1" },
  "122184": { name: "勝浦市", postalCode: "299-5292", address: "千葉県勝浦市新官1343-1" },
  "122192": { name: "市原市", postalCode: "290-8501", address: "千葉県市原市国分寺台中央1-1-1" },
  "122218": { name: "八千代市", postalCode: "276-8501", address: "千葉県八千代市大和田新田312-5" },
  "122283": { name: "四街道市", postalCode: "284-8555", address: "千葉県四街道市鹿渡無番地" },
  "122291": { name: "袖ケ浦市", postalCode: "299-0292", address: "千葉県袖ケ浦市坂戸市場1-1" },
  "122309": { name: "八街市", postalCode: "289-1192", address: "千葉県八街市八街ほ35-29" },
  "122358": { name: "匝瑳市", postalCode: "289-2198", address: "千葉県匝瑳市八日市場ハ793-2" },
  "122374": { name: "山武市", postalCode: "289-1392", address: "千葉県山武市殿台296" },
  "122382": { name: "いすみ市", postalCode: "298-8501", address: "千葉県いすみ市大原7400-1" },
  "122390": { name: "大網白里市", postalCode: "299-3292", address: "千葉県大網白里市大網115-2" },
  "123224": { name: "酒々井町", postalCode: "285-8510", address: "千葉県印旛郡酒々井町中央台4-11" },
  "124032": { name: "九十九里町", postalCode: "283-0195", address: "千葉県山武郡九十九里町片貝4099" },
  "124214": { name: "一宮町", postalCode: "299-4396", address: "千葉県長生郡一宮町一宮2457" },
  "124222": { name: "睦沢町", postalCode: "299-4492", address: "千葉県長生郡睦沢町下之郷1650-1" },
  "124230": { name: "長生村", postalCode: "299-4394", address: "千葉県長生郡長生村本郷1-77" },
  "124248": { name: "白子町", postalCode: "299-4292", address: "千葉県長生郡白子町関5074-2" },
  "124263": { name: "長柄町", postalCode: "297-0298", address: "千葉県長生郡長柄町桜谷712" },
  "124271": { name: "長南町", postalCode: "297-0192", address: "千葉県長生郡長南町長南2110" },
  "124412": { name: "大多喜町", postalCode: "298-0292", address: "千葉県夷隅郡大多喜町大多喜93" },
  "124438": { name: "御宿町", postalCode: "299-5192", address: "千葉県夷隅郡御宿町須賀1522" },
};

/** 市町村の情報。番号が対応表に無ければ null */
export function municipality(code: string | null | undefined): ShogaiMunicipality | null {
  const s = (code ?? "").trim();
  return s ? (SHOGAI_MUNICIPALITIES[s] ?? null) : null;
}

/**
 * 市町村名。番号が対応表に無ければ null。
 * ⚠ 一部の受給者証は insurer_municipality に **番号ではなく名称**が入っている
 *   (取込時に番号を解決できなかった 4 件)。その場合はそのまま名称として扱う。
 */
export function municipalityName(code: string | null | undefined): string | null {
  const s = (code ?? "").trim();
  if (!s) return null;
  const m = SHOGAI_MUNICIPALITIES[s];
  if (m) return m.name;
  // 数字でない = 名称が直接入っている (未解決データ)
  return /^\d+$/.test(s) ? null : s;
}

/** 提出先の宛名。「千葉市」→「千葉市長」/「長生村」→「長生村長」 */
export function municipalityHead(code: string | null | undefined): string | null {
  const n = municipalityName(code);
  if (!n) return null;
  // 末尾が 市/区/町/村 なら そのまま + 長。それ以外は判断できないので名称だけ返す
  return /[市区町村]$/.test(n) ? `${n}長` : n;
}
