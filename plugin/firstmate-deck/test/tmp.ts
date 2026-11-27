// Where a test's scratch directories go: TMPDIR (the runner points it at disk), made if it does not exist yet.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

export function tmp(): string {
  const d = tmpdir();
  mkdirSync(d, { recursive: true });
  return d;
}
