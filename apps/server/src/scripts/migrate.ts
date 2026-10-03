import { config } from '../config.js';
import { PostgresStore } from '../infrastructure/store.js';
import { migrate } from '../infrastructure/migrations.js';
if(!config.DATABASE_URL)throw new Error('Set DATABASE_URL before running migrations.');
const store=new PostgresStore(config.DATABASE_URL);try{await migrate(store.pool);console.log('FeedRelay database migrations applied.');}finally{await store.close();}
