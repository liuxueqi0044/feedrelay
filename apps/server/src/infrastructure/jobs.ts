import { PgBoss } from 'pg-boss';
import { nowISO, type Delivery, type Outbox, type Route, type Source, type SourceBinding, type Store, type Workspace } from '@feedrelay/core';
import { Processor, type Inbox } from '../services/processor.js';
import type { Config } from '../config.js';
type WorkType='fetch'|'release'|'deliver'|'inbox'|'billing';
export interface JobErrorDetails { name:string;code?:string;message:string }
const errorDetails=(error:unknown):JobErrorDetails=>{let value=error as {name?:string;code?:string;message?:string;cause?:unknown};for(let depth=0;depth<5&&value?.cause&&typeof value.cause==='object';depth++)value=value.cause as typeof value;return {name:value?.name??'Error',code:value?.code,message:(value?.message??'Unknown queue failure').slice(0,1024)};};
export class Jobs {
  private boss?:PgBoss;private timer?:ReturnType<typeof setInterval>;private running=false;private stopping=false;private tasks=new Set<Promise<unknown>>();
  private maintenanceAt=0;
  constructor(readonly store:Store,readonly processor:Processor,readonly config:Config,readonly log:(code:string,error?:JobErrorDetails)=>void=()=>{}){}
  async start(){
    if(this.config.MODE==='production'){
      this.boss=new PgBoss({connectionString:this.config.DATABASE_URL!,schema:'pgboss',max:5,application_name:'feedrelay-'+this.config.ROLE});this.boss.on('error',error=>this.log('queue_error',errorDetails(error)));await this.boss.start();
      for(const name of ['fetch','release','deliver','inbox','billing'])await this.boss.createQueue(name,{policy:'singleton',retryLimit:0,expireInSeconds:name==='fetch'?240:120,retentionSeconds:86400});
      const role=this.config.ROLE;const types:WorkType[]=role==='all'?['fetch','release','deliver','inbox','billing']:role==='fetch-worker'?['fetch']:role==='delivery-worker'?['deliver']:role==='control-worker'?['release','inbox','billing']:[];
      for(const type of types)await this.boss.work<{id:string}>(type,{localConcurrency:type==='fetch'?this.config.FETCH_CONCURRENCY:type==='deliver'?8:2,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await this.run(type,job.data.id);});
    }
    if(this.config.MODE==='demo'||this.config.ROLE==='all'||this.config.ROLE==='control-worker'){await this.tick();this.timer=setInterval(()=>{void this.tick();},1000);}
  }
  private async run(type:WorkType,id:string){if(this.stopping)return;const operation=type==='fetch'?this.processor.fetchSource(id):type==='release'?this.processor.releaseRoute(id):type==='deliver'?this.processor.deliver(id):type==='inbox'?this.processor.processInbox(id):this.processor.reconcile();this.tasks.add(operation);try{await operation;}finally{this.tasks.delete(operation);}}
  private async schedule(type:WorkType,id:string){if(this.boss){await this.boss.send(type,{id},{singletonKey:id,retryLimit:0});}else await this.run(type,id);}
  async tick(){if(this.running||this.stopping)return;this.running=true;try{
    const snapshot=await this.store.read(async tx=>({
      sources:await tx.list<Source>('sources',{nextPollAt:{lte:nowISO()}},{limit:100,orderBy:'nextPollAt'}),
      routes:await tx.list<Route>('routes',{state:{in:['active','initializing']},nextReleaseAt:{lte:nowISO()}},{limit:100,orderBy:'nextReleaseAt'}),
      deliveries:await tx.list<Delivery>('deliveries',{state:{in:['pending','retry_wait','unknown','quota_deferred']},nextAttemptAt:{lte:nowISO()}},{limit:100,orderBy:'nextAttemptAt'}),
      inbox:await tx.list<Inbox>('inbox',{state:'pending',nextAttemptAt:{lte:nowISO()}},{limit:50,orderBy:'createdAt'}),
      outbox:await tx.list<Outbox>('outbox',{state:'pending'},{limit:200,orderBy:'createdAt'})
    }));
    for(const s of snapshot.sources){const active=await this.store.read(async tx=>{const bindings=await tx.list<SourceBinding>('sourceBindings',{sourceId:s.id,state:'active'});for(const b of bindings){const w=await tx.get<Workspace>('workspaces',b.workspaceId);if(w?.state==='active'&&(!s.checkedAt||(await tx.list('routes',{workspaceId:b.workspaceId,sourceId:s.id,state:{in:['active','initializing']}},{limit:1})).length))return true;}return false;});if(active)await this.schedule('fetch',s.id);}
    for(const r of snapshot.routes)await this.schedule('release',r.id);
    for(const d of snapshot.deliveries)await this.schedule('deliver',d.id);
    for(const inbox of snapshot.inbox)await this.schedule('inbox',inbox.id);
    for(const event of snapshot.outbox){await this.schedule(event.type,event.aggregateId);await this.store.transaction(['outbox:'+event.id],async tx=>{const current=await tx.get<Outbox>('outbox',event.id);if(current?.state==='pending'){current.state='dispatched';current.dispatchedAt=nowISO();await tx.put('outbox',current);}});}
    if(Date.now()-this.maintenanceAt>30000){this.maintenanceAt=Date.now();await this.processor.maintain();if(this.boss)await this.schedule('billing','reconcile');}
  }catch(error){this.log('scheduler_tick_failed',errorDetails(error));}finally{this.running=false;}}
  async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);while(this.running)await new Promise(r=>setTimeout(r,50));if(this.boss)await this.boss.stop({graceful:true,timeout:30000});await Promise.allSettled([...this.tasks]);}
}
