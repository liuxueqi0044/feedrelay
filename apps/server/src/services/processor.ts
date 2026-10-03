import { createHash } from 'node:crypto';
import { fetchFeed, discoverFeed, SourceError, type NormalizedItem } from '@feedrelay/sources';
import { type Checkout, type Payment, type Subscription } from '@feedrelay/billing';
import { audit, emit, newId, nowISO, plusMs, stableId, type Actor, type Delivery, type Destination, type Entity, type Item, type Route, type Source, type SourceBinding, type Tx, type User, type Workspace } from '@feedrelay/core';
import { FeedService, type Binding } from './feed-service.js';
import { AuthService } from './auth.js';
import { TelegramError, type MessageResult } from '../infrastructure/telegram.js';
export interface Inbox extends Entity { botId:string;updateId:string;update:Record<string,any>;state:'pending'|'processed'|'failed';attempts:number;nextAttemptAt:string;error?:string }
interface RateSlot extends Entity { nextAt:string }
interface Attempt extends Entity { workspaceId:string;deliveryId:string;number:number;state:string;messageId?:string;error?:string;finishedAt?:string }
interface DemoFeed extends Entity { entries:NormalizedItem[] }
const demoItem=(n:number):NormalizedItem=>({title:n===1?'A quieter way to follow your sources':n===2?'Your first route is ready':`Sample update ${n}: shipped and ready to share`,summary:'This is a sandbox article. FeedRelay checks a feed, applies your rules, and sends one message to your connected destination.',url:`https://example.com/feedrelay/article-${n}`,externalId:`demo-${n}`,contentHash:createHash('sha256').update('demo-'+n).digest('hex'),publishedAt:nowISO(),identityCandidates:[`id:demo-${n}`,`url:https://example.com/feedrelay/article-${n}`]});
export class Processor {
  constructor(readonly feeds:FeedService,readonly auth:AuthService){}
  get store(){return this.feeds.store;}get billing(){return this.feeds.billing;}
  async fetchSource(id:string){
    const leased=await this.store.transaction(['source:'+id],async tx=>{const s=await tx.get<Source>('sources',id);if(!s||s.leaseUntil&&s.leaseUntil>nowISO())return; s.leaseVersion++;s.leaseUntil=plusMs(nowISO(),180000);await tx.put('sources',s);return s;});if(!leased)return;
    let result:Awaited<ReturnType<typeof fetchFeed>>|undefined,error:string|undefined;
    try{
      if(this.feeds.config.MODE==='demo'){
        const feed=await this.store.transaction(['demo-feed'],async tx=>{let f=await tx.get<DemoFeed>('recovery','demo-feed');if(!f){f={id:'demo-feed',createdAt:nowISO(),entries:[demoItem(2),demoItem(1)]};await tx.put('recovery',f);}return f;});
        result={kind:'snapshot',url:leased.url,title:'FeedRelay sample feed',items:feed.entries};
      }else result=!leased.lastSuccessAt?await discoverFeed(leased.url):await fetchFeed(leased.resolvedUrl??leased.url,{etag:leased.etag,lastModified:leased.lastModified});
    }catch(e){error=e instanceof SourceError?e.code:'fetch_failed';}
    await this.store.transaction(['source:'+id],async tx=>{
      const s=await tx.get<Source>('sources',id);if(!s||s.leaseVersion!==leased.leaseVersion)return;s.leaseUntil=undefined;s.checkedAt=nowISO();
      const run={id:newId(),createdAt:nowISO(),sourceId:id,state:error?'failed':result?.kind??'failed',error};await tx.put('fetchRuns',run);
      if(error||!result){s.failures++;s.state=s.failures>=10?'blocked':'degraded';s.error=error;s.nextPollAt=plusMs(nowISO(),Math.min(86400000,60000*2**Math.min(s.failures,10)));}
      else{if(result.kind==='snapshot')await this.feeds.ingest(tx,s,result);if(result.etag)s.etag=result.etag;if(result.lastModified)s.lastModified=result.lastModified;s.failures=0;s.state='healthy';s.error=undefined;s.lastSuccessAt=nowISO();let interval=60;
        for(const r of await tx.list<Route>('routes',{sourceId:id,state:{in:['active','initializing']}})){const w=await tx.get<Workspace>('workspaces',r.workspaceId);if(w?.state==='active'){const ent=await this.billing.entitlements(tx,r.workspaceId);interval=Math.min(interval,Math.max(ent.minIntervalMinutes,r.requestedIntervalMinutes));await emit(tx,'release',r.id,r.workspaceId);}}
        s.nextPollAt=plusMs(nowISO(),interval*60000+Math.floor(Math.random()*Math.min(3000,interval*600)));}
      await tx.put('sources',s);
    });
  }
  async releaseRoute(id:string){
    const row=await this.store.read(tx=>tx.get<Route>('routes',id));if(!row)return;
    await this.store.transaction(['workspace:'+row.workspaceId,'route:'+id,'source:'+row.sourceId],async tx=>{
      const r=await tx.get<Route>('routes',id);if(!r||!['active','initializing'].includes(r.state))return;const w=await tx.get<Workspace>('workspaces',r.workspaceId);if(w?.state!=='active')return;
      const b=await tx.get<SourceBinding>('sourceBindings',r.sourceBindingId),d=await tx.get<Destination>('destinations',r.destinationId),s=await tx.get<Source>('sources',r.sourceId);if(!b||b.state!=='active'||!d||d.state!=='active'||!s)return;
      const ent=await this.billing.entitlements(tx,r.workspaceId);const sources=await tx.list<SourceBinding>('sourceBindings',{workspaceId:r.workspaceId,state:'active'},{orderBy:'createdAt'}),destinations=await tx.list<Destination>('destinations',{workspaceId:r.workspaceId,state:'active'},{orderBy:'createdAt'});
      if(!sources.slice(0,ent.maxSources).some(x=>x.id===b.id)||!destinations.slice(0,ent.maxDestinations).some(x=>x.id===d.id)){r.state='plan_limit';r.pauseReason='plan_limit';r.version++;await tx.put('routes',r);return;}
      if(!s.lastSuccessAt||s.leaseUntil&&s.leaseUntil>nowISO())return;
      if(r.state==='initializing'){if(s.lastSuccessAt<r.baselineAfter){await emit(tx,'fetch',s.id);return;}r.baselineSeq=s.seq;r.cursor=s.seq;r.state='active';r.nextReleaseAt=plusMs(nowISO(),Math.max(ent.minIntervalMinutes,r.requestedIntervalMinutes)*60000);await tx.put('routes',r);return;}
      if(r.nextReleaseAt>nowISO())return;
      // A due check must finish before the route advances its clock.
      if(s.nextPollAt<=nowISO()||s.lastSuccessAt<r.nextReleaseAt){await emit(tx,'fetch',s.id);return;}
      const maxSeq=s.seq;const items=await tx.list<Item>('items',{sourceId:s.id,seq:{gt:r.cursor,lte:maxSeq}},{limit:200,orderBy:'seq'});
      for(const item of items){if(item.createdAt>=plusMs(nowISO(),-86400000))await this.feeds.evaluate(tx,r,item);else await tx.put('evaluations',{id:stableId(r.workspaceId,r.id,item.id,'article'),createdAt:nowISO(),workspaceId:r.workspaceId,routeId:r.id,itemId:item.id,decision:'expired'});r.cursor=item.seq;}
      if(items.length<200){r.cursor=maxSeq;r.nextReleaseAt=plusMs(nowISO(),Math.max(ent.minIntervalMinutes,r.requestedIntervalMinutes)*60000);}else await emit(tx,'release',r.id,r.workspaceId);
      await tx.put('routes',r);
    });
  }
  async deliver(id:string){
    const row=await this.store.read(tx=>tx.get<Delivery>('deliveries',id));if(!row)return;
    const claimed=await this.store.transaction(['workspace:'+row.workspaceId,'delivery:'+id,'chat:'+row.chatId,'bot-rate'],async tx=>{
      const d=await tx.get<Delivery>('deliveries',id);if(!d||!['pending','retry_wait','unknown','quota_deferred'].includes(d.state)||d.nextAttemptAt>nowISO())return;
      const w=await tx.get<Workspace>('workspaces',d.workspaceId);if(w?.state!=='active'){d.state='expired';d.error='workspace_inactive';await this.billing.releaseUsage(tx,d.workspaceId,d.id);await tx.put('deliveries',d);return;}
      const destination=d.destinationId?await tx.get<Destination>('destinations',d.destinationId):undefined,route=d.routeId?await tx.get<Route>('routes',d.routeId):undefined;
      if(d.kind!=='bot'&&(!destination||destination.state!=='active'||destination.workspaceId!==d.workspaceId)){d.state='blocked';d.error='destination_inactive';await tx.put('deliveries',d);return;}
      if(d.routeId&&!route){d.state='expired';d.error='route_deleted';await this.billing.releaseUsage(tx,d.workspaceId,d.id);await tx.put('deliveries',d);return;}
      if(route){const binding=await tx.get<SourceBinding>('sourceBindings',route.sourceBindingId);if(route.state!=='active'||binding?.state!=='active'){d.state='blocked';d.error='route_paused';await tx.put('deliveries',d);return;}
        if(d.routeVersion!==route.version||d.destinationVersion!==destination?.version){d.state='blocked';d.error='configuration_changed';await tx.put('deliveries',d);return;}
        const ent=await this.billing.entitlements(tx,d.workspaceId);const sourceRows=await tx.list<SourceBinding>('sourceBindings',{workspaceId:d.workspaceId,state:'active'},{orderBy:'createdAt'}),destinationRows=await tx.list<Destination>('destinations',{workspaceId:d.workspaceId,state:'active'},{orderBy:'createdAt'});if(!sourceRows.slice(0,ent.maxSources).some(x=>x.id===route.sourceBindingId)||!destinationRows.slice(0,ent.maxDestinations).some(x=>x.id===route.destinationId)){d.state='blocked';d.error='plan_limit';await tx.put('deliveries',d);return;}}
      if(d.state==='unknown'&&d.unknownRetries>=1){d.state='needs_review';d.error='delivery_outcome_uncertain';await tx.put('deliveries',d);return;}
      const other=(await tx.list<Delivery>('deliveries',{chatId:d.chatId,state:'sending'},{limit:1}))[0];if(other&&other.id!==d.id){d.nextAttemptAt=plusMs(nowISO(),1200);await tx.put('deliveries',d);return;}
      const earlier=(await tx.list<Delivery>('deliveries',{chatId:d.chatId,state:{in:['pending','retry_wait','unknown']}},{orderBy:'enqueueSeq',limit:100})).filter(x=>x.id!==d.id&&(x.enqueueSeq??0)<(d.enqueueSeq??0))[0];if(earlier){d.nextAttemptAt=earlier.nextAttemptAt>nowISO()?earlier.nextAttemptAt:plusMs(nowISO(),1200);await tx.put('deliveries',d);return;}
      const bot=await tx.get<RateSlot>('rateLimits','bot'),chat=await tx.get<RateSlot>('rateLimits',stableId('chat',d.chatId));const earliest=[bot?.nextAt??'',chat?.nextAt??'',nowISO()].sort().at(-1)!;
      if(earliest>nowISO()){d.nextAttemptAt=earliest;await tx.put('deliveries',d);return;}
      if(d.kind!=='bot'){const reservation=await this.billing.reserveUsage(tx,d.workspaceId,d.id,nowISO(),plusMs(nowISO(),3600000));if(!reservation.ok){d.state='quota_deferred';d.error='quota_exhausted';d.nextAttemptAt=plusMs(nowISO(),3600000);await tx.put('deliveries',d);return;}d.reservationId=reservation.reservationId;}
      await tx.put<RateSlot>('rateLimits',{id:'bot',createdAt:bot?.createdAt??nowISO(),nextAt:plusMs(nowISO(),50)});await tx.put<RateSlot>('rateLimits',{id:stableId('chat',d.chatId),createdAt:chat?.createdAt??nowISO(),nextAt:plusMs(nowISO(),1200)});
      if(d.state==='unknown')d.unknownRetries++;d.attemptCount++;d.attemptId=newId();d.leaseUntil=plusMs(nowISO(),90000);d.state='sending';d.version++;d.error=undefined;await tx.put('deliveries',d);await tx.put<Attempt>('attempts',{id:d.attemptId,createdAt:nowISO(),workspaceId:d.workspaceId,deliveryId:d.id,number:d.attemptCount,state:'sending'});return d;
    });if(!claimed)return;
    let result:MessageResult|undefined,error:TelegramError|undefined;try{result=await this.feeds.telegram.call<MessageResult>('sendMessage',{chat_id:claimed.chatId,text:claimed.text,parse_mode:claimed.parseMode,link_preview_options:{is_disabled:true},reply_markup:claimed.replyMarkup});}catch(e){error=e instanceof TelegramError?e:new TelegramError('unknown','unexpected_transport_error');}
    await this.store.transaction(['workspace:'+claimed.workspaceId,'delivery:'+id],async tx=>{
      const d=await tx.get<Delivery>('deliveries',id),a=await tx.get<Attempt>('attempts',claimed.attemptId!);if(a){a.state=result?'sent':error!.kind;a.messageId=result?String(result.message_id):undefined;a.error=error?.code;a.finishedAt=nowISO();await tx.put('attempts',a);}if(!d)return;
      // Late platform receipts remain facts, even after another worker takes the lease.
      if(result){if(d.state!=='sent'){d.state='sent';d.messageId=String(result.message_id);d.sentAt=new Date(result.date*1000).toISOString();d.error=undefined;d.leaseUntil=undefined;if(d.kind!=='bot')await this.billing.commitUsage(tx,d.workspaceId,d.id);await tx.put('deliveries',d);await audit(tx,'delivery_sent',id,undefined,{messageId:d.messageId});}return;}
      if(d.attemptId!==claimed.attemptId||d.state!=='sending')return;
      d.leaseUntil=undefined;d.error=error!.code;
      if(error!.kind==='unknown'){d.state=d.unknownRetries>=1?'needs_review':'unknown';d.nextAttemptAt=plusMs(nowISO(),60000);if(d.kind!=='bot')await this.billing.releaseUsage(tx,d.workspaceId,d.id,{preserveUnknown:true});}
      else if(error!.kind==='blocked'){d.state='blocked';if(d.kind!=='bot')await this.billing.releaseUsage(tx,d.workspaceId,d.id);if(d.destinationId){const dest=await tx.get<Destination>('destinations',d.destinationId);if(dest){dest.state='blocked';dest.error=error!.code;dest.version++;await tx.put('destinations',dest);}}}
      else if(error!.kind==='permanent'||d.attemptCount>=8){d.state='dead';if(d.kind!=='bot')await this.billing.releaseUsage(tx,d.workspaceId,d.id);}
      else{d.state='retry_wait';d.nextAttemptAt=plusMs(nowISO(),error!.retryAfter?error!.retryAfter*1000:Math.min(3600000,1000*2**d.attemptCount+Math.random()*1000));}
      await tx.put('deliveries',d);
    });
  }
  async receive(update:Record<string,any>){
    const updateId=String(update.update_id),id=stableId(this.feeds.config.BOT_ID,updateId);
    await this.store.transaction(['inbox:'+id],async tx=>{if(await tx.get('inbox',id))return;await tx.put<Inbox>('inbox',{id,createdAt:nowISO(),botId:this.feeds.config.BOT_ID,updateId,update,state:'pending',attempts:0,nextAttemptAt:nowISO()});await emit(tx,'inbox',id);});
    if(update.pre_checkout_query){const q=update.pre_checkout_query;const decision=await this.billing.validatePreCheckout(q.invoice_payload,String(q.from.id),q.currency,q.total_amount,q.id);await this.feeds.telegram.call('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok:decision.ok,error_message:decision.errorMessage});}
  }
  async processInbox(id:string){
    const inbox=await this.store.read(tx=>tx.get<Inbox>('inbox',id));if(!inbox||inbox.state==='processed'||inbox.nextAttemptAt>nowISO())return;const u=inbox.update;
    try{
      const m=u.message;
      if(m?.successful_payment){const p=m.successful_payment;await this.billing.recordPayment({chargeId:p.telegram_payment_charge_id,payload:p.invoice_payload,payerId:String(m.from.id),currency:p.currency,totalAmount:p.total_amount,expirationDate:p.subscription_expiration_date,isRecurring:p.is_recurring,isFirstRecurring:p.is_first_recurring,paidAt:m.date});}
      else if(m?.refunded_payment){const p=m.refunded_payment;await this.billing.recordRefund({chargeId:p.telegram_payment_charge_id,payload:p.invoice_payload,payerId:m.from?.id,currency:p.currency,totalAmount:p.total_amount,refundedAt:m.date});}
      else if(u.subscription){await this.billing.recordSubscriptionUpdate({payerId:String(u.subscription.user.id),payload:u.subscription.invoice_payload,state:u.subscription.state,updateId:String(u.update_id)});}
      else if(u.my_chat_member||u.chat_member){const event=u.my_chat_member??u.chat_member;const destinations=await this.store.read(tx=>tx.list<Destination>('destinations',{chatId:String(event.chat.id),state:{ne:'disabled'}}));for(const d of destinations){try{if(d.kind==='channel')await this.feeds.channelPermission(d.chatId,d.authorizedBy);}catch{await this.blockDestination(d.id,'channel_permission_lost');}}}
      else if(m?.from&&!m.from.is_bot&&m.chat?.type==='private'&&String(m.chat.id)===String(m.from.id)){
        const account=await this.auth.identity(String(m.from.id),[m.from.first_name,m.from.last_name].filter(Boolean).join(' '),true);
        if(m.chat_shared){const binding=(await this.store.read(tx=>tx.list<Binding>('bindings',{telegramId:account.actor.telegramId,requestId:m.chat_shared.request_id,consumed:false})))[0];if(binding)await this.feeds.bindChannel(account.actor,binding.id,String(m.chat_shared.chat_id));}
        else if(typeof m.text==='string'){const command=m.text.split(' ')[0].split('@')[0],arg=m.text.split(' ')[1];const deliveryId=stableId('bot-response',id);
          if(command==='/start'&&arg?.startsWith('bind_')){const b=await this.store.read(tx=>tx.get<Binding>('bindings',arg.slice(5)));if(!b||b.telegramId!==account.actor.telegramId||b.userId!==account.actor.userId||b.consumed||b.expiresAt<nowISO())throw new Error('binding_expired');
            const rights={is_anonymous:false,can_manage_chat:true,can_delete_messages:false,can_manage_video_chats:false,can_restrict_members:false,can_promote_members:false,can_change_info:false,can_invite_users:false,can_post_stories:false,can_edit_stories:false,can_delete_stories:false,can_post_messages:true,can_edit_messages:false};
            await this.store.transaction(['workspace:'+account.workspace.id],tx=>this.feeds.enqueue(tx,account.workspace.id,account.actor.telegramId,'Choose a channel you manage. Add FeedRelay with permission to post.', 'bot',{replyMarkup:{keyboard:[[{text:'Connect my channel',request_chat:{request_id:b.requestId,chat_is_channel:true,user_administrator_rights:{...rights,can_manage_chat:false},bot_administrator_rights:rights,bot_is_member:true}}]],resize_keyboard:true,one_time_keyboard:true}},deliveryId));
          }else{let text:string;switch(command){case '/support':case '/paysupport':text=this.feeds.config.SUPPORT_EMAIL?`Contact ${this.feeds.config.SUPPORT_EMAIL} for account and payment support.`:'Support contact is not configured yet.';break;case '/terms':text=this.feeds.config.TERMS_URL||'Paid subscriptions are not available yet.';break;case '/pause':{const routes=await this.feeds.listRoutes(account.actor);for(const r of routes)await this.feeds.pauseRoute(account.actor,r.id);text='All routes are paused. Resume them in the dashboard.';break;}case '/status':case '/plan':{const ent=await this.billing.entitlements(account.workspace.id);text=`Plan: ${ent.plan}. Deliveries: ${ent.used}/${ent.deliveryLimit}. Minimum check interval: ${ent.minIntervalMinutes} minutes.`;break;}default:text='Welcome to FeedRelay. Add a public RSS feed, connect a destination, and publish new articles automatically. Open the dashboard to configure your routes.';}
            await this.store.transaction(['workspace:'+account.workspace.id],tx=>this.feeds.enqueue(tx,account.workspace.id,account.actor.telegramId,text,'bot',{replyMarkup:{inline_keyboard:[[{text:'Open dashboard',web_app:{url:this.feeds.config.PUBLIC_URL+'/dashboard'}}]]}},deliveryId));}
        }
      }
      await this.store.transaction(['inbox:'+id],async tx=>{const current=await tx.get<Inbox>('inbox',id);if(current){current.state='processed';current.error=undefined;await tx.put('inbox',current);}});
    }catch{await this.store.transaction(['inbox:'+id],async tx=>{const current=await tx.get<Inbox>('inbox',id);if(current){current.attempts++;current.state=current.attempts>=5?'failed':'pending';current.error='update_processing_failed';current.nextAttemptAt=plusMs(nowISO(),Math.min(3600000,5000*2**current.attempts));await tx.put('inbox',current);}});}
  }
  async blockDestination(id:string,error:string){const d=await this.store.read(tx=>tx.get<Destination>('destinations',id));if(!d)return;await this.store.transaction(['workspace:'+d.workspaceId],async tx=>{const current=await tx.get<Destination>('destinations',id);if(current&&current.state!=='disabled'){current.state='blocked';current.error=error;current.version++;await tx.put('destinations',current);}});}
  async maintain(){
    const stale=await this.store.read(tx=>tx.list<Delivery>('deliveries',{state:'sending',leaseUntil:{lt:nowISO()}},{limit:100}));
    for(const row of stale)await this.store.transaction(['workspace:'+row.workspaceId,'delivery:'+row.id],async tx=>{const d=await tx.get<Delivery>('deliveries',row.id);if(d?.state==='sending'&&d.leaseUntil!<nowISO()){d.state='unknown';d.nextAttemptAt=plusMs(nowISO(),60000);d.error='worker_interrupted';d.leaseUntil=undefined;if(d.kind!=='bot')await this.billing.releaseUsage(tx,d.workspaceId,d.id,{preserveUnknown:true});await tx.put('deliveries',d);}});
    const channels=await this.store.read(tx=>tx.list<Destination>('destinations',{kind:'channel',state:'active',verifiedAt:{lt:plusMs(nowISO(),-1800000)}},{limit:5}));
    for(const d of channels)try{await this.feeds.channelPermission(d.chatId,d.authorizedBy);await this.store.transaction(['workspace:'+d.workspaceId],async tx=>{const current=await tx.get<Destination>('destinations',d.id);if(current?.version===d.version){current.verifiedAt=nowISO();await tx.put('destinations',current);}});}catch{await this.blockDestination(d.id,'channel_permission_lost');}
    await this.cancelDeleting();
  }
  async cancelDeleting(){
    const workspaces=await this.store.read(tx=>tx.list<Workspace>('workspaces',{state:{in:['deleting','deleted']}}));
    for(const w of workspaces)try{
      await this.store.transaction(['billing:'+this.feeds.config.BOT_ID,'workspace:'+w.id],async tx=>{
        const current=await tx.get<Workspace>('workspaces',w.id);
        if(!current||!['deleting','deleted'].includes(current.state))return;
        const subscriptions=await tx.list<Subscription>('subscriptions',{workspaceId:w.id,botId:this.feeds.config.BOT_ID},{limit:2});
        if(subscriptions.length>1)return;
        const sub=subscriptions[0];
        if(sub){
          const checkout=await tx.get<Checkout>('checkouts',sub.checkoutId),owner=await tx.get<User>('users',current.ownerId);
          // Cancel only the recorded checkout owner, using this bot's original charge.
          if(!checkout||checkout.workspaceId!==w.id||checkout.botId!==this.feeds.config.BOT_ID||checkout.ownerId!==current.ownerId||checkout.payerId!==sub.payerId||checkout.payload!==sub.payload||owner?.telegramId!==sub.payerId)return;
          if(!sub.renewalCanceled){
            if(!sub.firstChargeId)return;
            const ok=await this.feeds.telegram.editUserStarSubscription({user_id:sub.payerId,telegram_payment_charge_id:sub.firstChargeId,is_canceled:true});
            if(ok!==true)return;
            await tx.put('subscriptions',{...sub,renewalCanceled:true,renewalState:'canceled' as const,canceledAt:nowISO()});
            await audit(tx,'workspace_subscription_canceled',w.id,undefined,{workspaceId:w.id,chargeId:sub.firstChargeId});
          }
        }
        // Late subscription facts never reactivate a deleted workspace or its resources.
        if(current.state==='deleted')return;
        for(const s of await tx.list<Entity>('sessions',{workspaceId:w.id}))await tx.remove('sessions',s.id);
        for(const b of await tx.list<SourceBinding>('sourceBindings',{workspaceId:w.id})){b.state='disabled';b.version++;await tx.put('sourceBindings',b);}
        for(const d of await tx.list<Destination>('destinations',{workspaceId:w.id})){d.state='disabled';d.version++;await tx.put('destinations',d);}
        for(const r of await tx.list<Route>('routes',{workspaceId:w.id})){r.state='paused';r.pauseReason='workspace_deleted';r.version++;await tx.put('routes',r);}
        current.state='deleted';await tx.put('workspaces',current);await audit(tx,'workspace_deleted',w.id);
      });
    }catch{ /* Keep the closing workspace and subscription for the next maintenance retry. */ }
  }
  async reconcile(){
    if(this.feeds.config.MODE==='demo'||!this.billing.billingEnabled)return;
    const cursor=await this.store.read(tx=>tx.get<Entity & {lastRun:string;offset:number}>('recovery','billing-reconciliation'));
    if(cursor&&cursor.lastRun>plusMs(nowISO(),-3600000))return;
    const result=await this.feeds.telegram.call<{transactions:Array<Record<string,any>>}>('getStarTransactions',{offset:cursor?.offset??0,limit:100});
    for(const transaction of result.transactions){
      const refunded=!!transaction.receiver,partner=transaction.source??transaction.receiver;
      if(partner?.type!=='user'||partner.transaction_type!=='invoice_payment')continue;
      const chargeId=String(transaction.id);if(refunded)await this.billing.recordRefund({chargeId,payload:partner.invoice_payload,payerId:String(partner.user.id),currency:'XTR',totalAmount:Math.abs(transaction.amount),refundedAt:transaction.date});
      else{const existing=await this.store.read(tx=>tx.list<Payment>('payments',{botId:this.feeds.config.BOT_ID,chargeId},{limit:1}));if(!existing.length)await this.billing.recordPayment({chargeId,payload:partner.invoice_payload,payerId:String(partner.user.id),currency:'XTR',totalAmount:Math.abs(transaction.amount),isRecurring:!!partner.subscription_period,paidAt:transaction.date});}
    }
    await this.store.transaction(['billing-reconciliation'],tx=>tx.put('recovery',{id:'billing-reconciliation',createdAt:cursor?.createdAt??nowISO(),lastRun:nowISO(),offset:result.transactions.length===100?(cursor?.offset??0)+90:0}));
  }
  async publishDemo(){if(this.feeds.config.MODE!=='demo')throw new Error('demo_disabled');await this.store.transaction(['demo-feed'],async tx=>{let f=await tx.get<DemoFeed>('recovery','demo-feed');if(!f)f={id:'demo-feed',createdAt:nowISO(),entries:[demoItem(2),demoItem(1)]};const entry=demoItem(f.entries.length+1);f.entries.unshift(entry);await tx.put('recovery',f);for(const r of await tx.list<Route>('routes',{state:'active'})){r.nextReleaseAt=nowISO();await tx.put('routes',r);}for(const s of await tx.list<Source>('sources')){s.nextPollAt=nowISO();await tx.put('sources',s);await emit(tx,'fetch',s.id);} });}
  async freezeRecovery(){const epoch=newId();await this.store.transaction(['recovery'],async tx=>{const refreshSources=new Set<string>();for(const r of await tx.list<Route>('routes')){if(r.state==='active'||r.state==='initializing'){await tx.put('recovery',{id:newId(),createdAt:nowISO(),workspaceId:r.workspaceId,epoch,routeId:r.id,oldCursor:r.cursor,state:'needs_review'});r.state='recovery';r.pauseReason='database_restored';r.baselineAfter=nowISO();r.version++;await tx.put('routes',r);refreshSources.add(r.sourceId);}}for(const id of refreshSources){const source=await tx.get<Source>('sources',id);if(source){source.nextPollAt=nowISO();await tx.put('sources',source);await emit(tx,'fetch',id);}}for(const d of await tx.list<Delivery>('deliveries',{state:{in:['pending','retry_wait','sending','unknown','needs_review','quota_deferred']}})){if(d.kind!=='bot')await this.billing.releaseUsage(tx,d.workspaceId,d.id,{preserveUnknown:['sending','unknown','needs_review'].includes(d.state)});d.state='needs_review';d.error='database_restored';await tx.put('deliveries',d);}await tx.put('recovery',{id:epoch,createdAt:nowISO(),kind:'recovery_epoch'});});return epoch;}
}
