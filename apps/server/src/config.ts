import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
dotenv({path:resolve(process.cwd(),'../../.env'),quiet:true});dotenv({quiet:true});
const env=z.object({
  MODE:z.enum(['demo','production']).default('demo'), ROLE:z.enum(['all','api','control-worker','fetch-worker','delivery-worker']).default('all'),
  NODE_ENV:z.string().default('development'), PORT:z.coerce.number().default(4100), HOST:z.string().default('127.0.0.1'),
  TRUSTED_PROXY_CIDRS:z.string().max(1024).default(''),
  PUBLIC_URL:z.url().default('http://localhost:3000'), DATABASE_URL:z.string().optional(),
  BOT_TOKEN:z.string().optional(), BOT_ID:z.string().default('demo-bot'), BOT_USERNAME:z.string().default('FeedRelayDemoBot'), WEBHOOK_SECRET:z.string().optional(),
  TELEGRAM_CLIENT_ID:z.string().optional(), TELEGRAM_CLIENT_SECRET:z.string().optional(),
  BILLING_ENABLED:z.enum(['true','false']).default('false'), STARTER_STARS:z.coerce.number().int().min(1).max(10000).default(300),
  SUPPORT_EMAIL:z.string().default(''), TERMS_URL:z.string().default(''),
  DEMO_DATA_PATH:z.string().default('.data/demo.json'), LOG_LEVEL:z.string().default('info'),
  FETCH_CONCURRENCY:z.coerce.number().int().min(1).max(32).default(4)
}).parse(process.env);
if(env.MODE==='production'){
  if(!env.DATABASE_URL)throw new Error('DATABASE_URL is required in production.');
  if(!/^\d+$/.test(env.BOT_ID))throw new Error('BOT_ID must be the numeric Telegram bot ID in production.');
  if(['all','api','delivery-worker','control-worker'].includes(env.ROLE)&&!env.BOT_TOKEN)throw new Error('BOT_TOKEN is required for this production role.');
  if(['all','api'].includes(env.ROLE)&&(!env.WEBHOOK_SECRET||env.WEBHOOK_SECRET.length<32))throw new Error('WEBHOOK_SECRET must contain at least 32 random characters.');
  if(!env.PUBLIC_URL.startsWith('https://'))throw new Error('PUBLIC_URL must use HTTPS in production.');
}
if(env.MODE==='demo'&&env.HOST!=='127.0.0.1'&&env.HOST!=='localhost')throw new Error('Demo must bind to loopback only.');
if(env.BILLING_ENABLED==='true'&&(!env.SUPPORT_EMAIL||!env.TERMS_URL))throw new Error('Billing requires SUPPORT_EMAIL and TERMS_URL.');
export type Config=typeof env;
export const config=env;
