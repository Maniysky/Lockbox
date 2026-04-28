const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const reportFile = path.join(root, "test-results", "custom-html-report", "index.html");

if (!fs.existsSync(reportFile)) {
  console.error("No custom report found. Run tests first: npm test");
  console.error(`Expected file: ${reportFile}`);
  process.exit(1);
}

if (process.platform === "win32") {
  execFileSync("cmd", ["/c", "start", "", reportFile], { stdio: "ignore", windowsHide: true });
} else if (process.platform === "darwin") {
  execFileSync("open", [reportFile], { stdio: "ignore" });
} else {
  execFileSync("xdg-open", [reportFile], { stdio: "ignore" });
}
