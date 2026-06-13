#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSetupPlan,
  defaultLayout,
  executeSetup,
  parseArgs,
  printHelp,
  printPlan,
} from "./setup-local-lib.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    printHelp();
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const layout = defaultLayout();
  const plan = buildSetupPlan({ options, layout });

  printPlan(plan, options);
  const didContinue = await executeSetup({ repoRoot, options, plan });
  if (!didContinue) return;

  if (options.mode === "check") {
    console.log("");
    console.log("Next:");
    if (!plan.canInstallLovely) {
      console.log("- Install Balatro through Steam if the game path above is missing.");
    }
    console.log("- Run `npm run setup:local -- --install` to install repo deps, mods, and Lovely.");
    console.log("- Run `npm run live -- naive` for the no-token smoke test.");
  } else {
    console.log("");
    console.log("Next:");
    if (options.mode === "uninstall") {
      console.log("- Install Balatro through Steam and rerun `npm run setup:local -- --install` when you want a fresh setup.");
    } else {
      console.log("- Run `npm run live -- naive` for the no-token smoke test.");
      console.log("- Run `npm run live` after adding BASE_URL / BASE_KEY / MODEL to .env.");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
