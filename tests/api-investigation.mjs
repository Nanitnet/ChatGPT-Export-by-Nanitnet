// Read-only investigation of a fresh guest test chat. Never reads/logs cookies,
// request headers, bootstrap data, token values or raw response bodies.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {firefox}=require(process.env.PLAYWRIGHT_MODULE);
const browser=await firefox.launch({headless:true});
const observed=[];
const pending=[];
const report={profile:'fresh guest; no user account',observed};
const redact=path=>path.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi,'<id>');
try {
  const page=await browser.newPage();
  page.on('response',response=>{
    const url=new URL(response.url());
    if(url.origin!=='https://chatgpt.com'||!(/conversation|auth\/session/.test(url.pathname)))return;
    pending.push((async()=>{
      observed.push({path:redact(url.pathname),method:response.request().method(),status:response.status(),contentType:await response.headerValue('content-type')});
    })());
  });
  await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:25000});
  const reject=page.getByRole('button',{name:'Reject non-essential',exact:true});
  if(await reject.isVisible())await reject.click();
  await page.waitForTimeout(2000);
  const prompt='Reply with exactly: API_EXPORT_PROBE_OK';
  await page.locator('[role=textbox][contenteditable=true],textarea').first().fill(prompt);
  const send=page.locator('[data-testid="send-button"],button[aria-label="Send"],button[aria-label="Send message"],button[aria-label="Send prompt"]');
  for(const button of await send.all())if(await button.isVisible()&&await button.isEnabled()){await button.click();break;}
  await page.waitForFunction(()=>{
    const text=document.body.innerText;
    const assistant=[...document.querySelectorAll('[data-message-role="assistant"]')].at(-1);
    return (text.match(/API_EXPORT_PROBE_OK/g)||[]).length>=2&&(!assistant||assistant.hasAttribute('data-message-complete'));
  },null,{timeout:45000});
  report.chatCreated=true;
  report.liveProbes=await page.evaluate(async()=>{
    const id=location.pathname.match(/\/(?:c|uc)\/([a-f0-9-]{36})\/?$/i)?.[1];
    if(!id)return {error:'test chat ID unavailable'};
    const results=[];
    async function probe(path,token=null){
      try {
        const headers={Accept:'application/json'};
        if(token)headers.Authorization=`Bearer ${token}`;
        const response=await fetch(path,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',headers,signal:AbortSignal.timeout(15000)});
        const item={path:path.replace(id,'<id>'),status:response.status(),contentType:response.headers.get('content-type')};
        if(response.ok&&item.contentType?.includes('application/json')){
          const data=await response.json();
          item.mappingNodes=data.mapping&&typeof data.mapping==='object'?Object.keys(data.mapping).length:0;
          item.hasCurrentNode=typeof data.current_node==='string';
        }
        results.push(item);
      }catch{results.push({path:path.replace(id,'<id>'),error:'network, redirect or timeout'});}
    }
    await probe(`/backend-api/conversation/${id}`);
    await probe(`/backend-anon/conversation/${id}`);
    let token=null;
    try {
      const session=await fetch('/api/auth/session',{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
      const data=session.ok?await session.json():null;
      token=typeof data?.accessToken==='string'?data.accessToken:null;
      results.push({path:'/api/auth/session',status:session.status(),hasAccessToken:!!token});
    }catch{results.push({path:'/api/auth/session',error:'network, redirect or timeout'});}
    if(token)await probe(`/backend-api/conversation/${id}`,token);
    token=null;
    return results;
  });
  // A reload reveals any ordinary GET used by the current frontend; do not read HTML/bootstrap.
  await page.reload({waitUntil:'domcontentloaded',timeout:25000});
  await page.waitForTimeout(1500);
  await Promise.allSettled(pending);
  report.completed=true;
}catch(error){report.error=error.name+': '+String(error.message).split('\n')[0];}
finally{
  await browser.close();
  await writeFile(new URL('../test-results/api-investigation/report.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
