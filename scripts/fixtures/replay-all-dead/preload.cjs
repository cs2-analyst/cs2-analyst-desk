const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('acceptance',{
  fixture:id=>ipcRenderer.invoke('acceptance:fixture',id),
  close:()=>ipcRenderer.send('acceptance:close'),
});
contextBridge.exposeInMainWorld('cs2Analyst',{replay:{getChunk:request=>ipcRenderer.invoke('acceptance:chunk',request)}});
