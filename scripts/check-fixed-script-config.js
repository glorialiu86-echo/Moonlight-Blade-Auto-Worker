import { checkFixedScriptConfig } from "./lib/fixed-script-config-check.js";

checkFixedScriptConfig()
  .then((summary) => {
    console.log("fixed-script config check passed");
    console.log(JSON.stringify(summary, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
