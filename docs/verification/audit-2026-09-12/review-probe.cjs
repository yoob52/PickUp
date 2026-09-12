const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
(async()=>{
const out = path.resolve('docs/verification/audit-2026-09-12');
await fs.mkdir(out,{recursive:true});
const data = await fs.mkdtemp(path.join(os.tmpdir(),'pickup-review-'));
const env={...process.env,PICKUP_E2E:'1',PICKUP_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({args:['.'],env});
const results={};
try {
 const page=await app.firstWindow();
 await expect(page.getByText('现在准备做什么？')).toBeVisible();
 await page.screenshot({path:path.join(out,'01-main.png'),fullPage:true});
 results.windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
 results.seed=await page.evaluate(async()=>{
  const api=window.pickup;const id=()=>crypto.randomUUID();
  const good=(r)=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value};
  for(let i=1;i<=101;i++){
   const t=good(await api.createTask({commandId:id(),title:`当天完成-${String(i).padStart(3,'0')}`}));
   good(await api.completeTask({commandId:id(),task:{taskId:t.taskId,expectedVersion:1}}));
  }
  const a=good(await api.createTask({commandId:id(),title:'审查当前任务'}));
  good(await api.startTask({commandId:id(),task:{taskId:a.taskId,expectedVersion:1}}));
  const b=good(await api.createTask({commandId:id(),title:'审查等待任务'}));
  good(await api.markWaiting({commandId:id(),task:{taskId:b.taskId,expectedVersion:1},reason:'等待确认'}));
  const review=good(await api.getDailyReview());
  return {currentId:a.taskId,total:review.completedToday.total,items:review.completedToday.items.length,hasMore:review.completedToday.hasMore,dayKey:review.dayKey};
 });
 await page.getByRole('button',{name:'今日收尾'}).click();
 await expect(page.getByText('当天完成 101',{exact:true})).toBeVisible();
 results.reviewList={rows:await page.locator('#review-completed .endday-item').count(),hint:await page.locator('#review-completed .helper').innerText(),buttons:await page.locator('#review-completed button').count()};
 await page.screenshot({path:path.join(out,'02-review-limit.png'),fullPage:true});
 // Simulate crossing midnight only inside the test processes.
 const nextDay=await app.evaluate(()=>{const n=new Date();n.setHours(24,0,1,0);globalThis.__reviewOriginalNow=Date.now;Date.now=()=>n.getTime();return n.getTime()});
 await page.clock.install({time:new Date(nextDay-2000)});
 await page.clock.fastForward(3000);
 results.midnight={staleLabel:await page.getByText('当天完成 101',{exact:true}).count(),freshQuery:await page.evaluate(async()=>{const r=await window.pickup.getDailyReview();return r.ok?{dayKey:r.value.dayKey,total:r.value.completedToday.total}:r})};
 await page.screenshot({path:path.join(out,'03-review-stale-date.png'),fullPage:true});
 await app.evaluate(()=>{Date.now=globalThis.__reviewOriginalNow;delete globalThis.__reviewOriginalNow});
 await page.getByRole('button',{name:'稍后收尾'}).click();
 await page.getByRole('button',{name:'今日收尾'}).click();
 await page.getByLabel('给当前任务补一句断点（可选）').fill('审核草稿：下一步检查日志');
 await page.locator('#review-unfinished .endday-main').first().click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'今日收尾'}).click();
 results.reviewDraftAfterInspect=await page.getByLabel('给当前任务补一句断点（可选）').inputValue();
 await page.getByRole('button',{name:'稍后收尾'}).click();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(600,540));
 await page.screenshot({path:path.join(out,'04-small-window.png'),fullPage:true});
 results.smallWindow=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,reviewButtonVisible:[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('今日收尾')).some(x=>x.getClientRects().length>0),nextStartButtonVisible:[...document.querySelectorAll('.next-up button')].some(x=>x.getClientRects().length>0)}));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1120,780));
 await page.getByRole('button',{name:'打开设置'}).click();
 await page.screenshot({path:path.join(out,'05-settings.png'),fullPage:true});
 results.settings=await page.getByRole('dialog').innerText();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 // Synthetic long content via the real bridge, then inspect detail layout.
 results.longTitle=await page.evaluate(async(id)=>{const r=await window.pickup.getTaskDetail({taskId:id});if(!r.ok)throw Error(r.message);return window.pickup.updateTask({commandId:crypto.randomUUID(),taskId:id,expectedVersion:r.value.task.version,title:'VeryLongUnbrokenTaskName'.repeat(8),note:'长备注测试。'.repeat(200)})},results.seed.currentId);
 await page.locator('.current-card').getByRole('button',{name:'查看当前任务详情'}).click();
 await expect(page.getByRole('dialog').getByRole('heading',{name:/VeryLong/})).toBeVisible();
 results.longDetail=await page.getByRole('dialog').evaluate(n=>({client:n.clientWidth,scroll:n.scrollWidth,headingWidth:n.querySelector('h2').getBoundingClientRect().width}));
 await page.screenshot({path:path.join(out,'06-long-detail.png'),fullPage:true});
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));
} finally {await app.close();console.log('isolated test data retained:',data);}
})().catch(e=>{console.error(e);process.exitCode=1});
