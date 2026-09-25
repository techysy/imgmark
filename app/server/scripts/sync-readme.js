// 把仓库根目录的 README.md / LICENSE 同步到 app/server/（npm 发包内容）。
// 路径以本脚本位置锚定（app/server/scripts → 仓库根），与运行时 cwd 无关——
// 旧版用 "../README.md" 相对 cwd，从根目录或 npm prepare（cwd=app/server）跑都拷不到。
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const pkg = path.join(__dirname, "..");
for (const f of ["README.md", "LICENSE"]) {
  try {
    fs.copyFileSync(path.join(root, f), path.join(pkg, f));
    console.log(`synced ${f}`);
  } catch (e) {
    console.warn(`skip ${f}: ${e.message}`);
  }
}
