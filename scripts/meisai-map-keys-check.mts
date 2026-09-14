/**
 * MEISAI 対応表 (_meisai_num_to_client*.json) のキーが
 * 無関係な commit で静かに削除されないかを見張る (2026-09-14 新設・H/J)
 *
 *   npx tsx scripts/meisai-map-keys-check.mts
 *   npx tsx scripts/meisai-map-keys-check.mts -- --update
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   commit 1b2e9a0a (2026-08-19「受給者証ページを一本化」という★無関係な機能commit) で
 *   四街道の対応表から6名が誤って削除されていた。同じ差分で新規6名を追加していたため
 *   ★件数(キー数)は変わらず、「件数が減ったら気付く」検査では検知できない
 *   (2026-09-14実測で確認済み)。本checkは★キー集合そのものを基準ファイルと比較し、
 *   消えたキーを個別に検出する (件数一致の裏で入れ替わっていても見逃さない)。
 *
 *   市原 鈴木浩隆のように「一度も対応表に入ったことがない」穴は
 *   propose_meisai_client_mapping.mjs 側の問題 (別途是正済み・e892a9a2)。
 *   本checkは★既にあった対応が消えることだけを見張る (新規追加の要否は見ない)。
 *
 * ── 見ているもの ──────────────────────────────────────────────────────
 *   migrations/_meisai_num_to_client*.json (タグ無し既定ファイル _meisai_num_to_client.json
 *   を含む) 全ファイルの 全キー→client_id。
 *   ・基準ファイルにあって今は無いキー         = ★FAIL (消えた対応)
 *   ・基準ファイルと今でclient_idが違うキー     = ★FAIL (merge等でID付け替えの可能性)
 *   ・今だけにある新規キー                     = PASS (参考表示のみ)
 *
 * ⚠ --update する前に、FAIL したキーが 1b2e9a0a の型 (取込と無関係な機能commitに
 *   巻き込まれた削除) でないか、git log -p --follow -- migrations/<該当ファイル> で
 *   確認すること。正当な削除 (利用者統合・拠点廃止等) だけを --update で受け入れる。
 *
 * ── 負のコントロール ──────────────────────────────────────────────────
 *   MEISAI_MAP_DIR / MEISAI_MAP_BASELINE 環境変数で対象ディレクトリ・基準ファイルの
 *   場所を差し替えられる (既定は migrations/ と本ファイルと同じ場所の
 *   meisai-map-keys-baseline.json)。実ファイルを一切触らずにテストできる。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.argv.includes("--update");
const TARGET_DIR = process.env.MEISAI_MAP_DIR ?? join(__dirname, "..", "migrations");
const BASELINE_PATH = process.env.MEISAI_MAP_BASELINE ?? join(__dirname, "meisai-map-keys-baseline.json");

type Snapshot = Record<string, Record<string, string>>; // ファイル名 -> {キー: client_id}
type Baseline = { _readme?: string[]; files: Snapshot };

function loadCurrent(): Snapshot {
  const files = readdirSync(TARGET_DIR).filter((f) => /^_meisai_num_to_client.*\.json$/.test(f));
  const snap: Snapshot = {};
  for (const f of files) {
    snap[f] = JSON.parse(readFileSync(join(TARGET_DIR, f), "utf8"));
  }
  return snap;
}

const current = loadCurrent();
const fileNames = Object.keys(current).sort();
const totalKeys = fileNames.reduce((s, f) => s + Object.keys(current[f]).length, 0);
console.log(`══ MEISAI対応表 キー消失チェック (${TARGET_DIR}) ══`);
console.log(`対象ファイル数: ${fileNames.length} / 総キー数: ${totalKeys}\n`);

if (UPDATE) {
  const prevReadme = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline)._readme : undefined;
  const baseline: Baseline = {
    _readme: prevReadme ?? [
      "npm run check:meisai-map-keys の基準値。",
      "",
      "■ 何を見ているか",
      "  migrations/_meisai_num_to_client*.json 全ファイルの 全キー→client_id を",
      "  スナップショットしたもの。commit 1b2e9a0a (2026-08-19) で四街道6名が",
      "  無関係な機能commitに巻き込まれて削除されていた事故 (同時に6名追加して",
      "  いたため件数は変わらず、キー数だけの検査では検知できなかった) の再発防止。",
      "  このcheckはキー集合そのものを比較するので、件数が同じままの入れ替わりも検知できる。",
      "",
      "■ FAILの意味",
      "  「消えたキー」= 基準値にあって今は無い対応。最優先で確認すること。",
      "  「client_idが変わったキー」= merge_duplicate_clients.mjs 等でIDが",
      "  付け替わった可能性。意図したものなら受け入れてよい。",
      "",
      "■ --update する前に必ず確認すること",
      "  FAILしたキーが 1b2e9a0a の型 (取込と無関係な機能commitに巻き込まれた削除) で",
      "  ないか、git log -p --follow -- migrations/<該当ファイル> で",
      "  該当行を削除したcommitのメッセージを見て確認すること。",
      "  正当な削除 (利用者の統合・拠点の廃止等) だけを --update で受け入れる。",
      "",
      "■ 更新のしかた",
      "  npx tsx scripts/meisai-map-keys-check.mts -- --update",
    ],
    files: current,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`★ 基準値を更新しました: ${BASELINE_PATH}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.log("⚠ 基準値ファイルが無い。初回は -- --update で作成してください。");
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
const removed: { file: string; key: string; oldClientId: string }[] = [];
const changed: { file: string; key: string; oldClientId: string; newClientId: string }[] = [];
const added: { file: string; key: string; clientId: string }[] = [];

for (const [file, keys] of Object.entries(baseline.files)) {
  const curFile = current[file] ?? {};
  for (const [key, oldClientId] of Object.entries(keys)) {
    if (!(key in curFile)) {
      removed.push({ file, key, oldClientId });
    } else if (curFile[key] !== oldClientId) {
      changed.push({ file, key, oldClientId, newClientId: curFile[key] });
    }
  }
}
for (const [file, keys] of Object.entries(current)) {
  const baseFile = baseline.files[file] ?? {};
  for (const key of Object.keys(keys)) {
    if (!(key in baseFile)) added.push({ file, key, clientId: keys[key] });
  }
}

if (added.length) {
  console.log(`○ 新規追加 ${added.length} 件 (PASS対象。参考表示):`);
  for (const a of added.slice(0, 30)) console.log(`   ${a.file} ${a.key} → ${a.clientId}`);
  if (added.length > 30) console.log(`   ... 他 ${added.length - 30} 件`);
  console.log("");
}

let fail = false;
if (removed.length) {
  fail = true;
  console.log(`★ FAIL — 消えたキー ${removed.length} 件:`);
  for (const r of removed) console.log(`   ${r.file} ${r.key} (旧client_id=${r.oldClientId})`);
  console.log("");
}
if (changed.length) {
  fail = true;
  console.log(`★ FAIL — client_idが変わったキー ${changed.length} 件:`);
  for (const c of changed) console.log(`   ${c.file} ${c.key}: ${c.oldClientId} → ${c.newClientId}`);
  console.log("");
}

if (fail) {
  console.log("⚠ --update する前に、上記が 1b2e9a0a の型 (無関係commitでの巻き添え削除) でないか");
  console.log("  git log -p --follow -- migrations/<該当ファイル> で確認すること。");
  process.exitCode = 1;
} else {
  console.log("✅ 消えたキー・client_id変更なし。");
}
