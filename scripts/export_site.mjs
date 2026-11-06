#!/usr/bin/env node
/**
 * 生成 GitHub Pages 静态站点：site/index.html（单文件移动版看板）。
 *
 * 用法：node scripts/export_site.mjs
 * 说明：
 *   - 从 data/*.json 归档读取净值，结构与小程序 nav-data.js 完全一致；
 *   - 注入 share-template.html 的数据占位符，产出自包含 HTML，可直接静态托管；
 *   - 由 GitHub Actions 在每日净值更新后调用，也可本地手动运行。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TEMPLATE = path.join(ROOT, "share-template.html");
const SITE_DIR = path.join(ROOT, "site");

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

const navData = { generatedAt, products };
const rows = products.reduce((sum, p) => sum + p.shares.reduce((s2, sh) => s2 + sh.rows.length, 0), 0);

const template = fs.readFileSync(TEMPLATE, "utf8");
const marker = "/*__NAV_DATA__*/ null";
if (!template.includes(marker)) {
  console.error("模板缺少数据占位标记");
  process.exit(1);
}
const html = template.replace(marker, JSON.stringify(navData));

fs.mkdirSync(SITE_DIR, { recursive: true });
fs.writeFileSync(path.join(SITE_DIR, "index.html"), html);
console.log(`已生成站点：site/index.html（${(html.length / 1024).toFixed(0)} KB）`);
console.log(`数据时间：${generatedAt}｜产品数：${products.length}｜净值 ${rows} 条`);
