import { type Pool } from 'pg';
import { tables } from '@feedrelay/core';
import { sqlNames } from './store.js';
export async function migrate(pool:Pool){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('feedrelay:migrations',0))");
    await client.query('CREATE TABLE IF NOT EXISTS fr_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const exists=await client.query('SELECT 1 FROM fr_migrations WHERE version=1');
    if(!exists.rowCount){
      for(const t of tables){ const name=sqlNames[t];await client.query(`CREATE TABLE ${name} (id text PRIMARY KEY,workspace_id text,created_at timestamptz NOT NULL,data jsonb NOT NULL,CHECK(data->>'id'=id),CHECK(data->>'createdAt' IS NOT NULL),CHECK(workspace_id IS NOT DISTINCT FROM data->>'workspaceId')); CREATE INDEX ${name}_workspace ON ${name}(workspace_id,created_at DESC); CREATE INDEX ${name}_data ON ${name} USING gin(data jsonb_path_ops);`); }
      const unique: Array<[string,string,string?]> = [
        ['users',"(data->>'telegramId')"],['workspaces',"(data->>'ownerId')"],['sessions',"(data->>'tokenHash')"],
        ['sources',"(data->>'urlHash')"],['sourceBindings',"workspace_id,(data->>'sourceId')","data->>'state'='active'"],
        ['destinations',"(data->>'chatId')","data->>'state'<>'disabled'"],['items',"(data->>'sourceId'),((data->>'seq')::bigint)"],
        ['itemAliases',"(data->>'sourceId'),(data->>'key')"],['routes',"workspace_id,(data->>'sourceBindingId'),(data->>'destinationId')"],
        ['deliveries',"workspace_id,(data->>'routeId'),(data->>'itemId'),(data->>'kind')","data->>'itemId' IS NOT NULL"],
        ['inbox',"(data->>'botId'),(data->>'updateId')"],['idempotency',"workspace_id,(data->>'key'),(data->>'scope')"]
      ];
      for(const [table,expr,predicate] of unique) await client.query(`CREATE UNIQUE INDEX ${sqlNames[table as typeof tables[number]]}_business_key ON ${sqlNames[table as typeof tables[number]]}(${expr}) ${predicate?'WHERE '+predicate:''}`);
      for(const [table,field] of [['sources','nextPollAt'],['routes','nextReleaseAt'],['deliveries','nextAttemptAt']] as const)await client.query(`CREATE INDEX ${sqlNames[table]}_due ON ${sqlNames[table]}((data->>'state'),(data->>'${field}'))`);
      await client.query('CREATE INDEX fr_items_sequence ON fr_items ((data->>\'sourceId\'),((data->>\'seq\')::bigint)); INSERT INTO fr_migrations(version) VALUES(1)');
    }
    if(!(await client.query('SELECT 1 FROM fr_migrations WHERE version=2')).rowCount){
      const billingKeys:Array<[string,string,string[]]>=[
        ['checkouts','workspace_bot',['workspace_id',"(data->>'botId')"]],['checkouts','payload_bot',["(data->>'botId')","(data->>'payload')"]],
        ['subscriptions','workspace_bot',['workspace_id',"(data->>'botId')"]],['subscriptions','payload_bot',["(data->>'botId')","(data->>'payload')"]],
        ['payments','charge_bot',["(data->>'botId')","(data->>'chargeId')"]],['refunds','charge_bot',["(data->>'botId')","(data->>'chargeId')"]],['grants','charge_bot',["(data->>'botId')","(data->>'chargeId')"]],
        ['reservations','delivery_period',['workspace_id',"(data->>'deliveryId')","(data->>'periodId')"]],['ledger','logical_delivery',['workspace_id',"(data->>'deliveryId')"]]
      ];
      for(const[t,label,columns]of billingKeys)await client.query(`CREATE UNIQUE INDEX ${sqlNames[t as typeof tables[number]]}_${label}_key ON ${sqlNames[t as typeof tables[number]]}(${columns.join(',')})`);
      await client.query('INSERT INTO fr_migrations(version) VALUES(2)');
    }
    if(!(await client.query('SELECT 1 FROM fr_migrations WHERE version=3')).rowCount){
      await client.query("DROP INDEX fr_routes_business_key; CREATE UNIQUE INDEX fr_routes_business_key ON fr_routes(workspace_id,(data->>'sourceBindingId'),(data->>'destinationId')) WHERE data->>'state'<>'deleted'; INSERT INTO fr_migrations(version) VALUES(3)");
    }
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
