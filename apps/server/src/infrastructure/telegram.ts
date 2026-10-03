export class TelegramError extends Error {
  constructor(public kind:'retry'|'blocked'|'permanent'|'unknown',public code:string,public retryAfter?:number){super(code);this.name='TelegramError';}
}
export interface MessageResult { message_id: number; date: number }
export interface TelegramTransport { call<T>(method:string,body:Record<string,unknown>):Promise<T> }
export class TelegramClient implements TelegramTransport {
  constructor(private token?:string,readonly demo=false,private fetcher:typeof fetch=fetch){}
  async call<T>(method:string,body:Record<string,unknown>):Promise<T>{
    if(this.demo){
      if(method==='sendMessage')return {message_id:Math.floor(Math.random()*1e8),date:Math.floor(Date.now()/1000)} as T;
      if(method==='getMe')return {id:0,username:'FeedRelayDemoBot'} as T;
      if(method==='getChat')return {id:body.chat_id,type:'channel',title:'Demo channel'} as T;
      if(method==='getChatMember')return {status:'administrator',can_post_messages:true} as T;
      if(method==='getStarTransactions')return {transactions:[]} as T;
      if(method==='createInvoiceLink')throw new TelegramError('permanent','demo_billing_disabled');
      return true as T;
    }
    if(!this.token)throw new TelegramError('permanent','bot_not_configured');
    try{
      const response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      let data:{ok:boolean;result:T;error_code?:number;parameters?:{retry_after?:number};description?:string};
      try{data=await response.json() as typeof data;}catch{throw new TelegramError(method==='sendMessage'?'unknown':'retry','invalid_platform_response');}
      if(!data.ok){
        if(data.error_code===429)throw new TelegramError('retry','telegram_rate_limited',data.parameters?.retry_after??30);
        if(data.error_code===403||/not enough rights|chat not found|bot is not a member/i.test(data.description??''))throw new TelegramError('blocked','telegram_permission_lost');
        if((data.error_code??response.status)>=500)throw new TelegramError(method==='sendMessage'?'unknown':'retry','telegram_unavailable');
        throw new TelegramError('permanent','telegram_request_rejected');
      }
      return data.result;
    }catch(e){if(e instanceof TelegramError)throw e;throw new TelegramError(method==='sendMessage'?'unknown':'retry','telegram_connection_failed');}
  }
  editUserStarSubscription(input:{user_id:string;telegram_payment_charge_id:string;is_canceled:boolean}){return this.call<boolean>('editUserStarSubscription',input);}
}
