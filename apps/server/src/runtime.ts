import { resolve } from 'node:path';
import { BillingService } from '@feedrelay/billing';
import type { Store } from '@feedrelay/core';
import type { Config } from './config.js';
import { MemoryStore, PostgresStore } from './infrastructure/store.js';
import { AuthService } from './services/auth.js';
import { FeedService } from './services/feed-service.js';
import { Processor } from './services/processor.js';
import { TelegramClient } from './infrastructure/telegram.js';
export async function runtime(config:Config,provided?:Store){
  let store=provided;
  if(!store){if(config.MODE==='demo'){const demo=new MemoryStore(resolve(process.cwd(),config.DEMO_DATA_PATH));await demo.load();store=demo;}else store=new PostgresStore(config.DATABASE_URL!);}
  const billing=new BillingService(store,{botId:config.BOT_ID,priceStars:config.STARTER_STARS,billingEnabled:config.MODE==='production'&&config.BILLING_ENABLED==='true',supportContact:config.SUPPORT_EMAIL,termsUrl:config.TERMS_URL});
  const auth=new AuthService(store,config);const telegram=new TelegramClient(config.BOT_TOKEN,config.MODE==='demo');const feeds=new FeedService(store,billing,telegram,config);const processor=new Processor(feeds,auth);
  return {store,billing,auth,telegram,feeds,processor};
}
