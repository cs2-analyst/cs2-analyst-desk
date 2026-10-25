# P8.1-L2：Dust2 地图几何数据源与版本匹配可行性审查

日期：2026-10-25（Asia/Shanghai）。性质：只读技术研究；仅新增本文和配套 [机器记录](p8-1l2-map-geometry-feasibility-2026-10-25.json)。版本保持 0.2.0。

**结论：部分具备启动条件。** 可以在另行授权后，先实施资源身份记录、逐能力拒绝门控，以及同 tick 原生 XYZ 的水平/三维距离。尚不具备交付“与目标 Dust2 DEM 匹配、已验证”的导航或静态 LOS 的条件。最关键缺口是 **目标 DEM → 实际地图资源闭包的可信绑定，以及同一构建上的独立空间真值**。本机有地图文件，并非缺少游戏安装；文件存在、工具支持相应格式、游戏版本接近，都不能替代这两个前提。

推荐后续以 **C（可信离线预处理）+ A（纯确定性本地查询）** 为优先验证路线；B（受限独立 helper）作为读取 Source 2 资源的备选。这里是技术建议，不授权实施，不放行 P8.1C/D、P8.2，也不创建新生产类型或模块。

## 1. 审查基线与方法

### 1.1 仓库与未合并的范围决策

| 项目 | 本轮实际核对 |
| --- | --- |
| 仓库 | `https://github.com/cs2-analyst/cs2-analyst-desk.git`，本地 `E:\cs2-analyst` |
| 开始分支 / HEAD | `codex/p8-1b-r-l1-l2` / `2596a3d22f4186f5226f5736ef8a7c35703fad06`；工作区干净 |
| 最新远端 | 实际执行 `git fetch origin --prune`；`origin/main=f44984e5464552c81737922c67df3d9f17c27c71` |
| 相对 main | 开始 HEAD 多两个 P8.1B/B-R 研究提交；`apps/`、`packages/`、`scripts/`、根依赖文件与 main 无差异 |
| 本轮分支 | 从上述干净 HEAD 创建 `codex/p8-1l2-map-geometry-feasibility`；未合并其他分支 |
| PR #4 | [范围决策 PR][S01]：`open`、`draft=true`、`merged=false`，head `8f61854793f3d9230d1cd160b3fd01dedaafcadd`，base 为上述 main；不能将 API 返回的预计算 `merge_commit_sha` 当作已合并 |

已同时阅读本地 `docs/ai-coach-technical-route.md` 与 PR #4 head 上的更新版；`p8-scope-decision-l1-l2-2026-10-25.md`、`p8-1a-decision-evidence-contract.md` 在当前分支不存在，实际通过已 fetch 的 PR head 用 `git show` 读取，引用 [范围决定][S01a] 和 [契约草案第 12 节][S01b]，没有复制或合并进当前分支。用户本轮明确授权研究 L1/L2，优先于旧阶段地图中的“不启动 P8”；授权范围仍只限本次研究。

还读取了 P8.1B/B-R 报告、能力矩阵、JSON 的 `historical.record` 与 `currentRun`、`docs/replay-resources.json`、`docs/replay-calibration.json`、架构、fixture 白名单、地图回放实施记录和审计脚本，以及 parser/native 源码与 provenance。遵循全局/项目 AGENTS、DEM/domain/analytics 工作流及 model-routing；`.agents/workflows/feature-development.md` 在本基线不存在。研究涉及架构、格式和证据边界，按 reasoning 工作处理，文档完成后独立 reviewer 只读复审。

### 1.2 实际方法与状态含义

- 使用 GitHub 连接读取候选原仓库的 README、源码、测试、平台工作流、LICENSE 和 release 元数据；记录完整提交 SHA，避免将搜索摘要当结论。
- 网络搜索只用于发现线索；能力判断优先依赖原始代码。Valve Developer Community 的 VMAP、VPK、CS2 Workshop Tools 页面访问返回 403/不可访问，**没有把这些未读取页面作为格式通过证据**；Valve 的旧 CS:GO protobuf 只用于说明 Source 1 的 CRC 方案不能照搬。[S16]
- 本机只读核验白名单 DEM header、原始 protobuf 字段、SHA-256、Steam 安装元数据和已有 VPK 的文件身份；未提取地图、未解析 NAV/碰撞、未启动游戏、未注入、未访问游戏进程。
- 未下载地图、DEM、release 二进制或资产；未安装依赖、编译工具、创建 helper、运行候选工具或其上游测试。读取公共发布包的文本源码不等于安装该包。
- `PASS` 仅用于已实际执行且限定范围成立的检查；`BLOCKED` 为明确前置缺口；`NOT RUN` 为本轮未实测；`UNSUPPORTED` 为格式或产品范围明确不支持。源码中的格式分支和测试存在，只标“源码证据”，不标运行 PASS。

## 2. 本地输入与版本事实

### 2.1 Dust2 DEM：新增发现与已有证据

| 项目 | 实测 / 源码事实 | 能证明什么 |
| --- | --- | --- |
| `.demo/dust2.dem` | 557650967 bytes；SHA-256 `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c` | 本轮重新计算，与白名单及 B-R 记录一致；文件未移动或复制 |
| native adapter | `@cs2-analyst/demoparser-native` `0.42.0-backport.363.1`，Windows x64 MSVC；verified binary SHA `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1` | 本次加载时校验 provenance；不是候选地图工具 |
| 上游来源 | demoparser `v0.42.0`，base `d3767705dc5846d73ed29db50eaeda58778dc934`，#363 backport；补丁摘要见 `packages/demoparser-native/source.json` | 固定解析链，而非最新版 parser 的推测 |
| 当前 `parseHeader()` | `map_name=de_dust2`、`patch_version=14055`、`demo_version_name=valve_demo_2`、GUID `8e9d71ab-04a1-4c01-bb61-acfede27c046`、addons 为空 | 名称、游戏/格式线索；GUID 不应当作地图内容身份 |
| 原始 `CDemoFileHeader` | 首帧 cmd=1、payload=183 bytes；tag 13 为 varint **`build_num=10231`**；tag 15 为 `server_start_tick=51144` | 本轮只读原始字段核验；不是 `map_build` |

关键区别：固定的生成 protobuf 定义有 `build_num`（tag 13），但 `first_pass/parser.rs:311–335` 的 `parse_header()` 没有将其插入导出字典。[S02] 本地生成源 SHA-256 `953ad3f19e1c1bd888d8d51292ff47cb1379a979353f07fb7977a4c152e4f5b5` 与 `source.json` 一致。故不能从现有返回字典没该键推断 DEM 没有游戏 build 信息，也不能反过来把 build 10231 当成 Dust2 地图哈希。本轮没有改 adapter。

固定 schema 的 `CSVCMsg_ServerInfo` 没有旧 Source 1 的 `map_crc` 字段，但有 opaque `game_session_manifest`；`CNETMsg_SpawnGroup_Load` 有 `worldname`、offset、manifest bytes 和 creation sequence。这里只确认定义存在：**本轮未解码这份 DEM 的这些消息，未验证它们是否含稳定内容身份、覆盖哪些依赖或采用何种摘要算法**。这是下一次只读调查的候选入口，不能声称 DEM 的所有消息都绝无资源标识。原 `CS:GO map_crc → BSP` 服务不是已经成立的 CS2 匹配链。[S16]

现有 `dem-parser/src/providers/demoparser2-adapter.ts` 调用 native header，`converters.ts` 主要取 `header.map_name` 构造 Match；不能假定归档已经保留未来所需的地图绑定材料。个人 DEM 不上传服务端；后续新增提取字段须单独授权并走契约工作流。

### 2.2 本机确有地图安装，但不等于匹配目标 DEM

通过 Steam 注册表的安装路径与 `libraryfolders.vdf` 定位 app 730，再仅读取以下明确文件；没有全盘扫描或资源提取。

| 已有本地文件 / 元数据 | 本轮值 |
| --- | --- |
| `C:\Steam\steamapps\appmanifest_730.acf` | `buildid=26144732`；depot 2347770 manifest `67499503218971311` |
| `...\Counter-Strike Global Offensive\game\csgo\steam.inf` | ClientVersion / ServerVersion `2000935`；PatchVersion `1.41.9.2`；SourceRevision `11162119`；VersionDate `Oct 22 2026`；VersionTime `14:13:16`（未认定时区） |
| `steam.inf` 摘要 | 190 bytes；SHA-256 `67bb5f38cdcfb57331eea7dbcf2d337f46ea6ed998d3482e2637f830f7210a06` |
| `game\csgo\maps\de_dust2.vpk` | 262476433 bytes；SHA-256 `51d6bb432b6553bfae6c38219a527c5de2464a2b107080f2b8be7d8427ebb885` |
| `game\csgo\pak01_dir.vpk` | 7708830 bytes；SHA-256 `562972293ed7a5d40e341c4df7d6b0ee06430452694177142f0c1239dd3f2c8b` |

`...` 表示上面 Steam common 目录下的完整安装目录，详见 JSON。这里只证明采样时本地字节和安装声明；没有解包验证 VPK 内 Dust2 NAV、world physics 及引用闭包的存在性/一致性。文件修改日期不能代替地图构建日期。`build_num`、`SourceRevision`、Steam `buildid`、`ClientVersion` 不是可互换的编号；本轮没有建立 `10231/14055 → 26144732/2000935` 的可信映射。

### 2.3 现有雷达/overview 的可复用范围

`docs/replay-resources.json` 固定 app 730 / depot 2347770 / manifest `2312433566686574487`，buildId/clientVersion 均 null；resourceId 为 `valve-730-2347770-2312433566686574487-vrf20.1`。与本机当前 manifest 不同，**差异不能证明 Dust2 几何必然改变，也不能确认两者等价**。

Dust2 原 overview SHA `97947e99bc7930fc06dc15af3dcf942dbca5ca1c6f36119a089615fd4b383620`、PNG SHA `0828297130ce26db25a299806ff743df9104de634a3e64b52b358f6f4399354d`；1024×1024，`posX=-2476,posY=3239,scale=4.4`。本轮运行既有审计/测试，13 张图片和原 overviews 与 manifest 一致。既有四区域配准是人工选取雷达区域与 native 观测的粗配准；重新执行的是已存基准回归，没有新增本轮人工地标或像素级精度测量。

`apps/desktop/shared/replay-map-geometry.ts` 仅有投影算术和 overview 层选择：

```text
u = (x - posX) / scale × width / 1024
v = (posY - y) / scale × height / 1024
```

它不含碰撞、NAV、LOS 或地图 build；Dust2 仅一个无界 default 图层。`scripts/replay-resource-audit.mjs` 的十地图白名单和 `check-replay-map-assets.mjs` 的图片摘要检查也不覆盖新几何资产。不得扩展该白名单来暗中携带 VPK/NAV。

## 3. 候选来源与工具

所有平台描述均区分上游发布/构建证据和本机运行。下表的输入/功能是实际读源码后的结论；除明确不支持外，**候选 Dust2 运行均 NOT RUN**。

| 候选 | 实际输入与输出 / CS2 格式 | 拓扑、碰撞、遮挡与动态边界 | 版本、平台、依赖与当前判断 |
| --- | --- | --- | --- |
| Source 2 游戏资源 + ValveResourceFormat / Source 2 Viewer | VPK 只是容器；编译 `.vmap_c/.vwrld_c/.vwnod_c`、实体/模型/物理资源形成依赖闭包；`.vphys_c` 或模型内嵌 PHYS 提供 shapes；Source 2 `.nav` 是另一输入。不能把地图当一个 Source 1 `.bsp`。支持读取/导出这些类别有源码证据。[S03][S04] | NAV areas/polygons、连接、hull、ladder、生成参数；physics 的 mesh/hull/sphere/capsule、bind pose、collision attributes、surface properties 可访问。地图 loader 可解析实体和静态变换，**不等于恢复 DEM 时刻的动态对象状态**。几何导出不是游戏可见性裁判。 | release 20.1 有 `cli-windows-x64.zip`；本仓旧资源确曾使用该版本，但本次未运行。20.1 NAV 源码接受 30–36；当前 master 增加的测试不能追认旧二进制验证。[S03][S05] 原始文件必须本机已有，独立读取不需要游戏运行/注入/在线服务；Steam 只涉及获取资源的来源。首选提取候选。 |
| Awpy 当前 Rust core / Python API | 当前 `nav.rs` 接受 Source 2 NAV 30–36；`geometry.rs` 消费 Awpy **AWMH v1 `.mesh`**，不是直接读取 VPK、BSP 或二进制 `.vphys_c`。[S06][S07] | 有向 area 连接、点选区、图路径、静态 segment/BVH 查询。NAV 读取部分 KV3 受限制，读取 area 后不等于完整 ladder/生成/自定义尾段语义均可用；hiding/encounter 假设亦需核对。不能把 centroid 路径长度当真实可行路长或 ETA。静态 checker 不重建烟雾/门。[S06][S08] | 本次 main Cargo version 3.1.2、Rust MSRV 1.88；最近一个 release 是 awpy-v3.1.1，不假设两者相同。Python 3.11+、Polars/PyO3；发布工作流有 Windows x64 wheel。[S09] 传 map name 可触发最新缓存/网络下载，必须绕过这种默认行为；将来只允许显式本地文件与固定摘要。[S10] 研究/离线对照候选；不替换现有 DEM parser。 |
| awpy-data 离线资产管线 | 从已有 CS2 install 的 per-map VPK 与 pak01 导出 `.nav`、overview/radar、world_physics 模型 glTF，再产生 AWMH `.mesh`；原始文件路径存在 TODO。[S11] | 代码默认以材质子串删掉 clip/sky/passbullets/glass/window，再以 **8 world units grid** 做 vertex clustering。删面语义和简化会改变边界/薄墙/孔洞；不是精确 optical LOS、玩家碰撞或弹道的通用资产。[S12] | tag 按 ClientVersion，manifest 含游戏版本、source_revision、buildid 及 ZIP SHA/size；**未提供经验证的 DEM→地图内容绑定**，ZIP hash 也不能替代原始源闭包清单。[S13] 当前 release 2000935 仅检查元数据，未下载。Python 3.11 stdlib + 外部 S2V；安装脚本固定 **Linux x64 S2V 19.2**，CI 在 Ubuntu，不能将 Windows 宣传等同端到端实测。离线路线参考，不能原样导入生产。 |
| `cs2-nav` / JanEricNitschke/cs2_meeting_points | Rust/PyO3，NAV binary、JSON、`.tri` 查询/绘图链；**审查的 0.3.20 源码只接受 NAV 30–35，拒绝 36**。[S14] | 有连接和路径、静态 collision 工具；现有 tests 含 `.nav/.tri` 和集成流程，但本轮未运行、未获取样本字节。NAV36 场景为 **UNSUPPORTED**，不能因名称 CS2 或近期提交而认定可读当前格式。 | 有 Windows MSVC binary 与 wheel 发布流程；其游戏数据/图像处理不是 DEM 时态还原。输入显式本地文件可离线；不要求注入。备用旧 NAV 对照，非本次首选。 |
| Node `sourcenav@1.0.0` | 发布包 README 明确 NAV **16**；实际 `index.js` 是 `binary-parser` 的 BSPSize、places、四方向旧 area 布局，仅检查 magic，未见 Source 2 分支。[S15] | 旧连接/角点不能套进 Source 2 NAV30–36；即使不立即抛错，也可能错读。无碰撞/动态遮挡。CS2 NAV 为 **UNSUPPORTED**。 | CommonJS Node + binary-parser/commander，MIT；npm 唯一版本发表于 2018-03-14，2022 modified 不是新版本发布；无本轮 Windows 测试。未找到可核实原 GitHub 地址，直接读取固定版本的发布源码/README/LICENSE；未安装。不能作为 A 的现成 Source 2 reader。 |
| `three-mesh-bvh` | ESM JavaScript/类型声明，输入 Three.js BufferGeometry；**不是 NAV/VPK/Source 2 parser**。[S17] | 有 segment 所需 raycastFirst（near/far）、BVH 和几何测试；应明确 local/world frame、双面、端点 epsilon、空网格/异常坐标，不能直接将无限 ray 当线段。无地图语义、导航或动态 DEM 状态。 | MIT；Node benchmark/test 脚本、近期维护；master package 0.9.15 与 latest release v0.9.16 不一致，需将来固定具体提交/发布包。本机运行 NOT RUN。适合 A 中消费已验证资产的候选计算核；需要另引 three 依赖，当前禁止引入。 |
| BSPSource（排除性对照） | Java，Source 1 `VBSP` `.bsp → .vmf`；README **明确不支持 Source 2**，源码读 VBSP header；其中历史 Dota 2 支持措辞不能推成现代 Source 2 支持。[S18] | Source 1 brush/face 数据不能作为 CS2 Dust2 碰撞真值；CS2 能力 **UNSUPPORTED**。 | 有 Windows 包 / Java 24+ jar 路线；代码 Unlicense，依赖另有 Apache/BSD notices；近期仍维护不改变格式边界。仅说明为什么传统 BSP 方案不成立。 |

### 3.1 固定源码、维护与许可

以下均为本轮 GitHub API 实际读取的提交树 SHA 与仓库 pushed_at（不是质量保证或本轮编译记录）：

| 项目 | 审查源码 SHA | pushed_at（UTC） | 许可证与测试证据 |
| --- | --- | --- | --- |
| VRF master | `651253f52bbcc989b4f924fa5e0d70f0fc84abfa` | 2026-10-24 21:36:10 | MIT；README 单独排除 `Tests/Files` 游戏文件；当前 NavTest 覆盖 30/35/36，36 用 point_template_test VPK，不是 Dust2。[S03][S05] |
| VRF 20.1 | `9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304` | release 2026-10-15 07:55:06 | NAV 接受 30–36，但该版本 NavTests 实际只见 30/35；本仓 manifest 也固定此提交；新 master 当前为 .NET 10，不能套成旧工具的运行依赖。 |
| Awpy main | `afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2` | 2026-10-21 18:11:24 | MIT；NAV 合成链/不可达/跨高度测试、mesh 合成墙和缓存测试；存在不等于本轮执行或 Dust2 真值。[S08] |
| awpy-data | `7c73907f74521d271f0eb40bcbe14a4912184e05` | 2026-10-23 06:12:47 | MIT 仅覆盖脚本；README 明确提取资产归 Valve，若干路径/坐标声明仍需实测。[S11] |
| cs2-nav | `f12d8a9c3ed1558e36426660c91e0b0d04889ca6` | 2026-10-23 03:05:46 | MIT；release v0.3.20 2026-10-16；源码仍拒绝36。[S14] |
| three-mesh-bvh | `16d6ae6383e9a20600152be2955851b20914b1ca` | 2026-10-22 12:46:15 | MIT；RandomRaycasts 测试与 Three.js 常规查询比较，非游戏真值。[S17] |
| BSPSource | `eaac417f16d3a4d8ef55bb637ecd7bff28740209` | 2026-10-11 21:45:46 | Unlicense，第三方 notices；无 Source 2 支持。[S18] |

这些代码许可证未出现“仅个人使用”条款；**不因此推定 Valve 游戏资源也获同样分发许可**。现有 `replay-resources.json.usage` 的授权仅针对已固定雷达/overview，不能扩展为新 NAV/碰撞资产再分发授权。工具版权 notices、游戏素材允许用途和二进制分发要分别记录；Steam 条款及上游资产归属声明供后续许可核查，本轮不作公开分发已获许可的结论。[S19][S11]

### 3.2 导出坐标与遮挡语义：不能直接接线

VRF **20.1** physics 导出源码先将 shape 顶点变换到 bind pose，再给 glTF node 写 `transform × TransformSourceToGltf`；其 Conversion 文件定义 Source↔glTF 变换。awpy-data `weld()` 则直接遍历 mesh primitive 的 POSITION，没有遍历节点世界矩阵，README 声称其验证过的 19.x 原始顶点为 Hammer/Z-up。[S04][S12] **这并不自动构成错误**：对于固定导出器、identity world transform，raw local 顶点可能恰好是目标 frame；也不能将任意 glTF loader 应用矩阵后的坐标再次当 Source XYZ。未来须固定导出路径，区分 raw POSITION / scene world / Source world，用独立基准核验轴、单位、实例和根变换，防止重复旋转、单位缩放或遗漏变换。

同样，collision tags 描述碰撞交互；render mesh 描述绘制；NAV 描述生成时的导航。玻璃、网格、clip、blocklos、sky、静态 props、实体实例的几何是否进入某类查询必须有独立 policy 和基准，不能复用一个“删掉 glass/passbullets”的资产同时证明行走、光学遮挡和弹道。建议最初保留未简化几何和标签，边界无法确认则拒绝；优化版需要单独误差验收，而非只与自身导出结果比较。

## 4. DEM → 地图几何的可审计匹配策略

### 4.1 四种关系的证据强度

| 关系 | 能作的判断 | 不能作的判断 |
| --- | --- | --- |
| 同名 `de_dust2` | 候选筛选 | 同一地图构建 |
| overview 参数/坐标粗配准相同 | 投影 convention 一致、图中大区合理 | 墙体/平台/连接完全相同 |
| 游戏 patch/build/manifest 接近或相同 | 缩小资源候选及排除已知冲突 | 精确几何相同；本地覆盖/自定义内容还可能不同 |
| 记录 DEM 对应的实际资源闭包及摘要，并经独立基准认证 | 在已声明闭包、能力/区域和构建范围内启用查询 | 玩家感知、未覆盖动态状态、所有地图/未来版本通过 |

地图侧可读证据包括：VPK 目录/成员及其 SHA-256、`.vmap_c/.vwrld_c/.vwnod_c` 引用、模型内嵌 physics/外部 `.vphys_c`、NAV major/subversion/生成参数/hull、overview/PNG 摘要，以及可能存在的 REDI 输入依赖 CRC、compiler identifier/fingerprint。[S03][S20] **格式版本、依赖 CRC 和 compiler fingerprint 不等于地图唯一 build**；CRC 不能当防篡改内容摘要，元数据可能缺失/裁剪，本轮未从本地资源读取这些内部值。

### 4.2 建议记录与确认规则（规划，非生产契约）

为每个资源闭包记录 map key、源 app/depot/manifest、安装声明/采集时间、来源权限、原始 VPK/成员 SHA-256、全部相关世界/静态 prop/物理/NAV/overview 依赖、版本/坐标 convention、提取器提交和二进制摘要、所有转换/过滤/简化参数及输出摘要。按能力保留不同闭包：只验证 NAV 不能一并启用 LOS。内容摘要标识实际字节，生成时间和文件名只辅助溯源。

另存 **DEM 摘要 → 资源集合 → 能力验收记录** 的独立绑定，不把 `gameBuild` 塞进名为 `mapBuild` 的字段。可接受的确认路径：

1. **强直接绑定（尚 NOT RUN）**：将来证实 DEM 内 resource/session manifest 含可解释的内容身份，并用相同算法覆盖匹配资源闭包；或者录制方在录制时保存了可验证的服务器/录制环境资源清单及对应 DEM。需要验证标识语义、完整性和覆盖面，不能只比对 opaque bytes 或文件路径。
2. **受控同构建绑定（待授权实测）**：用户本机在固定、不可变的 map bytes 上制作本地 DEM，同时记录安装/挂载覆盖、完整资源摘要和录制 provenance；由独立基准认证该资源集合。它可建立新的同构建 fixture，**不能追认旧 `.demo/dust2.dem` 的绑定**，也不要求本轮下载替代 DEM。
3. **间接线索**：已有旧 DEM 的 patch/build、时间、地标、overview 匹配只能使候选更可信；缺少上两类可审计关联时保留 `unconfirmed`。有限地标不排除其他位置小改动，不允许人工勾选一个“看起来一致”就全图确认。

确认状态与能力测试状态独立；`confirmed` 的含义需在后续契约中限定为“基于何种绑定、覆盖哪些源字节/区域”。若资源不足，保留 `unknown/unconfirmed` 及原因，不能补零、自动选 latest 或退回同名地图。已知冲突为 mismatch；来源未知和缺失分别记录，不混为同一个错误。

### 4.3 更新、失效与缓存

- 缓存键至少覆盖 DEM 摘要、输入 tick/坐标及采样版本、资源闭包摘要、能力/算法/policy/验证集版本。只按 map name/game patch 缓存会误用旧结果。
- 检测到 Steam 安装更新、文件摘要改变、导出器/过滤策略/验证协议变更时，新的组合默认拒绝，完成对应复验后才启用。读取前后身份变化则终止作业，避免更新中拼接多个构建；长任务使用受控不可变输入，后续如何保留本地快照需另行决定，当前没有复制。
- 旧资源闭包若仍完整且原绑定有效，旧结果保留为明确版本的历史结果；撤销或发现错误时按受影响能力撤销/标 stale，重新生成不能悄悄覆盖历史记录。不是把全体旧 DEM 强制套入新地图。
- 用户现有雷达的 `versionMatch: unconfirmed` 不整体更改。未来确认应逐 DEM、逐资源集合、逐能力登记；展示图的状态和几何查询的状态分别呈现。不改当前仅允许 unconfirmed 的生产类型来伪装本轮已确认。

**当前旧 Dust2 DEM 的判定仍为 unconfirmed / BLOCKED。** 已确认 `build_num` 的存在不是确认 map bytes；本机地图、旧雷达 manifest、当前 awpy-data tag 之间没有已证实的完整等价关系。

## 5. 七类能力逐项门槛

| 能力 | 当前状态及证据范围 | 进入 PASS 的最低门槛 |
| --- | --- | --- |
| 世界 XYZ → overview | **PASS（算术/固定资源子能力）**：本轮9项回归与13图片检查；真实版本匹配投影 **BLOCKED**；新独立点精度 **NOT RUN** | 同构建资源绑定；独立非共线地标覆盖地图边缘/中心，验证轴向、缩放、方向及误差分布；保留原 PNG 空间，HUD rotate/zoom 不直接套用 |
| XY/XYZ 距离 | **PASS（历史 B-R 四对同 tick 数值子能力）**；本轮没有重跑四对，生产化边界验收 **NOT RUN** | 同一 Source frame、actualTick、有效有限端点；`hypot(dx,dy)` / `hypot(dx,dy,dz)`；缺失、溢出、异时拒绝；输出 world units；误差来自坐标量化/采样，不把 double 舍入当地图精度。无需地图 mesh，也不据此启用地图战术结论 |
| 导航可达性 | **BLOCKED**：无已绑定且验证过的 Dust2 NAV；候选运行 **NOT RUN** | NAV 格式/拓扑真实可读；有向连接、玩家 hull、起终点归属与高度、断连、单向跌落/特殊连接/不在 nav 上的案例。路径不存在仅表示该受支持图中未找到，不自动证明所有玩家行动不可能 |
| 静态 LOS | **BLOCKED**：匹配碰撞、标签 policy、独立遮挡真值缺失；运行 **NOT RUN** | 固定 Source frame 与眼位/目标端点定义；所有声明的静态 occluders/props 和变换纳入；墙/无遮挡、端点接面、薄几何、clip/玻璃等基准。线段不穿静态几何仅为几何关系，不代表渲染可见或玩家实际看见 |
| 多楼层/平台/楼梯 | **BLOCKED**：当前 Dust2 default 层不提供结构；运行 **NOT RUN** | 同 XY 不同 Z、多平台和跨层连接的独立标签；真实 polygon/hull/碰撞支撑；边界多解/找不到层返回 unknown。ΔZ 和单一全图 Z 阈值不能代替楼层 |
| 动态遮挡 | **BLOCKED**：DEM 效果原点/expiry 不足以恢复烟雾体积，门/可破坏对象状态未验；运行 **NOT RUN** | smoke 时变空间体积、展开/消散/扰动与 tick 一致性；动态实体身份/transform/破坏状态；缺一项不应把静态 clear 升级为完整可见。球形近似不是真实体积通过证据 |
| 协同/支援条件 | **BLOCKED**：路线/时序/状态/遮挡联合门槛未满足；运行 **NOT RUN** | 可执行路径及长度定义、速度/姿态/资源/武器动作、时间窗、交战条件和动态不确定性；每个子依赖均版本匹配且通过，独立人工评审其条件性解释。近距离不能证明补枪、交叉火力或路线安全 |

POV、实际注意力、心理、意图、玩家真的看到/听到什么：**UNSUPPORTED（产品范围）**。几何可见 ≠ 玩家实际看见；距离接近 ≠ 可支援。模型提示词不得绕过这些硬边界。

## 6. Windows + Electron 的三种架构

成本为相对工程判断，不是实测工时、内存或性能；本轮未做候选安装、编译、IPC 或安装包验证。

| 方案 | 可行路径、平台证据 | 成本/风险与隔离 | 结论 |
| --- | --- | --- | --- |
| A：TS / Node | 数值距离、投影、经验证的只读 graph/mesh 查询可放纯共享包；three-mesh-bvh 是几何核候选。未找到经本轮源码确认、可直接完成 Source 2 NAV+collision 闭包读取的现成 Node 方案；sourcenav 明确不适用 | 查询/分发相对低成本；自己移植二进制解析则成本高且需追踪格式更新，移植/三方依赖须后续授权。大 mesh/BVH 放现有 utility/worker 作业，Renderer 仅消费已计算 DTO；Worker 线程不提供 native 崩溃隔离，也不自动限制资源 | 最小数值能力可行；不宣称 A 已具备原始地图读取器。经验证资产上运行 NOT RUN |
| B：独立 native helper | VRF .NET CLI/library 最有格式证据；当前 master net10，20.1 有现成 win-x64 自包含 release。Rust Awpy/cs2-nav 则分别有不同 NAV 支持与 bindings；现有 DEM native 不能自然当地图 parser | 构建、签名、第三方 notices、运行时/压缩库、二进制 provenance 和格式维护成本中高。外部 `.exe` 应由受控 Node 进程用 `spawn/execFile` 参数数组启动，不能把它当 JS module 传 `utilityProcess.fork`。限制输入路径、输出协议/字节数、超时、取消、并发；崩溃/非零/非法输出立即拒绝。Electron utilityProcess 提供 Node 子进程而非自动权限沙箱；硬 CPU/内存/进程树限制需 Windows Job Objects 等独立机制并实测。[S21][S22] | 可行备选；不在 Electron 主线程加载新 native addon。Windows x64 运行/发布/资源上限 NOT RUN |
| C：可信离线预处理 | 由维护者在固定已有资源上用固定 VRF 提取，输出 NAV graph 与静态碰撞数据，桌面只读消费。awpy-data 是流程参考，不能不审查地沿用其过滤/简化/下载默认行为 | 预处理和真值标注成本中高，桌面查询较简单；每个有效源闭包独立建档，允许相同内容复用输出，但每个 game/build→闭包关联要有记录。不得按地图名一份资产覆盖所有构建。许可、资产体积、错误打包与更新中断仍是阻塞 | 优先验证 C+A；资源缺失时本地 L1 仍可用。首轮不必给桌面绑定 Steam/游戏安装/在线资产服务 |

C 的建议输出：JSON manifest + 小端只读二进制（格式仅规划）。NAV 保存 Source XYZ 顶点、area/hull、原始有向连接/portal、支持过的特殊连接及 unknown；碰撞保存未简化顶点/索引、实例 transform、surface/collision tags、来源对象引用。必须保留 query policy 和坐标转换版本；AWMH v1 的 positions+indices 可作实验交换格式，但没有来源/标签/绑定，单独不足以满足生产证据需求。[S07][S12]

安装包构建应只接受已签收的特定资产 allowlist、manifest/文件摘要和测试证书；任何缺项/多出文件/过期证书都不启用对应能力，不能自动采集 latest。资产不应进入现有雷达目录绕过 preflight。是否可再分发尚需许可核查；可先选用户本机预处理或受控内部验证，不预设把地图资产塞进 installer。本轮没有创建这一打包机制。

## 7. 最小 Dust2 独立基准集设计

以下是 **待构建协议**，全部新几何真值实测 NOT RUN；地点名称只帮助选点，没有制造“该坐标无遮挡”等数值标签。只在获授权且可绑定的同构建资源上采集，标注协议和误差阈值在看结果前冻结。

| 基准组 | 最小样例设计 | 独立来源与判定方式 |
| --- | --- | --- |
| G01 坐标配准 | 至少6个分散且非共线地标：出生区/包点/中路等，覆盖边缘与中心；眼位、脚底和雷达点定义不混用 | 人工从同构建游戏/编辑器记录 Source XYZ、原始 radar 像素和定位截图；两人复核，盲测至少留2点；预先按人工像素标注不确定度固定容差，报告每点/最大/RMS误差。旧四区域只作粗回归，不升级为精确点真值 |
| G02 距离与异常 | 同 tick 两点、重合、仅 Z 差异、极大值/NaN/缺失/异时 | 手工或独立高精度算术核验合成数值边界；真实端点来自固定 native。只验 arithmetic，不宣称路线长度、米制或地图一致性 |
| G03 邻接可通行 | 至少2对已实际走通的相邻区域，记录双向或单向及姿态/hull | 人工在固定构建离线演示并记录起终点、路径、游戏状态；核对 NAV 原始边，再比较候选结果。area ID 从 parser 得来不是独立真值 |
| G04 墙隔与不可达 | 1对近而被墙隔、但可以绕行的端点；另1对在固定受支持动作集合下不可达/在 nav 外；增加单向跌落的反向例 | 明确区分“直线不通”“无直接边”“全图无路径”；墙隔不必然全局不可达。无法独立证明全图不可达则标 unknown，不能为凑数把绕路当断连 |
| G05 静态遮挡 | 至少2对实心墙遮挡，选择远离墙边/接面的明确情形；再设薄墙/clip/玻璃的 policy 边界 | 同构建游戏/编辑器的独立可见/trace 证据与人工复核；记录眼位、目标高度、站蹲、动态物为空。开枪伤害/穿墙不能单独当视线真值；候选工具自己的射线不算独立标签 |
| G06 静态无遮挡 | 至少2对空旷、端点不落碰撞体内且无动态物的明确线段；反向查询复核 | 独立场景观察/trace 记录，同样固定眼位/目标端点及视线语义。目标可见仅用于该基准，不拿来推断 DEM 玩家注意力 |
| G07 高度与平台 | 至少2组跨高度路线（楼梯/坡/平台），另1组近 XY、不同 Z 的端点和边界歧义 | 人工记录实际通路及高度；既验证 polygon 选区也验证有向连接，不只比较 Z。Dust2 单雷达层不能作为多高度标签 |
| G08 烟雾前/中/后 | 同静态 clear 端点，受控烟雾展开前、有效中、消散后各至少1时刻；再设不穿烟对照，边缘/扰动后续单列 | 同构建游戏内真实效果/引擎证据与人工时序标注；记录实际 tick、相位、体积真值可用性、位置/眼位。视觉观察不足以认证体积重建时只标 smoke 基准观察，不启用动态查询；球体模型的输出不能给自己标答案 |

每条记录包含来源类别（人工 / 独立已验证几何 / 候选自身输出）、资源闭包摘要、DEM/场景来源、真实 tick、端点定义、动作与动态状态、标注者/复核者、容差、预期值或 unknown、证据位置、验证器版本。合成边界和真实 Dust2 样例分别计数。拿同一个 exporter 生成 mesh 再用其 viewer 画出的 mesh 认证，只能证明内部一致性；两个依赖相同底层 exporter 的工具相符也不能单独证明源几何完整。

通过门槛：无争议的正/负例全部符合冻结标签，数值误差符合事前容差；所有拒绝/缺失/资源错配例必须拒绝，任何静默错配或明确 false-clear 都阻断发布。歧义案例允许 abstain 并降低能力覆盖，不能移出失败集掩盖结果。先取得未简化资产基线，再另行验收简化资产；性能预算在真实体积/查询测量后确定，本报告不捏造毫秒或内存 PASS。

## 8. 与现有 CS2 Analyst 的集成边界

- `replay-map-geometry.ts` 保持现有显示职责；未来纯计算共享能力进入 `packages/`（具体包名待设计），不从 Electron shared 文件反向被领域包导入。投影 convention 可在单独获准变更中共享/消重，本轮不移动代码。`match-model` 负责正式事实与引用，analytics/deep-review 消费已验证几何结果，findings 仍按证据规则工作；地图 reader 不绕过 `dem-parser → match-model → analytics → findings` 的事实链。
- `docs/replay-resources.json` 继续管理当前显示资产。新几何 registry 应关联其 overview/PNG 身份，不能把它当 NAV/physics manifest 或一并改 confirmed。现有雷达、插值、回放、热力图口径和用户流程不变；几何失败不影响已有示意图显示或确定性报告。
- 本地 deterministic query 计算距离、投影、通过门槛的 graph/segment 查询；解析 Source 2 和构建紧凑数据更适合离线维护链或受控 helper。纯查询核可由规划 knowledge-pipeline/coach-api 复用，但服务须独立验证 registry/能力。个人 DEM 和完整轨迹留在桌面，服务不重读个人 DEM 或让模型计算核心数值。
- 查询证据需关联 DEM/parser/sampling、actualTick/相位、地图资源闭包、匹配方法与状态、query 算法/policy、基准证书和缺失原因。模型仅接收必要的已计算事实、局部引用别名和已允许能力；内部路径、完整资源清单与原始 SteamID 不进入 Prompt。
- 门控顺序：输入事实有效 → 资源身份/匹配有效 → 该能力基准有效 → 必要动态/时序有效 → 输出允许。任一失败返回 unknown/abstain 和具体原因，回退 **L1 服务器事实复盘**。同 tick 原始世界距离可作为独立数值事实，但不得在地图能力失败时借此输出补枪/路线结论。
- `ServerStateAtTick`、`SpatialActionContext` 仍只是规划职责名；本轮不创建它们，也不修改任何共享契约。模型不会通过文字地点猜路线、从雷达猜墙体，或者根据输出格式合法就覆盖能力门槛。

## 9. 最小实施顺序与阻塞

以下均需后续明确授权，本轮不会自动执行。

1. **首个可实施小单元**：在共享边界设计资源身份/拒绝门控与同 tick XY/XYZ world-unit 距离，冻结异常输入、引用、单位和误差语义。不引入新地图 reader/资产，不将 display versionMatch 改 confirmed。最小验收包含资源缺失/篡改/错配拒绝与数值边界；不宣称地图几何已通过。
2. **首个真正地图能力验证**：先对已有本地资源做固定版本的、受控离线读取实验，确认 Dust2 NAV 实际 major/subversion、玩家 hull/连接和全部所需资源存在；最初优先 NAV graph 的受限邻接查询，并完成同构建绑定及 G01/G03/G04/G07。它是待验证目标，不能现在标为可用路线规划。
3. **并行的证据前提（不是本轮启动工作）**：只读研究旧 DEM 的 session/spawn manifest；若无法构建可靠绑定，旧 fixture 在取得可信新绑定证据前持续保持 unconfirmed，另行批准受控同构建 fixture 制作。用户无需重传目前已有安装文件；真正缺少的是历史 DEM 的来源资源关联或新的可证明关联，不能下载替代地图弥补。
4. 只有上述门槛过后，再评估未简化 static collision 与 G05/G06；动态烟雾/门和联合支援条件作为独立后续能力，不因 NAV/LOS 通过自动启用。B/C 的二进制发布、许可、性能/进程限额需要独立 Windows 验收。

**当前可以开始的第一项能力是严格限定的原生坐标距离；对于导航/LOS 基础设施，本轮只确认了值得开展受控实验的工具路径，尚缺旧 DEM 的地图绑定与独立真值，不能直接进入产品实施验收。** 研究完成不等于 P8.1 完成；未启动 C/D 或 P8.2。

## 10. 实际执行、复现与未执行项

| 实际命令 / 检查 | 真实结果 |
| --- | --- |
| `git fetch origin --prune`；status/log/rev-parse/diff；GitHub GET PR #4 | exit 0；基线与 draft 状态见第1节 |
| `Get-FileHash .demo/dust2.dem -Algorithm SHA256` | exit 0；摘要与白名单一致 |
| `native.parseHeader('.demo/dust2.dem')` / `getBindingProvenance()` | exit 0；地图/patch/GUID/verified binary 如第2节；没有输出昵称或服务器名 |
| 临时 stdin Node wire probe（下面完整命令） | exit 0；原始 tag13=10231、tag15=51144；未写脚本或 DEM |
| Steam registry/libraryfolders → 明确 appmanifest/steam.inf/两个 VPK 的只读元数据和 SHA | 成功；只证明文件身份，NAV/physics 内部内容 NOT RUN |
| `node --test --test-reporter=tap scripts/replay-resource-audit.test.mjs scripts/check-replay-map-assets.test.mjs apps/desktop/tests/replay-map.test.mjs` | exit 0，**9/9 pass**、0 fail/skip；不计为新几何测试 |
| `node scripts/check-replay-map-assets.mjs` | exit 0，`prepared=13,expected=13,mode=verified-assets` |
| 新增 JSON 解析/状态/本地文档链接/提交范围检查、`git diff --check` | 结果保存在配套 JSON 的 `validation`；不将文档结构检查当几何验证 |

原始 header 探针复现如下。仅对本 fixture 首帧未压缩且 payload 在已读范围内的格式运行，遇其他布局会明确失败；它不是生产 protobuf 解码器。字段语义依据已核验生成源，绝不将任意 tag13 认作地图 build。

独立只读复审通过：复核关键 NAV/碰撞处理源码、原始 header 和安装元数据，重跑既有9项测试/13资源检查，并核对本文与 JSON 的状态一致性。复审重复执行不增加本轮唯一测试数；未独立复验所有远端 metadata/许可证或地图内部几何。已采纳“持续保持 unconfirmed，直到取得可信新绑定”的措辞建议；JSON 路径经字符码与目录存在性复核正确，无需修订。

```powershell
@'
const fs = require('node:fs');
const fd = fs.openSync('.demo/dust2.dem', 'r');
const b = Buffer.alloc(65536);
const len = fs.readSync(fd, b, 0, b.length, 0);
fs.closeSync(fd);
let p = 16;
function v() {
  let x = 0n, s = 0n;
  for (let i = 0; i < 10; i++) {
    if (p >= len) throw Error('truncated');
    const c = b[p++]; x |= BigInt(c & 127) << s;
    if (!(c & 128)) return x;
    s += 7n;
  }
  throw Error('varint');
}
const cmd = Number(v()), tick = v().toString(), size = Number(v());
if (cmd !== 1) throw Error('not uncompressed DemFileHeader');
const end = p + size;
if (end > len) throw Error('header too big');
const fields = [];
while (p < end) {
  const key = Number(v()), tag = key >>> 3, wire = key & 7;
  let value;
  if (wire === 0) value = v().toString();
  else if (wire === 2) {
    const l = Number(v());
    if ([1, 5, 11, 12].includes(tag)) value = b.subarray(p, p + l).toString();
    p += l;
  } else if (wire === 1) p += 8;
  else if (wire === 5) p += 4;
  else throw Error('unsupported wire');
  if (p > end) throw Error('overrun');
  fields.push({ tag, wire, ...([1, 2, 5, 11, 12, 13, 15].includes(tag) ? { value } : {}) });
}
console.log(JSON.stringify({ cmd, tick, size, fields }));
'@ | node
```

未执行：候选工具安装/构建/运行、VPK 提取、真实 NAV/physics 解析、地图直接内容绑定、独立 Dust2 坐标/路线/LOS/高度/烟雾基准、helper/IPC/installer 压力与崩溃测试、全仓 typecheck/build（仅文档变更，无新增运行时逻辑）、DEM 全量重解析、模型/服务调用。上游 test/release 的存在没有计入本轮运行数。探路时不存在的本地文档/旧 `.tmp/p6-*` 目录、不可访问的外部页面均按缺失记录，没有据此假设本机没有游戏；没有运行会下载/复制资源的 prepare/fetch 管线。

最终 Git SHA 应通过 `git log -1 --format=%H -- docs/p8-1l2-map-geometry-feasibility-2026-10-25.md` 读取，避免文档自引用；结束分支、状态与变更范围见最终交付。只新增两份研究文档，不 push main、不自动合并、不修改版本或创建 tag/Release。

## 11. 证据索引

以下链接为实际读过的原始资料；大部分固定到审查提交。release/PR 状态是 2026-10-25 的采样，未来可改变。

[S01]: https://github.com/cs2-analyst/cs2-analyst-desk/pull/4
[S01a]: https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-scope-decision-l1-l2-2026-10-25.md
[S01b]: https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-1a-decision-evidence-contract.md
[S02]: https://github.com/LaihoE/demoparser/blob/d3767705dc5846d73ed29db50eaeda58778dc934/src/parser/src/first_pass/parser.rs#L311
[S03]: https://github.com/ValveResourceFormat/ValveResourceFormat/blob/9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304/ValveResourceFormat/NavMesh/NavMeshFile.cs
[S04]: https://github.com/ValveResourceFormat/ValveResourceFormat/blob/9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304/ValveResourceFormat/IO/GltfModelExporter.Physics.cs
[S05]: https://github.com/ValveResourceFormat/ValveResourceFormat/blob/651253f52bbcc989b4f924fa5e0d70f0fc84abfa/Tests/Formats/NavTest.cs
[S06]: https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/crates/awpy/src/nav.rs
[S07]: https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/crates/awpy/src/geometry.rs
[S08]: https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/crates/awpy-python/tests/test_nav.py
[S09]: https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/.github/workflows/release.yml
[S10]: https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/crates/awpy-python/python/awpy/data.py
[S11]: https://github.com/pnxenopoulos/awpy-data/blob/7c73907f74521d271f0eb40bcbe14a4912184e05/README.md
[S12]: https://github.com/pnxenopoulos/awpy-data/blob/7c73907f74521d271f0eb40bcbe14a4912184e05/scripts/process_geometry.py
[S13]: https://github.com/pnxenopoulos/awpy-data/blob/7c73907f74521d271f0eb40bcbe14a4912184e05/scripts/package_release.py
[S14]: https://github.com/JanEricNitschke/cs2_meeting_points/blob/f12d8a9c3ed1558e36426660c91e0b0d04889ca6/src/nav.rs#L916
[S15]: https://cdn.jsdelivr.net/npm/sourcenav@1.0.0/index.js
[S16]: https://github.com/ValveSoftware/csgo-demoinfo/blob/master/demoinfogo/netmessages_public.proto
[S17]: https://github.com/gkjohnson/three-mesh-bvh/blob/16d6ae6383e9a20600152be2955851b20914b1ca/src/core/cast/raycastFirst.template.js
[S18]: https://github.com/ata4/bspsrc/blob/eaac417f16d3a4d8ef55bb637ecd7bff28740209/README.md
[S19]: https://store.steampowered.com/subscriber_agreement/
[S20]: https://github.com/ValveResourceFormat/ValveResourceFormat/blob/9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304/ValveResourceFormat/Resource/Blocks/ResourceEditInfoStructs/InputDependency.cs
[S21]: https://www.electronjs.org/docs/latest/api/utility-process
[S22]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

补充直接源码：

- [VRF LoadWorldPhysics：manifest、模型内嵌/独立物理](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/651253f52bbcc989b4f924fa5e0d70f0fc84abfa/ValveResourceFormat/IO/Extract/MapExtract.cs#L486)、[PhysAggregateData](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/651253f52bbcc989b4f924fa5e0d70f0fc84abfa/ValveResourceFormat/Resource/ResourceTypes/PhysAggregateData.cs)、[20.1 glTF 变换](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304/ValveResourceFormat/IO/GltfModelExporter.Conversion.cs)、[20.1 NAV 测试](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304/Tests/NavTests.cs)、[Windows publish 工作流](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/651253f52bbcc989b4f924fa5e0d70f0fc84abfa/.github/workflows/build.yml)、[20.1 release](https://github.com/ValveResourceFormat/ValveResourceFormat/releases/tag/20.1)。
- [Awpy 合成墙/缓存测试](https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/crates/awpy-python/tests/test_visibility.py)、[Cargo 与 MSRV](https://github.com/pnxenopoulos/awpy/blob/afb1537f1e8cfe5ebcd54b29fb001707ab2bd5d2/Cargo.toml)、[awpy-data 提取脚本](https://github.com/pnxenopoulos/awpy-data/blob/7c73907f74521d271f0eb40bcbe14a4912184e05/scripts/extract_assets.py)、[Linux 19.2 下载脚本](https://github.com/pnxenopoulos/awpy-data/blob/7c73907f74521d271f0eb40bcbe14a4912184e05/scripts/install_tools.sh)。
- [cs2-nav manifest](https://github.com/JanEricNitschke/cs2_meeting_points/blob/f12d8a9c3ed1558e36426660c91e0b0d04889ca6/Cargo.toml)、[Windows 发布脚本](https://github.com/JanEricNitschke/cs2_meeting_points/blob/f12d8a9c3ed1558e36426660c91e0b0d04889ca6/.github/workflows/publish.yml)、[集成测试](https://github.com/JanEricNitschke/cs2_meeting_points/blob/f12d8a9c3ed1558e36426660c91e0b0d04889ca6/tests/integration.rs)。
- [sourcenav 固定版本 README](https://cdn.jsdelivr.net/npm/sourcenav@1.0.0/README.md)、[package.json](https://cdn.jsdelivr.net/npm/sourcenav@1.0.0/package.json)、[LICENSE](https://cdn.jsdelivr.net/npm/sourcenav@1.0.0/LICENSE.md)、[npm 原始元数据](https://registry.npmjs.org/sourcenav)。
- [three-mesh-bvh package](https://github.com/gkjohnson/three-mesh-bvh/blob/16d6ae6383e9a20600152be2955851b20914b1ca/package.json)、[随机射线对照测试](https://github.com/gkjohnson/three-mesh-bvh/blob/16d6ae6383e9a20600152be2955851b20914b1ca/test/RandomRaycasts.test.js)、[BSPSource VBSP reader](https://github.com/ata4/bspsrc/blob/eaac417f16d3a4d8ef55bb637ecd7bff28740209/bspsrc-lib/src/main/java/info/ata4/bspsrc/lib/BspFile.java)。
