// Standalone test Electron, never loaded by the product main process.
const {app,BrowserWindow,ipcMain}=require('electron');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const fixtures=JSON.parse(readFileSync(process.env.P7_ALL_DEAD_FIXTURES,'utf8'));
let selected;
ipcMain.handle('acceptance:fixture',(_event,id)=>{
  selected=fixtures.find(f=>f.id===id);if(!selected)throw new Error('Unknown test fixture');
  return {id:selected.id,metadata:selected.metadata,anchor:selected.anchor};
});
ipcMain.handle('acceptance:chunk',async(_event,request)=>{
  const source=selected;
  if(request.sessionId!==source.metadata.sessionId||request.round!==1)return {kind:'error',message:'Wrong fixture session'};
  await new Promise(ok=>setTimeout(ok,80));
  const chunk=source.chunks.find(c=>c.block===request.block);
  return chunk?{kind:'success',chunk}:{kind:'error',message:'Missing controlled chunk'};
});
ipcMain.on('acceptance:close',()=>app.quit());
app.whenReady().then(()=>{
  const win=new BrowserWindow({width:Number(process.env.P7_WIDTH),height:Number(process.env.P7_HEIGHT),useContentSize:true,frame:false,
    webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true},show:true});
  win.loadFile(process.env.P7_ALL_DEAD_HTML);
});
app.on('window-all-closed',()=>app.quit());
