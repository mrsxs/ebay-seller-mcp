# ebay-seller-mcp

eBay 卖家 MCP 服务器：**Terapeak 商品调研**（关键词在 eBay 美国站的真实成交均价、成交件数、售罄率、卖家数、成交总额、热卖 listing、每日 / 周 / 月走势、类目分布、在售竞争）、**eBay 前台搜索**（买家看到的排名、价格、运费、发货地、已售件数），**自家店铺数据**（订单、流量、卖家表现）、**财务**（资金、交易和费用明细、回款）、**广告**（推广活动、效果报表、广告管理）和**刊登与管理**（新刊登、改内容 / 改价改库存 / 增删规格、下架、重新上架：都是预检 → 用户确认后执行）。

调研和搜索从**本机紫鸟（Ziniao）店铺浏览器里已登录的 eBay Seller Hub** 取：Terapeak 用 Seller Hub Research 页面自己的接口，前台搜索在一个专用标签页里真实打开搜索页再读页面，不需要 App Key，请求走那家店的紫鸟代理 IP。
刊登走 **eBay 开放平台**（需要自己的开发者密钥和店铺授权，见「刊登」）。

- **调研只读**：调研和搜索工具不改 listing、不改价、不发消息。
- **写操作都两步走**：新刊登 `ebay_listing_preview` 只让 eBay 校验、不刊登，`ebay_listing_publish` 只能发布预检通过的原样内容；
  改已有 listing / 下架 / 重新上架的 `*_preview` 只生成「改前 → 改后」的修改记录，`ebay_listing_apply` 才执行。执行都要 `confirm: true`（客户端应先把预检结果给用户确认）。
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
| `EBAY_DATA_DIR` | 浏览器锁、冷却文件、刊登预检记录目录，默认 `~/.ebay-seller-mcp`。多个程序用同一个紫鸟浏览器时共用这个目录，才能互相排队。 |
| `EBAY_API_KEYS` | 刊登用：eBay 开发者密钥和店铺授权文件，默认 `~/.config/ebay-seller-mcp/api-keys.json`。 |
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
| `ebay_listing_defaults` | 刊登：店里的运费 / 退货 / 付款政策，最近在售商品常用的发货地和政策组合（预检的默认值），最近用过的类目 |
| `ebay_category_suggest` | 刊登：按英文关键词推荐叶子类目（ID 和完整路径） |
| `ebay_category_aspects` | 刊登：类目的商品属性（必填 / 建议 / 可选、可选值、能否做规格名）、能用的商品状态、能否多规格 |
| `ebay_listing_preview` | 刊登预检（不刊登）：上传图片到 eBay 图片服务，让 eBay 按真实规则校验，返回错误 / 警告、刊登费用、内容摘要和 `preview_id`（24 小时有效） |
| `ebay_listing_publish` | 正式刊登：按 `preview_id` 发布预检通过的原样内容（`confirm: true`）；同一个 `preview_id` 重复调用不会重复刊登 |
| `ebay_orders` | 自家订单：最近 7~90 天，每单的状态、金额、卖家应收、收货国家、最晚发货时间、商品明细；可只看未发货 / 已发货。**不返回买家个人信息**（只给收货国家） |
| `ebay_traffic` | 自家流量（官方流量报告）：按天或按商品的曝光、浏览、来自搜索的浏览、成交笔数、搜索点击率、转化率；数据到昨天 |
| `ebay_seller_standards` | 卖家表现：卖家等级和各项考核指标（交易缺陷率、延迟发货率、未解决纠纷等） |
| `ebay_finance_summary` | 财务概况：现在的资金（总额、可提现、处理中、冻结），最近 N 天的销售、退款、非销售扣费、运单、纠纷合计，这段时间的回款 |
| `ebay_transactions` | 资金交易明细：每笔销售 / 退款 / 扣费 / 运单的金额、状态、关联订单、费用拆分（成交费、国际费、广告费…）；不返回买家信息 |
| `ebay_payouts` | 回款记录：时间、状态、金额、换汇金额和汇率、手续费；不返回银行卡信息 |
| `ebay_ad_campaigns` | 推广活动：状态、按成交 / 按点击付费、固定 / 动态费率、日预算 |
| `ebay_ad_campaign_ads` | 活动里的商品和各自的广告费率 |
| `ebay_ad_report` | 推广效果报表（按账户 / 活动 / 商品 / 每笔成交 / 关键词 / 搜索词）：曝光、点击、点击率、广告成交、成交额、广告费；eBay 异步生成，第一次可能返回 pending，过一两分钟同样参数再调 |
| `ebay_ad_change_preview` | 广告修改预检：暂停 / 恢复 / 结束活动、改费率策略、改商品费率、加 / 移商品、改日预算，返回「改前 → 改后」和 `change_id` |
| `ebay_ad_change_apply` | 执行广告修改（`confirm: true`）：执行前重新读活动，预检后被改过就拒绝；同一个 `change_id` 不会重复执行 |
| `ebay_listings` | 自家 listing 列表：在售 / 已结束未售出（ItemID、标题、SKU、价格区间、可售数量、已售件数、关注人数、规格数） |
| `ebay_listing_get` | 一条 listing 的详情：标题、类目、价格和可售数量（逐个规格）、图片、属性、规格配图、政策、发货地、描述 |
| `ebay_listing_revise_preview` | 修改预检：改标题 / 描述 / 图片 / 属性 / 状态 / 类目 / 政策 / 发货地 / 议价、改价改库存、按 SKU 增删规格，返回「改前 → 改后」和 `change_id` |
| `ebay_listing_end_preview` | 下架预检（返回 `change_id`） |
| `ebay_listing_relist_preview` | 重新上架预检：已结束 90 天内的 listing 按原样重新刊登（返回 `change_id`） |
| `ebay_listing_apply` | 执行修改 / 下架 / 重新上架（`confirm: true`）：执行前重新读 listing，预检后被改过就拒绝；同一个 `change_id` 不会重复执行 |

## 口径

- eBay 美国站（EBAY-US），金额美元。Terapeak 的日期按**美国太平洋时间**，截止到今天，和 Seller Hub 页面一致；只统计已付款、未退款的成交。
- 比例字段（`avg_sold_price_change`、`free_shipping_share`、`sell_through`、`promoted_share`）是 0~1 的小数。
- 售罄率 `sell_through` = 有成交的 listing ÷（有成交 + 没成交的 listing）。
- 成交均价受个别高价商品影响大：看价格时结合价格区间、listing 明细和类目筛选。
- 前台搜索按这家店紫鸟浏览器的收货地显示运费；`sold` 是卡片上的「已售」件数（「1.2K+ sold」取下限）。页面上分不出哪些是广告位，推广情况看 `ebay_research_active`。
- 前台搜索在窗口最小化时第一次打开可能要过 eBay 的浏览器检查（最多等 45 秒，通过一次后同一标签页之后的搜索 2～4 秒）。

## 刊登

刊登用 eBay 开放平台（Trading API 刊登、Media API 传图、Account / Taxonomy / Metadata API 查政策和类目），需要：

1. **开发者密钥**：在 [developer.ebay.com](https://developer.ebay.com) 建 Production 密钥集（处理好 Marketplace Account Deletion：不保存 eBay 用户数据可申请豁免），
   在 User Tokens 里建一个 RuName 并开启 OAuth。把 `app_id`、`cert_id`、`ru_name` 写进 `~/.config/ebay-seller-mcp/api-keys.json`（`chmod 600`）：
   ```json
   { "app_id": "...", "cert_id": "...", "ru_name": "..." }
   ```
2. **店铺授权**：在终端运行
   ```bash
   EBAY_SHOPS='[{"name":"美国站","store_id":"12345678901234"}]' npx -y ebay-seller-mcp@latest auth --shop 美国站
   # 或 npx -y ebay-seller-mcp@latest auth --store-id 12345678901234
   ```
   会在**这家店的紫鸟店铺浏览器**里打开 eBay 授权页（不在别的浏览器里登录卖家账号），点「Agree」后授权保存到上面的文件，约 18 个月有效。
   申请的权限：订单 / 流量 / 库存 / 广告 / 账户只读、财务、身份、店铺只读，加上刊登（`sell.inventory`）和广告（`sell.marketing`，生成效果报表也要这项）。
   之前授权过、后来工具提示「授权里没有这项权限」时，重新运行一次 `auth`。

刊登口径：一口价、GTC 长期在售、美元、eBay 美国站；运费 / 退货 / 付款用店里已有的业务政策（不传就用最近在售商品最常用的组合）；
图片上传后 eBay 保留约 30 天，同一张图在有效期内不重复上传；预检记录 24 小时内可发布。发布带 UUID，网络中断后用同一个 `preview_id` 重发，eBay 会认出已刊登的商品而不会重复刊登。

店铺数据口径：订单时间是 UTC；流量日期按美国太平洋时间、到昨天为止，点击率 = 来自搜索的浏览 ÷ 搜索曝光，转化率 = 成交笔数 ÷ 浏览（0~1 的比例）。

财务和广告口径：金额美元（回款附换汇后的金额）；交易时间 UTC；广告报表按 UTC 整天、到昨天；广告修改只支持按成交付费活动的商品级操作（按点击付费的广告组、关键词请在 Seller Hub 里管理）。

修改口径：改价改库存用 ReviseInventoryStatus（数量是可售数量，不含已卖出的），其余用 ReviseFixedPriceItem（图片、商品属性整组替换）；规格要有 SKU 才能单独改。
已有销量（或 12 小时内到期）的 listing，eBay 不允许改标题、类目、发货地。下架后只能重新上架（新 ItemID）；重新上架带 UUID 防重复。

## 说明

非官方工具：调研和搜索用的是 eBay Seller Hub 页面自己调用的内部接口和公开搜索页，平台改版可能导致失效。请求和你在 Seller Hub 里手动查看一样走店铺浏览器，但请控制调用频率，遇到验证时先在浏览器里手动处理，不要反复重试；使用时请遵守 eBay 的用户协议。

## 开发

```bash
npm test
```

测试不连浏览器。

## License

MIT
