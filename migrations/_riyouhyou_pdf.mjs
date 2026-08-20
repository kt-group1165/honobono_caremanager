// ============================================================================
// 居宅の「サービス利用票」PDF を読む共通パーサ。
//
// ── なぜ利用票なのか ──────────────────────────────────────────────────
//   居宅の実績取込元は今まで 全居宅居宅サービス計.CSV だったが、あれは
//   1 列目が「国保提出区分」の **請求明細**で、請求しなかった人は出てこない。
//   そのため「6 月に提供したが 7/10 に請求できなかった」利用者 (月遅れ) が
//   丸ごと欠落し、請求漏れを検出できなかった (2026-08-20 四街道で発覚)。
//
//   利用票は請求と独立して月ごとに作られるので、月遅れの人も載る。
//   訪問介護における MEISAI (稼働データ) と同じ位置づけ。
//
//   ⚠ 利用票は **担当ケアマネごと**に出力する。1 事業所で 3〜5 ファイルになる。
//     ケアマネを 1 人出し忘れるとその担当分が丸ごと欠ける。
//
// ── 要介護度の読み方 ──────────────────────────────────────────────────
//   様式は「要介護1 2 3 4 5」が印字してあり該当に○が付く形式で、○は
//   テキスト抽出できない。代わりに **区分支給限度基準額**が印字されているので
//   そこから一意に引く (四街道 132 名で全員引けた)。
// ============================================================================
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 区分支給限度基準額 (単位/月) → 要介護度。2026 年度の値 */
export const LIMIT_TO_CARE_LEVEL = {
  5032: "要支援1",
  10531: "要支援2",
  16765: "要介護1",
  19705: "要介護2",
  27048: "要介護3",
  30938: "要介護4",
  36217: "要介護5",
};

/**
 * 氏名に出る文字。
 * ⚠ `[一-龥]` (U+4E00–U+9FA5) だけでは足りない。実データで欠けた例:
 *     々 (U+3005)        佐々木邦生 → 「木 邦生」
 *     﨑 (U+FA11)        山﨑美代子 → 拾えない  ← CJK 互換漢字 U+F900–U+FAFF
 *     ｹ (U+FF79)        四ｹ所トシ子 → 「所 トシ子」  ← 半角カナが混じる
 *   姓が丸ごと落ちて「当方に無い人」として誤検出される (2026-08-20 に 8 名分)。
 */
const NAME_CH = "[\\u3005\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF66-\\uFF9Fぁ-んァ-ヶー]";

/**
 * 利用者名の正規化。
 * ほのぼの側は同一人物を区別するために氏名へ印を付けることがあり、
 * そのまま取り込まれている (四街道: 「入）濱島ふじ子」「金子和子1」「中村光子〇」)。
 * **氏名そのものは書き換えない**。突合のときだけ落とす
 * (書き換えるとほのぼの側と対応が取れなくなる)。
 */
export function normRiyouName(s) {
  let n = (s || "").normalize("NFKC").replace(/[\s　]/g, "");
  // 先頭の状態印。閉じ括弧だけ / 開き括弧だけ の片側欠けもある
  //   「入）濱島ふじ子」= 入院。NFKC 後は 入) になる
  n = n.replace(/^[（(【[]?[^）)】\]]{0,3}[）)】\]]/, "");
  // 末尾の連番・記号 (金子和子1 / 中村光子〇)
  n = n.replace(/[0-9０-９〇○●※★☆]+$/, "");
  return n;
}

/**
 * 保険者番号 (6桁) / 被保険者番号 (10桁) を **座標**で拾う。
 *
 * ⚠ テキストを素直に連結してはいけない。利用票には暦日のヘッダ (1〜31) が
 *   1 文字ずつ並んでおり、単純連結すると "…123456789…" が番号に紛れ込む。
 *   ラベル「保険者/番号」「被保険/者番号」の y 座標に近い行だけを採る。
 *
 * @param {{x:number,y:number,t:string}[]} words ページ内の語 (座標つき)
 */
export function pickInsuranceNumbers(words) {
  const labelY = (kw) => {
    const w = words.find((w) => w.t.includes(kw));
    return w ? w.y : null;
  };
  const yInsurer = labelY("保険者") ?? null;   // 「保険者」「番号」
  const yInsured = labelY("被保険") ?? null;   // 「被保険」「者番号」

  // 1 桁数字を y でまとめ、x 順に連結
  const rows = new Map();
  for (const w of words) {
    if (!/^\d$/.test(w.t)) continue;
    const k = Math.round(w.y);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(w);
  }
  const joined = [...rows.entries()]
    .map(([y, ws]) => ({ y, s: ws.sort((a, b) => a.x - b.x).map((w) => w.t).join("") }))
    .sort((a, b) => a.y - b.y);

  /** ラベル y から下に一番近い、桁数の合う行 */
  const near = (y, len) => {
    if (y == null) return null;
    const cand = joined
      .filter((r) => r.s.length === len && r.y >= y - 12 && r.y <= y + 24)
      .sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y));
    return cand[0]?.s ?? null;
  };
  return {
    insurer: near(yInsurer, 6),
    insured: near(yInsured, 10),
  };
}

/**
 * 事業所名の突合キー。半角カナ・全角英数のゆれを NFKC で吸収する。
 *   PDF「KT在宅ｻﾎﾟｰﾄｾﾝﾀｰ」/ DB「ＫＴ在宅サポートセンター」→ どちらも KT在宅サポートセンター
 *   PDF は先頭に「*」が付くことがある (ほのぼの側の印)
 */
export function normOfficeName(s) {
  return (s || "").normalize("NFKC").replace(/[\s　*＊]/g, "");
}

/**
 * ページから「居宅介護支援事業者事業所名」を拾う。
 * ⚠ フォルダ名や PDF のファイル名から拠点を当てない。
 *   実際に「四街道利用票別表全CM.pdf」の中身が KT在宅 だった事故がある (2026-08-20)。
 *   どの事業所の利用票かは **中身で決める**。
 */
export function pickOfficeName(t) {
  const m = /\n([^\n]{3,40})\n認定済/.exec(t);
  return m ? m[1].trim() : null;
}

/**
 * 利用票 PDF 1 ファイルを読む。pdf は呼出側で fitz(PyMuPDF) 相当を使えないため、
 * テキスト抽出済みのページ配列を渡す設計にしている。
 * @param {string[]} pageTexts ページごとのテキスト
 * @param {Array<{x:number,y:number,t:string}[]>} [pageWords] ページごとの語 (座標つき)。
 *        渡すと保険者番号・被保険者番号も拾う
 * @returns {{name:string, nameKey:string, careLevel:string|null, insurer:string|null, insured:string|null, month:string|null, officeName:string|null}[]}
 */
export function parseRiyouhyouPages(pageTexts, pageWords) {
  const out = new Map(); // nameKey -> row (同一人物が複数ページに跨る)
  for (let pi = 0; pi < pageTexts.length; pi++) {
    const t = pageTexts[pi];
    const nm = new RegExp(`(${NAME_CH}{1,8}[\\s　]+${NAME_CH}{1,8})\\s*様`).exec(t);
    if (!nm) continue;
    const name = nm[1].replace(/\s+/g, " ").trim();
    const key = normRiyouName(name);
    if (out.has(key)) continue;

    // 要介護度: 区分支給限度基準額から引く
    let careLevel = null;
    for (const m of t.matchAll(/\b(\d{4,5})\b/g)) {
      const v = Number(m[1]);
      if (LIMIT_TO_CARE_LEVEL[v]) { careLevel = LIMIT_TO_CARE_LEVEL[v]; break; }
    }
    // 提供年月「令和 8年 6月分」
    const ym = /令和\s*(\d+)\s*年\s*(\d+)\s*月分/.exec(t);
    const month = ym ? `${2018 + Number(ym[1])}-${String(Number(ym[2])).padStart(2, "0")}` : null;

    const nums = pageWords?.[pi] ? pickInsuranceNumbers(pageWords[pi]) : { insurer: null, insured: null };
    out.set(key, {
      name, nameKey: key, careLevel,
      insurer: nums.insurer, insured: nums.insured, month,
      officeName: pickOfficeName(t),
    });
  }
  return [...out.values()];
}

/** dir 配下 (再帰) の PDF を集める。0 バイトは出力失敗なので弾いて知らせる */
export function findRiyouhyouPdfs(dir) {
  const out = [];
  const empty = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = path.join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.pdf$/i.test(name)) {
        if (st.size === 0) empty.push(p);
        else out.push(p);
      }
    }
  };
  walk(dir);
  return { files: out.sort(), empty };
}
