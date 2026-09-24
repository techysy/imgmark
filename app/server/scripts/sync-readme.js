const fs = require("fs");
for (const f of ["../README.md", "../LICENSE"]) {
  try { fs.copyFileSync(f, f.replace("../", "")); } catch {}
}
