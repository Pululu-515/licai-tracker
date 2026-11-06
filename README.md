# 理财净值看板（云端版）

每天北京时间 06:50 / 08:00 自动抓取 11 个理财产品的净值，归档并部署成静态网页。
不依赖任何一台电脑开机——抓取、计算、发布全部在 GitHub 云端完成。

## 访问

部署完成后网址为：`https://Pululu-515.github.io/licai-tracker/`

手机、电脑、亲友都能直接打开，打开的永远是最新数据。

## 目录说明

| 路径 | 含义 |
| --- | --- |
| `data/<登记编码>.json` | 净值主档（产品信息 + 各份额完整净值序列），每日增量追加 |
| `data/archive/<编码>.csv` | 累计净值 CSV，每次全量重写（幂等） |
| `data/state.json` | 当日是否已抓取的状态标记，供 06:50 / 08:00 两次任务去重 |
| `scripts/update_daily.mjs` | 抓取 + 归档 + 指标计算 + 刷新 PC 版看板 |
| `scripts/export_site.mjs` | 把归档导出为自包含单页 `site/index.html` |
| `share-template.html` | 移动端看板模板（数据占位符 `/*__NAV_DATA__*/ null`） |
| `.github/workflows/update.yml` | 定时任务：抓取 → 生成站点 → 提交 → 部署 Pages |

## 手动操作

- **立即更新一次**：仓库 Actions 页 → 每日净值更新 → Run workflow
- **本地重算（不联网）**：`node scripts/update_daily.mjs --build-only && node scripts/export_site.mjs`
- **增删产品**：修改 `scripts/update_daily.mjs` 顶部的 `PRODUCTS` 与 `ALL_PRODUCTS`（两处要一致），以及 `scripts/export_site.mjs` 的 `PRODUCT_ORDER`

## 说明

- 抓取的是各理财公司 / 中国理财网公开披露的净值，仅供自用参考，不构成投资建议。
- 网页里的持仓与交易记录保存在访问者自己的浏览器 localStorage 中，不上传服务器。
- 若某天任务失败，第二天成功运行会自动补齐缺口（数据源返回完整历史序列）。
