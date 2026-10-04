import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { PgBoss } from '../../apps/server/node_modules/pg-boss/dist/index.js';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PostgresStore } from '../../apps/server/src/infrastructure/store.js';
import { migrate } from '../../apps/server/src/infrastructure/migrations.js';
import { nowISO, newId, type Entity, type Source, type Item } from '../../packages/core/src/index.js';
import type { Config } from '../../apps/server/src/config.js';
import { runtime } from '../../apps/server/src/runtime.js';
import { Jobs } from '../../apps/server/src/infrastructure/jobs.js';
let embedded:EmbeddedPostgres,store:PostgresStore,boss:PgBoss,connection:string;
beforeAll(async()=>{
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));
  await mkdir(resolve('.data'),{recursive:true});const databaseDir=await mkdtemp(resolve('.data','pg-test-'));
  embedded=new EmbeddedPostgres({databaseDir,user:'feedrelay',password:'test-only-password',port,persistent:true,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await embedded.initialise();await embedded.start();await embedded.createDatabase('feedrelay_test');connection=`postgres://feedrelay:test-only-password@127.0.0.1:${port}/feedrelay_test`;
  store=new PostgresStore(connection);await migrate(store.pool);
},60000);
afterAll(async()=>{await boss?.stop({graceful:true,timeout:5000});await store?.close();await embedded?.stop();},30000);
async function expectLocksFree(keys:string[]){
  const client=await store.pool.connect(),held:string[]=[];
  try{for(const key of keys){const result=await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key]);if(result.rows[0]?.locked)held.push(key);expect(result.rows[0]?.locked).toBe(true);}}
  finally{for(const key of held.reverse())await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);client.release();}
}
describe('real PostgreSQL persistence and queue',()=>{
  it('migration is repeatable and business keys reject duplicates',async()=>{
    await migrate(store.pool);const user={id:newId(),createdAt:nowISO(),telegramId:'555100001',name:'Owner',privateChatStarted:true};await store.transaction(['identity'],tx=>tx.put('users',user));
    await expect(store.transaction(['identity'],tx=>tx.put('users',{...user,id:newId()}))).rejects.toBeDefined();
    expect((await store.read(tx=>tx.list('users',{telegramId:user.telegramId}))).length).toBe(1);
  });
  it('supports numeric sorting before pagination and compound due filters',async()=>{
    const sourceId=newId();await store.transaction(['source:'+sourceId],async tx=>{for(const seq of [12,2,1,110,9])await tx.put<Item>('items',{id:newId(),createdAt:nowISO(),sourceId,seq,title:String(seq),summary:'test',contentHash:'hash'+seq,revision:1,updatedAt:nowISO()});});
    const items=await store.read(tx=>tx.list<Item>('items',{sourceId,seq:{gt:1,lte:12}},{orderBy:'seq',limit:3}));expect(items.map(i=>i.seq)).toEqual([2,9,12]);
  });
  it('parameterizes multi-value IN filters and treats empty lists as no matches',async()=>{
    const testGroup=newId();await store.transaction(['in-filter:'+testGroup],async tx=>{for(const state of ['pending','active','done',null])await tx.put('recovery',{id:newId(),createdAt:nowISO(),testGroup,state});});
    const rows=await store.read(tx=>tx.list<Entity & {state:string}>('recovery',{testGroup,state:{in:['pending','active']}}));expect(rows.map(row=>row.state).sort()).toEqual(['active','pending']);
    expect(await store.read(tx=>tx.list('recovery',{testGroup,state:{in:[]}}))).toEqual([]);
    expect(await store.read(tx=>tx.list('recovery',{testGroup,state:{in:["pending') OR true --"]}}))).toEqual([]);
    expect(await store.read(tx=>tx.list('recovery',{testGroup,state:{in:[null,'active']}}))).toHaveLength(2);
  });
  it('rolls back partial business writes',async()=>{
    const id=newId();await expect(store.transaction(['rollback'],async tx=>{await tx.put('audit',{id,createdAt:nowISO()});throw new Error('rollback');})).rejects.toThrow('rollback');expect(await store.read(tx=>tx.get('audit',id))).toBeUndefined();
  });
  it('serializes concurrent aggregate mutations without lost increments',async()=>{
    const id=newId();await store.transaction(['counter'],tx=>tx.put('recovery',{id,createdAt:nowISO(),value:0}));
    await Promise.all(Array.from({length:8},()=>store.transaction(['counter'],async tx=>{const r=(await tx.get<Entity & {value:number}>('recovery',id))!;r.value++;await tx.put('recovery',r);})));expect((await store.read(tx=>tx.get<Entity & {value:number}>('recovery',id)))?.value).toBe(8);
  });
  it('serializes heavy same-key concurrency across two independent pools without stale snapshots',async()=>{
    const left=new PostgresStore(connection,8),right=new PostgresStore(connection,8),id=newId(),keys=['counter:'+id,'aggregate:'+id];let calls=0;
    try{
      await left.transaction(keys,tx=>tx.put('recovery',{id,createdAt:nowISO(),value:0}));
      await Promise.all(Array.from({length:64},(_,index)=>(index%2?left:right).transaction(index%2?[...keys,keys[0]!]:[...keys].reverse(),async tx=>{
        calls++;const row=(await tx.get<Entity & {value:number}>('recovery',id))!;
        await new Promise(resolve=>setTimeout(resolve,2));row.value++;await tx.put('recovery',row);
      })));
      expect((await store.read(tx=>tx.get<Entity & {value:number}>('recovery',id)))?.value).toBe(64);
      expect(calls).toBe(64);await expectLocksFree(keys);
    }finally{await Promise.all([left.close(),right.close()]);}
  },20000);
  it('rolls back business writes and clears session locks before returning a connection to the pool',async()=>{
    const isolated=new PostgresStore(connection,1),id=newId(),keys=['rollback:a:'+id,'rollback:b:'+id];let calls=0;
    try{
      await expect(isolated.transaction(keys,async tx=>{calls++;await tx.put('audit',{id,createdAt:nowISO()});throw new Error('business_rollback');})).rejects.toThrow('business_rollback');
      expect(calls).toBe(1);expect(await store.read(tx=>tx.get('audit',id))).toBeUndefined();
      const remaining=await isolated.pool.query<{count:string}>("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");expect(remaining.rows[0]?.count).toBe('0');
      await expectLocksFree(keys);
      await isolated.transaction(keys,tx=>tx.put('audit',{id,createdAt:nowISO()}));expect(await store.read(tx=>tx.get('audit',id))).toBeDefined();
    }finally{await isolated.close();}
  });
  it('cleans a partially acquired lock set after a real PostgreSQL lock timeout',async()=>{
    const isolated=new PostgresStore(connection,1),suffix=newId(),first='partial:a:'+suffix,second='partial:b:'+suffix,blocker=await store.pool.connect();let called=false;
    try{
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[second]);await isolated.pool.query("SET lock_timeout='75ms'");
      await expect(isolated.transaction([second,first],async()=>{called=true;})).rejects.toMatchObject({code:'55P03'});
      expect(called).toBe(false);await expectLocksFree([first]);
      const remaining=await isolated.pool.query<{count:string}>("SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");expect(remaining.rows[0]?.count).toBe('0');
    }finally{await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[second]);blocker.release();await isolated.close();}
  });
  it('destroys a connection after unlock failure while preserving its already committed result',async()=>{
    const isolated=new PostgresStore(connection,1),id=newId(),keys=['cleanup:a:'+id,'cleanup:b:'+id],client=await isolated.pool.connect();
    const original=client.query.bind(client),pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;let failedUnlocks=0;
    const fault=vi.spyOn(client,'query').mockImplementation(((...args:unknown[])=>{
      const text=typeof args[0]==='string'?args[0]:(args[0] as {text?:string})?.text;
      if(text?.startsWith('SELECT pg_advisory_unlock(')){failedUnlocks++;return Promise.reject(new Error('injected_unlock_failure'));}
      return (original as (...input:unknown[])=>unknown)(...args);
    }) as typeof client.query);client.release();
    try{
      await expect(isolated.transaction(keys,async tx=>{await tx.put('audit',{id,createdAt:nowISO()});return 'committed';})).resolves.toBe('committed');
      expect(failedUnlocks).toBe(1);expect(await store.read(tx=>tx.get('audit',id))).toBeDefined();fault.mockRestore();
      const replacement=await isolated.pool.query<{pid:number}>('SELECT pg_backend_pid() AS pid');expect(replacement.rows[0]?.pid).not.toBe(pid);await expectLocksFree(keys);
    }finally{fault.mockRestore();await isolated.close();}
  });
  it('destroys a session when an acquisition reply is lost after PostgreSQL grants the lock',async()=>{
    const isolated=new PostgresStore(connection,1),suffix=newId(),keys=['lost:a:'+suffix,'lost:b:'+suffix],client=await isolated.pool.connect();let called=false;
    const original=client.query.bind(client),pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const fault=vi.spyOn(client,'query').mockImplementation((async(...args:unknown[])=>{
      const result=await (original as (...input:unknown[])=>Promise<unknown>)(...args);
      if(typeof args[0]==='string'&&args[0].startsWith('SELECT pg_advisory_lock(')&&(args[1] as string[])[0]===keys[1])throw new Error('lost_acquisition_reply');
      return result;
    }) as typeof client.query);client.release();
    try{
      await expect(isolated.transaction(keys,async()=>{called=true;})).rejects.toThrow('lost_acquisition_reply');expect(called).toBe(false);fault.mockRestore();
      const replacement=await isolated.pool.query<{pid:number}>('SELECT pg_backend_pid() AS pid');expect(replacement.rows[0]?.pid).not.toBe(pid);await expectLocksFree(keys);
    }finally{fault.mockRestore();await isolated.close();}
  });
  it('keeps serialization retries bounded and reads SQLSTATE from wrapped causes',async()=>{
    const isolated=new PostgresStore(connection,1),key='retry:'+newId();let calls=0;
    const failure=()=>new Error('query_wrapper',{cause:new Error('driver_wrapper',{cause:Object.assign(new Error('serialization_failure'),{code:'40001'})})});
    try{
      await expect(isolated.transaction([key],async()=>{if(++calls<3)throw failure();return 'ok';})).resolves.toBe('ok');expect(calls).toBe(3);
      calls=0;await expect(isolated.transaction([key],async()=>{calls++;throw failure();})).rejects.toThrow('query_wrapper');expect(calls).toBe(6);await expectLocksFree([key]);
    }finally{await isolated.close();}
  });
  it('pg-boss dispatches a persisted job and supports singleton keys',async()=>{
    boss=new PgBoss({connectionString:connection,schema:'pgboss',max:3});boss.on('error',()=>{});await boss.start();await boss.createQueue('test-delivery',{policy:'singleton',retryLimit:0});
    let result:string|undefined;await boss.work<{id:string}>('test-delivery',{pollingIntervalSeconds:0.5},async jobs=>{result=jobs[0]?.data.id;});await boss.send('test-delivery',{id:'hello'},{singletonKey:'hello',retryLimit:0});
    const deadline=Date.now()+10000;while(!result&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));expect(result).toBe('hello');
  },15000);
  it('runs the full feed to delivery loop through PostgreSQL and pg-boss',async()=>{
    const config:Config={MODE:'demo',ROLE:'all',NODE_ENV:'test',PORT:4100,HOST:'127.0.0.1',TRUSTED_PROXY_CIDRS:'',PUBLIC_URL:'http://localhost:3000',BOT_ID:'demo-bot',BOT_USERNAME:'TestBot',BILLING_ENABLED:'false',STARTER_STARS:300,SUPPORT_EMAIL:'',TERMS_URL:'',DEMO_DATA_PATH:'unused',LOG_LEVEL:'error',FETCH_CONCURRENCY:2};
    const services=await runtime(config,store);const {actor}=await services.auth.identity('555100002','Queue owner',true);const source=await services.feeds.addSource(actor,'https://demo.feedrelay.invalid/queue.xml');const destination=await services.feeds.privateDestination(actor);const route=await services.feeds.saveRoute(actor,{name:'Integration route',sourceBindingId:source.id,destinationId:destination.id,requestedIntervalMinutes:60});
    const errors:Array<{code:string;error?:unknown}>=[];const jobs=new Jobs(store,services.processor,{...config,MODE:'production',DATABASE_URL:connection},(code,error)=>errors.push({code,error}));
    const wait=async(predicate:()=>Promise<boolean>)=>{const end=Date.now()+15000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Pipeline did not reach expected state: '+JSON.stringify(errors));};
    try{
      await jobs.start();await wait(async()=>((await store.read(tx=>tx.get<Entity & {state:string}>('routes',route.id)))?.state==='active'));
      expect(await services.feeds.listDeliveries(actor)).toHaveLength(0);
      await services.processor.publishDemo();await wait(async()=>(await services.feeds.listDeliveries(actor)).some(d=>d.state==='sent'));
      const deliveries=await services.feeds.listDeliveries(actor);expect(deliveries).toHaveLength(1);expect(deliveries[0]?.messageId).toBeDefined();expect((await services.billing.entitlements(actor.workspaceId)).used).toBe(1);
      expect(errors).toEqual([]);
    }finally{await jobs.stop();}
  },40000);
});
