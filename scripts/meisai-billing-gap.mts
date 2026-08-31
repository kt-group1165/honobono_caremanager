/**
 * 「ヘルパーが働いているのに、どこにも請求されていない利用者」を洗い出す。
 *
 * ══ なぜ要るか ═══════════════════════════════════════════════════════════════
 *   2026-08-31、高品の 加茂 照子 に 28 回の稼働 (身1×21 / 身3×2 / 身2×1 / 同行×4) が
 *   あるのに、**伝送データ全体を探しても 1 行も無い** ことが分かった。
 *   有効な認定 (要介護5) を持っているので資格が無いわけでもない。
 *   1 人の話とは思えないので、同じものを全拠点・全 MEISAI で機械的に出す。
 *
 * ══ 使い方 ═══════════════════════════════════════════════════════════════════
 *   npm run check:billing-gap
 *   MONTH=2026-06 npm run check:billing-gap
 *   npm run check:billing-gap -- --area 高品
 *
 *   出る金額は MEISAI の「金額」= **ヘルパーに払った賃金**。請求額ではない。
 *
 *   DB は読み取りのみ。伝送データも読むだけ (新システム/*.CSV は書かない)。
 *
 * ══ 判定 ═════════════════════════════════════════════════════════════════════
 *   MEISAI に稼働行がある利用者について、その番号が **同じ制度の伝送**に出てくるかを見る。
 *     介護の稼働 → 被保険者番号 が 介護/居宅 の伝送に出てくるか
 *     障害の稼働 → 受給者証番号 が 障害 の伝送に出てくるか
 *
 *   ⚠ 制度をまたいで一括で見てはいけない。両制度を持つ利用者は 59 名いて、
 *     「障害では請求されているが介護は未請求」が実在する
 *     (高品 加茂 照子: 介護 28 回が未請求なのに障害は請求済み)。
 *
 *   ⚠ 逆に、**制度をフォルダで決めつけてもいけない**。MEISAI の 制度フォルダと
 *     実際の制度は一致しないことがある (四街道 松戸 孝雄 は 介護 フォルダだが
 *     コードは 021001/021002 = 自立支援で、障害の KJ260701 で請求済みだった)。
 *     MEISAI のコードは ほのぼの内部コードなので機械的に制度を確定できない。
 *     そこで **もう一方の制度での請求状況も併記**して、人が判断できるようにする。
 *
 *   ⚠ **MEISAI はヘルパーの勤務実績であって請求実績ではない。**
 *     自費サービス・保険外・他事業所が請求 のケースが正当に有りうるので、
 *     ここに出たものが全部 請求漏れとは限らない。**人が見るための一覧**。
 *     (前例: 姉ム 工藤 孝子 81,999 円は被保番なしで載っていた 2026-08-04)
 *
 *   ⚠ 伝送データが手元に無い拠点は判定できないので「判定不能」として分けて出す。
 *     無いものを「請求漏れ」と言わない。
 *
 *   請求が見当たらない人は **他の月に請求があるか**も併せて出す。意味がまるで違う。
 *     他の月にはある → その月だけ抜けている = **取りこぼしの疑いが濃い**
 *     どの月にも無い → もともと請求していない = 自費運用などの可能性が高い
 *
 * ══ 利用者の引き当て (ここで一度しくじった) ══════════════════════════════════
 *   最初は取込の `_meisai_num_to_client_<拠点>.json` だけで引いていたが、
 *   **障害の取込はこのファイルを使っていない** (import_meisai_shougai_records.mjs は
 *   受給者証ベース)。そのため「マッピングに無い = 取り込めていない」と誤って
 *   621 名を挙げてしまった。実際には おゆみ野 稲葉 裕子 は 528 件入っていた。
 *
 *   引き当ては 2 段構えにする。
 *     1. `_meisai_num_to_client_<拠点>.json`
 *     2. clients.user_number 直引き — ただし **氏名が一致したときだけ**
 *
 *   ⚠ 番号だけで引くと別人に当たる。MEISAI の「232」は DB では 泉水 さき の
 *     user_number で、MEISAI 上の 松戸 孝雄 は「100232」だった。
 *     氏名で裏を取らないと、ある人の稼働が別人のものとして集計される。
 *   そのうえで「取り込めているか」は **DB に実績が有るかを実際に数えて**判定する。
 *   取込の内部事情を推測しない。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KAIGO = join(__dirname, "..");
const MONTH = process.env.MONTH ?? "2026-06";
const YYYYMM = MONTH.replace("-", "");
const AREA = (() => {
  const i = process.argv.indexOf("--area");
  return i >= 0 ? process.argv[i + 1] : "";
})();

function loadEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(join(KAIGO, ".env.local"), "utf8");
    const vars: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = /^([^#=\s][^=]*)=(.*)$/.exec(line);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const env = loadEnvLocal();
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.log("check:billing-gap: スキップ (env 必要)");
  process.exit(0);
}
const supabase = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const decodeSjis = (p: string): string => new TextDecoder("shift_jis").decode(readFileSync(p));

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/** MEISAI 1 行ぶん。列はファイルごとに違うので **ヘッダー名で引く** */
interface Worked {
  area: string;
  file: string;
  clientNum: string;
  clientName: string;
  rows: number;
  amount: number;
  codes: Set<string>;
  system: "介護" | "障害" | "?";
}

function readMeisai(): Map<string, Worked> {
  const out = new Map<string, Worked>();
  const base = join(KAIGO, "サービス実績データ");
  walk(base, (p) => {
    if (!/^MEISAI.*\.csv$/i.test(basename(p))) return;
    const rel = p.slice(base.length + 1);
    const parts = rel.split(sep);
    const area = parts[0];
    if (AREA && area !== AREA) return;
    if (!rel.includes(YYYYMM)) return;
    const system = rel.includes(`${sep}障害${sep}`) ? "障害" : rel.includes(`${sep}介護${sep}`) ? "介護" : "?";

    const lines = decodeSjis(p).split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const header = lines[0].split(",").map((h) => h.trim());
    const gi = (n: string) => header.indexOf(n);
    const iNum = gi("利用者番号"), iName = gi("利用者名"), iCode = gi("サービスコード"), iAmt = gi("金額");
    if (iNum < 0 || iName < 0) return;         // MEISAI ではない (CHINGIN 等)
    for (const line of lines.slice(1)) {
      const c = line.split(",");
      const num = (c[iNum] ?? "").trim();
      if (!num) continue;
      const key = `${area}|${system}|${num}`;
      let w = out.get(key);
      if (!w) {
        w = { area, file: basename(p), clientNum: num, clientName: (c[iName] ?? "").trim(), rows: 0, amount: 0, codes: new Set(), system };
        out.set(key, w);
      }
      w.rows++;
      const amt = Number((c[iAmt] ?? "").replace(/[^0-9.-]/g, ""));
      if (Number.isFinite(amt)) w.amount += amt;
      const code = (c[iCode] ?? "").trim();
      if (code) w.codes.add(code);
    }
  });
  return out;
}

/**
 * 伝送データを 1 回だけ走査して「番号 → その番号が請求された提供年月の集合」を作る。
 *
 * ⚠ **月はフォルダ名で決めてはいけない。行に書かれている提供年月で決める。**
 *   月遅れ請求は翌月のフォルダに入る (例: 大網 池田 芳勝 の 202606 分は
 *   202607 フォルダの KK260801 に入っている)。フォルダで数えると
 *   「6 月だけ請求が無い」と誤判定する (2026-08-31 に実際に踏んだ)。
 *
 * 制度はフォルダで決まる: …/訪問介護/障害/… は障害、それ以外は介護。
 */
interface DensouIndex {
  /** 制度 → 番号 → 提供年月 (YYYY-MM) の集合 */
  kaigo: Map<string, Set<string>>;
  shogai: Map<string, Set<string>>;
  areas: Set<string>;
  files: number;
  months: Set<string>;
}

function readDensouIndex(): DensouIndex {
  const idx: DensouIndex = {
    kaigo: new Map(), shogai: new Map(), areas: new Set(), files: 0, months: new Set(),
  };
  const base = join(KAIGO, "伝送データ");
  if (!existsSync(base)) return idx;
  walk(base, (p) => {
    const name = basename(p);
    if (!/\.csv$/i.test(name)) return;
    if (/解説/.test(name)) return;
    // 当方が書き出したものは「ほのぼのが請求したか」の判定材料にならない
    if (p.includes(`${sep}新システム${sep}`)) return;
    idx.files++;
    const rel = p.slice(base.length + 1);
    idx.areas.add(rel.split(sep)[0]);
    const into = rel.includes(`${sep}障害${sep}`) ? idx.shogai : idx.kaigo;
    for (const line of decodeSjis(p).split(/\r?\n/)) {
      if (!line) continue;
      // 提供年月は 6 桁で、前後がカンマ (認定期間などの 8 桁日付とは区別される)
      const ymMatches = [...line.matchAll(/,(20\d{4}),/g)].map((m) => m[1]);
      if (ymMatches.length === 0) continue;
      // ⚠ 6 桁の数字は単位数や金額でも出るので、**月として成立するものだけ**採る。
      //   絞らないと 2097-48 のような値が混ざり、偶然 202606 と一致した行で
      //   「請求済み」と誤判定しうる。
      const months = [...new Set(ymMatches)]
        .filter((y) => {
          const yy = Number(y.slice(0, 4)), mm = Number(y.slice(4));
          return yy >= 2015 && yy <= 2035 && mm >= 1 && mm <= 12;
        })
        .map((y) => `${y.slice(0, 4)}-${y.slice(4)}`);
      if (months.length === 0) continue;
      months.forEach((m) => idx.months.add(m));
      for (const nm of line.matchAll(/[0-9A-Za-z]{10}/g)) {
        let set = into.get(nm[0]);
        if (!set) { set = new Set(); into.set(nm[0], set); }
        months.forEach((m) => set!.add(m));
      }
    }
  });
  return idx;
}

async function fetchAll<T>(build: () => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const { data, error } = await build();
  if (error) throw new Error(String((error as { message?: string }).message ?? error));
  return data ?? [];
}

async function main(): Promise<void> {
  console.log(`稼働はあるのに請求されていない利用者を探す (${MONTH})${AREA ? ` — 拠点=${AREA}` : ""}`);

  const worked = readMeisai();
  console.log(`MEISAI: 利用者 ${worked.size} 件ぶん (拠点×制度×利用者番号)`);

  const densou = readDensouIndex();
  console.log(`伝送データ: ${densou.files} 本 / 拠点 ${densou.areas.size} / 番号 介護 ${densou.kaigo.size} 種類・障害 ${densou.shogai.size} 種類`);
  const ms = [...densou.months].sort();
  console.log(`伝送に出てくる提供年月: ${ms.length} 種類 (${ms[0] ?? "-"} 〜 ${ms[ms.length - 1] ?? "-"})`);
  if (densou.files === 0) {
    console.log("伝送データが 1 本も無いので判定できません。");
    process.exit(0);
  }

  // 利用者番号 → client_id (取込と同じマッピングファイルを使う)
  const mapCache = new Map<string, Record<string, string>>();
  // ⚠ 対応表のファイル名は **フォルダ名と一致しない**。取込は TAG で読むので
  //   さつきが丘 の表は `_meisai_num_to_client_さつき.json` にある。
  //   フォルダ名だけで探すと表が無いことになり、番号だけの引き当てに落ちて
  //   別人に当たる (2026-09-01 是正。さつきが丘 3 名がこれで誤検出されていた)。
  const existingTags = readdirSync(join(KAIGO, "migrations"))
    .filter((f) => /^_meisai_num_to_client_.*\.json$/.test(f))
    .map((f) => f.replace("_meisai_num_to_client_", "").replace(".json", ""));
  const loadMap = (area: string): Record<string, string> | null => {
    if (mapCache.has(area)) return mapCache.get(area)!;
    let tag: string | undefined = existingTags.includes(area) ? area : undefined;
    if (!tag) {
      const cands = existingTags.filter((t) => area.startsWith(t) && t.length >= 2);
      cands.sort((a, b) => b.length - a.length);
      tag = cands[0];
    }
    if (!tag) return null;
    const p = join(KAIGO, "migrations", `_meisai_num_to_client_${tag}.json`);
    if (!existsSync(p)) return null;
    const m = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
    mapCache.set(area, m);
    return m;
  };

  // clients.user_number → id (マッピングファイルで引けないぶんの受け皿)
  const byUserNumber = new Map<string, string[]>();
  const clientName = new Map<string, string>();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("clients").select("id, user_number, name").order("id").range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const c of (data ?? []) as { id: string; user_number: string | null; name: string | null }[]) {
        clientName.set(c.id, c.name ?? "");
        const n = (c.user_number ?? "").trim();
        if (!n) continue;
        if (!byUserNumber.has(n)) byUserNumber.set(n, []);
        byUserNumber.get(n)!.push(c.id);
      }
      if (!data || data.length < PAGE) break;
    }
  }

  /**
   * 氏名の表記ゆれを畳む。全角/半角・空白・括弧書きに加えて、
   * **姓によく出る異体字**を寄せる (髙/高・﨑/崎・澤/沢 など)。
   * ⚠ 寄せるのは字形の異体だけ。読みが同じでも別字のもの (齊藤/斎藤 等) は寄せない。
   */
  const ITAIJI: Record<string, string> = {
    "髙": "高", "﨑": "崎", "澤": "沢", "眞": "真", "濱": "浜",
    "邊": "辺", "邉": "辺", "瀨": "瀬", "德": "徳", "曻": "昇",
  };
  const normName = (v: string): string =>
    v.normalize("NFKC")
      .replace(/[（(].*?[)）]/g, "")
      .replace(/[\s　]/g, "")
      .replace(/./g, (ch) => ITAIJI[ch] ?? ch)
      .trim();

  const clientIds = new Set<string>();
  const resolved = new Map<string, string>();     // key -> client_id
  const unresolved: Worked[] = [];                // どちらの手でも利用者に辿り着けない
  const nameConflict: string[] = [];              // 番号は当たるが氏名が違う (= 別人)
  for (const [key, w] of worked) {
    const m = loadMap(w.area);
    let cid = m?.[w.clientNum];
    if (!cid) {
      // 番号だけで引くと別人に当たるので、**氏名が一致したときだけ**採用する
      // MEISAI の氏名には制度の区別記号が付く (「宇野　純一　障」「稲葉　裕子　支」
      // 「松崎　淑子　移」)。完全一致では別人扱いになるので前方一致で見る。
      const sameName = (a: string, b: string): boolean => {
        const x = normName(a), y = normName(b);
        if (!x || !y) return false;
        if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
        // 名がカタカナと漢字で違うだけのことがある (「齊藤ﾕｳｷ」と「齊藤 優希」)。
        // ここは **番号が一致している**前提なので、姓が同じなら同一人とみなす。
        return x.slice(0, 2) === y.slice(0, 2);
      };
      const hits = (byUserNumber.get(w.clientNum) ?? []).filter(
        (id) => sameName(clientName.get(id) ?? "", w.clientName),
      );
      if (hits.length === 1) cid = hits[0];
      else if ((byUserNumber.get(w.clientNum) ?? []).length > 0) {
        const other = (byUserNumber.get(w.clientNum) ?? []).map((id) => clientName.get(id) ?? "?");
        nameConflict.push(`${w.area} 番号${w.clientNum} MEISAI「${w.clientName}」 vs 当方「${other.join("/")}」`);
      }
    }
    if (!cid) { unresolved.push(w); continue; }
    resolved.set(key, cid);
    clientIds.add(cid);
  }
  if (nameConflict.length) {
    console.log(`${EOL_}⚠ 番号は当たるが氏名が違う ${nameConflict.length} 件 — 別人に紐づけないよう引き当てから外した:`);
    [...new Set(nameConflict)].slice(0, 15).forEach((c) => console.log("   " + c));
    if (nameConflict.length > 15) console.log(`   … 他 ${nameConflict.length - 15} 件`);
  }

  // client_id → 番号。介護 (被保険者番号) と 障害 (受給者証番号) を分けて持つ
  const kaigoNo = new Map<string, string[]>();
  const shogaiNo = new Map<string, string[]>();
  // 対象月に **保険の資格があるか**。自費運用か請求漏れかを切り分ける決め手になる
  const hasKaigoCert = new Set<string>();
  const hasShogaiCert = new Set<string>();
  type CertRow = {
    client_id: string; insured_number?: string | null;
    certification_start_date: string | null; certification_end_date: string | null;
  };
  const [my2, mm2] = MONTH.split("-").map(Number);
  const mEnd = `${MONTH}-${String(new Date(my2, mm2, 0).getDate()).padStart(2, "0")}`;
  const coversMonth = (c: { certification_start_date: string | null; certification_end_date: string | null }) =>
    !(c.certification_start_date && c.certification_start_date > mEnd)
    && !(c.certification_end_date && c.certification_end_date < `${MONTH}-01`);
  const ids = [...clientIds];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const certs = await fetchAll<CertRow>(() =>
      supabase.from("client_insurance_records")
        .select("client_id, insured_number, certification_start_date, certification_end_date")
        .in("client_id", chunk));
    for (const c of certs) {
      if (coversMonth(c)) hasKaigoCert.add(c.client_id);
      if (!c.insured_number) continue;
      if (!kaigoNo.has(c.client_id)) kaigoNo.set(c.client_id, []);
      kaigoNo.get(c.client_id)!.push(c.insured_number.trim());
    }
    const sho = await fetchAll<CertRow & { beneficiary_number: string | null }>(() =>
      supabase.from("shougai_certifications")
        .select("client_id, beneficiary_number, certification_start_date, certification_end_date")
        .in("client_id", chunk));
    for (const c of sho) {
      if (coversMonth(c)) hasShogaiCert.add(c.client_id);
      if (!c.beneficiary_number) continue;
      if (!shogaiNo.has(c.client_id)) shogaiNo.set(c.client_id, []);
      shogaiNo.get(c.client_id)!.push(c.beneficiary_number.trim());
    }
  }

  // 各利用者の当月の実績件数を実測する (取込の内部事情を推測しない)
  const recCount = new Map<string, number>();
  {
    const [my, mm] = MONTH.split("-").map(Number);
    const from = `${MONTH}-01`;
    const to = `${MONTH}-${String(new Date(my, mm, 0).getDate()).padStart(2, "0")}`;
    const idList = [...clientIds];
    // ⚠ PostgREST は 1 回で 1000 行しか返さない。limit を大きくしても効かないので
    //   必ず range() で回しきる。ここを忘れると「実績が無い」と誤判定する
    //   (最初の版で 1,411 名を取込漏れと誤って挙げた)。
    const PAGE = 1000;
    for (let i = 0; i < idList.length; i += 100) {
      const chunk = idList.slice(i, i + 100);
      for (let fromRow = 0; ; fromRow += PAGE) {
        const { data, error } = await supabase
          .from("kaigo_visit_schedule").select("user_id").in("user_id", chunk)
          .gte("visit_date", from).lte("visit_date", to)
          .order("id").range(fromRow, fromRow + PAGE - 1);
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as { user_id: string }[]) {
          recCount.set(r.user_id, (recCount.get(r.user_id) ?? 0) + 1);
        }
        if (!data || data.length < PAGE) break;
      }
    }
  }

  const notImported: Worked[] = [];
  /** 別制度では請求されているが、この制度では請求が見当たらない (情報として出す) */
  const crossSystem: Worked[] = [];
  const notBilled: (Worked & { why: string; otherMonths: string[]; otherSystemBilled: boolean })[] = [];
  const noNumber: Worked[] = [];
  let billed = 0;
  for (const [key, w] of worked) {
    const cid = resolved.get(key);
    if (!cid) continue;                                   // unmapped は別枠
    // ⚠ **番号は制度別に持たない。両制度を合わせて見る。**
    //   介護認定を持たず受給者証だけの利用者が 介護 フォルダの MEISAI に出ることがあり
    //   (四街道 松戸 孝雄)、制度別に引くと「番号が無い」「請求が無い」と誤判定する。
    //   実際それで 251 名を「番号未登録」に挙げてしまっていた。
    const allNums = [...new Set([...(kaigoNo.get(cid) ?? []), ...(shogaiNo.get(cid) ?? [])])];
    if ((recCount.get(cid) ?? 0) === 0) notImported.push(w);   // 稼働はあるのに実績が DB に無い
    if (allNums.length === 0) { noNumber.push(w); continue; }

    /** その番号が **対象月ぶんとして** 請求されているか (月遅れでも提供年月で拾える) */
    const billedIn = (n: string, m: string) =>
      densou.kaigo.get(n)?.has(m) || densou.shogai.get(n)?.has(m);
    if (allNums.some((n) => billedIn(n, MONTH))) {
      billed++;
      // 制度別に見ると片方だけ請求されていることがある (加茂 照子: 障害は請求済み・介護は未請求)。
      // 数には入れず、気づけるように記録だけしておく。
      const isShogai = w.system === "障害";
      const pool = isShogai ? densou.shogai : densou.kaigo;
      const own = (isShogai ? shogaiNo.get(cid) : kaigoNo.get(cid)) ?? [];
      if (own.length > 0 && !own.some((n) => pool.get(n)?.has(MONTH))) crossSystem.push(w);
      continue;
    }
    if (!densou.areas.has(w.area)) continue;              // その拠点の伝送が手元に無い → 判定不能

    // 他の月には請求があるか。あるならその月だけ抜けている = 取りこぼしの疑いが濃い
    const otherMonths = [...new Set(allNums.flatMap((n) => [
      ...(densou.kaigo.get(n) ?? []), ...(densou.shogai.get(n) ?? []),
    ]))].filter((m) => m !== MONTH).sort();
    notBilled.push({ ...w, why: `番号 ${allNums.join("/")} が伝送に無い`, otherMonths, otherSystemBilled: false });
  }

  // ⚠ MEISAI の「金額」は **ヘルパーに払った賃金** (出どころが NEXT の賃金集計)。
  //   請求額ではないので、そのつもりで表示する。桁の大きさを掴むための目安。
  const yen = (n: number) => n.toLocaleString() + "円";
  console.log("");
  console.log(`請求されている ${billed} / 請求が見当たらない ${notBilled.length} / 番号未登録 ${noNumber.length}`);
  console.log(`実績が DB に入っていない ${notImported.length} / 利用者に辿り着けない ${unresolved.length}`);

  if (notBilled.length) {
    console.log(`${EOL_}★ 稼働はあるのに伝送に 1 行も無い (${notBilled.length} 名) — 人が見て 自費/保険外/他事業所請求 でないか確かめること
   (金額は **ヘルパーに払った賃金**。請求額ではない)`);
    notBilled.sort((a, b) => b.amount - a.amount);
    // 「その月だけ抜けている」ほうが取りこぼしの疑いが濃いので先に出す
    const onlyThisMonth = notBilled.filter((w) => w.otherMonths.length > 0);
    const never = notBilled.filter((w) => w.otherMonths.length === 0);
    if (onlyThisMonth.length) {
      console.log(`${EOL_}  ── ★★ 他の月には請求がある = **その月だけ抜けている** (${onlyThisMonth.length} 名) ──`);
      for (const w of onlyThisMonth) {
        console.log(`   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}  請求のある月: ${w.otherMonths.join(",")}`);
      }
    }
    if (never.length) {
      // 制度またぎは別枠 (crossSystem) で出すので、ここに来るのは全部「本命」
      const pure = never;
      if (pure.length) {
        // 対象月に保険の資格があるかで意味が変わる。
        //   資格あり → 請求できたはずなのにしていない = **請求漏れの疑いが濃い**
        //   資格なし → そもそも保険を使えない = 自費で当然
        const withCert = pure.filter((w) => hasKaigoCert.has(resolved.get(`${w.area}|${w.system}|${w.clientNum}`) ?? "")
          || hasShogaiCert.has(resolved.get(`${w.area}|${w.system}|${w.clientNum}`) ?? ""));
        const withoutCert = pure.filter((w) => !withCert.includes(w));
        const line = (w: Worked) =>
          `   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}  コード ${[...w.codes].join(",")}`;
        if (withCert.length) {
          console.log(`${EOL_}  ── ★★ 資格はあるのに一度も請求されていない (${withCert.length} 名) — ここが本命 ──`);
          console.log("     対象月に有効な認定/受給者証がある。請求できたはずなのにしていない");
          withCert.forEach((w) => console.log(line(w)));
        }
        if (withoutCert.length) {
          console.log(`${EOL_}  ── 対象月に保険の資格が無い (${withoutCert.length} 名) — 自費で当然かもしれない ──`);
          withoutCert.forEach((w) => console.log(line(w)));
        }
      }

    }
  }
  if (noNumber.length) {
    console.log(`${EOL_}被保険者番号 / 受給者証番号が当方に無い (${noNumber.length} 名) — この人たちは請求そのものができない`);
    // 拠点に偏っていれば取込の問題、散っていれば個別の登録漏れ。まず内訳を出す
    const byArea = new Map<string, { n: number; amount: number }>();
    for (const w of noNumber) {
      const a = byArea.get(w.area) ?? { n: 0, amount: 0 };
      a.n++; a.amount += w.amount; byArea.set(w.area, a);
    }
    [...byArea].sort((a, b) => b[1].n - a[1].n)
      .forEach(([a, v]) => console.log(`   ${a.padEnd(10)} ${String(v.n).padStart(4)} 名  ${yen(v.amount)}`));
    console.log("   (金額はヘルパーに払った賃金)");
  }
  if (crossSystem.length) {
    console.log(`${EOL_}参考: 別制度では当月に請求があるが、この制度では見当たらない (${crossSystem.length} 名)`);
    console.log("   稼働の制度フォルダと実際の制度が食い違っているだけかもしれない。コードを見て判断すること");
    crossSystem.slice(0, 15).forEach((w) =>
      console.log(`   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}  コード ${[...w.codes].join(",")}`));
    if (crossSystem.length > 15) console.log(`   … 他 ${crossSystem.length - 15} 名`);
  }

  if (notImported.length) {
    console.log(`${EOL_}稼働はあるのに実績が DB に 1 件も無い (${notImported.length} 名) — 取込漏れ`);
    notImported.sort((a, b) => b.amount - a.amount);
    notImported.slice(0, 20).forEach((w) =>
      console.log(`   ${w.area.padEnd(8)} ${w.system.padEnd(2)} ${w.clientName.padEnd(16)} ${String(w.rows).padStart(3)}回 ${yen(w.amount).padStart(12)}`));
    if (notImported.length > 20) console.log(`   … 他 ${notImported.length - 20} 名`);
  }
  if (unresolved.length) {
    const byArea = new Map<string, { n: number; amount: number }>();
    for (const w of unresolved) {
      const a = byArea.get(w.area) ?? { n: 0, amount: 0 };
      a.n++; a.amount += w.amount; byArea.set(w.area, a);
    }
    console.log(`${EOL_}利用者に辿り着けない (${unresolved.length} 名) — 取込マッピングにも clients.user_number にも無い`);
    [...byArea].sort((a, b) => b[1].amount - a[1].amount)
      .forEach(([a, v]) => console.log(`   ${a.padEnd(10)} ${String(v.n).padStart(4)} 名  ${yen(v.amount)}`));
  }
  console.log(`${EOL_}(この一覧は判断材料。MEISAI は勤務実績であって請求実績ではない)`);
}

const EOL_ = String.fromCharCode(10);

main().catch((e: unknown) => {
  console.error("check:billing-gap 実行エラー:", e instanceof Error ? e.message : e);
  process.exit(1);
});
