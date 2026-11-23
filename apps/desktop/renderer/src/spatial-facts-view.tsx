import { Badge, Body1, Button, Caption1, Card, Subtitle1, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import type { DesktopPlayerComparison, DesktopSpatialFactCard, DesktopSpatialFactsV1 } from '@cs2-analyst/report-contract';
import { palette } from './theme';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: { backgroundColor: palette.card, border: `1px solid ${palette.border}`,
    borderRadius: tokens.borderRadiusLarge, boxShadow: 'none', padding: '16px', gap: '8px' },
  heading: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  rows: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  number: { fontVariantNumeric: 'tabular-nums' },
});

const number = (value: number) => value.toFixed(1);
const position = (value: { x: number; y: number; z: number }) =>
  `${number(value.x)}, ${number(value.y)}, ${number(value.z)}`;

export function SpatialFactsView({ facts, players, onReplay }: {
  facts?: DesktopSpatialFactsV1;
  players: DesktopPlayerComparison[];
  onReplay?: (round: number, tick: number) => void;
}) {
  const s = useStyles();
  const names = new Map(players.map(player => [player.playerId, player.playerName]));
  const name = (id: string) => names.get(id) ?? '未知玩家';
  if (!facts) return <Card className={s.card} data-spatial-facts="legacy">
    <Subtitle1>空间事实</Subtitle1><Body1>此归档尚未计算空间事实。重新选择原 DEM 分析后可查看。</Body1>
  </Card>;
  if (facts.status === 'unavailable') return <Card className={s.card} data-spatial-facts="unavailable">
    <Subtitle1>空间事实</Subtitle1><Body1>{facts.reason === 'no-valid-facts'
      ? '已检查的范围内没有可展示的精确证据片段。' : '空间事实暂时无法计算，其他报告仍可使用。'}</Body1>
    {facts.coverage?.truncated ? <Caption1 className={s.muted}>已达到处理上限，后续内容未评估。</Caption1> : null}
    {facts.coverage?.withheld ? <Caption1 className={s.muted}>有 {facts.coverage.withheld} 项证据不足或冲突。</Caption1> : null}
  </Card>;
  return <div className={s.list} data-spatial-facts={facts.status}>
    <Card className={s.card}>
      <div className={s.heading}><Subtitle1>服务器空间事实</Subtitle1>
        <Badge appearance="tint" color={facts.status === 'partial' ? 'warning' : 'success'}>
          {facts.status === 'partial' ? '部分证据' : '已记录'}
        </Badge></div>
      <Caption1 className={s.muted}>已扫描 {facts.coverage.inspectedTicks} / {facts.coverage.deathTicks} 个死亡 tick，
        展示 {facts.cards.length} 个片段；{facts.coverage.withheld} 项证据不足或冲突{facts.coverage.truncated ? '，结果已限量' : ''}。</Caption1>
      <Caption1 className={s.muted}>这些是本机解析或已保存报告中的服务器记录，存档不会重新读取 DEM。距离与端点位移不证明视野、通路、支援或玩家意图；两个端点之间的路径未知。</Caption1>
    </Card>
    {facts.cards.map((card, index) => <SpatialCard key={`${card.kind}:${card.round}:${card.eventTick}:${index}`}
      card={card} name={name} onReplay={onReplay} />)}
  </div>;
}

function SpatialCard({ card, name, onReplay }: {
  card: DesktopSpatialFactCard;
  name: (id: string) => string;
  onReplay?: (round: number, tick: number) => void;
}) {
  const s = useStyles();
  return <Card className={s.card} data-spatial-card={card.kind}>
    <div className={s.heading}>
      <Subtitle1>R{card.round} · {card.kind === 'event-prestate' ? '击杀事件前状态' : '1v1 形成'}</Subtitle1>
      {onReplay ? <Tooltip content="回放使用已有采样，可能插值；本卡数值来自精确 tick。" relationship="description">
        <Button size="small" appearance="subtle" onClick={() => onReplay(card.round, card.eventTick)}>
        查看回放
        </Button></Tooltip> : null}
    </div>
    {card.kind === 'event-prestate' ? <div className={s.rows}>
      <Caption1 className={s.muted}>事件 tick {card.eventTick} · 精确采样 tick {card.sampleTick}</Caption1>
      <Body1 className={s.number}>{name(card.participants[0].playerId)}（{card.participants[0].side}） ↔ {name(card.participants[1].playerId)}（{card.participants[1].side}）</Body1>
      <Body1 className={s.number}>水平距离 {number(card.horizontal)} · 三维距离 {number(card.threeDimensional)} DEM 单位</Body1>
      {card.participants.map(player => <Caption1 key={player.role} className={s.muted}>
        {player.role === 'killer' ? '击杀者' : '被击杀者'} XYZ：{position(player.position)}
      </Caption1>)}
    </div> : <div className={s.rows}>
      <Caption1 className={s.muted}>形成 tick {card.eventTick} · 前一事件或冻结结束采样 tick {card.startTick} · 中间 {card.interiorNotEvaluatedTicks} tick 未评估</Caption1>
      <Body1 className={s.number}>双方水平距离 {number(card.separation.startHorizontal)} → {number(card.separation.formationHorizontal)} DEM 单位</Body1>
      <Body1 className={s.number}>双方三维距离 {number(card.separation.startThreeDimensional)} → {number(card.separation.formationThreeDimensional)} DEM 单位</Body1>
      {card.participants.map(player => <div key={player.side} className={s.rows}>
        <Caption1 className={s.muted}>{name(player.playerId)}（{player.side}）端点位移：水平 {number(player.horizontalDisplacement)}，三维 {number(player.threeDimensionalDisplacement)} DEM 单位</Caption1>
        <Caption1 className={s.muted}>起点 XYZ：{position(player.startPosition)} · 形成时 XYZ：{position(player.endPosition)}</Caption1>
      </div>)}
    </div>}
  </Card>;
}
