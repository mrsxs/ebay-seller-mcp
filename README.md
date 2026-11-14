# ebay-seller-mcp

eBay 卖家 MCP 服务器：**Terapeak 商品调研**（关键词在 eBay 美国站的真实成交均价、成交件数、售罄率、卖家数、成交总额、热卖 listing、每日 / 周 / 月走势、类目分布、在售竞争）和 **eBay 前台搜索**（买家看到的排名、价格、运费、发货地、已售件数）。

所有数据都从**本机紫鸟（Ziniao）店铺浏览器里已登录的 eBay Seller Hub** 取：Terapeak 用 Seller Hub Research 页面自己的接口，前台搜索在一个专用标签页里真实打开搜索页再读页面。不走 eBay 开放平台，不需要 App Key。请求走那家店的紫鸟代理 IP。

- **只读**：不改 listing、不改价、不发消息。
- **遇到验证就停**：eBay 浏览器检查页（Pardon Our Interruption）一直不放行、验证码、请求太频繁、请求被转到验证 / 登录页时，不重试，并且这家店 10 分钟内不再发请求（记在数据目录的 `cooldown.json`，用同一个数据目录的其他 MCP 进程也会停；删掉它可立即恢复）。
- **少发请求**：每个工具一次调用只发 1 个请求（前台搜索是打开 1 个页面）；相同查询 Terapeak 30 分钟、前台搜索 10 分钟内直接用缓存。
- 零依赖，Node.js ≥ 22。

## 前提

1. 本机装了紫鸟客户端和 `ziniao-cli`（`ziniao-cli store list` 能列出店铺）。用客户端自带的 Node 启动 MCP 时（如 Accio），会自动去 nvm / Homebrew / npm 全局目录找 `ziniao-cli`，找不到可用 `ZINIAO_CLI` 指定。
2. 店铺浏览器里登录了这家店的 eBay 卖家账号，Seller Hub → Research（Terapeak）能打开。
3. 店铺浏览器没开时工具会通过 `ziniao-cli` 自动打开（会弹出一次窗口）。每家店会用两个标签页：Seller Hub Research、eBay 搜索页。

## 配置

```json
{
  "mcpServers": {
    "ebay-seller": {
      "command": "npx",
      "args": ["-y", "ebay-seller-mcp@latest"],
      "env": {
        "EBAY_SHOPS": "[{\"name\":\"美国站\",\"store_id\":\"12345678901234\",\"default\":true}]"
      }
    }
  }
}
```

| 环境变量 | 说明 |
|---|---|
| `EBAY_SHOPS` | 店铺数组（JSON）。`store_id` 是**紫鸟店铺 ID**（`ziniao-cli store list` 里的 storeId），`name` 随便起，`default: true` 标默认店（不标则第一家）。 |
| `EBAY_STORE_ID` | 只有一家店时可以只设紫鸟店铺 ID，代替 `EBAY_SHOPS`。 |
| `EBAY_DATA_DIR` | 浏览器锁和冷却文件目录，默认 `~/.ebay-seller-mcp`。多个程序用同一个紫鸟浏览器时共用这个目录，才能互相排队。 |
| `ZINIAO_CLI` | `ziniao-cli` 的路径（自动查找失败时）。 |

配置写错时服务器照常启动，调用任何工具都会返回具体哪里错了。

## 工具

| 工具 | 内容 |
|---|---|
| `ebay_shops` | 已配置的店铺 |
| `ebay_research` | Terapeak 已售：最近 7 / 30 / 90 / 180 / 365 / 730 / 1095 天的成交均价（和上期比）、价格区间、平均运费、包邮占比、成交件数、成交总额、有成交 / 没成交的 listing 数、售罄率、卖家数；按成交件数排的 listing（成交件数、成交均价、运费、成交总额、最近成交日期）。可按类目筛选、翻页 |
| `ebay_research_trend` | Terapeak 已售走势：每天 / 每周 / 每月的成交均价和成交件数 |
| `ebay_research_categories` | Terapeak 类目分布：关键词的成交落在哪些类目，可一层层往下钻；类目 ID 可用于其他工具筛选 |
| `ebay_research_active` | Terapeak 在售：在售 listing 数、平均售价、平均运费、包邮占比、付费推广占比、价格区间；在售 listing（价格、运费、关注人数、是否推广、上架日期） |
| `ebay_search` | eBay 前台搜索：排名位置、标题、新旧、价格（含多规格价格区间、划线原价）、一口价 / 拍卖 / 可议价、运费、发货地、已售件数；可按排序、新旧、只看一口价、价格区间、类目筛选，每页 60 条，最多 3 页 |

## 口径

- eBay 美国站（EBAY-US），金额美元。Terapeak 的日期按**美国太平洋时间**，截止到今天，和 Seller Hub 页面一致；只统计已付款、未退款的成交。
- 比例字段（`avg_sold_price_change`、`free_shipping_share`、`sell_through`、`promoted_share`）是 0~1 的小数。
- 售罄率 `sell_through` = 有成交的 listing ÷（有成交 + 没成交的 listing）。
- 成交均价受个别高价商品影响大：看价格时结合价格区间、listing 明细和类目筛选。
- 前台搜索按这家店紫鸟浏览器的收货地显示运费；`sold` 是卡片上的「已售」件数（「1.2K+ sold」取下限）。页面上分不出哪些是广告位，推广情况看 `ebay_research_active`。
- 前台搜索在窗口最小化时第一次打开可能要过 eBay 的浏览器检查（最多等 45 秒，通过一次后同一标签页之后的搜索 2～4 秒）。

## 说明

非官方工具：用的是 eBay Seller Hub 页面自己调用的内部接口和公开搜索页，平台改版可能导致失效。请求和你在 Seller Hub 里手动查看一样走店铺浏览器，但请控制调用频率，遇到验证时先在浏览器里手动处理，不要反复重试；使用时请遵守 eBay 的用户协议。

## 开发

```bash
npm test
```

测试不连浏览器。

## License

MIT
