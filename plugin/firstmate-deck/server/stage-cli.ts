// Deterministic helper behind bin/fleet stage(s) and bin/page (claim): see stage-data.ts for where the facts come from.
//   stage-cli.ts stage <root> <taskId>                   one task's stage (JSON); a live task, else its newest archive line
//   stage-cli.ts stages <root> [--project p] [--table]   every live task's stage, one pass (JSON array, or a table)
//   stage-cli.ts drift <root> [project]                  "<n>" drift flags across live tasks; each flagged task on stderr
//   stage-cli.ts task-of <root> <agentId>                the fm.task label of that agent ("" when it has none)
import { archiveRow, labelledAgents, rowOf, stages, table } from "./stage-data.ts";
import { loadAllLive } from "./state.ts";

function die(msg: string): never {
  console.error(`stage: ${msg}`);
  process.exit(1);
}

const [cmd, root, ...rest] = process.argv.slice(2);
if (!cmd || !root) die("usage: stage-cli.ts <stage|stages|drift|task-of> <root> ...");

try {
switch (cmd) {
  case "stage": {
    const id = rest[0];
    if (!id) die("stage needs a task id");
    const live = loadAllLive(root).find((t) => t.id === id);
    const row = live ? rowOf(live, labelledAgents([id]), new Date()) : archiveRow(root, id);
    if (!row) die(`no such task '${id}'`);
    console.log(JSON.stringify(row));
    break;
  }
  case "stages": {
    const i = rest.indexOf("--project");
    const project = i >= 0 ? rest[i + 1] : undefined;
    if (i >= 0 && !project) die("--project needs a value");
    const rows = stages(root, project);
    console.log(rest.includes("--table") ? (rows.length ? table(rows) : "no live tasks") : JSON.stringify(rows));
    break;
  }
  case "drift": {
    const rows = stages(root, rest[0]);
    const bad = rows.filter((r) => r.flags.some((f) => f.drift));
    for (const r of bad) console.error(`drift: ${r.id} (${r.stage}): ${r.flags.filter((f) => f.drift).map((f) => f.text).join("; ")}`);
    console.log(String(bad.reduce((n, r) => n + r.flags.filter((f) => f.drift).length, 0)));
    break;
  }
  case "task-of": {
    const id = rest[0];
    if (!id) die("task-of needs an agent id");
    console.log(labelledAgents([]).find((r) => r.id === id)?.task ?? "");
    break;
  }
  default:
    die(`unknown command '${cmd}'`);
}
} catch (e) {
  die((e as Error).message);
}
