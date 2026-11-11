import type { Page } from 'playwright';
export interface SidebarState {taskId:string;status:string;at:string;sequence:number}
export async function installSidebarListener(page:Page,receive:(event:SidebarState)=>void){
 await page.exposeBinding('__qwenTestSidebarEvent',(_source,event:SidebarState)=>receive(event)).catch(e=>{if(!String(e).includes('already registered'))throw e;});
 const script=`(()=>{
  const w=window;if(w.__qwenTestSidebarInstalled&&typeof w.__qwenTestWatch==='function')return;w.__qwenTestSidebarInstalled=true;
  const tracked=new Set(),last=new Map();let sequence=0;
  const emit=(row)=>{const id=row.getAttribute('data-chat-id'),status=row.getAttribute('data-status');if(!id||!status||!tracked.has(id)||last.get(id)===status)return;last.set(id,status);void w.__qwenTestSidebarEvent({taskId:id,status,at:new Date().toISOString(),sequence:++sequence});};
  w.__qwenTestWatch=(id)=>{tracked.add(id);for(const row of document.querySelectorAll('[data-chat-id]'))if(row.getAttribute('data-chat-id')===id)emit(row);};
  new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')emit(record.target);else for(const node of record.addedNodes)if(node instanceof Element){if(node.matches('[data-chat-id]'))emit(node);node.querySelectorAll('[data-chat-id]').forEach(emit);}}}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-status']});
 })();`;
 await page.addInitScript({content:script});await page.evaluate(script);
}
