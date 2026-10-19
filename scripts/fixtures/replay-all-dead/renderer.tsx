// Test-only entry. Imports the real component, styles, map assets and effect renderer.
// It is neither an electron-vite entry nor inside the installer's dist/** whitelist.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider, Button } from '@fluentui/react-components';
import { ReplayPlayer } from '../../../apps/desktop/renderer/src/replay-player';
import { coachTheme } from '../../../apps/desktop/renderer/src/theme';

declare const window: Window & { acceptance: any; mountControlledReplay: any };
function Harness() {
  const [fixture,setFixture]=useState<any>(null);
  const sequence=useRef(0);
  window.mountControlledReplay=async(id:string)=>setFixture({...await window.acceptance.fixture(id),key:++sequence.current});
  return <FluentProvider theme={coachTheme} style={{height:'100vh',display:'flex',flexDirection:'column',padding:12,boxSizing:'border-box',gap:8}}>
    <div style={{display:'flex',justifyContent:'space-between',flexShrink:0}}>
      <span>测试专用受控 DTO · 非真实 DEM 全员阵亡证据 · {fixture?.id}</span>
      <Button size="small" onClick={()=>window.acceptance.close()}>关闭验收</Button>
    </div>
    {fixture?<ReplayPlayer key={fixture.key} metadata={fixture.metadata} fileName="controlled-test-only.dto" initialPlayerId={fixture.anchor} active jump={null}/>:<span>等待受控夹具</span>}
  </FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
