import { config } from '../config.js';
import { TelegramClient } from '../infrastructure/telegram.js';
if(config.MODE!=='production'||!config.BOT_TOKEN||!config.WEBHOOK_SECRET)throw new Error('Configure a production bot before setup.');
const bot=new TelegramClient(config.BOT_TOKEN);
const me=await bot.call<{id:number;username:string}>('getMe',{});if(String(me.id)!==config.BOT_ID)throw new Error('BOT_ID does not match BOT_TOKEN.');
await bot.call('setWebhook',{url:config.PUBLIC_URL+'/api/telegram/webhook',secret_token:config.WEBHOOK_SECRET,allowed_updates:['message','pre_checkout_query','subscription','my_chat_member','chat_member'],drop_pending_updates:false});
await bot.call('setMyCommands',{commands:[{command:'start',description:'Configure your feed routes'},{command:'help',description:'How FeedRelay works'},{command:'status',description:'Delivery usage and plan'},{command:'pause',description:'Pause all routes'},{command:'sources',description:'Manage feeds'},{command:'destinations',description:'Connect Telegram destinations'},{command:'plan',description:'View your plan'},{command:'support',description:'Get help'},{command:'paysupport',description:'Payment support'},{command:'terms',description:'Subscription terms'}]});
await bot.call('setChatMenuButton',{menu_button:{type:'web_app',text:'Dashboard',web_app:{url:config.PUBLIC_URL+'/dashboard'}}});
console.log(`Webhook and commands configured for @${me.username}.`);
