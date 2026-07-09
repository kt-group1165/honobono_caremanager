"use client";

/**
 * ファイル保存ヘルパ。File System Access API 対応ブラウザ (Edge/Chrome) では
 * 保存ダイアログでフォルダを選べる。非対応 (Firefox/Safari) は従来のダウンロード。
 *  - saveBlobToFile: 1 ファイルを「名前を付けて保存」
 *  - saveFilesToFolder: 複数ファイルを「フォルダ選択」して一括保存 (伝送の取込フォルダ向け)
 * pickerId を同じにすると前回選んだ場所を記憶する。
 */

interface FSWritable { write(data: Blob): Promise<void>; close(): Promise<void> }
interface FSFileHandle { createWritable(): Promise<FSWritable> }
interface FSDirHandle { getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSFileHandle> }
type SaveFilePicker = (opts: {
  suggestedName?: string;
  id?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FSFileHandle>;
type DirPicker = (opts?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FSDirHandle>;

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

function download(blob: Blob, fileName: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 1 ファイルを保存。保存できたら true / ユーザーがキャンセルしたら false。 */
export async function saveBlobToFile(blob: Blob, fileName: string, pickerId = "kaigo-export"): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName: fileName,
        id: pickerId,
        types: [{ description: "CSV ファイル", accept: { "text/csv": [".csv", ".CSV"] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
      console.warn("保存ダイアログに失敗、通常ダウンロードにフォールバック:", e);
    }
  }
  download(blob, fileName);
  return true;
}

/** 複数ファイルをフォルダ選択して一括保存。保存できたら true / キャンセルは false。 */
export async function saveFilesToFolder(
  files: { blob: Blob; fileName: string }[],
  pickerId = "kaigo-densou",
): Promise<boolean> {
  if (files.length === 0) return true;
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (typeof picker === "function") {
    try {
      const dir = await picker({ id: pickerId, mode: "readwrite" });
      for (const f of files) {
        const fh = await dir.getFileHandle(f.fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(f.blob);
        await w.close();
      }
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
      console.warn("フォルダ保存に失敗、通常ダウンロードにフォールバック:", e);
    }
  }
  for (const f of files) download(f.blob, f.fileName);
  return true;
}
