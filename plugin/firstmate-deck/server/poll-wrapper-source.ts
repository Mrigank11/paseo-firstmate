// The poll wrapper, shipped as source and run with `node -e` (see spawnPoll in lavish.ts). Paseo bundles the plugin, so
// a sibling .mjs file is not guaranteed to exist and import.meta.url is not usable; and nothing is ever written to a
// shared directory such as /tmp for the daemon to execute later.
//
// What it does: runs one `lavish-axi poll` as a child and makes sure it never outlives whoever started it. The plugin
// keeps the wrapper's stdin open as a pipe. When that pipe closes (the plugin was stopped, crashed or killed with -9) the
// poll child is killed and the wrapper exits, so no orphan keeps holding the Lavish listener (and swallowing comments).
// SIGTERM/SIGINT/SIGHUP are forwarded to the child. Stdout passes straight through.
//
// Invoked as: node -e <source> -- --firstmate-deck-poll-wrapper <lavish cli.mjs> poll <page> [...]
// The marker argument is how killStalePoll recognises a wrapper in /proc/<pid>/cmdline.
export const POLL_WRAPPER_MARKER = "--firstmate-deck-poll-wrapper";

export const POLL_WRAPPER_SOURCE = [
  'const{spawn}=require("node:child_process");',
  "const args=process.argv.slice(2);",
  'if(!args.length){console.error("usage: <lavish cli.mjs> poll <page> [...]");process.exit(2)}',
  'const child=spawn(process.execPath,args,{stdio:["ignore","pipe","inherit"],env:process.env});',
  "child.stdout.pipe(process.stdout);",
  "let stopping=false;",
  "function stop(){if(stopping)return;stopping=true;",
  ' try{child.kill("SIGTERM")}catch{}',
  ' setTimeout(()=>{try{child.kill("SIGKILL")}catch{}process.exit(1)},2000).unref()}',
  'process.stdin.on("end",stop);process.stdin.on("close",stop);process.stdin.on("error",stop);process.stdin.resume();',
  'for(const sig of["SIGTERM","SIGINT","SIGHUP"])process.on(sig,stop);',
  'child.on("error",e=>{console.error("poll-wrapper: "+e.message);process.exitCode=1;process.stdin.destroy()});',
  'child.on("close",(code,signal)=>{process.exitCode=code??(signal?1:0);process.stdin.destroy()});',
].join("\n");
