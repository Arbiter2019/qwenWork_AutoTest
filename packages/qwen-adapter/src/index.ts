import { chromium, type Browser, type Page } from 'playwright';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AdapterHealth, AppAdapter, AppEvent, SampleInput, TaskQuestion, TaskRef, TaskSnapshot } from '../../core/src/types.ts';
import { json, snapshotFromMessages, inputMatches, redactEvent, type MessageRow } from './projection.ts';
import { installSidebarListener, type SidebarState } from './sidebar.ts';

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export class QwenAdapter implements AppAdapter {
 private browser?:Browser;private db?:Database.Database;private page?:Page;private queue:Promise<unknown>=Promise.resolve();
 private sidebar=new Map<string,SidebarState[]>();
 private interactionIds=new Map<string,{signature:string;id:string}>();
 private listeners=new Set<()=>void>();
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 readonly endpoint:string;readonly dbPath:string;
 constructor(options:{endpoint?:string;dbPath?:string}={}){
  this.endpoint=options.endpoint??'http://127.0.0.1:9229';
  const url=new URL(this.endpoint);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('App 调试连接仅允许本机回环地址');
  this.dbPath=options.dbPath??(process.platform==='darwin'?join(homedir(),'Library/Application Support/QwenWorkCN/data/agents.db'):join(process.env.APPDATA??join(homedir(),'AppData/Roaming'),'QwenWorkCN/data/agents.db'));
 }
 private async connect(){
  if(!existsSync(this.dbPath))throw new Error('未找到千问办公数据库，请配置 QWEN_APP_DB');
  this.db??=new Database(this.dbPath,{readonly:true,fileMustExist:true,timeout:3000});
  if(!this.browser?.isConnected()){
   this.browser=await chromium.connectOverCDP(this.endpoint,{timeout:4000});
   this.page=this.browser.contexts().flatMap(c=>c.pages()).find(p=>/app\.asar\/out\/renderer\/index\.html/.test(p.url()));
   if(!this.page)throw new Error('未找到千问办公主窗口');
   this.page.setDefaultTimeout(5000);
   await installSidebarListener(this.page,event=>{const list=this.sidebar.get(event.taskId)??[];list.push(event);this.sidebar.set(event.taskId,list.slice(-500));for(const listener of this.listeners)listener();});
  }
  return this.page!;
 }
 private async locked<T>(action:()=>Promise<T>):Promise<T>{const next=this.queue.then(action,action);this.queue=next.catch(()=>{});return next;}
 async health():Promise<AdapterHealth>{try{await this.connect();this.db!.prepare('select id from agent_turn_inputs limit 0').all();return {connected:true,mode:'real',version:'2.0.1（适配基线）',message:'已连接真实 App；任务状态监听与消息记录辅助采集',capabilities:{cdp:true,submit:true,models:true,expertKit:true,backgroundConcurrency:true,terminalStatus:true,eventProjection:true,sidebarListener:true,fullEventStream:false}};}catch(e){return {connected:false,mode:'real',message:String(e instanceof Error?e.message:e)};}}
 private kit(id:string){
  for(const dir of ['plugins','plugins-custom']){const root=join(homedir(),'.qwenworkcn',dir);if(!existsSync(root))continue;for(const folder of readdirSync(root)){const file=join(root,folder,'.qoder-plugin/plugin.json');if(!existsSync(file))continue;const p=json(readFileSync(file,'utf8'));if(p.name===id||p.id===id||folder===id)return {id,name:String(p.displayName??p.name)};}}
  throw new Error(`专家套件ID不可用：${id}；请使用 App 已安装套件的插件标识`);
 }
 async preflight(inputs:SampleInput[]){for(const id of new Set(inputs.map(i=>i.expertKitId).filter(Boolean)))this.kit(id);}
 async submit(input:SampleInput,_attemptId:string):Promise<TaskRef>{return this.locked(async()=>{
  const p=await this.connect();const kit=input.expertKitId?this.kit(input.expertKitId):undefined;
  await p.keyboard.press('Escape');await p.locator('button[aria-label="新任务"]').click();
  await p.getByRole('button',{name:'此电脑',exact:true}).waitFor();
  const model=p.getByRole('button',{name:/^(标准|高级)$/});await model.waitFor();
  if((await model.innerText()).trim()!==input.model){await model.click();await p.getByRole('menuitem').filter({hasText:new RegExp('^\s*'+input.model)}).first().click();}
  const editor=p.locator('[contenteditable="true"][role="textbox"]');await editor.fill(input.prompt);
  if(kit){await editor.fill('');await p.getByRole('button',{name:'添加文件、技能、插件等',exact:true}).click();await p.getByRole('menuitem',{name:'专家套件',exact:true}).click();const item=p.getByRole('menu').last().getByRole('menuitem').filter({hasText:kit.name});if(await item.count()!==1)throw new Error('专家套件未在 App 可用菜单中唯一匹配：'+kit.name);await item.click();const token=editor.locator('[data-mention-type="plugin"]');if(!(await token.getAttribute('data-mention-id'))?.startsWith('plugin:'+kit.id+':'))throw new Error('套件引用ID与 CSV 不一致');await editor.press('End');await p.keyboard.insertText(input.prompt);}
  const actual=(await editor.innerText()).trim();if(!actual.includes(input.prompt.trim()))throw new Error('App 编辑器输入校验失败');
  const before=new Set((this.db!.prepare('select id from agent_turn_inputs where created_at >= ?').all(Math.floor(Date.now()/1000)-60) as any[]).map(x=>x.id));const started=Math.floor(Date.now()/1000)-2;
  await p.getByRole('button',{name:'发送消息',exact:true}).click();
  for(let i=0;i<100;i++){
   const rows=this.db!.prepare('select id,chat_id,sub_chat_id,message_id,content,prompt_preview from agent_turn_inputs where created_at >= ? order by created_at desc').all(started) as any[];
   const candidates=rows.filter(r=>!before.has(r.id)&&inputMatches(r,input.prompt,(this.db!.prepare("select parts from messages where sub_chat_id=? and role='user'").all(r.sub_chat_id) as any[]).flatMap(m=>json(m.parts,[]))));
   if(candidates.length>1)throw new Error('出现多个相同输入的新任务，需人工核对提交归属');
   if(candidates.length===1){const r=candidates[0],sub=this.db!.prepare('select session_id from sub_chats where id=?').get(r.sub_chat_id) as any;await p.evaluate(id=>(window as any).__qwenTestWatch(id),r.chat_id);return {taskId:r.chat_id,chatId:r.chat_id,subChatId:r.sub_chat_id,sessionId:sub?.session_id,inputId:r.id,messageId:r.message_id};}
   await delay(100);
  }
  throw new Error('发送后未取得唯一 App 任务ID，请人工核对，禁止自动重复提交');
 });}
 async inspect(ref:TaskRef):Promise<TaskSnapshot>{
  await this.connect();if(!ref.subChatId||!ref.inputId)return {status:'unknown',error:'缺少 App 任务关联'};
  const input=this.db!.prepare('select * from agent_turn_inputs where id=? and chat_id=? and sub_chat_id=?').get(ref.inputId,ref.chatId??ref.taskId,ref.subChatId) as any;
  if(!input)return {status:'unknown',error:'关联输入已不存在'};
  const sub=this.db!.prepare('select model_level,session_id from sub_chats where id=?').get(ref.subChatId) as any;
  if(!sub)return {status:'unknown',error:'关联会话已不存在'};
  const rows=this.db!.prepare('select id,role,parts,metadata,created_at,updated_at from messages where sub_chat_id=? order by sequence').all(ref.subChatId) as MessageRow[];
  const snap=snapshotFromMessages(rows,sub.model_level);
  await this.page!.evaluate(id=>(window as any).__qwenTestWatch?.(id),ref.chatId??ref.taskId);
  for(const e of this.sidebar.get(ref.chatId??ref.taskId)??[])snap.events!.push({id:`${e.at}:${e.sequence}`,source:'sidebar-listener',type:'sidebar_status',at:e.at,payload:{taskId:e.taskId,status:e.status}});
  if(input.error_code){snap.status='failed';snap.error=input.error_message??input.error_code;snap.errorCode=/rate|429/.test(input.error_code)?'rate_limit':input.error_code;}
  // Read only the exact session created by this platform; unknown binary payloads remain metadata.
  if(sub.session_id){ref.sessionId=sub.session_id;const events=this.db!.prepare('select id,event_id,seq,payload,occurred_at from session_event_log where session_id=? order by seq').all(sub.session_id) as any[];for(const e of events){const buffer=Buffer.from(e.payload);let payload:unknown;try{payload=redactEvent(JSON.parse(buffer.toString('utf8')));}catch{payload={encoding:'opaque',bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')};}snap.events!.push({id:e.event_id??e.id,type:'session_event',source:'session_event_log',at:e.occurred_at,payload});}}
  if(snap.status==='running'){
   const state=await this.page!.locator(`[data-chat-id="${ref.chatId??ref.taskId}"]`).first().getAttribute('data-status').catch(()=>null);
   if(/pending_interaction|permission|approval|ask|question|input|confirm/.test(state??'')){
    snap.status='waiting_human';snap.question=await this.locked(async()=>{const p=await this.connect();await this.focusPage(p,ref);return await this.readQuestion(p,ref);});
   }else this.interactionIds.delete(ref.taskId);
  }
  return snap;
 }
 async focus(ref:TaskRef){await this.locked(async()=>{const p=await this.connect();await this.focusPage(p,ref);});}
 private async focusPage(p:Page,ref:TaskRef){const row=p.locator(`[data-chat-id="${ref.chatId??ref.taskId}"]`).first();await row.locator('button[data-slot="list-action"]').click();await p.waitForTimeout(150);}
 private async readQuestion(p:Page,ref:TaskRef):Promise<TaskQuestion>{
  const section=p.locator('[data-slot="session-question"]');
  if(await section.count()!==1)return {id:'permission:'+ref.inputId,kind:'permission',questions:[{text:'请在 App 中处理权限确认或无法识别的追问',options:[]}]};
  const panel=section.locator('[data-slot="session-question-panel"][data-state="current"]');
  const text=await panel.locator('legend').innerText().catch(async()=>await panel.innerText());
  const options=await panel.locator('[data-slot="session-question-option-label"]').allTextContents();
  const panelIdentity=await panel.evaluate(e=>{const w=window as any;w.__qwenQuestionNodes??=new WeakMap();let id=w.__qwenQuestionNodes.get(e);if(!id){id=crypto.randomUUID();w.__qwenQuestionNodes.set(e,id);}return id;});
  const signature=panelIdentity+':'+text+':'+JSON.stringify(options);let entry=this.interactionIds.get(ref.taskId);
  if(entry?.signature!==signature){entry={signature,id:createHash('sha256').update(ref.inputId+':'+signature).digest('hex').slice(0,20)};this.interactionIds.set(ref.taskId,entry);}
  const identity=entry!.id;
  return {id:identity,kind:options.length?'choice':'text',questions:[{text,options}]};
 }
 async answer(ref:TaskRef,q:TaskQuestion,indices:number[][]){await this.locked(async()=>{
  const p=await this.connect();await this.focusPage(p,ref);if(q.kind!=='choice')throw new Error('该追问需要人工处理');
  const section=p.locator('[data-slot="session-question"]');
  if(await section.count()===1){
   const current=await this.readQuestion(p,ref);if(current.id!==q.id)throw new Error('追问已变化，重新核对后回答');
   const option=section.locator('[data-slot="session-question-panel"][data-state="current"] [data-slot="session-question-option"]').nth(indices[0]?.[0]??0);await option.click();
   const send=section.getByRole('button',{name:'提交',exact:true});if(await send.isEnabled()){await send.click();return;}
   const next=section.getByRole('button',{name:/下一/});if(await next.count()===1){await next.click();return;}
   throw new Error('当前题已选择但无法确认提交入口，请人工处理');
  }
  throw new Error('未找到任务追问面板，请人工处理');
 });}
 async stop(ref:TaskRef):Promise<boolean>{
  const initial=await this.inspect(ref);if(['succeeded','failed','stopped'].includes(initial.status))return true;
  const clicked=await this.locked(async()=>{const p=await this.connect();await this.focusPage(p,ref);const stop=p.locator('button[aria-label="停止生成"]');if(await stop.count()!==1)return false;await stop.evaluate((e:HTMLButtonElement)=>e.click());return true;});
  if(!clicked)return false;
  for(let i=0;i<50;i++){if(['succeeded','failed','stopped'].includes((await this.inspect(ref)).status))return true;await delay(200);}return false;
 }
 async close(){this.db?.close();await this.browser?.close();}
}
