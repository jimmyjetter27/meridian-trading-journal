import { app } from 'electron';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
const output = resolve('artifacts');
mkdirSync(output, { recursive: true });
mkdirSync(resolve('artifacts/smoke-profile'), { recursive: true });
app.setPath('userData', mkdtempSync(resolve('artifacts/smoke-profile/run-')));
const timeout = setTimeout(() => {
  console.error('Smoke timed out');
  app.exit(1);
}, 30000);
app.on('browser-window-created', (_event, win) => {
  win.hide();
  win.webContents.on('did-finish-load', async () => {
    try {
      const state = await win.webContents.executeJavaScript(
        `(async()=>{const wait=()=>new Promise(r=>setTimeout(r,100));for(let i=0;i<50&&!document.querySelector('h1');i++)await wait();if(!document.body.textContent.includes('Performance overview'))throw Error('Dashboard did not mount');if(!document.body.textContent.includes('RISK DISCLAIMER'))throw Error('Missing risk banner');const read=await window.journal.call('journal:read',{});if(!read.ok)throw Error(read.error);const id=await window.journal.call('accounts:add',{broker_name:'Exness',account_type:'Demo',base_currency:'USD',display_name:'Smoke account',starting_balance:10000,login_id:'123',server_name:'Demo'});if(!id.ok)throw Error(id.error);const select=await window.journal.call('accounts:select',id.data);if(!select.ok)throw Error(select.error);const map=await window.journal.call('mappings:save',{broker_name:'Exness',standard_symbol:'XAUUSD',broker_symbol:'XAUUSDm'});if(!map.ok)throw Error(map.error);const imported=await window.journal.call('csv:import',{account_id:id.data,text:'Ticket,Symbol,Type,Volume,Open Price,Close Price,Open Time,Close Time,Profit\\nsmoke-${Date.now()},XAUUSDm,buy,0.1,2000,2010,2026.09.01 10:00:00,2026.09.01 11:00:00,100'});if(!imported.ok||imported.data.inserted!==1)throw Error('IPC import failed');const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('All assets'));button.click();await wait();await wait();return {title:document.title,tradeCount:(await window.journal.call('journal:read',{})).data.trades.length,disclaimer:true,ipc:true};})()`,
      );
      writeFileSync(
        resolve(output, 'dashboard.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      writeFileSync(resolve(output, 'smoke.json'), JSON.stringify(state, null, 2));
      console.log('Electron smoke passed', state);
      clearTimeout(timeout);
      app.quit();
    } catch (e) {
      console.error(e);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
await import('../electron/main.js');
