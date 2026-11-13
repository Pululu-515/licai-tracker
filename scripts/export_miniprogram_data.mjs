#!/usr/bin/env node
/**
 * 把本地归档的净值数据导出成小程序的数据模块。
 *
 * 用法：
 *   node scripts/export_miniprogram_data.mjs                 # 导出 JS 模块到 ../理财小程序
 *   node scripts/export_miniprogram_data.mjs --json site/nav-data.json
 *                                                            # 额外输出 JSON 文件（云端小程序在线更新用）
 *
 * 产物：../理财小程序/utils/nav-data.js（若该目录存在）
 *       --json 指定的 JSON 文件（可选）
 * 说明：
 *   - 这是「内置快照」模式，小程序打开即可看到导出时刻的净值；
 *   - 后续接入微信云开发后，小程序改为从云数据库读取，本文件的 product 结构保持一致，
 *     页面代码无需改动（只替换 utils/nav-source.js 里的数据来源）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_FILE = path.resolve(ROOT, "..", "理财小程序", "utils", "nav-data.js");

// --json <路径>：额外输出一份纯 JSON（小程序「手动更新」从 GitHub Pages 拉取的就是它）
const argv = process.argv.slice(2);
const jsonArgIdx = argv.indexOf("--json");
const JSON_OUT = jsonArgIdx >= 0 && argv[jsonArgIdx + 1] ? path.resolve(ROOT, argv[jsonArgIdx + 1]) : null;

const PRODUCT_ORDER = [
  "Z7003126000267",
  "Z7007126000099",
  "Z7001126000218",
  "Z7006926001306",
  "Z7002426000328",
  "Z7008926000543",
  "Z7006926001747",
  "Z7008926000548",
  "Z7001626000675",
  "Z7001026000481",
  "Z7001026000529",
  "Z7008926000549",
  "Z7001426001893",
];

const round = (v) => (v == null || v === "" || !Number.isFinite(parseFloat(v)) ? null : parseFloat(v));

const products = [];
for (const code of PRODUCT_ORDER) {
  const file = path.join(DATA_DIR, `${code}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`跳过 ${code}：无归档文件`);
    continue;
  }
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const shares = Object.entries(m.shares || {}).map(([shareCode, s]) => ({
    code: shareCode,
    rows: (s.rows || []).map((r) => ({
      date: r.date,
      nav: round(r.nav),
      acumlt: round(r.acumlt),
      wan: round(r.yieldPerMyriad),
      y7: round(r.yieldSevenDay),
    })),
  }));
  products.push({
    code: m.prodRegCode || code,
    name: m.prodName || code,
    orgName: m.orgName || "",
    source: m.source || "",
    updatedAt: m.lastChangeAt || m.lastUpdated || "",
    shares,
  });
}

const generatedAt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  dateStyle: "short",
  timeStyle: "short",
}).format(new Date());

const banner = `// 本文件由 理财记录工具/scripts/export_miniprogram_data.mjs 自动生成，请勿手工编辑。
// 数据时间：${generatedAt}（北京时间）
// 重新导出：cd 理财记录工具 && node scripts/export_miniprogram_data.mjs
`;

const body = `module.exports = ${JSON.stringify({ generatedAt, products }, null, 2)};\n`;

if (fs.existsSync(path.dirname(OUT_FILE))) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, banner + body);
}

if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt, products }));
}

const rows = products.reduce((sum, p) => sum + p.shares.reduce((s2, sh) => s2 + sh.rows.length, 0), 0);
if (fs.existsSync(OUT_FILE)) {
  console.log(`已导出 ${products.length} 个产品 / ${rows} 条净值 -> ${path.relative(ROOT, OUT_FILE)}`);
}
if (JSON_OUT) {
  console.log(`已导出 JSON 快照 -> ${path.relative(ROOT, JSON_OUT)}`);
}
console.log(`数据时间：${generatedAt}`);
