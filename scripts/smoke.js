import { spawnSync } from "node:child_process";

for (const command of ["openclaw", "gh"]) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.error || result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  console.log(`${command} ok:`, result.stdout.trim());
}
