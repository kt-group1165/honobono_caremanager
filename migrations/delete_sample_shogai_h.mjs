/**
 * 障害サンプル (tag=h) の撤去
 *
 *   node migrations/delete_sample_shogai_h.mjs              DRY RUN (何を消すか出す)
 *   node migrations/delete_sample_shogai_h.mjs --execute    撤去
 *
 * ⚠ 撤去後に ★ もう一度 DRY RUN を回して 0 件を独立に確認すること。
 *   deleteByTag は「消したのに行が残っていたら例外を投げる」。
 */
import { deleteByTag } from "./_sample_data.mjs";

const EXECUTE = process.argv.includes("--execute");
await deleteByTag("h", {
  dryRun: !EXECUTE,
  extraTables: [
    { table: "shougai_certifications", key: "client_id" },
    { table: "client_office_assignments", key: "client_id" },
    { table: "kaigo_visit_schedule", key: "user_id" },
    { table: "shogai_jogen_kanri_results", key: "client_id" },
  ],
});
console.log(EXECUTE ? "撤去しました。★ もう一度 DRY RUN で 0 件を確認してください" : "DRY RUN です");
