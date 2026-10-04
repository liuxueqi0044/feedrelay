import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { AppError, DEFAULT_RULES, audit, newId, nowISO, requireWorkspace, type Actor, type Delivery, type Destination, type Entity, type SourceBinding, type Workspace } from '@feedrelay/core';
import { type Payment } from '@feedrelay/billing';
import type { Config } from './config.js';
import { AuthService, safeEqual, validateMiniApp } from './services/auth.js';
import { FeedService } from './services/feed-service.js';
import { Processor } from './services/processor.js';
import { TelegramError } from './infrastructure/telegram.js';
import { SourceError } from '@feedrelay/sources';
declare module 'fastify' { interface FastifyRequest { actor:Actor;csrf:string } }
const id=z.string().min(1).max(128);
const rules=z.object({include:z.array(z.string().trim().min(1).max(100)).max(20).default([]),exclude:z.array(z.string().trim().min(1).max(100)).max(20).default([]),field:z.enum(['title','all']).default('all'),caseSensitive:z.boolean().default(false),template:z.string().trim().min(1).max(1500).default(DEFAULT_RULES.template),summaryLength:z.number().int().min(0).max(1000).default(500)});
const routeInput=z.object({name:z.string().trim().min(1).max(100),sourceBindingId:id,destinationId:id,requestedIntervalMinutes:z.number().int().min(5).max(1440),rules:rules.default(DEFAULT_RULES)});
const params=(input:unknown)=>z.object({id}).parse(input).id;
export async function createApi(config:Config,auth:AuthService,feeds:FeedService,processor:Processor){
  const trustedProxies=config.TRUSTED_PROXY_CIDRS.split(',').map(value=>value.trim()).filter(Boolean);
  const app=Fastify({logger:{level:config.LOG_LEVEL,redact:['req.headers.cookie','req.headers.authorization','req.headers.x-telegram-bot-api-secret-token','req.headers.x-csrf-token','res.headers.set-cookie']},bodyLimit:1024*1024,trustProxy:trustedProxies.length?trustedProxies:false});
  await app.register(cookie);await app.register(helmet);await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
  app.decorateRequest('actor',null as unknown as Actor);app.decorateRequest('csrf','');
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof AppError)return reply.code(error.status).send({code:error.code,message:error.message});
    if(error instanceof z.ZodError)return reply.code(400).send({code:'invalid_input',message:error.issues[0]?.message??'Check the supplied fields.'});
    if(error instanceof TelegramError)return reply.code(error.kind==='blocked'?403:503).send({code:error.code,message:error.kind==='blocked'?'The bot or your account cannot post in this destination. Check its permissions.':'Telegram could not complete this request. Try again later.'});
    if(error instanceof SourceError)return reply.code(400).send({code:error.code,message:error.message});
    const details=error as {statusCode?:number;code?:string;name?:string};
    if(details.statusCode===429)return reply.code(429).send({code:'rate_limited',message:'Too many requests. Try again shortly.'});
    app.log.error({code:details.code??details.name},'Request failed');return reply.code(details.statusCode??500).send({code:'internal_error',message:'This request could not be completed.'});
  });
  app.addHook('onRequest',async(request)=>{
    const path=request.url.split('?')[0]!;const mutation=!['GET','HEAD','OPTIONS'].includes(request.method);
    if(mutation&&path!=='/api/telegram/webhook'){
      const origin=request.headers.origin;if(origin&&origin!==new URL(config.PUBLIC_URL).origin&&!(config.MODE==='demo'&&['http://localhost:3000','http://127.0.0.1:3000'].includes(origin)))throw new AppError('origin_forbidden','This request came from an untrusted website.',403);
    }
    if(path==='/api/config'||path==='/healthz'||path.startsWith('/health/')||path.startsWith('/api/auth/')&&path!=='/api/auth/logout'||path==='/api/telegram/webhook')return;
    const identity=await auth.resolve(request.cookies.fr_session);request.actor=identity.actor;request.csrf=identity.csrf;
    if(mutation){const supplied=request.headers['x-csrf-token'];if(typeof supplied!=='string'||!safeEqual(supplied,identity.csrf))throw new AppError('csrf_invalid','Refresh the page and try again.',403);}
  });
  const sessionCookie=(reply:FastifyReply,token:string)=>reply.setCookie('fr_session',token,{httpOnly:true,secure:config.MODE==='production',sameSite:'lax',path:'/',maxAge:43200});
  app.get('/health/live',async()=>({ok:true,role:config.ROLE}));
  app.get('/healthz',async(_request,reply)=>{try{await feeds.store.read(tx=>tx.list('workspaces',{}, {limit:1}));return {ok:true,role:config.ROLE};}catch{return reply.code(503).send({ok:false});}});
  app.get('/health/ready',async(_request,reply)=>{try{await feeds.store.read(tx=>tx.list('workspaces',{}, {limit:1}));return {ok:true,mode:config.MODE};}catch{return reply.code(503).send({ok:false});}});
  app.get('/api/config',async()=>({mode:config.MODE,botUsername:config.BOT_USERNAME,billingEnabled:config.MODE==='production'&&feeds.billing.billingEnabled,starterStars:config.STARTER_STARS,supportEmail:config.SUPPORT_EMAIL,termsUrl:config.TERMS_URL}));
  app.post('/api/auth/demo',async(_request,reply)=>{if(config.MODE!=='demo')throw new AppError('not_found','Not found.',404);const account=await auth.login('999000001','Demo operator');sessionCookie(reply,account.token);return {user:account.user,workspace:account.workspace,csrf:account.csrf};});
  app.post('/api/auth/miniapp',async(request,reply)=>{if(!config.BOT_TOKEN)throw new AppError('login_unavailable','Mini App login is not configured.',503);const body=z.object({initData:z.string().min(1).max(8192)}).parse(request.body);const user=validateMiniApp(body.initData,config.BOT_TOKEN);const account=await auth.login(user.id,user.name);sessionCookie(reply,account.token);return {user:account.user,workspace:account.workspace,csrf:account.csrf};});
  app.get('/api/auth/telegram/start',async(_request,reply)=>{const flow=await auth.startOidc();reply.setCookie('fr_oidc',flow.cookie,{httpOnly:true,secure:config.MODE==='production',sameSite:'lax',path:'/',maxAge:600});return reply.redirect(flow.url);});
  app.get('/api/auth/telegram/callback',async(request,reply)=>{const query=z.record(z.string(),z.string()).parse(request.query);const account=await auth.completeOidc(query,request.cookies.fr_oidc);sessionCookie(reply,account.token);reply.clearCookie('fr_oidc',{path:'/'});return reply.redirect('/dashboard');});
  app.post('/api/auth/logout',async(request,reply)=>{await auth.logout(request.cookies.fr_session);reply.clearCookie('fr_session',{path:'/'});return {ok:true};});
  app.get('/api/me',async request=>{const account=await auth.resolve(request.cookies.fr_session);return {user:account.user,workspace:account.workspace,csrf:account.csrf};});
  app.post('/api/telegram/webhook',{config:{rateLimit:false}},async(request,reply)=>{
    const secret=request.headers['x-telegram-bot-api-secret-token'];if(config.MODE!=='production'||typeof secret!=='string'||!config.WEBHOOK_SECRET||!safeEqual(secret,config.WEBHOOK_SECRET))throw new AppError('webhook_forbidden','Not authorized.',403);
    const update=z.object({update_id:z.number().int().nonnegative()}).passthrough().parse(request.body);await processor.receive(update);return reply.send({ok:true});
  });
  app.get('/api/overview',async request=>{const actor=request.actor,ent=await feeds.billing.entitlements(actor.workspaceId);return feeds.store.read(async tx=>{
    await requireWorkspace(tx,actor);const sourceRows=await tx.list('sourceBindings',{workspaceId:actor.workspaceId,state:'active'}),destinationRows=await tx.list('destinations',{workspaceId:actor.workspaceId,state:{ne:'disabled'}}),routeRows=await tx.list('routes',{workspaceId:actor.workspaceId}),deliveryRows=await tx.list<Delivery>('deliveries',{workspaceId:actor.workspaceId,kind:{ne:'bot'}},{limit:10000});
    return {sources:sourceRows.length,destinations:destinationRows.length,routes:routeRows.length,sent:deliveryRows.filter(d=>d.state==='sent').length,pending:deliveryRows.filter(d=>['pending','sending','retry_wait','unknown','quota_deferred'].includes(d.state)).length,failed:deliveryRows.filter(d=>['dead','blocked','needs_review'].includes(d.state)).length,usage:{used:ent.used,reserved:ent.reserved,limit:ent.deliveryLimit},plan:ent.plan,activity:deliveryRows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,6).map(d=>({id:d.id,title:d.kind==='test'?'Destination test':d.text.replace(/<[^>]+>/g,'').split('\n')[0],status:d.state,createdAt:d.createdAt}))};
  });});
  app.get('/api/sources',request=>feeds.listSources(request.actor));
  app.post('/api/sources',async(request,reply)=>{const {url}=z.object({url:z.string().min(1).max(2048)}).parse(request.body);return reply.code(201).send(await feeds.addSource(request.actor,url));});
  app.delete('/api/sources/:id',async request=>{await feeds.removeSource(request.actor,params(request.params));return {ok:true};});
  app.post('/api/sources/:id/check',request=>feeds.checkSource(request.actor,params(request.params)));
  app.get('/api/sources/:id/items',request=>feeds.sourceItems(request.actor,params(request.params)));
  app.post('/api/imports/preview',async request=>{const {opml}=z.object({opml:z.string().max(512000)}).parse(request.body);return feeds.previewImport(opml);});
  app.post('/api/imports',async request=>{const {feeds:entries}=z.object({feeds:z.array(z.object({url:z.string().max(2048),title:z.string().max(200).optional()})).max(100)}).parse(request.body);return feeds.import(request.actor,entries);});
  app.get('/api/exports/opml',async(request,reply)=>reply.header('content-type','application/xml; charset=utf-8').header('content-disposition','attachment; filename="feedrelay.opml"').send(await feeds.export(request.actor)));
  app.get('/api/destinations',request=>feeds.store.read(async tx=>{await requireWorkspace(tx,request.actor);return tx.list<Destination>('destinations',{workspaceId:request.actor.workspaceId,state:{ne:'disabled'}},{orderBy:'createdAt'});}));
  app.post('/api/destinations/private',request=>feeds.privateDestination(request.actor));
  app.post('/api/destination-bindings',request=>feeds.createBinding(request.actor));
  app.post('/api/destinations/channel',request=>{const {bindingId,chatId}=z.object({bindingId:id,chatId:z.string().regex(/^-\d+$/)}).parse(request.body);return feeds.bindChannel(request.actor,bindingId,chatId);});
  app.post('/api/destinations/:id/test',request=>feeds.testDestination(request.actor,params(request.params)));
  app.post('/api/destinations/:id/verify',request=>feeds.verifyDestination(request.actor,params(request.params)));
  app.delete('/api/destinations/:id',async request=>{await feeds.removeDestination(request.actor,params(request.params));return {ok:true};});
  app.get('/api/routes',request=>feeds.listRoutes(request.actor));
  app.post('/api/routes',async(request,reply)=>reply.code(201).send(await feeds.saveRoute(request.actor,routeInput.parse(request.body))));
  app.patch('/api/routes/:id',async request=>{const routeId=params(request.params),patch=routeInput.partial().parse(request.body);const current=(await feeds.listRoutes(request.actor)).find(r=>r.id===routeId);if(!current)throw new AppError('not_found','This route was not found.',404);return feeds.saveRoute(request.actor,{name:current.name,sourceBindingId:current.sourceBindingId,destinationId:current.destinationId,requestedIntervalMinutes:current.requestedIntervalMinutes,rules:current.rules,...patch},routeId);});
  app.delete('/api/routes/:id',async request=>{await feeds.removeRoute(request.actor,params(request.params));return {ok:true};});
  app.post('/api/routes/:id/pause',request=>feeds.pauseRoute(request.actor,params(request.params)));
  app.post('/api/routes/:id/resume',request=>{const {backlog}=z.object({backlog:z.enum(['skip','recent']).default('skip')}).parse(request.body??{});return feeds.resumeRoute(request.actor,params(request.params),backlog);});
  app.post('/api/routes/:id/preview',request=>feeds.previewRoute(request.actor,params(request.params)));
  app.post('/api/routes/:id/backfill',request=>{const {limit}=z.object({limit:z.number().int().min(1).max(20)}).parse(request.body);return feeds.backfill(request.actor,params(request.params),limit);});
  app.get('/api/deliveries',request=>feeds.listDeliveries(request.actor));
  app.post('/api/deliveries/:id/retry',request=>{const {acknowledgeDuplicateRisk}=z.object({acknowledgeDuplicateRisk:z.boolean().default(false)}).parse(request.body??{});return feeds.retry(request.actor,params(request.params),acknowledgeDuplicateRisk);});
  app.get('/api/billing',async request=>{const ent=await feeds.billing.status(request.actor);const payments=await feeds.store.read(tx=>tx.list<Payment>('payments',{workspaceId:request.actor.workspaceId},{orderBy:'createdAt',direction:'desc',limit:100}));return {plan:ent.plan,usage:{used:ent.used,reserved:ent.reserved,limit:ent.deliveryLimit},entitlements:{sourceLimit:ent.maxSources,destinationLimit:ent.maxDestinations,minIntervalMinutes:ent.minIntervalMinutes,deliveryLimit:ent.deliveryLimit},starterStars:config.STARTER_STARS,billingEnabled:config.MODE==='production'&&ent.billingEnabled,paidThrough:ent.paidUntil,renewState:ent.renewalCanceled?'canceled':ent.subscription?'active':'none',payments:payments.map(p=>({id:p.id,chargeId:p.chargeId,amountStars:p.totalAmount,state:p.state,createdAt:p.createdAt}))};});
  app.post('/api/billing/checkouts',async request=>{if(config.MODE!=='production')throw new AppError('billing_disabled','Payments are disabled in the sandbox.',503);const body=z.object({termsAccepted:z.literal(true)}).parse(request.body);const key=request.headers['idempotency-key'];const checkout=await feeds.billing.checkout(request.actor,body.termsAccepted,typeof key==='string'?key:undefined);const invoiceUrl=await feeds.telegram.call<string>('createInvoiceLink',{title:'FeedRelay Starter',description:'30 sources, 3 destinations, checks every 5 minutes and 5,000 deliveries per 30-day paid period. Renews until canceled.',payload:checkout.payload,currency:'XTR',prices:[{label:'Starter — 30 days',amount:checkout.amount}],subscription_period:checkout.subscriptionPeriod,provider_token:''});return {invoiceUrl};});
  app.post('/api/billing/cancel-renewal',request=>feeds.billing.cancelRenewal(request.actor,feeds.telegram));
  app.get('/api/settings',request=>feeds.store.read(async tx=>({workspace:await requireWorkspace(tx,request.actor),supportEmail:config.SUPPORT_EMAIL})));
  app.delete('/api/workspace',async request=>{z.object({confirmation:z.literal('DELETE')}).parse(request.body);await feeds.store.transaction(['workspace:'+request.actor.workspaceId],async tx=>{const w=await requireWorkspace(tx,request.actor);w.state='deleting';w.version++;await tx.put('workspaces',w);for(const s of await tx.list<Entity>('sessions',{workspaceId:w.id}))await tx.remove('sessions',s.id);await audit(tx,'workspace_deletion_requested',w.id,request.actor);});return {state:'deleting'};});
  app.post('/api/demo/publish',async()=>{if(config.MODE!=='demo')throw new AppError('not_found','Not found.',404);await processor.publishDemo();return {queued:true};});
  return app;
}
