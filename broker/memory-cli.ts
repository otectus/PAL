import { readFile } from "node:fs/promises";
import { request } from "./client.ts";
const args = process.argv.slice(2);
let command = (args.shift() || "health").replaceAll("-", "_");
if(['curation','retention','models'].includes(command)&&args[0]&&!args[0].startsWith('--'))command+='_'+args.shift()!.replaceAll('-','_');
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) throw new Error("Use named arguments");
  flags[key.slice(2).replaceAll("-", "_")] =
    args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
}
async function stdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("Memory input exceeds 1 MiB");
  }
  return text;
}
try {
  let params: Record<string, unknown> = {};
  if (flags.file || flags.stdin) {
    const text = flags.file
      ? await readFile(String(flags.file), "utf8")
      : await stdin();
    params = JSON.parse(text);
  }
  for (const name of [
    "id",
    "job_id",
    "backend",
    "text",
    "output",
    "input",
    "staging",
    "selection", "reason", "assessment_id", "action","change_id","hold_id","cursor","dataset",
  ])
    if (typeof flags[name] === "string") params[name] = flags[name];
  for (const key of ['limit','offset','max_cases','expected_epoch'])if(typeof flags[key]==='string')params[key]=Number(flags[key]);
  if (flags.job) params.job_id = flags.job;
  if (flags.expected_revision)
    params.expected_revision = Number(flags.expected_revision);
  if (flags.known_revision)
    params.known_revision = Number(flags.known_revision);
  if (flags.world_at)
    params.world_at_us = Date.parse(String(flags.world_at)) * 1000;
  if (flags.dry_run) params.dry_run = true;
  const method =
    command === "query"
      ? "retrieve"
      : command === "forget_preview"
        ? "forget_preview"
        : command;
  if (command === "daemon")
    throw new Error(
      "Graph memory runs in the PAL broker. Start pal-broker.service or node broker/main.ts.",
    );
  if (flags.help) {
    console.log(
      "pal memory health|doctor|curation settings|configure|status|preview|run|list|apply|undo|cancel|retry|review-later|keep-local|statement-correct, retention preview|protect|release|forecast|policy-preview|policy-apply|policy-undo, models probe|evaluate, query|deep-recall|inspect|remember|correct|resolve-conflict|forget-preview|forget|erasure-status|workspace|policy-get|policy-update|rebuild|backup|restore|compact|readjudicate\nUse --session SESSION_ID to select a project, --file CLAIM.json or --stdin for structured requests, --json for machine output.\ncompact --output BACKUP.sqlite backs memory up to that new file, then removes rows that only erased records still use.\nreadjudicate --output BACKUP.sqlite backs memory up to that new file, then accepts or rejects pending extraction candidates under the current acceptance rule; --dry-run reports the same decisions without writing.",
    );
  } else {
    // Backup, restore, rebuild, compaction and re-adjudication (which backs up first) can take minutes.
    const slow = ["backup", "restore", "rebuild", "compact", "readjudicate","retention_protect","retention_policy_apply","models_probe","models_evaluate"].includes(method);
    const result = await request("memory.graph", {
      sessionId: flags.session,
      method,
      params,
    }, method==="models_evaluate"?24*60*60000:slow?15*60000:method==="deep_recall"?20000:10000);
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
