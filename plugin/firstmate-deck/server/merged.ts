// Has a task's branch already been merged into the project's base branch? (T8: the captain merged on GitHub; the first mate has not heard.)
import { execFile } from "node:child_process";

/** True when `branch` exists in `repo` and is an ancestor of `base` (or of origin/base). Any git failure is "not merged". */
export function branchMerged(repo: string, branch: string, base = "main"): Promise<boolean> {
  const git = (...args: string[]) => new Promise<boolean>((resolve) => {
    execFile("git", ["-C", repo, ...args], { timeout: 5000 }, (err) => resolve(!err));
  });
  return (async () => {
    if (!(await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`))) return false;
    return (await git("merge-base", "--is-ancestor", branch, base)) || (await git("merge-base", "--is-ancestor", branch, `origin/${base}`));
  })();
}
