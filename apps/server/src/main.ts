import { config } from './config.js';
import { runtime } from './runtime.js';
import { createApi } from './api.js';
import { Jobs } from './infrastructure/jobs.js';
const services=await runtime(config);
const jobs=new Jobs(services.store,services.processor,config,(code,error)=>{console.error(JSON.stringify({level:'error',code,role:config.ROLE,time:new Date().toISOString(),...(error?{error:{...error,message:error.message.replace(/\b(?:https?|postgres(?:ql)?):\/\/\S+/gi,'[redacted-url]')}}:{})}));});
const app=['all','api'].includes(config.ROLE)?await createApi(config,services.auth,services.feeds,services.processor):undefined;
let shuttingDown=false;
async function stop(){if(shuttingDown)return;shuttingDown=true;await app?.close();await jobs.stop();await services.store.close();}
process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
await jobs.start();if(app)await app.listen({host:config.HOST,port:config.PORT});
console.log(JSON.stringify({level:'info',message:'FeedRelay started',mode:config.MODE,role:config.ROLE,port:app?config.PORT:undefined}));
