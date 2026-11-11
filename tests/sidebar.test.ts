import { it,expect } from 'vitest';
import { chromium } from 'playwright';
import { installSidebarListener } from '../packages/qwen-adapter/src/sidebar.ts';
it('recovers from a partially installed listener after reload or interrupted setup',async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent('<div data-chat-id="ours" data-status="loading"></div>');await page.evaluate(()=>{(window as any).__qwenTestSidebarInstalled=true;});const events:any[]=[];await installSidebarListener(page,e=>events.push(e));await page.evaluate(()=>(window as any).__qwenTestWatch('ours'));await expect.poll(()=>events.length).toBe(1);}finally{await browser.close();}
});
it('listens only to tracked sidebar task states without treating idle as success',async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent('<div data-chat-id="ours" data-status="loading"></div><div data-chat-id="other" data-status="loading"></div>');const events:any[]=[];await installSidebarListener(page,e=>events.push(e));await page.evaluate(()=>{(window as any).__qwenTestWatch('ours');document.querySelector('[data-chat-id="ours"]')!.setAttribute('data-status','pending_interaction');document.querySelector('[data-chat-id="other"]')!.setAttribute('data-status','idle');});await expect.poll(()=>events.length).toBeGreaterThan(0);expect(events.every(e=>e.taskId==='ours')).toBe(true);expect(events.at(-1).status).toBe('pending_interaction');}finally{await browser.close();}
});
