# P8.1-L2.2B：DEM 与本地 Dust2 地图资源身份绑定证据研究

日期：2026-10-26（Asia/Shanghai）。应用版本 **0.2.0**。[机器证据记录](p8-1l2-demo-map-binding-research-2026-10-26.json)。

**bindingStatus: unconfirmed。现有证据不能将目标 DEM 绑定到当前 Dust2 地图资源构建，也不能证明其几何等价。** 本轮只完成只读研究，不将研究完成称为地图能力 PASS。新增证据是：明确的本地 depot cache 内部编号与安装声明相符，且其中 5 个指定文件的大小和重算 SHA-1 与缓存声明一致；这仍未跨过 DEM→录制构建这一断点。[R05–R07、B01–B07]

## 1. 审查基线、规则与研究边界

| 项目 | 本轮实查 |
| --- | --- |
| 仓库 / 初始目录 | cs2-analyst/cs2-analyst-desk / E:\cs2-analyst |
| 初始分支、HEAD、工作区 | codex/p8-1l2-resource-inventory；b50bc7ac5cb079e86bc64e9f107ba1501aa34e60；干净 |
| fetch 后 origin/main | f44984e5464552c81737922c67df3d9f17c27c71 |
| 资源盘点最新远端 | b50bc7ac5cb079e86bc64e9f107ba1501aa34e60；ls-remote 与 tracking ref 一致 |
| 前置提交 | 几何研究 babcdd8cdff444dad86ff78e0f3e1f4499c54ddb；距离基础 623caaccbbd479e538c6b1166b8890170ab4c8f1；盘点 b50bc7ac5cb079e86bc64e9f107ba1501aa34e60，均在当前历史中 |
| 范围决策 PR #4 | open、draft=true、merged=false；head 8f61854793f3d9230d1cd160b3fd01dedaafcadd；base f44984e5464552c81737922c67df3d9f17c27c71 |
| 本轮独立分支 | codex/p8-1l2-demo-map-binding-research；从上述干净初始 HEAD 创建 |
| 相对 main 的边界 | 当前分支继承前置研究和 L2.1 生产/测试变更；盘点 HEAD 对 main ancestor 检查 exit 1，不视为已合并 |
| 本轮差异基准 | b50bc7ac5cb079e86bc64e9f107ba1501aa34e60；仅新增指定 MD/JSON |

依据 P01–P09、R01–R04、R09–R10、S15–S16。PR 的 merge_commit_sha 是潜在合并提交，不是合并凭证；本轮未合并或复制 PR 草案。范围文档不在当前 checkout，从已 fetch 的 PR 分支读取，引用[固定 head 的范围决策][S16]。

已检查全局/项目 AGENTS、[fixture 白名单](demo-fixtures.md)、.agents/routing/model-routing.md、.agents/workflows.md、DEM/domain 工作流及 .agents/agents/reviewer.md、tester.md；全局文件仅含自身路径文字。仓库没有 .agents/workflows/feature-development.md，最初尝试的 .agents/roles 路径也不存在，后以实际路径恢复。按身份命名空间/证据推理工作处理，另交独立 reviewer，不更换或编译 parser。先核对后已向用户报告计划。[P01–P09、R01–R04]

前置材料：[L2 研究](p8-1l2-map-geometry-feasibility-2026-10-25.md)及[JSON](p8-1l2-map-geometry-feasibility-2026-10-25.json)、[L2.1](p8-1l2-distance-foundation.md)及[验证 JSON](p8-1l2-distance-validation-2026-10-25.json)、[L2.2A](p8-1l2-resource-inventory-2026-10-26.md)及[JSON](p8-1l2-resource-inventory-2026-10-26.json)。本轮重新采样身份，前轮测试数只作历史记录，不冒充本轮运行结果。

读证范围：原始首 header（缓冲 65536 bytes、只解释 183-byte 首帧），已有 native 的 header-only 接口，明确 Steam 元数据/缓存 manifest，两个 VPK 的头和目录，以及指定文件的不透明摘要。VPK preload 均为 0。对 Steam manifest 的解析仅针对分发元数据，不是地图资源成员；其 SHA-1 用于与实际文件比较，同时另记 SHA-256，二者不混称。[R05–R07]

未提取、解包、解码或转换任何 VPK 成员、NAV、PHYS、WORLD 或模型；未下载资产/二进制/DEM，未安装依赖、编译 helper、运行地图提取器、启动或访问 CS2 进程。只新增两份研究文档，不改生产代码、测试、契约、manifest、版本；不发布、不合并、不进入 L2.2C/NAV/LOS/P8.2。

## 2. 证据分级与本轮可复现身份

observed 表示本轮文件观测；schema-only 表示仅固定 schema/静态行为；inferred 是推断；unconfirmed 是关系未获证明；not-run 是未执行；contradicted 针对被证据反驳的具体命题。schema-only 不等于真实消息存在；observed 不等于身份绑定成功。机器记录保留每条 evidenceRefs。

| 身份/字段 | 本轮结果 | 证据 |
| --- | --- | --- |
| .demo/dust2.dem | 557650967 bytes；SHA-256 db90fe85aab023a1d2c8a5996182e6120d98ef494f02a070b17982b235e4958c | R05 |
| 首帧 | magic PBDEMS2\0；cmd=1，未压缩；payload 183 bytes；tick unsigned 4294967295（int32 为 -1 sentinel） | R05 |
| map_name / patch_version | de_dust2 / 原始 tag2 int32 14055；native 输出字符串 "14055" | F02/F05、R05 |
| build_num / server_start_tick | 原始 tag13=10231 / tag15=51144 | F01/F04、R05 |
| demo_version_guid | 8e9d71ab-04a1-4c01-bb61-acfede27c046 | F03、R05 |
| native | 0.42.0-backport.363.1；Windows x64；binary SHA-256 132d664125b60542dc80dc8bc270e2c8e181a0a55433fdac5be285ef4d9b0de1 | R05 |
| 固定生成 schema | SHA-256 953ad3f19e1c1bd888d8d51292ff47cb1379a979353f07fb7977a4c152e4f5b5，与 source.json/provenance 断言一致 | S01、R05 |
| Steam app/build | 730 / 26144732 | R05 |
| 核心 depot/manifest | 2347770 / 67499503218971311 | R05/R07 |
| steam.inf | ClientVersion=ServerVersion=2000935；PatchVersion=1.41.9.2；SourceRevision=11162119；ServerAppID=2347773 | R05/R07 |
| VPK 目录 | 地图 632 条目，共享 137734 条目；共享索引引用 505 分片均 stat 存在 | R06 |
| 依赖闭包 | 真实语义依赖边仍为 0；成员内容未读 | R06/S14 |

本轮可比的 DEM/header、安装元数据、容器、022/339 分片、overview/PNG、固定源码摘要均与 L2.2A 相同。所有文件摘要及逐项 unchanged/newly-hashed 对照见 JSON observations.files/comparisonToL22A。新发现的 cache 不是前轮已观测项。安装时间字段 Oct 22 2026 / 14:13:16 的来源时区未确认；不据其推算 DEM 录制时间或地图构建时间。[R05–R07]

hash 期间检查 size/mtime 稳定；不是整个安装的原子快照，也不是对任意本地篡改的认证。未保存服务器名、client name、玩家身份、IP、LastOwner、轨迹或完整游戏文件清单。

## 3. A：DEM 版本字段定义与语义边界

### 3.1 build_num

CDemoFileHeader.build_num 是 **optional int32、字段编号 13、wire type 0**。固定生成代码位置 protobuf.rs:661–662；raw proto 镜像同义定义，真实首 header 观察到 10231。[S01/S04、F01、R05]

**Observed field; semantic namespace unconfirmed.**

当前公开材料没有证明赋值该字段的引擎生产者、赋值函数或赋值时机，也没有可信定义把它归入“地图 build”“Steam app build”“服务器 executable build”或 SourceRevision 命名空间。只能证明它被记录在 DEM 的第一个 FileHeader 帧；文件中的位置不证明引擎何时采集该数值。未获得适用于此 DEM 的官方 Source 2 header 生产代码。[S01–S07、外部检索 T01/T07]

first-pass parse_header 解码含该字段的生成消息，但未把 build_num 放入输出字典；临时消息结束后不保留。header-only、Node 导出和 adapter 均没有补取它。本轮从原始 header 单独读出，不改生产 parser。不能用“导出缺键”证明“文件没有”。[S02:81–89,311–335、R01/R05/R09]

### 3.2 patch_version 与版本编号

| 名称 | 本轮值 / 真实来源 | 可证范围 |
| --- | --- | --- |
| DEM tag2，当前 schema 名 patch_version | 原始 optional int32 14055 | 不是原始点分版本字符串；native 用 getter.to_string() 得到 "14055" |
| steam.inf PatchVersion | 字符串 1.41.9.2 | 当前安装文件自述；未证 tag2 的编码/换算 |
| ClientVersion / ServerVersion | 2000935 / 2000935 | 当前文件两个独立键，恰好相等不构成通用规则 |
| appmanifest buildid | 26144732 | 当前 Steam 安装声明的 app build |
| depot manifest ID | 67499503218971311 | 特定 depot 版本的清单编号，非文件摘要 |
| SourceRevision | 11162119 | 当前文件自述的 revision 字段；具体生产/命名空间未由官方实现确认 |
| 地图容器 SHA / 成员 SHA / 闭包摘要 | 容器已算；成员/闭包未算 | 具体字节身份与版本编号是不同证据 |

证据：F02、R05/R07、S08–S12。Steam 官方说明 app build 可包含多个 depot，每个 depot 版本有唯一 64-bit manifest ID，app build 完成后另行分配 BuildID；manifest 可声明文件大小/SHA1。该机制没有提供本 DEM header 字段到这些编号的映射。[S08/S09]

保留命名冲突：固定 demofile-net f14fedc 的 CDemoFileHeader tag2 名为 network_protocol，类型同为 optional int32；本项目固定生成代码和所读 GameTracking 镜像称 patch_version。[S01/S04/S07] 因而“tag2 在所有解析器中总叫 patch_version”这一命题被反例反驳（contradicted）。本报告保留项目键名与原始值，不据此宣称它已被权威证明为网络协议号；更不把 14055 按十进制补点后与 steam.inf 比较。该不同名字只说明不能把名称当语义认证。

GetAppBuildId 官方 API 返回当前 app BuildID，文档没有声明它等于 CDemoFileHeader.build_num；本轮未调用 API/启动游戏。[S10] 不把 10231、14055、26144732、2000935、11162119 相等比较或排列大小来确定地图时代。无法由不同编号直接判为 mismatched，也不能由近似编号判为 matched。

### 3.3 GUID、起始 tick 与其他 header 线索

demo_version_guid 是 optional string/tag12，值如第 2 节；名称不是 map GUID，未证每场唯一或内容认证。本文沿用用户“DEM GUID”指这个原始字段，不能作为比赛 UUID 或地图指纹。server_start_tick 是 optional int32/tag15，51144；当前 header 导出丢弃，未证明其钟表时间或资源身份意义。[F03/F04、S01/S02/S04、R05]

demo_version_name=valve_demo_2、fullpackets_version=2、addons=""、clientside entities/particles flags 为 true，均仅为本 header 的观察。空 addons 不能证明录制端没有覆盖挂载；true flags 不是资源几何摘要。map_name=de_dust2 只缩小候选。首 header 没有命名为 worldname/game_session_manifest/spawngroupmanifest 的定义；它们属于其他消息，不能从 header 缺失推广到全 DEM。[R05、S01/S04–S06]

## 4. B：Steam→本地资源证据链

### 4.1 新增本地分发元数据对应

只检查两个精确路径：C:/Steam/depotcache/2347770_67499503218971311.manifest 存在；C:/Steam/steamapps/depotcache/2347770_67499503218971311.manifest 不存在。无目录泛扫、下载、解密或访问 Steam 后端。[R06]

存在的文件 3099314 bytes，SHA-256 **6318b4ccd089f1d2b30689cc247c81469856779d016c7c24198a12d96a2e3627**。依据固定 SteamKit 的分段 magic/长度与生成 protobuf tags，只读解析该分发元数据：[S11/S12、R07]

- payload section=3099234 bytes；metadata=52 bytes；signature section=**0 bytes**；结尾标记恰好至 EOF。
- 内部 depot_id=2347770，gid_manifest=67499503218971311，creation_time=1792704192，filenames_encrypted=false，cb_disk_original=65046717914。
- 2992 个 file mappings；只保存以下 5 个明确条目，不保留其余文件清单或 chunk 内容。
- 元数据中的 filename/tag1、size/tag2、sha_content/tag5 来自固定生成定义；这里 SHA-1 来自 Steam manifest，不能冒称为 SHA-256。重算文件 SHA-1 用来核对该声明；另独立计算 SHA-256。

| 指定文件（相对安装根） | bytes | cache 声明 = 重算 SHA-1 |
| --- | ---: | --- |
| game/csgo/maps/de_dust2.vpk | 262476433 | 7dc529cd65d843a2b8a98c297e79b9923dd70a5d |
| game/csgo/pak01_dir.vpk | 7708830 | 8d4538401fb2f65735bb3297cf68ad4e8112be39 |
| game/csgo/pak01_022.vpk | 111048084 | 28eb4283e9c6292c2aa2a17862b0ba998594c638 |
| game/csgo/pak01_339.vpk | 107971185 | 61c4db6d4113774f65673755dae4c7be3fcf5f80 |
| game/csgo/steam.inf | 190 | 38d9850281f88fa7ac44357dc0b969abb9800914 |

5/5 的大小和 SHA-1 比较相符；文件 SHA-256 同 R05/R07。**这是可复现的“未认证本地清单声明与指定文件字节对应”，不是 Valve 签名认证、历史 BuildID 认证、整个 depot 校验或 DEM 绑定。** 空 signature section 不认定该 cache 损坏，也不认定发行来源已验证；未检验 CRC、签名或远端可信副本。[R07、B03/B04]

### 4.2 每条映射边的状态

| 边 | 直接证据 / 来源类别 | 真实文件、版本范围、歧义 | 当前状态 |
| --- | --- | --- | --- |
| B01 DEM header/protocol→特定游戏/服务器构建 | F01–F04 原值 + 固定 schema/parser；无生产者赋值规则 | 是；只覆盖此 DEM 与固定 decoder；build_num/tag2 命名空间不明 | unconfirmed |
| B02 录制构建→Steam app build/depot set | SteamPipe 有官方通用机制，但无本 DEM 的历史关联记录 | 无目标映射文件；当前安装不是录制环境，server app 也不必是 730 | unconfirmed |
| B03 当前 appmanifest build→depot/manifest | appmanifest InstalledDepots，与 cache 内部编号相符；本地声明 | 是；仅采样安装，未取得签名历史构建表 | observed（声明） |
| B04 cache mappings→指定文件字节 | 5/5 size+重算 SHA1，对应独立 SHA256 | 是；仅指定文件，非全部 505 分片；cache 未认证 | observed（字节对应） |
| B05 map VPK→地图入口定位 | vmap_c 的目录路径、archiveIndex/offset/length | 是；仅当前容器目录，无成员摘要/读取/CRC 校验 | observed（存储定位） |
| B06 地图入口→实际资源依赖闭包 | VRF 静态 loader 提示；本地仅候选路径 | 否（没有真实引用观测）；版本限固定工具实现；挂载/闭包未证 | inferred / unconfirmed |
| B07 闭包→DEM 几何等价 | 无目标 ID/摘要比较、独立空间基准或验收规则 | 未运行；同发行构建也不证明运行时实际挂载 | unconfirmed |
| B08 历史 overview→本安装/DEM 几何 | provenance 编号不同；022/339 声明摘要相同、dir 摘要不同 | 历史原始 manifest 未再取得；部分相同不代表整个地图相同 | unconfirmed |

各边详细 directEvidence/sourceKind/versionScope/ambiguity/evidenceRefs 在 JSON bindingEdges。B03–B05 可复现不填补 B01/B02/B06/B07。没有任何从 DEM 出发的 binding-candidate-verified 路径，更没有 matched；也没有足以判定几何 mismatched 的证据。

### 4.3 VPK 身份与历史显示 provenance

| 文件 | 本轮 SHA-256 |
| --- | --- |
| maps/de_dust2.vpk | 51d6bb432b6553bfae6c38219a527c5de2464a2b107080f2b8be7d8427ebb885 |
| pak01_dir.vpk | 562972293ed7a5d40e341c4df7d6b0ee06430452694177142f0c1239dd3f2c8b |
| pak01_022.vpk | f96763d0dc5a126c7f7051dca0823b570ab5027c6a122acc5a3e2e532e4d4322 |
| pak01_339.vpk | d0d925a4fd2e94549e9497823e50b51b6a084c5332e414c586779e90f8358bdf |

tree SHA：地图 3db59b38a9defbfcae9162ca47cb50db2ed3c7873f60f46206860251a86caebe；共享 25ab1a990a7db599074874b55e32d5d2667b4224ebc73691ad9d77624fe4939f。目录没有重复路径/边界异常，两容器之间重复路径 0；共享 505 分片 size 合计 53213813207 bytes，只有 022/339 计算内容摘要。地图入口 maps/de_dust2.vmap_c 为 archiveIndex=32767、offset=257550284、length=135488，CRC32=d2542890。11 个指定目录节点/定位记录全部在 JSON。[R05/R06]

VPK 目录 CRC32 未重算；它不是独立 SHA-256，也不是资源认证。整个 map VPK 的 SHA 固定该容器字节，但没有建立 DEM 对应关系；pak01_dir/tree 的 SHA 不覆盖外部共享分片。两个 v2 头声明尺寸和实际文件均相差 1062 bytes，沿用前轮观察；本轮仍未解释尾段或验签，不宣称损坏或认证通过。[R06、S13、前轮报告]

[现有 replay manifest](replay-resources.json) 仍声明历史 depot manifest **2312433566686574487**，与当前 **67499503218971311** 不同；历史 build/clientVersion 为 null。本轮重算现有 overview/PNG SHA 与前轮一致（JSON files），原 versionMatch/demVersionMatch 保持 unconfirmed。历史 provenance 的 022/339 SHA 恰与当前分片相同；历史 pak01_dir SHA d219493f5ba3205e544ec5320e109c390d3dd55ce37c0e7ced2f732f19210953 与当前不同。这是部分资源可跨 manifest 复用的具体线索，不能证明 Dust2 几何相同或不同，更不能证明旧 DEM 使用其中之一。[R05/R10、S19]

## 5. C：消息与资源关联的实际研究结果

**本轮没有解码任何 DEM packet/signon/fullpacket/SpawnGroups/Recovery 内容，也未扫描全 DEM 消息。下表所有消息的 DEM 实证均为 NOT RUN，状态 schema-only。** 实际观测仅第 2 节 header。未发现记录不等于记录不存在；不把 native 的 header-only 成功解释为消息读取成功。[R05、S02、R09]

| ID / Schema | Parser | DEM 实证 / 语义 / 绑定价值 / 限制 |
| --- | --- | --- |
| M01 CSVCMsg_ServerInfo（svc 40），game_session_manifest optional bytes/tag20，protocol/tag1、map_name/tag15、config/tag19 | second-pass 明确 decode，只取 max_classes→cls_bits | NOT RUN；只确认外层 bytes，内部格式、是否含内容 ID、算法与覆盖未知；候选线索 inferred，不能和 Steam manifest 或 .vrman_c 画等号 |
| M02 CNETMsg_SpawnGroup_Load（net 8），worldname optional string/tag1，spawngroupmanifest bytes/tag8 | message_type 枚举识别，但 first/second pass 无内容 handler，默认忽略 | NOT RUN；名字可筛选候选（inferred），不是内容指纹；world_offset_pos/angle tags6/7 尚未观测，不能假定坐标同一 |
| M03 SpawnGroup_ManifestUpdate（net 9），handle/tag1、manifest bytes/tag2、manifestincomplete/tag3 | 枚举识别，无内容 handler | NOT RUN；若以后观测，必须连同 Load 的 manifestincomplete/tag11、creationsequence/tag16、handle 与顺序考虑完整性；单条载入不能自证闭包 |
| M04 CDemoSpawnGroups repeated bytes msgs/tag3（cmd15）；Recovery initial_spawn_group/tag1、spawn_group_message bytes/tag2（cmd18） | first-pass 命令分派未处理，未见现有导出接口 | NOT RUN；只确认包装定义，不确认其 bytes 已是某种 CNET 消息；没有 frame 计数或覆盖声明 |
| M05 SignonState map_name/tag5、addons/tag6；GameSessionConfiguration s1_mapname/tag11、data bytes/tag14 | 无 SignonState 内容处理；nested config 随 ServerInfo 丢弃 | NOT RUN；启动/会话名字可能补充环境，但无稳定内容摘要语义；data 内层类型也未证 |
| M06 CSource2Metrics_MatchPerfSummary_Notification server_build_id optional uint32/tag3；clients.build_id/tag3、map/tag20 | 未找到匹配 handler | NOT RUN；telemetry schema 的存在不证明 DEM 有此传输；不得仅由 build 名称认作 Steam BuildID |
| M07 Sounds.sounddata guid uint32/tag18、sound_resource_id fixed64/tag19；Prefetch resource_type/tag2；ClientInfo send_table_crc fixed32/tag1 | 未识别可导出的地图身份路径 | NOT RUN；sound/send-table 范围的标识不能冒充 map/world 内容 GUID；不证明整个协议无其他资源身份 |

Schema 与源码索引：M01 S01:7886–7919/S05/S03:263,457–464；M02/M03 S01:4420–4469/S06；M04 S01:868–895/S04；M05 S01:4359–4372,4495–4539/S06；M06 S01:7606–7632；M07 S01:7763–7773,7998–8012。[R01–R04、R08/R09]

现有 API 无 manifest 查询接口。要从实际 DEM 获得上述值，需要另写有边界的帧/压缩/bitstream/消息只读探针，处理 CDemoPacket/FullPacket、bit-varint、net/svc 分派，以及可能的 SpawnGroups/Recovery 路径；直接运行完整 ticks/events API 既不能导出这些字段，又会处理无关实体/玩家数据。本轮选择源码可行性研究，**该探针 NOT RUN**，不为填充实证而新建完整 parser。这个选择是本轮研究覆盖限制，不是假定只读消息读取本身必须解包游戏资产。

即使未来读取到非空 bytes，其摘要仅能指纹化这段消息，不会自动成为地图内容摘要。需继续证明内部格式、稳定 ID/哈希算法、文件版本与运行时闭包的对应及重现规则，才可能从 schema-only→observed-unbound→binding-candidate-verified。当前这三个消息阶段没有跳级；未产生 observed-unbound 或 binding-candidate-verified 的真实消息记录。

## 6. D：直接、间接绑定方案的判断

直接绑定：**未建立**。没有从 DEM 观测出可与地图容器/入口/依赖内容独立对应的 ID、摘要或认证清单；这不是“不可能存在”的全协议结论。[F01–F05、M01–M07、B01/B02/B07]

间接发行构建绑定有潜在可审计方案，但当前 **unconfirmed**：

1. 先获得可追溯的录制服务器/游戏构建身份，证明其命名空间和所录值；再取得该构建的 app/depot/manifest 对应，包含 branch、平台、server app 与时间范围。当前 cache 只能证明当前安装的局部对应，不能补造历史记录。[B01–B04]
2. 在受信任的分发清单下，核对地图入口所属容器和所有实际共享依赖的内容身份。manifest 文件 ID 是索引编号，受控报告的 SHA 也只是报告字节；二者均不能自证闭包完整或来源可信。[B04–B06]
3. 记录实际挂载、覆盖优先级、addons/workshop/loose resources、版本更新和原子快照范围；只知道发行 build 一致仍只支持“同发行资源来源候选”，不自动证明录制运行时地图几何。[B01/B06/B07]
4. 再用独立、预先冻结的 Dust2 地标/高度/障碍真值验证坐标和所声明的几何能力；独立基准只能约束受测空间和误差，不反向认证全文件身份。[B07、S17]

如果最终只有高度可能，仍保留 unconfirmed。当前没有事先定义且通过审计的 matched 验收规则，不能在研究后降低门槛来取得 matched。文件身份已确认、发行版本关联、地图版本匹配、坐标精度、NAV、静态 LOS 和动态遮挡是不同门槛，不能用通用 matched=true 一次开放。[S17、L2.1]

## 7. E：当前资源身份与能力矩阵

| 能力 | 当前允许条件 | 本轮结论 / 证据 |
| --- | --- | --- |
| 同 DEM、同 actual tick XY/XYZ 距离 | 同 DEM SHA/match/map/parser/原生规范/单位，完整有限 XYZ，actual tick 一致，来源可回查 | 保持 L2.1；独立 calculateDemDistance，不依赖地图匹配；单位 DEM world units [C01/S18] |
| 原始服务器事实 | 字段、actual tick、来源、coverage/歧义有效，前缀输入不受未来信息扰动 | 不普遍要求 availableTick；不宣称玩家已知/看见/听见 [C02/S16] |
| 现有 overview 算术投影 | 已知参数、可信显示资源记录及绑定的 validated 算术依据 | 保留纯算术；不等于几何匹配或独立定位精度 [C03/S17/S19] |
| 地图定位精度声明 | 独立地标、XYZ/高度/变换与误差门槛通过 | 本轮未建新基准，不新增“精确/已验证”声明 [C04] |
| NAV 可达性 | 地图/NAV身份、拓扑/hull/高度与独立正反例验证 | blocked / not-implemented，不自动开放 [C05/S17] |
| 静态 LOS | 匹配完整碰撞闭包、变换/过滤语义与独立遮挡基准 | blocked / not-implemented，不自动开放 [C06/S17] |
| 动态遮挡 | 动态状态、时序和空间模型单独验证 | blocked / not-implemented [C07/S17] |

现有 overview 参数 posX=-2476、posY=3239、scale=4.4，PNG 1024×1024，既有投影按 overview 算术执行；历史 four-region/coarse registration 记录不冒充本轮独立精度基准。示意位置与纯数字距离可保留，但不推出可通行、到达时间、支援、交叉火力、LOS、动作因果或胜率收益。[S19、L2.1、S16]

本轮没有更改 L1/L2 输入/能力契约或重新运行 L2.1 真实距离测试；其已有通过记录和代码门控被静态核实，不能把本研究不匹配结论变成距离 API 的阻断条件。[R08/R09、S17/S18]

## 8. 下一步最小实验建议（仅建议，未实施）

**最小优先项是补 DEM→可信构建→历史 depot 关系，不是先提取地图。**

| 顺序 | 建议取证 / 预期产物 | 最小授权与停止条件 |
| --- | --- | --- |
| N01 | 固定可信 producer/协议来源，解释 build_num/tag2/GUID 的命名空间；取录制环境构建/挂载记录或可认证历史 app build→depot 映射，并与本 DEM 原值关联 | 单独元数据研究；不下载游戏资产、不启动游戏；没有历史关联就保留 unconfirmed，不能拿当前缓存代替 |
| N02 | 若 N01 需消息线索，明确授权一个有 byte/frame/消息数量上限的只读探针，限定 ServerInfo、SpawnGroup Load/Update 与必要包装；只保存 offset/tick/type/字段存在、长度/摘要及去敏身份字段 | 不新建完整实体解析器；不导出资源 bytes/服务器或玩家信息；压缩/格式不支持则停止报告；先证明 bytes 格式，不能猜成 Steam manifest/.vrman |
| N03 | 为已关联构建设计入口/依赖身份记录：容器 SHA、目录定位、成员摘要、真实引用、完整性、挂载优先级及审计规则；先利用元数据可证部分 | 本轮入口和成员/闭包没有验证；摘要可绑定 bytes 但不自证语义/闭包；另行授权实际资源内部读取 |
| N04 | 冻结独立 Dust2 空间基准与误差规则：分散地标、上下层/斜坡、阻挡两侧、正反例、坐标来源/采集方法、保留集和容差 | 单独实验授权，先定义验收再测；若无与目标构建关联的独立基准，不给精度 PASS |
| N05 | 在上述证据明确后，才决定是否值得提取几何 | 不因研究结束自动执行 L2.2C/NAV/LOS |

若最终确实需要读资源内部，最小分阶段申请为：

- 先仅定位并读取 maps/de_dust2.vmap_c 的资源头/RERL 与 maps/de_dust2/world.vrman_c（908 bytes）、world.vwrld_c（1961 bytes）、world_physics.vrman_c（901 bytes）、worldnodes/n0.vrman_c（902 bytes）的必要依赖元数据；确认实际引用后才扩大。不要一次提取整个地图包。[R06、S14]
- 目录只有路径、CRC、位置和长度，没有 vmap RERL、world DATA 依赖名或 manifest 内部资源列表，因而不能确认真实资源引用。预期产物是引用边、解析版本/完整性和内容摘要，不预设这些内部数据一定含稳定 GUID/内容摘要。[S13/S14]
- world_physics.vmdl_c（21843224 bytes）只在小元数据证实实际引用且另获最小授权后检查头/依赖/PHYS 身份；不因候选名称立即解码。NAV 的 481872 bytes 内容和拓扑不属于该最小身份研究，几何转换也另行决策。[R06/S14]
- 如果授权未来解包，优先仅内存/本地临时处理；游戏原始资产不进仓库、不上传，不持久化/提交原始 bytes。每次把容器 SHA、tree SHA、archive/offset/length、必要分片 SHA 与计算的成员摘要绑定，解析器版本/配置与输出元数据摘要齐备；前后检查源身份和运行记录。实际依赖边未闭合就不能宣称 closure complete。
- 这些操作本轮均 **NOT RUN**；当前没有证明必须解包才能解决 DEM→历史构建断点，提前提取不能修复这个断点。

## 9. 实际命令、退出码与未执行项

JSON commands 与 reviewAndValidationCommands 保存研究、验证和独立复审 shell 批次原文（含 stdin 探针）、实际 exitCode、去敏摘要；R05–R07 同时保存结构化输出。批次末尾退出码 0 不代表其中每条命令成功；中间缺路径/被截断均显式保留。外部工具参数/来源见 toolCalls、sources。文档编辑使用 apply_patch，不执行生成/安装/资源写入脚本。

| 批次 | exitCode | 摘要 |
| --- | ---: | --- |
| P01–P02 | 0 | 全局规则、初始目录/状态/remote |
| P03 | 1 | feature-development 工作流不存在，其余读取成功 |
| P04–P07 | 0 | docs/refs/版本核对；scope/roles 初次路径不存在的中间错误保留，后续恢复 |
| P08–P09 | 1 | 错 source.json 路径、固定源码目录无 raw proto；读取/检索结果部分截断后定向复核 |
| R01 | 0 | 真实角色路径、provenance/header/parser/资源审计逻辑 |
| R02 | 0 | 独立分支、ls-remote、frame/header/message 分发与候选字段 |
| R03–R04 | 0 | Schema/session/telemetry/资源候选、既有命令与门控静态阅读 |
| R05 | 0 | 白名单 DEM 摘要、raw/native header、指定文件摘要、去敏 Steam 数据 |
| R06 | 0 | VPK 头/目录、505 分片 stat、两处精确 manifest cache 检查 |
| R07 | 0 | 当前 cache 元数据、指定 5 文件 size/SHA1 对应与 SHA256 |
| R08–R09 | 0 | adapter/native header-only、更多 schema、前置 JSON/能力门控 |
| R10 | 0 | main 继承差异、历史 replay provenance；ancestor 子命令为 1 |
| V00 | 0 | 编辑上下文不匹配后的定向记录检查；没有执行资源操作 |
| V01–V05 | 0 | JSON/结构/链接/证据/隐私/范围检查、最终远端复核、暂存区 diff --check；仅两份 added 文档 |
| reviewer 批次 | 见 JSON | 独立静态核查和最终两文档复审 |

未执行：所有 DEM packet/实体/轨迹解析与消息 occurrence 扫描；所有网络 manifest 内层解码；历史 app/build 清单认证和 cache 签名/CRC 验证；完整 depot/全 505 分片 hash；所有 VPK 成员读取/提取/CRC/SHA/依赖验证、几何/空间真值/NAV/LOS/动态模型实验；GUI、安装版、typecheck/build/全仓或距离运行时测试。本轮没有生产变更，文档研究适用 JSON/结构/链接/范围验证，历史通过数不重算。本轮没有 push/PR 创建/merge、tag/Release。

## 10. 独立复审与交付检查

独立 reviewer 先重新核对固定 schema、两个 pass 分发、native header-only 和 L2.1 gates，再复核两份研究文档及机器证据。复审只读、不解析游戏/DEM 内容。关键复核项：GUID 字段名与语义边界、tag2 名称冲突、SpawnGroup“枚举识别但忽略内容”、全部消息 NOT RUN、cache 空签名不认证、5 文件对应不升级成 DEM 绑定。[JSON validation.independentReview]

独立复审 **PASS，0 阻塞项**；8 组独立检查通过，含 12 个本地链接与 13 个外部来源索引。主研究文档检查 11 组通过。复审未独立重算游戏文件或联网复查新外部 schema，不能冒充第二次 DEM 实测。实跑记录见 JSON validation；研究结论保持 **bindingStatus: unconfirmed**。仅两份新增文档；应用/包边界、resource manifest、版本、既有测试行为保持不变。最终提交 SHA、分支和工作区状态在交付消息提供，避免把文档自身提交 SHA 写进自身导致循环。

## 11. 证据索引

本地固定证据：S01=固定 generated protobuf.rs（摘要见第 2 节），S02=first_pass/parser.rs（08db73742d6e54426600afc1b96261196046d6902f5625f918b4a6e39593b8c2），S03=second_pass/parser.rs（f5a0291e89d746a8932c8ecd8915a4f491e02c529d525ea4cc7da1eaf11f95da）；其 provenance、行号、读取命令均在 JSON。S17=[资源门控源码](../packages/analytics/src/map-resource.ts)，S18=[原生距离源码](../packages/analytics/src/distance.ts)，S19=[既有显示 provenance](replay-resources.json)。

外部证据优先按官方定义、实际文件、固定实现区分。S04–S06 是第三方跟踪仓库中的协议 schema，**不是官方引擎生产者源码**；S07/S11–S14 只用于说明其自身固定实现。未找到的官方字段语义不会用第三方名称推断补齐。Steam 官方在线文档未提供版本 SHA，按本轮访问日期与段落记录，不伪称固定版本。

[S04]: https://github.com/SteamTracking/GameTracking-CS2/blob/a34ca3ebbcfc8e5728d2386ce9e989b0b6050b1d/Protobufs/demo.proto
[S05]: https://github.com/SteamTracking/GameTracking-CS2/blob/a34ca3ebbcfc8e5728d2386ce9e989b0b6050b1d/Protobufs/netmessages.proto
[S06]: https://github.com/SteamTracking/GameTracking-CS2/blob/a34ca3ebbcfc8e5728d2386ce9e989b0b6050b1d/Protobufs/networkbasetypes.proto
[S07]: https://github.com/saul/demofile-net/blob/f14fedc935a1fc58fec60104c7ce8358bbbdf780/src/DemoFile.Game.Cs/Protobufs/demo.proto
[S08]: https://partner.steamgames.com/doc/sdk/uploading?l=english
[S09]: https://partner.steamgames.com/doc/store/application/builds?l=english
[S10]: https://partner.steamgames.com/doc/api/ISteamApps#GetAppBuildId
[S11]: https://github.com/SteamRE/SteamKit/blob/2304189daa8510cb576d948485db274339d3eba7/SteamKit2/SteamKit2/Types/DepotManifest.cs
[S12]: https://github.com/SteamRE/SteamKit/blob/2304189daa8510cb576d948485db274339d3eba7/SteamKit2/SteamKit2/Base/Generated/ContentManifest.cs
[S13]: https://github.com/ValveResourceFormat/ValvePak/blob/32c9858f2305bf4d12320374753b951ddeb6042d/ValvePak/ValvePak/Package.Read.cs
[S14]: https://github.com/ValveResourceFormat/ValveResourceFormat/blob/651253f52bbcc989b4f924fa5e0d70f0fc84abfa/ValveResourceFormat/IO/Extract/MapExtract.cs
[S15]: https://github.com/cs2-analyst/cs2-analyst-desk/pull/4
[S16]: https://github.com/cs2-analyst/cs2-analyst-desk/blob/8f61854793f3d9230d1cd160b3fd01dedaafcadd/docs/p8-scope-decision-l1-l2-2026-10-25.md
