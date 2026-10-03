import { config } from '../config.js';
import { runtime } from '../runtime.js';
const services=await runtime(config);try{const epoch=await services.processor.freezeRecovery();console.log(`Recovery epoch ${epoch}: automatic routes frozen. Obtain fresh snapshots before explicit skip/backfill review.`);}finally{await services.store.close();}
