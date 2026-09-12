const {_electron,expect}=require('@playwright/test');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
(async()=>{const out=path.resolve('docs/verification/audit-2026-09-12');const data=await fs.mkdtemp(path.join(os.tmpdir(),'pickup-review-extra-'));const env={...process.env,PICKUP_E2E:'1',PICKUP_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;let app=await _electron.launch({args:['.'],env});const r={};
try{let p=await app.firstWindow();await expect(p.getByText('现在准备做什么？')).toBeVisible();
const id=await p.evaluate(async()=>{const r=await window.pickup.createTask({commandId:crypto.randomUUID(),title:'键盘验收事项'});if(!r.ok)throw Error(r.message);return r.value.taskId});
const start=p.getByRole('button',{name:'开始或继续'});await start.focus();await start.press('Enter');
r.keyboardStart={dialogCount:await p.getByRole('dialog').count(),state:await p.evaluate(async()=>{const r=await window.pickup.getWorkspaceSnapshot();return r.ok?r.value.currentTask?.title??null:r})};
if(await p.getByRole('dialog').count())await p.getByRole('button',{name:'关闭',exact:true}).click();
await p.locator('.task-row').getByRole('button',{name:'打开详情'}).click();await expect(p.getByRole('button',{name:'标记等待',exact:true})).toBeVisible();
r.detailButton=await p.getByRole('button',{name:'标记等待',exact:true}).evaluate(n=>({color:getComputedStyle(n).color,background:getComputedStyle(n).backgroundColor,parent:getComputedStyle(n.parentElement.parentElement).backgroundColor,disabled:n.disabled}));
await p.screenshot({path:path.join(out,'07-detail-contrast.png'),fullPage:true});
await p.getByRole('button',{name:'关闭',exact:true}).click();
await p.getByRole('button',{name:'记一件事'}).first().click();const field=p.getByLabel('标题',{exact:true});await expect(field).toBeFocused();
// Close the native window within the 300ms draft debounce interval.
await field.fill('关闭窗口前的未提交草稿');const t=Date.now();const exiting=new Promise(resolve=>app.process().once('exit',resolve));await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close()).catch(e=>{if(!String(e).includes('closed'))throw e});await exiting;r.nativeCloseElapsedMs=Date.now()-t;
app=await _electron.launch({args:['.'],env});p=await app.firstWindow();await expect(p.getByRole('button',{name:'记一件事'}).first()).toBeVisible();r.draftAfterNativeClose=await p.evaluate(()=>window.pickup.getDraft());
await fs.writeFile(path.join(out,'extra-results.json'),JSON.stringify(r,null,2));console.log(JSON.stringify(r,null,2));
}finally{await app.close();console.log('isolated test data retained:',data)}
})().catch(e=>{console.error(e);process.exitCode=1});
