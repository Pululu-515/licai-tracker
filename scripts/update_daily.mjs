#!/usr/bin/env node
/**
 * 理财记录工具 - 净值每日更新脚本
 *
 * 用法:
 *   node scripts/update_daily.mjs            # 手动运行：全量比对更新（首次运行即全量归档）
 *   node scripts/update_daily.mjs --daily    # 定时任务模式：含"今日已获取"跳过逻辑
 *
 * 功能:
 *   1. 为 PRODUCTS 中所有产品抓取净值（增量合并，只归档新增数据）
 *   2. 归档位置:
 *        data/<登记编码>.json      主档（产品信息 + 各份额完整净值序列）
 *        data/archive/<编码>.csv   累计净值 CSV（全量重写，幂等）
 *        data/state.json           更新状态（供 7 点 / 8 点定时任务判断）
 *   3. 计算指标并刷新 dashboard/index.html（当日万收、7日日均万收、7日年化、14日年化）
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ==================== 配置 ==================== */

const DAILY_FLAG = process.argv.includes("--daily");
const BUILD_ONLY = process.argv.includes("--build-only"); // 不请求接口，仅用已归档数据重建 CSV 与看板

// 监控的产品登记编码（可用环境变量 PRODUCTS=Z1,Z2 覆盖）
const PRODUCTS = (process.env.PRODUCTS || "").split(",").filter(Boolean).length
  ? process.env.PRODUCTS.split(",").filter(Boolean)
  : [
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

// 完整产品清单：看板重建始终使用它，不受 PRODUCTS 环境变量过滤影响，
// 避免单产品补抓（PRODUCTS=xxx）时把看板刷成只剩一个产品。
const ALL_PRODUCTS = [
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

// 年化口径（标准净值型理财口径，2026-11-05 修正）：
//   7日年化  = [(V_t / V_{t-7}) - 1] / 实际天数 × 365 × 100%
//   14日年化 = [(V_t / V_{t-14}) - 1] / 实际天数 × 365 × 100%
//   - t-7 / t-14 指 7 / 14 个自然日前的净值（取当日或之前最近一个披露日）
//   - 年化基数 365（公募基金口径；如需对齐按 360 计算的银行说明书，改这里）
//   - 单利年化，不做复利折算
//   - V 优先取累计净值（含分红），无累计净值时用单位净值
const ANNUALIZE_DAYS = 365;
const WINDOW_7D = 7;
const WINDOW_14D = 14;

// 份额过滤：只保留指定份额（未列出的产品保留全部份额）
const SHARE_FILTER = {
  Z7001126000218: ["NYJXLD1409G"],
  Z7007126000099: ["WPLK26D0101A"],
  Z7003126000267: ["J23852"],
  Z7008926000543: ["YJ01260819A"],
  Z7001626000675: ["132152A"],
  Z7001426001893: ["EW8730D"],
};

// 特殊数据源：不走中国理财网，改用发行机构官网
// Z7008926000543/Z7008926000548 北银理财 -> 北银理财官网产品详情页（2026-11-06 更换）
//   https://www.beijingbobwealth.com.cn/products_index/index.html?PROD_CODE=YJ01260819
//   详情页流程: /bylc-api/product/info（母代码，返回完整产品名）
//            → /bylc-api/product/subs（母代码，返回份额列表，按 SHARE_CLASS 选 A类）
//            → /bylc-api/product/navlist（份额代码如 YJ01260819A，START_DATE/END_DATE 为 YYYYMMDD）
const BOB_SOURCES = {
  Z7008926000543: {
    site: "https://www.beijingbobwealth.com.cn",
    prodCode: "YJ01260819", // 母产品代码（诚享7天持有期33号）
    shareClass: "A类", // 目标份额：33号A（YJ01260819A）
    canonicalShare: "YJ01260819A", // 归档份额 key（备用源数据会映射回这个 key）
  },
  Z7008926000548: {
    site: "https://www.beijingbobwealth.com.cn",
    prodCode: "YJ01260820", // 母产品代码（诚享7天持有期34号）
    shareClass: "A类", // 目标份额：34号A（YJ01260820A）
    canonicalShare: "YJ01260820A",
  },
  Z7008926000549: {
    site: "https://www.beijingbobwealth.com.cn",
    prodCode: "YJ01260823", // 母产品代码（智远21天持有期1号，2026-08-21 成立）
    shareClass: "A类", // 目标份额：智远21天1号A（YJ01260823A）
    canonicalShare: "YJ01260823A",
  },
};

// 招银理财官网（接口请求体加密，采用无头浏览器加载页面后截获明文响应）
//   https://www.cmbchinawm.com/proDetail?prodTradeCode=132152A&prodClcMode=01&finType=P
//   点击"产品净值及过往业绩"→"查看更多净值"后，POST /prod-api/web/api/product/getNetValAndRate
//   响应 data 为全量净值数组
const CMB_SOURCES = {
  Z7001626000675: {
    site: "https://www.cmbchinawm.com",
    prodTradeCode: "132152A",
    prodClcMode: "01",
    finType: "P",
  },
};
// Chrome 路径：优先 CHROME_PATH 环境变量，否则按平台自动探测常见安装位置
const CHROME_CANDIDATES =
  process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ].filter(Boolean)
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const CHROME_PATH =
  process.env.CHROME_PATH ||
  CHROME_CANDIDATES.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) ||
  CHROME_CANDIDATES[0];

// 农银理财官网（同招银：接口 Node 直连有 TLS 兼容问题，走无头浏览器页面内 fetch）
//   https://www.abcwealth.com.cn/#/product/productServer/net?idProduct=NYJXLD1409G&Tag=2
//   POST /awpsservice/fpproduct/productyield/findRange?productId=<份额>&yieldRange=THREE_YEARS&yieldType=UNIT_NET|TOT_NET|PFT_TTHOU|DAYS7_YEAR_PFT
//   注意：官网仅披露近 1 年（实测 86 条）净值，更早历史沿用中国理财网归档数据按日期合并
const ABC_SOURCES = {
  Z7001126000218: {
    site: "https://www.abcwealth.com.cn",
    productId: "NYJXLD1409G",
  },
};

// 光大理财官网（www.cebwm.com）：瑞数反爬，纯 HTTP 直连返回 412、XHR 报文加密，
//   但「渲染后的 DOM 是明文」——用无头 Chrome 打开详情页，直接从头部读
//   「X.XXXX / 份额净值（YYYY-MM-DD）」，只取最新一条（历史由备用源中国理财网补齐）。
//   详情页 https://www.cebwm.com/wealth/lcxx/lccp14/254999669/index.html
//   净值列表在 iframe /wealth/lcxx/jjjz87/index.html（每页仅 25 行、分页麻烦，故不用）
const CEB_SOURCES = {
  Z7001426001893: {
    site: "https://www.cebwm.com",
    detailPath: "/wealth/lcxx/lccp14/254999669/index.html",
    share: "EW8730D", // 产品编号 EW8730D = 阳光金日添利9号D
    prodName: "阳光金日添利9号D",
    orgName: "光大理财有限责任公司",
  },
};

// 浦银理财：2026-11-06 起两个产品均改回中国理财网数据源
//   Z7006926001306 https://xinxipilu.chinawealth.com.cn/queryMenu/prodType/prodTypeDetail?prodRegCode=Z7006926001306
//   Z7006926001747 https://xinxipilu.chinawealth.com.cn/queryMenu/prodType/prodTypeDetail?prodRegCode=Z7006926001747
// 不再需要 spdb-wm.com 官网源（fetchProductSpdb 函数保留备用，SPDB_SOURCES 清空后不会被调用）
//   旧官网源: POST https://www.spdb-wm.com/api/search  chlid=1008 为净值列表, searchword 用子份额表达式
// 浦银理财官网数据源（spdb-wm.com）：无头浏览器页面内 fetch，POST /api/search 分页取净值
//   详情页 https://www.spdb-wm.com/financialProducts/cpxq.shtml?REAL_PRD_CODE=2301260750
//   检索接口的 searchword 用份额代码（与理财网一致），REAL_PRD_CODE 仅详情页参数
const SPDB_SOURCES = {
  Z7006926001306: {
    site: "https://www.spdb-wm.com",
    subShareCode: "2501260175", // 双周鑫116号A类份额
    realPrdCode: "2301260750",
  },
};

// 双数据源编排：主源拿不到最新净值（失败或披露滞后）时，自动尝试备用源
//   primary/fallback 取值对应 SOURCE_FETCHERS（chinawealth = 中国理财网通用通道）
//   canonicalShare = 主源归档使用的份额 key，备用源数据统一映射回它
const DUAL_SOURCES = {
  Z7008926000543: { primary: "bob", fallback: "chinawealth", canonicalShare: "YJ01260819A" },
  Z7008926000548: { primary: "bob", fallback: "chinawealth", canonicalShare: "YJ01260820A" },
  Z7006926001306: { primary: "chinawealth", fallback: "spdb", canonicalShare: "2501260175" },
  // 徽银：同一官网的两个页面互为备用（数据一致，income_list 为主源）
  Z7002426000328: { primary: "hsbank", fallback: "hsbank_display", canonicalShare: "PNHY260395A" },
  // 光大：官网比中国理财网早一天披露，主源取官网最新一条，历史靠理财网补齐
  Z7001426001893: { primary: "ceb", fallback: "chinawealth", canonicalShare: "EW8730D" },
};

/** 徽银理财官网数据源（hsbankwm.com）：服务端直出 HTML 表格，分页 ?id=xx&page=N */
const HSBANK_SOURCES = {
  Z7002426000328: {
    site: "https://hsbankwm.com",
    id: "95937",
    share: "PNHY260395A", // 与旧存档份额键保持一致
  },
};

const BASE = "https://xinxipilu.chinawealth.com.cn";
const API = BASE + "/lcxp-platService";
const SIGN_KEY = "hold?fish:palm";
const REQUEST_DELAY_MS = parseInt(process.env.DELAY_MS || "", 10) || 1200; // 服务端有频控，请求间隔 ≥ 1s

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DATA_DIR = path.join(ROOT, "data");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const STATE_FILE = path.join(DATA_DIR, "state.json");

/* ==================== 接口协议层 ==================== */

const cookieJar = new Map();
let MANAGE_KEY = null;
let LICENSE_KEY = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}`);

function cookieHeader() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function storeCookies(res) {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    if (i > 0) cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

function aesEncrypt(plaintext) {
  const key = Buffer.from(MANAGE_KEY, "base64");
  const algo = { 16: "aes-128-ecb", 24: "aes-192-ecb", 32: "aes-256-ecb" }[key.length];
  const cipher = crypto.createCipheriv(algo, key, null);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

async function post(p, obj, { withSig = true } = {}) {
  const ts = Date.now().toString();
  const nonce = Math.random().toString(36).slice(2, 12);
  const plaintext = JSON.stringify(obj);
  const data = aesEncrypt(plaintext);
  const signStr = `data=${data}&nonce=${nonce}&timestamp=${ts}&signKey=${SIGN_KEY}`;
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Referer: BASE + "/queryMenu/prodType/prodTypeDetail",
    "X-Nonce": nonce,
    "X-Timestamp": ts,
    "X-Sign": crypto.createHash("sha256").update(signStr).digest("hex"),
    Cookie: cookieHeader(),
  };
  if (withSig && LICENSE_KEY) {
    headers["signature"] = crypto.createSign("RSA-SHA256").update(plaintext).sign(LICENSE_KEY, "base64");
  }
  const res = await fetch(API + p, { method: "POST", headers, body: data });
  storeCookies(res);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: res.status, msg: "non-json response", raw: text.slice(0, 200) };
  }
}

async function postRetry(p, obj, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await post(p, obj);
    if (r.code === 200) return r;
    const msg = String(r.msg || r.raw || "unknown");
    const backoff = 3000 + i * 5000; // 3s / 8s / 13s 递增退避
    log(`  ${p} 第${i + 1}次失败: ${msg}，${backoff / 1000}s 后重试`);
    await sleep(backoff);
    // 「验证失败 / non-json」多为会话密钥失效或被服务端限流：重建会话后再试
    if (i < tries - 1 && /验证失败|non-json|会话|过期|token/i.test(msg)) {
      try {
        await initSession();
        log("  已重建接口会话，继续重试");
      } catch (e) {
        log("  会话重建失败: " + e.message);
      }
    }
  }
  return null;
}

async function initSession() {
  // Step 1: RSA 密钥协商 -> AES 密钥
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 65537 });
  const pubRaw = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/-----[^\n]+-----/g, "").replace(/\s+/g, "");
  const privPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const res = await fetch(API + "/m/n", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", "User-Agent": "Mozilla/5.0" },
    body: pubRaw,
  });
  storeCookies(res);
  const enc = (await res.text()).trim();
  MANAGE_KEY = crypto
    .privateDecrypt({ key: privPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(enc, "base64"))
    .toString("utf8");
  // Step 2: license RSA 私钥（用于 signature 头）
  const init = await post("/product/getInitData", {}, { withSig: false });
  if (init.code === 200 && typeof init.data === "string" && init.data.includes("PRIVATE KEY")) {
    LICENSE_KEY = init.data
      .replace(/\s+/g, "\n")
      .replace("-----BEGIN\nPRIVATE\nKEY-----", "-----BEGIN PRIVATE KEY-----")
      .replace("-----END\nPRIVATE\nKEY-----", "-----END PRIVATE KEY-----");
  } else {
    throw new Error("获取 license 私钥失败: " + JSON.stringify(init).slice(0, 150));
  }
  log("接口会话初始化成功（密钥协商 + license）");
}

/* ==================== 业务数据层 ==================== */

/** 数值字符串规范化：去掉 1.004940000000 这类浮点长尾，保留有效精度 */
function normNum(v) {
  if (v == null || v === "") return "";
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return String(v);
  return String(parseFloat(n.toPrecision(12)));
}

async function fetchProduct(prodRegCode) {
  const detail = await postRetry("/product/getProductDetail", { prodRegCode, pageNum: 1, pageSize: 10 });
  let basic = {};
  let shares = null;
  if (detail && detail.code === 200) {
    basic = detail.data?.prodBasicInfoVo ?? {};
    shares = detail.data?.productTypeNetValueVo?.subShareList?.map((s) => s.subShareCode) ?? [];
    if (SHARE_FILTER[prodRegCode]) {
      shares = shares.filter((s) => SHARE_FILTER[prodRegCode].includes(s));
    }
  }
  // 详情接口被平台限流/风控时的降级：用份额过滤配置或既有归档的份额列表，
  // 直接抓净值（getNetValueLine 不依赖详情接口），名称沿用归档，避免整只产品漏更新。
  if (!shares || shares.length === 0) {
    const archiveFile = path.join(DATA_DIR, `${prodRegCode}.json`);
    let archivedMeta = null;
    try {
      archivedMeta = JSON.parse(fs.readFileSync(archiveFile, "utf8"));
    } catch {}
    if (SHARE_FILTER[prodRegCode]) {
      shares = SHARE_FILTER[prodRegCode];
    } else if (archivedMeta?.shares && Object.keys(archivedMeta.shares).length > 0) {
      shares = Object.keys(archivedMeta.shares);
    }
    if (!shares || shares.length === 0) {
      throw new Error(`获取产品详情失败: ${prodRegCode}`);
    }
    log(`${prodRegCode} 详情接口不可用，降级为已知份额列表: ${shares.join(",")}`);
    if (archivedMeta?.prodName) {
      basic.prodName = archivedMeta.prodName;
      basic.orgName = archivedMeta.orgName;
    }
  }

  const shareData = {};
  for (const share of shares) {
    const line = await postRetry("/product/getNetValueLine", { subShareCode: share, timeType: "1", prodRegCode });
    const rows = line?.data?.prodNetValueLine ?? [];
    shareData[share] = rows.map((r) => ({
      date: r.netValueDate,
      nav: normNum(r.shareNetVal),
      acumlt: normNum(r.acumltNetVal),
      // 若平台直接披露了万份收益/7日年化字段则一并保留
      yieldPerMyriad: r.yieldPerMyriad || "",
      yieldSevenDay: r.yieldSevenDay || "",
    }));
    await sleep(REQUEST_DELAY_MS);
  }
  return { prodRegCode, name: basic.prodName || "", orgName: basic.orgName || "", prodType: basic.prodType || "", shares: shareData };
}

/** 浦银理财官网数据源（无头浏览器页面内 fetch，POST /api/search 分页取净值） */
async function fetchProductSpdb(code) {
  const src = SPDB_SOURCES[code];
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    await page.goto(src.site + "/financialProducts/cpxq.shtml?REAL_PRD_CODE=" + (src.realPrdCode || src.subShareCode), { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await sleep(2000);
    const all = [];
    let totalElements = null;
    let pageNum = 1;
    const num = (v) => (v == null || v === "" ? "" : String(parseFloat(v)));
    while (true) {
      const res = await page.evaluate(async (word, p) => {
        const r = await fetch("https://www.spdb-wm.com/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chlid: 1008, cutsize: 150, dynexpr: [], dynidx: 1, extopt: [], orderby: "", page: p, size: 100, searchword: word }),
        });
        return await r.json();
      }, `(subShareCode='${src.subShareCode}')`, pageNum);
      const content = res?.data?.content ?? [];
      totalElements = res?.data?.totalElements ?? totalElements;
      for (const r of content) {
        const d = String(r.netValueDate || ""); // YYYYMMDD
        if (d.length !== 8 || !r.shareNetVal) continue;
        all.push({
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          nav: num(r.shareNetVal),
          acumlt: num(r.acumltNetVal),
          yieldPerMyriad: num(r.netRevPer10000),
          yieldSevenDay: num(r.yieldSevenDate),
        });
      }
      if (!content.length || all.length >= totalElements || pageNum >= 20) break;
      pageNum++;
      await sleep(1000);
    }
    if (!all.length) throw new Error("浦银理财净值列表为空");
    // 去重（按日期取最新一条）
    const byDate = new Map();
    for (const r of all) byDate.set(r.date, r);
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    // 产品名沿用已有归档
    const master = loadJson(path.join(DATA_DIR, `${code}.json`), null);
    return {
      prodRegCode: code,
      name: master?.prodName || "浦银理财产品（" + src.subShareCode + "）",
      orgName: "浦银理财有限责任公司",
      shares: { [src.subShareCode]: rows },
      replaceAll: true,
    };
  } finally {
    await browser.close();
  }
}

/** 徽银理财官网数据源（hsbankwm.com，服务端直出 HTML 表格，分页 ?id=xx&page=N） */
/** 徽银理财官网数据源（hsbankwm.com）：服务端直出 HTML 表格，分页 ?id=xx&page=N
 *  同一产品有两个页面（数据一致，分页大小不同），互为备用：
 *    lccs_income_list.php（主源）与 lccs_display.php（备用，见 DUAL_SOURCES）
 */
async function fetchProductHsbank(code, listPage = "lccs_income_list.php") {
  const src = HSBANK_SOURCES[code];
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    const parseRows = () =>
      page.evaluate(() => {
        const rows = [];
        for (const tr of document.querySelectorAll("tbody tr")) {
          const tds = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
          // 列：净值日期、单位净值、累计净值
          if (tds.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(tds[0])) {
            rows.push({ date: tds[0], nav: tds[1], acumlt: tds[2] });
          }
        }
        // 从分页链接中找最大页码
        let maxPage = 1;
        for (const a of document.querySelectorAll("a")) {
          const m = (a.getAttribute("href") || "").match(/page=(\d+)/);
          if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
        }
        return { rows, maxPage };
      });

    const listUrl = (p) => `${src.site}/${listPage}?id=${src.id}${p > 1 ? `&page=${p}` : ""}`;
    // 该站点偶发返回空表（约 5%），需显式等待表格渲染并重试
    const loadPage = async (p, attempts = 3) => {
      for (let a = 1; a <= attempts; a++) {
        try {
          await page.goto(listUrl(p), { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForSelector("tbody tr", { timeout: 15000 }).catch(() => {});
          await sleep(600);
          const parsed = await parseRows();
          if (parsed.rows.length) return parsed;
          if (a < attempts) {
            log(`    徽银第 ${p} 页为空，第 ${a} 次重试...`);
            await sleep(1500 * a);
          }
        } catch (e) {
          if (a === attempts) throw e;
          await sleep(1500 * a);
        }
      }
      return { rows: [], maxPage: 1 };
    };

    const first = await loadPage(1);
    const all = [...first.rows];
    for (let p = 2; p <= Math.min(first.maxPage, 30); p++) {
      const more = await loadPage(p);
      all.push(...more.rows);
      await sleep(500);
    }
    if (!all.length) throw new Error("徽银理财净值列表为空");
    // 官网表格偶有重复日期行（如 2026-10-30 出现两次），按日期去重取第一条
    const byDate = new Map();
    for (const r of all) if (!byDate.has(r.date) && r.nav) byDate.set(r.date, r);
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const master = loadJson(path.join(DATA_DIR, `${code}.json`), null);
    return {
      prodRegCode: code,
      name: master?.prodName || "徽银理财安盈稳健日开7号理财产品260395",
      orgName: "徽银理财有限责任公司",
      shares: { [src.share]: rows },
      replaceAll: true,
    };
  } finally {
    await browser.close();
  }
}

/** 农银理财官网数据源（无头浏览器页面内 fetch，官网仅披露近1年） */
async function fetchProductAbc(code) {
  const src = ABC_SOURCES[code];
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    await page.goto(src.site + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(2500);
    const raw = await page.evaluate(async (productId) => {
      const get = async (t) => {
        const res = await fetch("/awpsservice/fpproduct/productyield/findRange?productId=" + productId + "&yieldRange=THREE_YEARS&yieldType=" + t, { method: "POST" });
        const j = await res.json();
        return j.data?.yieldVOS || [];
      };
      const [unit, tot, pft, d7] = await Promise.all([get("UNIT_NET"), get("TOT_NET"), get("PFT_TTHOU"), get("DAYS7_YEAR_PFT")]);
      const infoRes = await fetch("/awpsservice/fpproduct/info?productId=" + productId);
      const info = (await infoRes.json()).data || {};
      const map = (arr) => new Map(arr.map((x) => [x.dateNet, x.dataValue]));
      const totM = map(tot), pftM = map(pft), d7M = map(d7);
      return {
        name: info.namFull || "",
        rows: unit.map((x) => ({
          dateNet: x.dateNet,
          nav: x.dataValue,
          acumlt: totM.has(x.dateNet) ? totM.get(x.dateNet) : "",
          pft: pftM.has(x.dateNet) ? pftM.get(x.dateNet) : "",
          d7: d7M.has(x.dateNet) ? d7M.get(x.dateNet) : "",
        })),
      };
    }, src.productId);
    const rows = raw.rows
      .map((r) => {
        const d = String(r.dateNet); // YYYYMMDD
        return {
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          nav: r.nav != null ? String(r.nav) : "",
          acumlt: r.acumlt !== "" ? String(r.acumlt) : "",
          yieldPerMyriad: r.pft !== "" && r.pft != null ? String(r.pft) : "",
          yieldSevenDay: r.d7 !== "" && r.d7 != null ? String(r.d7) : "",
        };
      })
      .filter((r) => r.nav)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw new Error("农银理财净值列表为空");
    return {
      prodRegCode: code,
      name: raw.name || "农银理财",
      orgName: "农银理财有限责任公司",
      shares: { [src.productId]: rows },
      replaceAll: false, // 官网仅近1年，与已归档的更早历史按日期合并
    };
  } finally {
    await browser.close();
  }
}

/** 招银理财官网数据源（无头浏览器截获明文响应） */
async function fetchProductCmb(code) {
  const src = CMB_SOURCES[code];
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
    let navData = null;
    page.on("response", async (res) => {
      if (res.url().includes("getNetValAndRate")) {
        try { navData = JSON.parse(await res.text()); } catch {}
      }
    });
    const url = `${src.site}/proDetail?prodTradeCode=${src.prodTradeCode}&prodClcMode=${src.prodClcMode}&finType=${src.finType}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
    await sleep(4000);
    // 点击"产品净值及过往业绩"标签
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent.trim() === "产品净值及过往业绩");
      if (els.length) els[0].click();
    });
    await sleep(5000);
    // 点击"查看更多净值"加载全量历史
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent.trim() === "查看更多净值");
      if (els.length) els[0].click();
    });
    await sleep(6000);
    if (!navData || !Array.isArray(navData.data)) throw new Error("招银理财净值接口未返回数据");
    const rows = navData.data
      .map((r) => ({
        // navDate 是北京时间零点的毫秒时间戳，直接 toISOString 会按 UTC 减一天，
        // 必须先加 8 小时偏移再取日期，否则所有净值日期都会提前一天
        date: new Date(new Date(r.navDate).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10),
        nav: r.nav != null ? String(r.nav) : "",
        acumlt: r.accuNav != null ? String(r.accuNav) : "",
        yieldPerMyriad: r.tenThousandUnitIncome != null ? String(r.tenThousandUnitIncome) : "",
        yieldSevenDay: r.annualizedYield != null ? String(r.annualizedYield) : "",
      }))
      .filter((r) => r.nav)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw new Error("招银理财净值列表为空");
    return {
      prodRegCode: code,
      name: `招银理财招睿添利日开25号固定收益类理财计划`,
      orgName: "招银理财有限责任公司",
      shares: { [src.prodTradeCode]: rows },
      replaceAll: true,
    };
  } finally {
    await browser.close();
  }
}

/** 北银理财官网数据源（beijingbobwealth.com.cn） */
async function fetchProductBob(code) {
  const src = BOB_SOURCES[code];
  const get = async (path, params) => {
    const qs = new URLSearchParams({ noCache: Date.now().toString(), ...params });
    const res = await fetch(src.site + path + "?" + qs, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: src.site + "/products_index/index.html?PROD_CODE=" + src.prodCode,
        Accept: "application/json",
      },
    });
    const j = await res.json();
    if (j.state !== "ok") throw new Error(`北银接口 ${path} 异常: ${j.msg || "unknown"}`);
    return j.data;
  };

  // 详情页流程：母产品 info 直接返回完整产品名 → subs 份额列表按 SHARE_CLASS 选份额 → navlist 取净值
  const info = await get("/bylc-api/product/info", { PROD_CODE: src.prodCode });
  const prodName = info?.PROD_NAME || "";
  await sleep(REQUEST_DELAY_MS);

  const subs = await get("/bylc-api/product/subs", { PROD_CODE: src.prodCode });
  await sleep(REQUEST_DELAY_MS);
  const wanted = src.shareClass || "A类";
  const sub =
    (subs || []).find((s) => String(s.SHARE_CLASS || "").startsWith(wanted)) || (subs || [])[0];
  if (!sub?.PROD_CODE) throw new Error(`北银 subs 未找到${wanted}份额（母代码 ${src.prodCode}）`);
  const shareCode = sub.PROD_CODE;

  const nav = await get("/bylc-api/product/navlist", {
    PROD_CODE: shareCode,
    START_DATE: "20200101",
    END_DATE: "20301231",
    pageSize: "2000",
    pageNumber: "1",
  });
  const list = nav?.list ?? [];
  const rows = list
    .map((r) => {
      const d = String(r.NAV_DATE); // YYYYMMDD
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        nav: r.NAV != null ? String(r.NAV) : "",
        acumlt: r.ACCUMULATIVE_NAV != null ? String(r.ACCUMULATIVE_NAV) : "",
        yieldPerMyriad: r.INCOME_UNIT != null ? String(r.INCOME_UNIT) : "",
        yieldSevenDay: r.INCOME_RATIO != null ? String(r.INCOME_RATIO) : "",
      };
    })
    .filter((r) => r.nav)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    prodRegCode: code,
    name: prodName,
    orgName: "北银理财有限责任公司",
    shares: { [shareCode]: rows },
    replaceAll: true, // 数据源整体替换，不做增量合并
  };
}

/**
 * 光大理财官网数据源（www.cebwm.com）
 *
 * 该站有瑞数反爬：纯 HTTP 直连返回 412 动态挑战页，XHR 请求/响应均为加密报文。
 * 但页面「渲染后的 DOM 文本是明文」，所以用无头 Chrome 打开详情页后直接读头部：
 *     "1.0100\n份额净值（2026-11-12）"
 * 只取最新一条（官网比中国理财网早一天），历史净值由备用源（中国理财网）合并补齐，
 * 因此返回 replaceAll: false，交给增量合并逻辑。
 */
async function fetchProductCeb(code) {
  const src = CEB_SOURCES[code];
  if (!src) throw new Error(`未配置光大理财数据源: ${code}`);
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    );
    await page.setViewport({ width: 1400, height: 1000 });
    await page.goto(src.site + src.detailPath, { waitUntil: "domcontentloaded", timeout: 90000 });
    // 瑞数挑战 + 页面渲染需要几秒，等「份额净值（日期）」出现
    await page
      .waitForFunction(() => /份额净值（\d{4}-\d{2}-\d{2}）/.test(document.body.innerText || ""), {
        timeout: 45000,
        polling: 500,
      })
      .catch(() => {});

    const snippet = await page.evaluate(() => {
      const t = document.body.innerText || "";
      const i = t.indexOf("份额净值（");
      if (i < 0) return "";
      return t.slice(Math.max(0, i - 60), i + 30);
    });
    const m = snippet.match(/([0-9]+(?:\.[0-9]+)?)\s*份额净值（(\d{4}-\d{2}-\d{2})）/);
    if (!m) throw new Error(`光大详情页未解析到净值，页面片段: ${JSON.stringify(snippet.slice(-60))}`);
    const navVal = m[1];
    const date = m[2];
    const nav = normNum(navVal);
    if (!nav) throw new Error(`光大净值异常: ${navVal}`);
    log(`  ${code} 光大官网最新 ${date} 净值 ${nav}`);
    return {
      prodRegCode: code,
      name: src.prodName,
      orgName: src.orgName,
      shares: { [src.share]: [{ date, nav, acumlt: nav, yieldPerMyriad: "", yieldSevenDay: "" }] },
      replaceAll: false, // 只有 1 条最新值，历史靠备用源合并
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 取一组抓取结果中的最新净值日期（无数据返回 null） */
function latestDateOf(fetched) {
  let latest = null;
  for (const rows of Object.values(fetched.shares || {})) {
    for (const r of rows) {
      if (r.date && (!latest || r.date > latest)) latest = r.date;
    }
  }
  return latest;
}

/**
 * 双数据源编排（DUAL_SOURCES）：主源失败、或主源最新净值日期落后于备用源时，采用备用源。
 * 备用源数据统一映射回 cfg.canonicalShare，并用增量合并写入——
 * 防止备用源历史较短导致归档缩水；主源恢复后由其 replaceAll 刷回官方口径。
 */
async function fetchDualSource(code, cfg) {
  let primary = null, primaryErr = null;
  try {
    primary = await SOURCE_FETCHERS[cfg.primary](code);
  } catch (e) {
    primaryErr = e;
    log(`  ${code} 主源(${cfg.primary})失败: ${e.message}`);
  }

  // 主源成功时也拉一次备用源对比新旧，避免主源披露滞后
  let fallback = null, fallbackErr = null;
  try {
    fallback = await SOURCE_FETCHERS[cfg.fallback](code);
  } catch (e) {
    fallbackErr = e;
    log(`  ${code} 备用源(${cfg.fallback})失败: ${e.message}`);
  }

  const pDate = primary ? latestDateOf(primary) : null;
  const fDate = fallback ? latestDateOf(fallback) : null;

  // 主源可用且不落后于备用源 → 用主源
  if (primary && pDate && (!fDate || pDate >= fDate)) {
    if (fDate) log(`  ${code} 主源最新 ${pDate}，备用源最新 ${fDate}，采用主源(${cfg.primary})数据`);
    return primary;
  }

  // 备用源有数据（主源失败，或备用源更新）→ 用备用源
  if (fallback && fDate) {
    log(`  ${code} 采用备用源(${cfg.fallback})（主源最新 ${pDate || "无"}，备用源最新 ${fDate}）`);
    const rows = Object.values(fallback.shares)
      .flat()
      .filter((r) => r.nav)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw primaryErr || fallbackErr || new Error("备用源无有效净值");
    const canonical = cfg.canonicalShare || Object.keys(fallback.shares)[0];
    return {
      prodRegCode: code,
      name: fallback.name || primary?.name || "",
      orgName: fallback.orgName || primary?.orgName || "",
      shares: { [canonical]: rows },
      replaceAll: false,
    };
  }

  throw primaryErr || fallbackErr || new Error("两个数据源均无可用净值");
}

const SOURCE_FETCHERS = {
  chinawealth: (code) => fetchProduct(code),
  bob: (code) => fetchProductBob(code),
  spdb: (code) => fetchProductSpdb(code),
  hsbank: (code) => fetchProductHsbank(code),
  hsbank_display: (code) => fetchProductHsbank(code, "lccs_display.php"),
  ceb: (code) => fetchProductCeb(code),
};

/* ==================== 指标计算 ==================== */

/**
 * 基于升序净值序列计算最新指标（标准净值型口径）。
 * 当日万收 = (nav_t - nav_{t-1}) / nav_{t-1} * 10000（平台披露 yieldPerMyriad 则优先采用）
 * 7日日均万收 = 近 7 个自然日（日历窗口）万收加总 / 7
 * 7日年化  = [(V_t / V_{t-7}) - 1] / 实际天数 × 365 × 100%（平台披露 annualizedYield 优先）
 * 14日年化 = [(V_t / V_{t-14}) - 1] / 实际天数 × 365 × 100%
 * 其中 V 优先取累计净值（含分红），t-7 / t-14 取当日或之前最近一个披露日。
 */
function calcIndicators(rowsAsc) {
  const n = rowsAsc.length;
  if (n < 2) return null;
  const nav = (i) => parseFloat(rowsAsc[i].nav);
  // 分红调整后的净值：优先累计净值
  const val = (i) => {
    const a = parseFloat(rowsAsc[i].acumlt);
    return Number.isFinite(a) && a > 0 ? a : nav(i);
  };
  const dayMs = 86400000;
  const toTs = (d) => Date.parse(d + "T00:00:00Z");
  const last = n - 1;
  const navToday = nav(last);
  const navPrev = nav(last - 1);
  if (!navToday || !navPrev) return null;

  const dailyWanShou = [];
  for (let i = 1; i < n; i++) {
    const a = nav(i), b = nav(i - 1);
    if (!a || !b) { dailyWanShou.push(null); continue; }
    const disclosed = parseFloat(rowsAsc[i].yieldPerMyriad);
    dailyWanShou.push(Number.isFinite(disclosed) && disclosed !== 0 ? disclosed : ((a - b) / b) * 10000);
  }
  const todayWanShou = dailyWanShou[dailyWanShou.length - 1] ?? null;

  // 近 7 个自然日（日历窗口）的万收加总 / 7
  const lastTs = toTs(rowsAsc[last].date);
  const winStart = lastTs - (WINDOW_7D - 1) * dayMs;
  let sum7 = 0, cnt7 = 0;
  for (let i = 1; i < n; i++) {
    const ts = toTs(rowsAsc[i].date);
    if (ts < winStart) continue;
    const v = dailyWanShou[i - 1];
    if (v != null) { sum7 += v; cnt7++; }
  }
  const wanShou7Avg = cnt7 ? sum7 / WINDOW_7D : null;

  // 找 t-days 当天或之前最近的一个披露日
  const baseIdx = (days) => {
    const target = lastTs - days * dayMs;
    for (let i = last - 1; i >= 0; i--) {
      if (toTs(rowsAsc[i].date) <= target) return i;
    }
    return -1;
  };
  // 区间年化：按实际跨越的自然日折算，避免节假日/周度披露造成偏差
  const annualize = (days) => {
    const i = baseIdx(days);
    if (i < 0) return null;
    const v0 = val(i), v1 = val(last);
    const span = (lastTs - toTs(rowsAsc[i].date)) / dayMs;
    if (!v0 || !v1 || !span) return null;
    return ((v1 / v0 - 1) / span) * ANNUALIZE_DAYS * 100;
  };

  // 平台披露的 7 日年化优先
  const disclosed7 = parseFloat(rowsAsc[last].yieldSevenDay);
  const annual7 = Number.isFinite(disclosed7) && disclosed7 !== 0 ? disclosed7 : annualize(WINDOW_7D);
  const annual14 = annualize(WINDOW_14D);

  const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
  return {
    date: rowsAsc[last].date,
    nav: navToday,
    acumlt: parseFloat(rowsAsc[last].acumlt) || null,
    wanShouToday: round(todayWanShou),
    wanShou7Avg: round(wanShou7Avg),
    annual7: round(annual7),
    annual14: round(annual14),
    annualBasis: `${ANNUALIZE_DAYS}日`,
    annualWindow: "日历日",
  };
}

/* ==================== 归档与看板 ==================== */

function toCsv(rows) {
  const head = "份额代码,净值日期,份额净值(元),累计净值(元),万份收益,7日年化(平台披露)";
  return (
    "\uFEFF" +
    head +
    "\n" +
    rows
      .map((r) => [r.subShareCode, r.date, r.nav, r.acumlt, r.yieldPerMyriad, r.yieldSevenDay].join(","))
      .join("\n") +
    "\n"
  );
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 净值「值签名」：对日期 + 净值 + 累计净值做哈希。
 * 用于判断本次抓取是否真的带来了新值（新增日期，或已有日期的净值被修正）。
 * 只有签名变化时才更新展示用的「净值更新时间」，保证时间与值严格一致。
 */
function valueSignature(sharesOut) {
  const payload = Object.keys(sharesOut)
    .sort()
    .map((k) => k + ":" + sharesOut[k].rows.map((r) => `${r.date}|${r.nav}|${r.acumlt}`).join(";"))
    .join("#");
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

function buildDashboardData(products) {
  const out = { generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }), products: [] };
  for (const p of products) {
    let sharesEntries = Object.entries(p.shares);
    if (SHARE_FILTER[p.prodRegCode]) {
      sharesEntries = sharesEntries.filter(([code]) => SHARE_FILTER[p.prodRegCode].includes(code));
    }
    const shares = [];
    for (const [code, rowsRaw] of sharesEntries) {
      const rowsAsc = [...rowsRaw].sort((a, b) => a.date.localeCompare(b.date));
      const indicators = calcIndicators(rowsAsc);
      shares.push({
        code,
        indicators,
        trend: rowsAsc.slice(-30).map((r) => ({ date: r.date, nav: parseFloat(r.nav) })),
      });
    }
    out.products.push({ code: p.prodRegCode, name: p.name, orgName: p.orgName, updatedAt: p.updatedAt || "", shares });
  }
  return out;
}

function writeDashboard(data) {
  const tplPath = path.join(DASHBOARD_DIR, "index.template.html");
  const tpl = fs.readFileSync(tplPath, "utf8");
  const html = tpl.replace("/*__NAV_DATA__*/null", JSON.stringify(data));
  fs.writeFileSync(path.join(DASHBOARD_DIR, "index.html"), html);
}

/* ==================== 主流程 ==================== */

// 取北京时间的日期（YYYY-MM-DD）。不能用 toISOString()：北京时间 7 点时 UTC 还是前一天 23 点，
// 会导致 7 点任务误判为"今日已完成"而跳过。这里显式按 Asia/Shanghai 取日期，不受机器时区影响。
const localDate = (d = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(d);

async function main() {
  const today = localDate();
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const state = loadJson(STATE_FILE, { lastNewDataDate: null, history: {} });

  if (BUILD_ONLY) {
    log("build-only 模式：仅根据已归档数据重建 CSV 归档与看板");
    const products = [];
    for (const code of ALL_PRODUCTS) {
      const m = loadJson(path.join(DATA_DIR, `${code}.json`), null);
      if (!m) { log(`  ${code} 无归档数据，跳过`); continue; }
      const allRows = [];
      for (const [share, s] of Object.entries(m.shares)) {
        for (const r of s.rows) allRows.push({ subShareCode: share, ...r });
      }
      fs.writeFileSync(path.join(ARCHIVE_DIR, `${code}.csv`), toCsv(allRows));
      products.push({
        prodRegCode: m.prodRegCode,
        name: m.prodName,
        orgName: m.orgName,
        updatedAt: m.lastChangeAt || m.lastUpdated || "",
        shares: Object.fromEntries(Object.entries(m.shares).map(([k, v]) => [k, v.rows])),
      });
      log(`  ${code} ${m.prodName} 重建完成（${allRows.length} 条）`);
    }
    writeDashboard(buildDashboardData(products));
    log("看板已刷新: dashboard/index.html");
    return;
  }

  if (DAILY_FLAG && state.lastNewDataDate === today) {
    console.log("SKIP: 今日已完成新增净值获取（lastNewDataDate=" + today + "），无需重复执行。");
    return;
  }

  await initSession();
  let gotNew = false;
  const report = [];

  for (const code of PRODUCTS) {
    log(`抓取产品 ${code} ...`);
    let fetched;
    try {
      // 官网类数据源（无头 Chrome）偶发加载失败，整源重试一次再判定失败
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          fetched = DUAL_SOURCES[code]
            ? await fetchDualSource(code, DUAL_SOURCES[code])
            : BOB_SOURCES[code]
              ? await fetchProductBob(code)
              : CMB_SOURCES[code]
              ? await fetchProductCmb(code)
              : ABC_SOURCES[code]
                ? await fetchProductAbc(code)
                : SPDB_SOURCES[code]
                  ? await fetchProductSpdb(code)
                  : HSBANK_SOURCES[code]
                    ? await fetchProductHsbank(code)
                    : await fetchProduct(code);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 1) {
            log(`  ${code} 第 1 次抓取失败: ${e.message}，8 秒后重试一次`);
            await sleep(8000);
          }
        }
      }
      if (lastErr) throw lastErr;
    } catch (e) {
      log(`  ${code} 抓取失败: ${e.message}`);
      report.push({ code, ok: false, error: e.message });
      continue;
    }

    const masterFile = path.join(DATA_DIR, `${code}.json`);
    const master = loadJson(masterFile, null);
    const productNew = [];

    const sharesOut = {};
    for (const [share, rows] of Object.entries(fetched.shares)) {
      if (SHARE_FILTER[code] && !SHARE_FILTER[code].includes(share)) continue; // 应用份额过滤
      const existing = master?.shares?.[share]?.rows ?? [];
      const existingDates = new Set(existing.map((r) => r.date));
      let merged;
      if (fetched.replaceAll) {
        // 官网数据源：整段替换，保证口径一致（不与旧数据源混用）
        merged = [...rows];
      } else {
        merged = [...existing];
        for (const r of rows) {
          if (!existingDates.has(r.date) && r.nav) merged.push(r);
        }
      }
      merged.sort((a, b) => a.date.localeCompare(b.date));
      // 统一在此统计新增（replaceAll 与增量合并都适用，避免重复计数）
      for (const r of merged) {
        if (!existingDates.has(r.date)) productNew.push({ share, ...r });
      }
      sharesOut[share] = { rows: merged };
    }

    // 值签名：只有净值真的发生了变化（新增日期或已有日期净值被修正）才更新时间，
    // 避免出现「净值没变但时间变了」
    const sig = valueSignature(sharesOut);
    const prevSig = master?.valuesSig || null;
    const nowStr = new Date().toLocaleString("zh-CN", { hour12: false });
    // 旧档案没有签名（首次运行）：锚定原 lastUpdated 作为基线，不无故把时间跳到当前
    const valuesChanged = prevSig ? prevSig !== sig : false;
    const lastChangeAt = valuesChanged
      ? nowStr
      : master?.lastChangeAt || master?.lastUpdated || nowStr;
    if (valuesChanged && productNew.length === 0) {
      // 仅净值被修正（无新增日期）也视为拿到了新值
      gotNew = true;
      log(`  ${code} 检测到净值修正（值签名变化，无新增日期）`);
    }

    // 归档
    const outObj = {
      prodRegCode: fetched.prodRegCode,
      prodName: fetched.name,
      orgName: fetched.orgName,
      source: BOB_SOURCES[code]
        ? "beijingbobwealth.com.cn（北银理财官网）"
        : CMB_SOURCES[code]
          ? "cmbchinawm.com（招银理财官网）"
          : ABC_SOURCES[code]
            ? "abcwealth.com.cn（农银理财官网）"
            : SPDB_SOURCES[code]
              ? "spdb-wm.com（浦银理财官网）"
              : HSBANK_SOURCES[code]
                ? "hsbankwm.com（徽银理财官网）"
                : CEB_SOURCES[code]
                  ? "cebwm.com（光大理财官网）+ chinawealth.com.cn（中国理财网）"
                  : "chinawealth.com.cn（中国理财网）",
      lastUpdated: nowStr,      // 最近一次检查时间（每次运行都会变，仅用于排查）
      lastChangeAt,             // 当前这批净值被获取到的时间（净值不变则不变，看板展示用）
      valuesSig: sig,
      shares: sharesOut,
    };
    fs.writeFileSync(masterFile, JSON.stringify(outObj, null, 2));

    const allRows = [];
    for (const [share, s] of Object.entries(sharesOut)) {
      for (const r of s.rows) allRows.push({ subShareCode: share, ...r });
    }
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${code}.csv`), toCsv(allRows));

    if (productNew.length > 0) gotNew = true;
    const latest = Object.values(sharesOut)[0]?.rows.at(-1)?.date ?? "-";
    report.push({
      code,
      ok: true,
      name: fetched.name,
      shares: Object.keys(sharesOut).length,
      newRows: productNew.length,
      latestDate: latest,
      totalRows: allRows.length,
    });
    log(`  ${code} ${fetched.name} | 新增 ${productNew.length} 条 | 最新净值日 ${latest} | 累计 ${allRows.length} 条`);
    await sleep(REQUEST_DELAY_MS);
  }

  // 更新状态
  if (gotNew) state.lastNewDataDate = today;
  state.history[today] = { at: new Date().toLocaleString("zh-CN", { hour12: false }), gotNew, report };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // 刷新看板
  try {
    const products = [];
    for (const code of ALL_PRODUCTS) {
      const m = loadJson(path.join(DATA_DIR, `${code}.json`), null);
      if (!m) continue;
      products.push({
        prodRegCode: m.prodRegCode,
        name: m.prodName,
        orgName: m.orgName,
        updatedAt: m.lastChangeAt || m.lastUpdated || "",
        shares: Object.fromEntries(Object.entries(m.shares).map(([k, v]) => [k, v.rows])),
      });
    }
    writeDashboard(buildDashboardData(products));
    log("看板已刷新: dashboard/index.html");
  } catch (e) {
    log("看板刷新失败: " + e.message);
  }

  if (!gotNew) {
    console.log("RESULT: 今日暂无新增净值数据（净值通常按 T+1 披露，明早会自动重试）。");
  } else {
    console.log(`RESULT: 更新完成，已获取新增净值并归档（lastNewDataDate=${state.lastNewDataDate}）。`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
