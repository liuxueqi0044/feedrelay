import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, jsonb, timestamp as pgTimestamp } from 'drizzle-orm/pg-core';
import { and, eq, sql, asc, desc } from 'drizzle-orm';
import { tables, type Table, type Tx, type Store, type Filter, type Entity, type ListOptions } from '@feedrelay/core';

export const sqlNames = Object.fromEntries(tables.map(t => [t,`fr_${t.replace(/[A-Z]/g,m=>'_'+m.toLowerCase())}`])) as Record<Table,string>;
const schema = Object.fromEntries(tables.map(t => [t,pgTable(sqlNames[t],{
  id: text('id').primaryKey(), workspaceId: text('workspace_id'), createdAt: pgTimestamp('created_at',{withTimezone:true,mode:'string'}).notNull(), data: jsonb('data').$type<Entity>().notNull()
})]));
function compare(a: unknown,b: unknown) { return a! < b! ? -1 : a! > b! ? 1 : 0; }
function matches(row: Entity, filter: Filter) {
  const values = row as unknown as Record<string,unknown>;
  return Object.entries(filter).every(([field,rule]) => {
    const value=values[field];
    if(rule === null || typeof rule !== 'object') return value===rule;
    return (rule.lt===undefined || compare(value,rule.lt)<0) && (rule.lte===undefined || compare(value,rule.lte)<=0) && (rule.gt===undefined || compare(value,rule.gt)>0) && (rule.gte===undefined || compare(value,rule.gte)>=0) && (!rule.in || rule.in.includes(value as never)) && (rule.ne===undefined || value!==rule.ne);
  });
}
function sqlState(error:unknown):string|undefined {
  let value=error as {code?:string;cause?:unknown}|undefined;
  for(let depth=0;depth<6&&value;depth++){
    if(typeof value.code==='string')return value.code;
    value=value.cause&&typeof value.cause==='object'?value.cause as typeof value:undefined;
  }
  return undefined;
}
export class MemoryStore implements Store {
  private records: Record<Table,Map<string,Entity>>;
  private tail: Promise<void> = Promise.resolve();
  constructor(private file?: string) { this.records=Object.fromEntries(tables.map(t=>[t,new Map()])) as Record<Table,Map<string,Entity>>; }
  async load() { if(!this.file)return; try { const parsed=JSON.parse(await readFile(this.file,'utf8')); for(const t of tables) this.records[t]=new Map((parsed[t]??[]).map((r:Entity)=>[r.id,r])); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e; } }
  private tx(records: Record<Table,Map<string,Entity>>): Tx { return {
    get: async <T extends Entity>(table:Table,id:string)=>structuredClone(records[table].get(id)) as T|undefined,
    list: async <T extends Entity>(table:Table,filter:Filter={},options:ListOptions={})=>{
      let rows=[...records[table].values()].filter(r=>matches(r,filter));
      if(options.orderBy) rows.sort((a,b)=>compare((a as unknown as Record<string,unknown>)[options.orderBy!],(b as unknown as Record<string,unknown>)[options.orderBy!])*(options.direction==='desc'?-1:1));
      return structuredClone(rows.slice(0,options.limit??10000)) as T[];
    },
    put:async <T extends Entity>(table:Table,row:T)=>{ records[table].set(row.id,structuredClone(row)); },
    remove:async(table,id)=>{records[table].delete(id);}
  }; }
  async transaction<T>(_keys:string[],callback:(tx:Tx)=>Promise<T>):Promise<T> {
    let release!:()=>void;const previous=this.tail;this.tail=new Promise<void>(r=>{release=r;});await previous;
    try {
      const draft=structuredClone(this.records);const result=await callback(this.tx(draft));
      if(this.file) { await mkdir(dirname(this.file),{recursive:true});await writeFile(this.file+'.tmp',JSON.stringify(Object.fromEntries(tables.map(t=>[t,[...draft[t].values()]]))),'utf8');await rename(this.file+'.tmp',this.file); }
      this.records=draft;return result;
    } finally{release();}
  }
  async read<T>(callback:(tx:Tx)=>Promise<T>){await this.tail;return callback(this.tx(structuredClone(this.records)));}
  async close(){await this.tail;}
}

export class PostgresStore implements Store {
  readonly pool: Pool;
  private db;
  constructor(connectionString:string,max=10){this.pool=new Pool({connectionString,max,connectionTimeoutMillis:10000});this.db=drizzle(this.pool);}
  private tx(db: Pick<typeof this.db,'select'|'insert'|'delete'>):Tx {
    return {
      get:async <T extends Entity>(table:Table,id:string)=>{const s=schema[table]!;const rows=await db.select({data:s.data}).from(s).where(eq(s.id,id)).limit(1);return rows[0]?.data as T|undefined;},
      list:async <T extends Entity>(table:Table,filter:Filter={},options:ListOptions={})=>{
        const s=schema[table]!;
        const field=(name:string,numeric=false)=>{if(!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name))throw new Error('Invalid field');const q=sql`(${s.data}->>${name})`;return numeric?sql`(${q})::numeric`:q;};
        const conditions=Object.entries(filter).flatMap(([key,value])=>{
          if(value===null)return [sql`${s.data} @> ${JSON.stringify({[key]:null})}::jsonb`];
          if(typeof value!=='object')return [sql`${s.data} @> ${JSON.stringify({[key]:value})}::jsonb`];
          return Object.entries(value).map(([op,v])=>{
            if(op==='in'){
              const values=v as Array<string|number|boolean|null>,nonNull=values.filter(value=>value!==null),matches=[];
              // Drizzle expands arrays inside sql templates; bind every scalar instead.
              if(nonNull.length)matches.push(sql`${field(key)} IN (${sql.join(nonNull.map(value=>sql`${String(value)}`),sql`, `)})`);
              if(values.includes(null))matches.push(sql`${s.data} @> ${JSON.stringify({[key]:null})}::jsonb`);
              return matches.length?sql`(${sql.join(matches,sql` OR `)})`:sql`false`;
            }
            const f=field(key,typeof v==='number');
            const ops: Record<string,string>={lt:'<',lte:'<=',gt:'>',gte:'>=',ne:'<>'};
            if(!ops[op])throw new Error('Invalid comparison');return sql`${f} ${sql.raw(ops[op]!)} ${String(v)}`;
          });
        });
        const order=options.orderBy ? (options.direction==='desc'?desc(field(options.orderBy,['seq','enqueueSeq','attemptCount','version','requestId'].includes(options.orderBy))):asc(field(options.orderBy,['seq','enqueueSeq','attemptCount','version','requestId'].includes(options.orderBy)))) : asc(s.id);
        const rows=await db.select({data:s.data}).from(s).where(and(...conditions)).orderBy(order).limit(Math.min(options.limit??10000,10000));return rows.map(r=>r.data as T);
      },
      put:async <T extends Entity>(table:Table,row:T)=>{const s=schema[table]!;await db.insert(s).values({id:row.id,workspaceId:row.workspaceId??null,createdAt:row.createdAt,data:row}).onConflictDoUpdate({target:s.id,set:{workspaceId:row.workspaceId??null,data:row}});},
      remove:async(table,id)=>{const s=schema[table]!;await db.delete(s).where(eq(s.id,id));}
    };
  }
  async transaction<T>(keys:string[],callback:(tx:Tx)=>Promise<T>):Promise<T>{
    const lockKeys=[...new Set(keys)].sort();
    for(let attempt=0;;attempt++){
      const client=await this.pool.connect(),acquired:string[]=[];
      let failure:unknown,destroy=false,locksReady=false;
      try{
        // Waiting inside SERIALIZABLE would pin a snapshot from before the previous owner commits.
        // Hold session locks on this reserved connection before BEGIN establishes the snapshot.
        for(const key of lockKeys){await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);acquired.push(key);}
        locksReady=true;
        return await drizzle(client).transaction(db=>callback(this.tx(db)),{isolationLevel:'serializable'});
      }catch(error){
        failure=error;
        // A lost acquisition reply may hide a lock already granted by PostgreSQL.
        if(!locksReady)destroy=true;
      }
      finally{
        for(const key of acquired.reverse())try{
          const result=await client.query<{unlocked:boolean}>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',[key]);
          if(result.rows[0]?.unlocked!==true){destroy=true;break;}
        }catch{destroy=true;break;}
        // A broken cleanup must never return a session holding locks to the pool.
        // Keep the committed result/original error: cleanup failure must not replay committed writes.
        client.release(destroy);
      }
      if(attempt<5&&['40001','40P01'].includes(sqlState(failure)??''))continue;
      throw failure;
    }
  }
  async read<T>(callback:(tx:Tx)=>Promise<T>){return this.db.transaction(db=>callback(this.tx(db)),{isolationLevel:'repeatable read',accessMode:'read only'});}
  async close(){await this.pool.end();}
}
