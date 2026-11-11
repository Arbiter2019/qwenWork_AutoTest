import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
test('真实服务模板可下载再导入，三种报告可独立下载',async({page,request})=>{
 await page.goto(process.env.UI_URL??'http://127.0.0.1:4317');
 const pending=page.waitForEvent('download');await page.getByRole('link',{name:'下载 CSV 模板'}).click();const download=await pending;const path=await download.path();expect(path).toBeTruthy();const csv=await readFile(path!,'utf8');expect(csv).toContain('ID,Prompt,专家套件ID,模型类型');const parsed=await request.post('/api/import',{data:{csv}});expect((await parsed.json()).samples).toHaveLength(2);
 const {runs}=await (await request.get('/api/runs')).json();const run=runs.find((r:any)=>r.status==='completed');test.skip(!run,'需要至少一条已完成运行');
 await page.getByRole('menuitem',{name:'测试记录'}).click();await page.getByRole('row').filter({hasText:run.name}).getByRole('button',{name:'查看报告'}).click();
 for(const [format,name]of [['csv','CSV 明细'],['json','JSON 事件'],['html','HTML 报告']]){const ready=page.waitForEvent('download');await page.getByRole('link',{name}).click();const d=await ready;expect(d.suggestedFilename()).toContain('.'+format);const text=await readFile((await d.path())!,'utf8');expect(text).toContain(run.id===undefined?'千问':format==='html'?'千问办公测试报告':run.id);if(format==='json')expect(JSON.parse(text).metrics.total).toBe(run.samples.length);}
});
