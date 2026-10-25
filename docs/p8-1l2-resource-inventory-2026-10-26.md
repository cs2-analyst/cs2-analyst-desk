# P8.1-L2.2A：Dust2 本地地图资源身份盘点与依赖闭包审计

日期：2026-10-26（Asia/Shanghai）。应用版本保持 **0.2.0**。仅新增本文及[机器记录](p8-1l2-resource-inventory-2026-10-26.json)，本轮没有修改生产代码、领域契约、依赖、资源 manifest 或版本号。

**审计完成，资源目录可读；依赖闭包验证与 DEM 精确绑定仍 BLOCKED，matchingStatus 保持 `unconfirmed`。** 本轮产物准确称为 **partial dependency inventory**。632 个地图包条目与 137,734 个共享包条目的可定位性，不等于实际依赖引用或闭包完整。审计的 PASS 只表示限定只读盘点与证据分级完成，绝非地图能力通过。

## 1. 审计基线与执行边界

| 项目 | 2026-10-26 实查 |
| --- | --- |
| 仓库 / 初始工作区 | `cs2-analyst/cs2-analyst-desk` / `E:\cs2-analyst`；干净 |
| 初始分支 / HEAD | `codex/p8-1l2-distance-foundation` / `623caaccbbd479e538c6b1166b8890170ab4c8f1` |
| 最新 origin/main | fetch 后 `f44984e5464552c81737922c67df3d9f17c27c71`；ls-remote 一致 |
| 几何研究远端 head | `babcdd8cdff444dad86ff78e0f3e1f4499c54ddb`，分支仍存在；对 main 的 ancestor 检查 exit 1 |
| 距离基础远端 head | `623caaccbbd479e538c6b1166b8890170ab4c8f1`，分支仍存在；对 main 的 ancestor 检查 exit 1 |
| 范围决策 [PR #4][S01] | open、draft=true、merged=false；head `8f61854793f3d9230d1cd160b3fd01dedaafcadd`；不能把预计算 merge_commit_sha 当作合并证据 |
| 本轮分支 | 从干净初始 HEAD 新建 `codex/p8-1l2-resource-inventory`；未合并其他分支 |
| 本轮差异基线 | 初始 HEAD。相对 main 已继承前置研究及距离基础生产/测试变更，不能把这些算作本轮新增 |
| 授权 | 用户附件明确授权本单元 L1/L2 只读研究；不扩展至后续阶段 |

已读取项目/全局 AGENTS、routing、workflows、DEM/domain 工作流、reviewer/tester 角色、[fixture 白名单](demo-fixtures.md)、[几何研究](p8-1l2-map-geometry-feasibility-2026-10-25.md)与[JSON](p8-1l2-map-geometry-feasibility-2026-10-25.json)、[距离基础](p8-1l2-distance-foundation.md)与[验证记录](p8-1l2-distance-validation-2026-10-25.json)、[replay manifest](replay-resources.json)、既有审计脚本及 native/adapter/protobuf 实现。基线无单独 feature-development.md 或 testing workflow；采用 workflows.md 与 tester 的验证职责。全局 AGENTS 文件实际仅含其自身路径文字。此项涉及身份命名空间与证据语义，按 reasoning 工作处理，并作独立只读复审。

预检后已先报告简短调查计划，再执行本地盘点。研究范围严格为：白名单 DEM 的 header/摘要，已知 Steam 元数据，明确 VPK 的摘要/头/目录，索引导出的分片名称 stat，既有 overview/PNG 的摘要/尺寸和静态源码。全文件 hash 会读取字节进行不透明摘要运算，**没有按成员提取、解码或导出游戏内容**；VPK 目录读取只消费头、路径字符串与 18 字节条目元数据，遇 preload 则跳过。两包实际 preload 合计均为 0。

没有解包、下载资产/二进制、安装依赖、编译 helper、运行外部地图解析器、NAV/PHYS 解析、几何转换、启动 CS2、注入或访问运行时内存。没有保存玩家身份、服务器名、client name、原始轨迹、Steam LastOwner 或完整 VPK 条目清单。

## 2. DEM 身份与 parser 实际可见范围

| 项目 | 本次实际观察 |
| --- | --- |
| 白名单输入 | `.demo/dust2.dem`，557650967 bytes；SHA-256 `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c`，与白名单一致 |
| 格式线索 | magic `PBDEMS2\0`；`demo_version_name=valve_demo_2`；`fullpackets_version=2` 是独立字段，不能当地图或总体引擎版本 |
| 生产 native header 导出 | `map_name=de_dust2`、`patch_version=14055`、GUID `8e9d71ab-04a1-4c01-bb61-acfede27c046`、addons 为空；entities/particles flags 为 true |
| 原始 header 单独读证 | 首帧未压缩 cmd=1，payload=183 bytes；原始 tick unsigned=`4294967295`（有符号 -1 sentinel）；tag13/wire0 `build_num=10231`，tag15/wire0 `server_start_tick=51144` |
| 当前 native | `@cs2-analyst/demoparser-native@0.42.0-backport.363.1`，`x86_64-pc-windows-msvc`；二进制 SHA-256 `132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1` |
| parser 来源 | upstream tag v0.42.0 / `d3767705dc5846d73ed29db50eaeda58778dc934`，#363 backport；source/provenance 一致性及 binary digest 在模块加载时校验 |
| 固定生成 schema | SHA-256 `953ad3f19e1c1bd888d8d51292ff47cb1379a979353f07fb7977a4c152e4f5b5`，本次与 source.json 断言相等 |

原始探针缓冲前 65536 字节，仅解释首帧 header，没有解析 packet、实体或轨迹。探针是临时 stdin Node 命令，完整源码与结果摘要见机器记录 C04；不是生产 parser 改造。生产实际导出的键名与允许保存的值分别记录，server/client/game-directory 值已省略。

固定 `protobuf.rs:636–666` 将 build_num 定义为 **optional int32 tag 13**，没有提供“地图 build ID”“Steam build ID”或地图内容摘要的语义保证。将其视为构建线索属于有限推断；其命名空间及到具体资源的映射仍 **unconfirmed**。不能把 `10231`、`14055`、Steam `26144732`、ClientVersion `2000935`、SourceRevision `11162119` 相互等同，也没有本次验证过的 patch→Steam build 映射。

当前 `first_pass/parser.rs:311–335` 不把 build_num/server_start_tick 插入 header 字典；[adapter](../packages/dem-parser/src/providers/demoparser2-adapter.ts) 仍走既有 native header。缺少导出键不等于文件无字段；原始字段观测也不等于已纳入生产模型。

探索曾读到 `.tmp/demo2-diagnostic/.../protobuf.rs`，其摘要 `74811922a7d301996f254242747e0e79de1b8e2e94f7661fc5635c3b1bd72c44` 与当前 provenance 不符。此份源码**不作为当前 parser 定义证据**。随后改读并校验 `vendor/demoparser/.build/work/` 下固定 schema 和两份 parser 源（C07/C11）。没有重建或修改任何源码。

## 3. Steam 安装与现有雷达身份

已知 Steam 注册表路径为 `c:/steam`，仅读取 `C:/Steam/steamapps/libraryfolders.vdf`、`appmanifest_730.acf` 和 app 指定安装目录的 `game/csgo/steam.inf`。没有全盘扫描。

| 元数据 | 观察值与含义 |
| --- | --- |
| app / install | app 730；`C:/Steam/steamapps/common/Counter-Strike Global Offensive` |
| Steam build | `26144732`；这是安装声明，不是地图 build |
| 核心内容 depot | `2347770` / manifest `67499503218971311` |
| 其他已安装 depot | 731、732、735、736、737、738、2347771、2347774；各自 manifest/size 原值见 JSON steam.installedDepots，未将它们混为地图包 |
| steam.inf | ClientVersion/ServerVersion=`2000935`；PatchVersion=`1.41.9.2`；SourceRevision=`11162119`；appID=730；ServerAppID=2347773 |
| 安装版本日期 | Oct 22 2026 / 14:13:16；来源时区未知，未据此推算地图构建时间 |
| 本地地图容器 | `game/csgo/maps/de_dust2.vpk` 存在；`game/csgo/pak01_dir.vpk` 存在；身份摘要见第 4 节 |

Steam 元数据能复核采样时的安装声明，不能认证 DEM 录制时资源、运行时挂载覆盖或完整地图依赖。本轮没有读取 gameinfo/挂载优先级或启动游戏。

现有显示资源来自 [replay manifest](replay-resources.json)：

- resourceId：`valve-730-2347770-2312433566686574487-vrf20.1`；来源 app 730 / depot 2347770 / manifest `2312433566686574487`；buildId/clientVersion 为 null。
- 来源由现有 manifest 记录为 Valve Steam distribution、此前本地提取；Source2Viewer-CLI `20.1.7467+9e2e6c7f67e3c4e5a5f443a60c3a5d841ba8f304`、DepotDownloader 3.4.0。本轮只读这些历史 provenance，未运行工具或重新获取资产；原 depot manifest SHA 的历史声明见 JSON，并未取得其原始 manifest 再校验。
- 本次重新计算 overview 原始 541 bytes 与 PNG 175761 bytes 的 SHA，均与 manifest 相同；PNG 1024×1024；posX=-2476、posY=3239、scale=4.4；无独立高度分层。
- `demVersionMatch` 以及 [现有地图定义](../apps/desktop/shared/replay-map-geometry.ts)的 `versionMatch` 都保持 `unconfirmed`；[前置身份记录](p8-1l2-distance-validation-2026-10-25.json)亦为 unconfirmed。
- 投影仅为 `u=(x-posX)/scale×width/1024`、`v=(posY-y)/scale×height/1024`；没有本次新增的地图几何坐标配准。雷达比例尺不能证明 NAV/碰撞单位或 map→DEM 变换。

现有显示 manifest 与当前安装的 depot manifest 不同。**这既不证明 Dust2 几何不同，也不证明相同。** 目录里的当前 overview 同为 541 bytes；没有读取该成员，不能用同尺寸或 CRC 建立精确内容等价。当前 vtex_c 与历史 PNG 还隔着解码/转换链，不能直接互换摘要。

## 4. 文件身份与摘要来源

以下均为本次读取本地明确文件重新计算的 SHA-256；hash 时文件大小/mtime 检查未变化（native source 的小文件另行直接读取并断言固定 schema 摘要）。这不是整个安装的原子快照。C16 再次确认两份 VPK 整体 SHA 与 C04 相同；没有复制资产。

| 本地文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `.demo/dust2.dem` | 557650967 | `db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c` |
| `C:/Steam/steamapps/libraryfolders.vdf` | 587 | `4998294afb8a1d065fff3604eff18da95123bed9f512b45e8220fc05129a3f79` |
| `C:/Steam/steamapps/appmanifest_730.acf` | 1479 | `0b7a01c99922dff011d16edd8e458e9d4cdf436962d33c161beccf20779056de` |
| `C:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/steam.inf` | 190 | `67bb5f38cdcfb57331eea7dbcf2d337f46ea6ed998d3482e2637f830f7210a06` |
| `C:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/maps/de_dust2.vpk` | 262476433 | `51d6bb432b6553bfae6c38219a527c5de2464a2b107080f2b8be7d8427ebb885` |
| `C:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk` | 7708830 | `562972293ed7a5d40e341c4df7d6b0ee06430452694177142f0c1239dd3f2c8b` |
| `C:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_022.vpk` | 111048084 | `f96763d0dc5a126c7f7051dca0823b570ab5027c6a122acc5a3e2e532e4d4322` |
| `C:/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_339.vpk` | 107971185 | `d0d925a4fd2e94549e9497823e50b51b6a084c5332e414c586779e90f8358bdf` |
| `docs/replay-resources.json` | 21974 | `a055ce462c1c8f464f54493b0bd7287fc16f5171bf29d2a3e1120de0a6e9f543` |
| `apps/desktop/renderer/src/assets/replay-overviews/de_dust2.txt` | 541 | `97947e99bc7930fc06dc15af3dcf942dbca5ca1c6f36119a089615fd4b383620` |
| `apps/desktop/renderer/src/assets/replay-maps/de_dust2.png` | 175761 | `0828297130ce26db25a299806ff743df9104de634a3e64b52b358f6f4399354d` |
| `vendor/demoparser/.build/work/src/csgoproto/src/protobuf.rs` | 464157 | `953ad3f19e1c1bd888d8d51292ff47cb1379a979353f07fb7977a4c152e4f5b5` |
| `vendor/demoparser/.build/work/src/parser/src/first_pass/parser.rs` | 17329 | `08db73742d6e54426600afc1b96261196046d6902f5625f918b4a6e39593b8c2` |
| `vendor/demoparser/.build/work/src/parser/src/second_pass/parser.rs` | 20255 | `f5a0291e89d746a8932c8ecd8915a4f491e02c529d525ea4cc7da1eaf11f95da` |

另有 VPK tree SHA（仅目录字节，不含成员数据；已观察 preload=0）：地图 `3db59b38a9defbfcae9162ca47cb50db2ed3c7873f60f46206860251a86caebe`；共享目录 `25ab1a990a7db599074874b55e32d5d2667b4224ebc73691ad9d77624fe4939f`。两者均不代替成员或外部分片的 SHA。

## 5. VPK 目录读取范围与实际结果

VPK 字节布局依据固定版本 [ValvePak 原始源码][S02]：v1/v2 头、NUL 结束的扩展名/目录/文件名、18 字节条目（CRC32/preload/archiveIndex/offset/length/0xFFFF）以及 `0x7FFF` 内嵌数据约定。本轮**没有安装或执行该库**，仅用 Node 内建 fs/assert 进行只读元数据检查。探针源码完整保存在 JSON C03/C08/C14 的 command，未新增脚本文件。

| 项目 | de_dust2.vpk | pak01_dir.vpk |
| --- | ---: | ---: |
| VPK version / header | 2 / 28 bytes | 2 / 28 bytes |
| treeSize | 36011 | 6279392 |
| 目录条目数 | 632 | 137734 |
| fileDataSectionSize | 262432236 | 0 |
| archiveMD5SectionSize | 7028 | 1428280 |
| otherMD5SectionSize / signatureSectionSize | 48 / 20 | 48 / 20 |
| preload bytes | 0 | 0 |
| 目录消费/终止符 | 恰好消费至 tree end；0xFFFF 均有效 | 同左 |
| 物理 archive | 0x7FFF：自身内嵌；632 条目 | 索引 0–504，共 505 个分片；均 stat 存在 |
| 索引边界异常 | 0 | 0 |
| 包内重复路径（忽略大小写） | 0 | 0 |

505 个分片 stat size 合计 53213813207 bytes；这只是按明确索引派生的文件存在/尺寸审计，**不是全分片内容摘要验证**。只对必要的 `pak01_022.vpk` 与 `pak01_339.vpk` 额外计算整体 SHA；成员仍未读取/解码。每条偏移+长度均落在声明 file-data 范围或对应分片 stat 尺寸内，证明物理定位合理，不能证明该字节范围真是预期资源。

两个容器间重复路径为 0。此结论仅限本次两个目录，未覆盖游戏其他容器、自定义挂载、运行时覆盖或文件搜索优先级。未发现“已证实缺失的实际依赖”：因为尚未从成员内容取得真实 expected-reference 集合，不能把未知依赖标为 missing。

两容器 v2 各声明 section size 之和比实际文件小 1062 bytes。原始库源码支持 20 字节签名头随后读取 key/signature；本轮没有解释本地尾段或验签，不能据此认定损坏，也不能宣称签名验证通过。archive hash sections 只读取头中的尺寸，未读取或验证区内 MD5/其他 hash。

地图包类型摘要：nav 1、vmap_c 1、vwrld_c 1、vents_c 1、vwnod_c 1、vrman_c 3、vmdl_c 570、vtex_c 7，另有 occlusion/vdata_c/dat/kv3/vvis_c（完整数量摘要见 JSON）。本轮只保留 11 个必要资源标识，没有输出完整目录清单。地图包**没有独立 vphys_c 条目**；这不意味着物理缺失，可能的模型内嵌 PHYS 尚未读验。

## 6. Partial dependency inventory

下表均为**观察到的目录条目**。扩展名类型来自索引，语义内容尚未解析。所有成员 SHA-256 均为 null / NOT RUN；CRC32 是索引声明，未重算，不是防碰撞或认证摘要。地图包条目归属其完整容器 SHA；共享条目还以 archiveIndex 指向明确分片。具体成员大小不等于编译块解析成功。

| 节点 | 资源路径 | bytes | 索引 CRC32 | archiveIndex / offset |
| --- | --- | ---: | --- | --- |
| R01 | `maps/de_dust2.nav` | 481872 | `77ee421b` | 32767 / 257685772 |
| R02 | `maps/de_dust2.vmap_c` | 135488 | `d2542890` | 32767 / 257550284 |
| R03 | `maps/de_dust2/entities/default_ents.vents_c` | 45073 | `d8aecbc3` | 32767 / 256599468 |
| R04 | `maps/de_dust2/world_physics.vmdl_c` | 21843224 | `54c48ad4` | 32767 / 234537592 |
| R05 | `maps/de_dust2/world_physics.vrman_c` | 901 | `bfd864cd` | 32767 / 3975380 |
| R06 | `maps/de_dust2/world.vwrld_c` | 1961 | `54ca519b` | 32767 / 3972517 |
| R07 | `maps/de_dust2/worldnodes/n0.vwnod_c` | 70445 | `1fb04fed` | 32767 / 0 |
| R08 | `maps/de_dust2/world.vrman_c` | 908 | `63a09a2a` | 32767 / 3976281 |
| R09 | `maps/de_dust2/worldnodes/n0.vrman_c` | 902 | `041d13b7` | 32767 / 3974478 |
| R10 | `resource/overviews/de_dust2.txt` | 541 | `ca427be7` | 22 / 49618256 |
| R11 | `panorama/images/overheadmaps/de_dust2_radar_psd.vtex_c` | 212310 | `c757b3ef` | 339 / 28689824 |

图分成两类边，避免混淆：

1. **verified storage edges（11 条）**：目录 → 上表条目的 archiveIndex/offset/length，可由本次目录与 stat 核验。kind 固定为 directory-storage-location，semanticDependency=false，contentVerified=false；这不是实际资源引用。
2. **candidate resource edges（8 条）**：下表依据命名和静态 loader 规则提出的候选。实际验证均为 false，**verified semantic dependency edges=0**；没有间接引用链得到验证。

| 边 | 端点 | 状态 | 证据来源 | 缺少的本地证据 |
| --- | --- | --- | --- | --- |
| E01 | R02 → R08 | `candidate` | S03:GetLumpFolderFromVmapRERL; naming + directory candidates | Local vmap RERL not read |
| E02 | R02 → R06 | `candidate` | S03:InitMapExtract; expected loader convention | Local RERL-selected lump folder and loader resolution not verified |
| E03 | R06 → R03 | `candidate` | S03:World.GetEntityLumpNames; directory/name candidate | Local world DATA entity-lump list not read |
| E04 | R06 → R07 | `candidate` | S03:World.GetWorldNodeNames; directory/name candidate | Local world DATA world-node list not read |
| E05 | R06 → R05 | `candidate` | S03:GetWorldPhysicsName; static loader convention | Local world identity and loader invocation not verified |
| E06 | R05 → R04 | `candidate` | S03:manifest.Resources.First().FirstOrDefault + model PHYS branch; name candidate | Local manifest resource list and model PHYS not read |
| E07 | R07 → R09 | `candidate` | Directory basename only | No verified reference direction or semantics; candidate association only |
| E08 | R02 → R01 | `candidate` | Map basename only; index presence | No local reference or NAV contents read; association only, direction does not assert runtime load |

这里没有将同名、邻近目录或同容器关系升级为 verified。E07/E08 特别标为 candidate-association，箭头仅表达候选调查方向，不证明 runtime 引用方向。

[VRF MapExtract 原始源码][S03]显示：vmap 的 RERL 查找以 world.vrman 结尾的引用以确定 lump folder；world 的 DATA 提供 entity-lump/world-node 名称；world_physics.vrman 的资源列表可指向模型，模型再可能含内嵌 PHYS，或为独立 PhysicsCollisionMesh。**这些是源码中的解析路径，不是本地 Dust2 的实际引用观测。** 本轮连这些小型 manifest 的成员内容也没有读取，不能报告它们确实指向哪个文件。

所以当前分级为：

| 证明层级 | 本轮结果 |
| --- | --- |
| 目录存在条目 | PASS；11 个必要节点有真实索引证据 |
| 资源真实引用该条目 | BLOCKED / unresolved；0 条实证 semantic edge |
| 地图资源 parser 成功解析依赖 | NOT RUN；未调用外部 reader |
| 同一身份且完整依赖闭包 | BLOCKED；只有 partial inventory |
| 所有预期共享模型/物理/材质/表面可定位 | unresolved；本次未取得实际引用列表 |
| NAV 格式版本、hull、拓扑 / 模型 PHYS / 坐标变换 | NOT RUN；不能从文件扩展名推导 |

## 7. DEM 与资源绑定线索的强度

| 线索 | 分级 | 当前可证 / 不能证 |
| --- | --- | --- |
| DEM SHA、map_name、patch_version、GUID | observed | 固定 DEM 字节与 header 线索；不能指认地图构建 |
| build_num=10231 | observed（值/类型）；语义 unconfirmed | schema optional int32 tag13；缺少地图/安装 ID 的验证映射 |
| ServerInfo.game_session_manifest | schema-only | 固定 schema 为 bytes/tag20；本次没从真实 DEM 读出值或验证其内容标识算法/覆盖范围 |
| SpawnGroup_Load.worldname / spawngroupmanifest | schema-only | string/tag1、bytes/tag8；另有 offsets、manifestincomplete、creationsequence；本次无真实消息值 |
| 本地 VPK/container/tree SHA | observed | 标识被采样容器/目录；没有相应 DEM 内容标识建立可比关系 |
| 静态 loader 路线与命名关系 | inferred | 仅缩小候选文件；不是实际引用或闭包 |
| DEM→Steam build→地图资源 | unconfirmed | 没有已验证映射或录制环境资源清单 |
| 显示 manifest 与当前安装 manifest 不同 | observed | 仅证声明编号不同；不判为 matched 或 mismatched |

固定 `second_pass/parser.rs:263,457–464` 确实 decode ServerInfo，但仅用 max_classes 计算 cls_bits；game_session_manifest 没有被上层持久化或导出。固定 first-pass 消息分发也未保留它。SpawnGroup_Load 没有显式 handler，相关 fallback 忽略其他消息；不能把“schema 能解码”当“生产已保留身份材料”。本次从源码观察到 handler/导出行为，而从真实 DEM 的消息内容观察仍 **NOT RUN**。不以未导出证明 DEM 无此消息。

当前能证明的是：**目标 DEM 字节身份、采样时安装元数据身份、两个容器及必要分片字节身份、已有显示资产字节身份和目录中的物理定位。** 只能缩小候选的是地图名、版本线索、安装编号与静态 loader/命名。仍未知的是消息内容身份语义、真实本地引用、模型内嵌/外部物理、完整共享闭包、坐标转换、录制环境挂载，以及本地资源是否对应目标 DEM。结论保持 `unconfirmed / BLOCKED`。

## 8. 未来资源身份 manifest 草案

机器记录 `manifestProposal` 是建议结构，不是生产类型、registry 或新资源 manifest；本轮没有接入消费者或升级现有门控。

| 字段 | 建议记录及本次状态 |
| --- | --- |
| sourceIdentity | app/build/depot 各自命名空间、元数据与容器摘要、采样/挂载证据；当前挂载 unresolved |
| entryResource | `maps/de_dust2.vmap_c`、父容器摘要、索引定位；memberSha256=null |
| dependencyInventory | 本次 nodes、candidate resource edges 与独立 storage edges；每项单独身份与证据 |
| dependencyClosureStatus | partial；完整性验证 BLOCKED；不能用 manifest hash 自证闭包 |
| extractorIdentity | **null**；本轮未运行提取器；未来须记版本/commit/binary/config/output digests |
| coordinateSpace | DEM native X/Y/Z、DEM-world-unit；map axes/unit/transform 均 null / NOT RUN；overview 单独保留参数与来源 |
| targetDemoIdentity | 目标 DEM SHA、map/header/patch/build 原值及读取方式 |
| bindingEvidence | B01–B07 线索引用；verifiedContentBindings=[] |
| matchingStatus | **unconfirmed**；matched/mismatched 均无本次足够证据 |
| limitations | 未知依赖、成员摘要、ID 算法覆盖、坐标及能力验收；允许按能力进一步拒绝 |

容器 SHA 标识容器本身；`pak01_dir.vpk` 和 tree 的 SHA 不覆盖外部分片内容。未来 registry 自身 SHA 同样只标识该文档，不认证其描述的所有资产、来源声明、闭包或匹配状态。

## 9. 实际命令、退出码与验证

**所有实际 PowerShell 批次的完整命令（含 stdin 探针源码）在机器记录 `commands`；GitHub/Web 调用参数与失败在 `toolCalls`。** 下表为对应摘要。批次最终 exitCode 不等于各子命令全成功；已知中间错误逐项保留。日志仅保留去敏结果，没有原始 Steam 元数据或完整资源条目输出。

| ID | exitCode | 真实结果 |
| --- | ---: | --- |
| P01 | 0 | Read task and global AGENTS (file contains its own path literal) |
| P02 | 0 | Clean initial branch and HEAD; workflow and source discovery |
| P03 | 0 | Fetch and ls-remote successful; exact remote refs in baseline |
| P04 | 0 | Read workflows/research/manifest; combined tool output truncated, relevant sections reread in subsequent commands |
| P05 | 1 | Exploration had absent index.js/.tools/.local paths. Actual entry is index.cjs; recovered P06/C05-C11; no audit PASS based on missing paths |
| P06 | 1 | Branch successfully created; final rg includes missing .local; local DEM parser sources located, no game-directory scan |
| C01 | 0 | Read existing script/manifest/source/Steam metadata. Ancestor checks returned 1 each; final diff command 0. Raw appmanifest private fields not copied to this log. |
| C02 | 0 | Exploratory diagnostic parser source read; rg wildcard error (123), missing build script path; shell final exit 0 masks intermediate errors. This diagnostic schema was not trusted after hash mismatch. |
| C03 | 0 | Index probe process exit 0; output was oversized and tool truncated it. Orchestrator JSON.parse failed on truncation prefix. C08 repeats same metadata walk with aggregate output; full entry list never emitted or committed. |
| C04 | 0 | PASS whitelist DEM/native/raw header hashes and replay metadata. Diagnostic .tmp schema SHA 748119... differs from fixed provenance; not used as current-parser definition. C07/C11 correct this. |
| C05 | 0 | Located build metadata/provenance; native work source discovery continued. Poll of C03 still running; later completion under C07. |
| C06 | 0 | Located vendor/demoparser/.build/work. rg docs/parser* wildcard invalid on Windows; later explicit paths used. No binaries compiled. |
| C07 | 1 | Verified fixed protobuf/source hashes and schema/dispatch. Last optional Get-Content vendor/demoparser/build.ps1 absent => overall exit 1. Successful hashes independently asserted C11. Poll C03 exit 0; orchestration parse failed due output truncation. |
| C08 | 0 | PASS exact VPK tree/entry metadata probe and stat bounds; compact output retained; no member payload read. 632 / 137734 entries; 1 embedded / 505 external archive indices. |
| C09 | 0 | Read missing research sections, current adapter, fixed first-pass dispatch and version files. No header/SpawnGroup manifest export found. Combined output partly truncated; fixed definitions already fully observed C07. |
| C10 | 0 | Read existing resource audit/check tests and first-pass message dispatch. Avoided mutating check-replay-map-assets.test.mjs; ran read-only audit test C12. |
| C11 | 0 | PASS fixed generated schema hash asserted equal source.json; three correct native source identities recorded. |
| C12 | 0 | PASS 3/3 existing resource tests, fail 0, skip 0; 10 overviews and 13 PNGs verified; not geometry tests. |
| C13 | 0 | PASS prepared=13 expected=13 mode=verified-assets; read-only script. |
| C14 | 0 | PASS map-only extra manifest entries and vphys extension count. No standalone vphys_c entries in this map index; embedded physics remains unparsed. |
| C15 | 0 | PASS opaque SHA-256 of explicit pak01_022.vpk and pak01_339.vpk; no member decoding. |
| C16 | 0 | PASS sanitized Steam fields; two container SHA values unchanged; tree SHA and section-size observations. Whole-file buffer used opaquely for hashing; no member parsing. |
| C17 | 0 | PASS first document validator: 9 check groups; JSON parse, 13 local links, 3 external source reference links, identities, state, graph and privacy; only two untracked docs. |
| C18 | 0 | PASS staged only two authorized documents; Git warned about future LF->CRLF conversion, no content change. |
| C19 | 2 | FAIL exit 2: staged diff --check found one extra EOF blank line in each document. Guard stopped later commands; not treated as PASS. |
| C20 | 0 | PASS removed extra EOF blank lines and adjusted literal backslash notation; documentation-only edit. |
| C21 | 0 | PASS restaged docs; cached diff --check, scope diff and status; exactly two added files, production/manifest/dependency delta empty. |
| C22 | 0 | PASS final document excerpt/numstat inspection before validation-log update. |
| C23 | 0（2 次） | 最终文档验证器 10 组检查 PASS；日志补齐后重复执行；13 本地链接 / 3 来源链接、身份、图、状态、隐私与 EOF 均通过。 |

C03 首次探针本身 exit 0，但返回体过长被工具截断，编排层 JSON.parse 失败；C08 减为聚合结果重跑成功。未把首次返回的局部文本冒充完整机器记录。P05/P06/C02/C06/C07 的不存在路径/Windows rg 通配符错误均为定位阶段错误，后续显式路径读取与独立断言恢复。候选 GitHub 源码路径一次 404、web open 一次受限，之后用连接的 contents/tree 找到并读取固定源码；不引用失败页面作证据。

既有 read-only 验证：`node --test --test-reporter=tap scripts/replay-resource-audit.test.mjs` **3/3 PASS，0 fail/skip**，覆盖十张地图 overview 和十三张 PNG 的现有身份；`node scripts/check-replay-map-assets.mjs` exit 0，prepared=expected=13、verified-assets。这些是显示资产回归，**不是地图几何或绑定测试**。没有运行会创建临时假图片的额外 preflight 测试。

最终文档结构、JSON 解析、本地链接（13 个）、来源引用（3 个）、节点/边/摘要/状态交叉一致性、私密数据/范围扫描均 PASS。独立复审无阻塞问题，并重新核对固定 schema 与两份 parser 源摘要；复审完整命令与 exit 0 结果见 JSON.validation.independentReview（RV01–RV03）。首次暂存后 diff --check 因两文档 EOF 各多一空行而 exit 2（C19），修正后 C21 exit 0；该失败及恢复均保留。最终补充日志后再执行同一验证器和暂存检查，结果见 JSON.validation。只变文档，不运行全仓 typecheck/build、应用/GUI/installer 或全 DEM 重解析，不把前置单元测试数计入本轮。

## 10. NOT RUN、阻塞与下一步最小实验

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| 编译资源 RERL/REDI/DATA/PHYS 和实际引用 | NOT RUN | 本轮不读成员内容、不调用外部地图 parser |
| NAV/碰撞提取或转换、工具/helper 安装/编译 | NOT RUN | 用户明确禁止 |
| DEM session/spawn manifest 的真实值 | NOT RUN | 现有接口不暴露；本轮未新增原始非 header 解码或改 parser |
| 全 505 分片 hash、成员 CRC/SHA、VPK hash/signature 校验 | NOT RUN | 目录定位检查不等于内容校验；本轮只 hash 两个必要共享分片 |
| 完整资源闭包 / DEM 精确匹配 | BLOCKED | 真实引用集合与 DEM 标识语义缺失 |
| 新几何坐标配准、NAV/LOS/动作条件能力 | NOT RUN | 没有几何提取、绑定或独立真值 |
| P8.1-L2.2B 或更后续 | NOT RUN | 未自动启动 |

后续最小实验建议（**均需另行授权，本轮没有执行**）：

1. 在固定容器 hash 与明确成员白名单上，批准只读内存观察 vmap 的 RERL、world/physics manifest 的引用和块目录；固定已有 reader 的身份，只输出必要引用标识。先验证小型资源间真实边，再解析索引定位与成员摘要，发现明确引用缺项时才标 missing。若必须提取或运行外部工具，应先取得该具体权限；不因本轮报告完成而启动。
2. 单独批准非生产 DEM 消息探针，读取 session/spawn manifest 的存在性、长度、可解释标识与完整性线索。必须独立核实标识命名空间、算法和覆盖面，才可与地图内容比较。opaque bytes、同名或版本相近均不升级匹配；无法建立链就继续 unconfirmed。
3. 完整共享依赖与坐标/能力真值验证另立工作单元。本轮不生成 NAV、mesh、gltf 或碰撞资产，不修改现有生产门控/显示状态。

## 11. 证据与交付

[S01]: https://github.com/cs2-analyst/cs2-analyst-desk/pull/4
[S02]: https://github.com/ValveResourceFormat/ValvePak/blob/32c9858f2305bf4d12320374753b951ddeb6042d/ValvePak/ValvePak/Package.Read.cs
[S03]: https://github.com/ValveResourceFormat/ValveResourceFormat/blob/651253f52bbcc989b4f924fa5e0d70f0fc84abfa/ValveResourceFormat/IO/Extract/MapExtract.cs

S04–S10 的本地固定源码路径、SHA 与行定位列于机器记录 `sources`；本地忽略的 native 构建源码没有复制进 Git，固定 provenance 参考 [source.json](../packages/demoparser-native/source.json)与[加载校验](../packages/demoparser-native/index.cjs)。外部资料均只读取原始文本，未下载可执行工具或游戏资产。

本轮只新增两份研究文档；验证后创建聚焦本地提交，不推送 main、不创建/合并 PR、tag 或 Release。提交 SHA 与最终工作区状态在最终汇报给出；避免将提交自身 hash 写进自身。也可运行 `git log -1 --format=%H -- docs/p8-1l2-resource-inventory-2026-10-26.md` 查询。完成后停止。
