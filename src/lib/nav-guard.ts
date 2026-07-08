// 未保存離脱ガード (汎用)。
//
// 画面側が「未保存変更あり」を registerNavGuard で登録し、
// 共有ナビ (UserSidebar の利用者切替等) が遷移前に confirmNav() を呼ぶ。
// 未保存なら window.confirm で確認し、キャンセルなら遷移を止める。
//
// - App Router には client-side 遷移の公式ガードが無いため、この軽量レジストリで代替する。
// - beforeunload (リロード/タブ閉じ) は各画面が別途 addEventListener する。
// - guard が未登録の画面では confirmNav() は常に true を返す (無害)。

type NavGuard = {
  /** 未保存変更があるか (最新値を返すこと。ref 経由推奨) */
  isDirty: () => boolean;
  /** 確認ダイアログの文言 */
  message: string;
};

let current: NavGuard | null = null;

/** 画面 mount 時に登録、unmount 時に registerNavGuard(null) で解除する。 */
export function registerNavGuard(guard: NavGuard | null): void {
  current = guard;
}

/**
 * 遷移してよいか。未保存なら confirm を出し、OK=true / キャンセル=false。
 * 登録が無い、または dirty でなければ true。
 */
export function confirmNav(): boolean {
  if (typeof window === "undefined") return true;
  if (current && current.isDirty()) {
    return window.confirm(current.message);
  }
  return true;
}
