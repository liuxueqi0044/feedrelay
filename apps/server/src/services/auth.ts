import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { AppError, newId, nowISO, plusMs, requireWorkspace, type Actor, type Entity, type Session, type Store, type User, type Workspace } from '@feedrelay/core';
import type { Config } from '../config.js';
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export const safeEqual=(a:string,b:string)=>{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
interface Flow extends Entity { state:string;cookieHash:string;verifier:string;nonce:string;expiresAt:string }
export function validateMiniApp(raw:string,token:string,at=Date.now()):{id:string;name:string}{
  const params=new URLSearchParams(raw);const keys=[...params.keys()];if(new Set(keys).size!==keys.length)throw new AppError('invalid_login','Invalid Telegram login.',401);
  const supplied=params.get('hash');params.delete('hash');if(!supplied||! /^[a-f0-9]{64}$/.test(supplied))throw new AppError('invalid_login','Invalid Telegram login.',401);
  const data=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const key=createHmac('sha256','WebAppData').update(token).digest();const expected=createHmac('sha256',key).update(data).digest('hex');
  const time=Number(params.get('auth_date'))*1000;
  if(!safeEqual(expected,supplied)||!Number.isFinite(time)||time>at+30000||at-time>300000)throw new AppError('invalid_login','Telegram login expired or is invalid.',401);
  const user=JSON.parse(params.get('user')??'null') as {id?:number;first_name?:string;last_name?:string}|null;
  if(!user?.id||!Number.isSafeInteger(user.id)||user.id<0)throw new AppError('invalid_login','Invalid Telegram identity.',401);
  return {id:String(user.id),name:[user.first_name,user.last_name].filter(Boolean).join(' ').slice(0,100)||'Telegram user'};
}
export class AuthService {
  private oidcConfig?:Promise<oidc.Configuration>;
  constructor(readonly store:Store,readonly config:Config){}
  async identity(telegramId:string,name:string,started=false,oidcSub?:string){
    return this.store.transaction(['identity:'+telegramId],async tx=>{
      let user=(await tx.list<User>('users',{telegramId}))[0];
      if(!user){user={id:newId(),createdAt:nowISO(),telegramId,name,privateChatStarted:started,oidcSub};await tx.put('users',user);}else{user.name=name||user.name;user.privateChatStarted ||= started;if(oidcSub)user.oidcSub=oidcSub;await tx.put('users',user);}
      let workspace=(await tx.list<Workspace>('workspaces',{ownerId:user.id}))[0];
      if(!workspace){workspace={id:newId(),createdAt:nowISO(),ownerId:user.id,name:`${user.name}'s workspace`,state:'active',freeAnchor:nowISO(),version:1};await tx.put('workspaces',workspace);}
      if(workspace.state!=='active')throw new AppError('workspace_deleted','This workspace has been deleted. Contact support to restore access.',403);
      return {user,workspace,actor:{userId:user.id,workspaceId:workspace.id,telegramId} satisfies Actor};
    });
  }
  async login(telegramId:string,name:string,oidcSub?:string){
    const account=await this.identity(telegramId,name,false,oidcSub);const token=secret();const csrf=secret();
    const session:Session={id:newId(),createdAt:nowISO(),workspaceId:account.workspace.id,userId:account.user.id,tokenHash:hash(token),csrf,expiresAt:plusMs(nowISO(),12*3600000)};
    await this.store.transaction(['session:'+session.id],tx=>tx.put('sessions',session));return {...account,token,csrf};
  }
  async resolve(token?:string){
    if(!token)throw new AppError('unauthorized','Sign in to continue.',401);
    return this.store.read(async tx=>{
      const session=(await tx.list<Session>('sessions',{tokenHash:hash(token)}))[0];if(!session||session.expiresAt<nowISO())throw new AppError('unauthorized','Your session expired. Sign in again.',401);
      const user=await tx.get<User>('users',session.userId);if(!user)throw new AppError('unauthorized','Sign in to continue.',401);
      const actor:Actor={userId:user.id,workspaceId:session.workspaceId,telegramId:user.telegramId};const workspace=await requireWorkspace(tx,actor);
      return {user,workspace,actor,session,csrf:session.csrf};
    });
  }
  async logout(token?:string){if(!token)return;await this.store.transaction(['session:'+hash(token)],async tx=>{for(const s of await tx.list<Session>('sessions',{tokenHash:hash(token)}))await tx.remove('sessions',s.id);});}
  private getOidc(){
    if(!this.config.TELEGRAM_CLIENT_ID||!this.config.TELEGRAM_CLIENT_SECRET)throw new AppError('login_not_configured','Telegram browser login is not configured. Open the Mini App from the bot.',503);
    return this.oidcConfig??=oidc.discovery(new URL('https://oauth.telegram.org'),this.config.TELEGRAM_CLIENT_ID,this.config.TELEGRAM_CLIENT_SECRET);
  }
  async startOidc(){
    const client=await this.getOidc();const state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier(),cookie=secret();
    await this.store.transaction(['oidc:'+state],tx=>tx.put<Flow>('authFlows',{id:newId(),createdAt:nowISO(),state,nonce,verifier,cookieHash:hash(cookie),expiresAt:plusMs(nowISO(),600000)}));
    const url=oidc.buildAuthorizationUrl(client,{redirect_uri:this.config.PUBLIC_URL+'/api/auth/telegram/callback',scope:'openid profile',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'});
    return {url:String(url),cookie};
  }
  async completeOidc(query:Record<string,string>,cookie?:string){
    const state=query.state;if(!state||!cookie)throw new AppError('invalid_login','Login could not be verified.',401);
    const flow=await this.store.transaction(['oidc:'+state],async tx=>{const f=(await tx.list<Flow>('authFlows',{state}))[0];if(!f||f.expiresAt<nowISO()||!safeEqual(f.cookieHash,hash(cookie)))throw new AppError('invalid_login','Login expired. Try again.',401);await tx.remove('authFlows',f.id);return f;});
    const url=new URL(this.config.PUBLIC_URL+'/api/auth/telegram/callback');for(const[k,v]of Object.entries(query))url.searchParams.set(k,v);
    const result=await oidc.authorizationCodeGrant(await this.getOidc(),url,{pkceCodeVerifier:flow.verifier,expectedState:flow.state,expectedNonce:flow.nonce});const claims=result.claims();
    if(!claims||!claims.sub||(!Number.isSafeInteger(claims.id)&&typeof claims.id!=='string'))throw new AppError('invalid_login','Telegram identity is unavailable.',401);
    const id=String(claims.id);if(!/^\d+$/.test(id))throw new AppError('invalid_login','Invalid Telegram identity.',401);
    return this.login(id,typeof claims.name==='string'?claims.name:'Telegram user',claims.sub);
  }
}
