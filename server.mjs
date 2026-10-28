const ROOM_NAMES=new Set(['Sala','Cozinha','Quarto','Casa de banho','Jardim/Praia']);
const PERSONA='És a Noa, uma personagem virtual da aplicação Noa de Bolso. Conversa em português de Portugal, com simpatia, naturalidade e respostas curtas, normalmente duas ou três frases. Responde ao que a pessoa disse e mantém o contexto da conversa. Não repitas simplesmente a mensagem. Não afirmes ver, ouvir ou fazer coisas fora do texto e do contexto recebidos. Não afirmes executar ações na aplicação, mudar indicadores, roupa ou luzes: essas funções não estão ligadas à conversa.';

function json(data,status=200){
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
}
function failure(code,message,status){return json({error:{code,message}},status);}
function extractReply(data){
  if(typeof data.output_text==='string'&&data.output_text.trim())return data.output_text.trim();
  return (Array.isArray(data.output)?data.output:[])
    .flatMap(item=>Array.isArray(item.content)?item.content:[])
    .map(part=>part.type==='output_text'?part.text:part.type==='refusal'?part.refusal:'')
    .filter(part=>typeof part==='string').join('\n').trim();
}
async function answerNoa(request,env){
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)return failure('FORBIDDEN','Pedido não autorizado.',403);
  if(!request.headers.get('oai-authenticated-user-id'))return failure('SIGN_IN_REQUIRED','Abre a aplicação com a tua conta do ChatGPT.',401);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return failure('INVALID_CONTENT','Formato de mensagem inválido.',415);
  if(Number(request.headers.get('content-length'))>24000)return failure('MESSAGE_TOO_LONG','A mensagem é demasiado longa.',413);
  let body;
  try{
    const text=await request.text();
    if(text.length>20000)return failure('MESSAGE_TOO_LONG','A mensagem é demasiado longa.',413);
    body=JSON.parse(text);
  }catch{return failure('INVALID_JSON','Não foi possível ler a mensagem.',400);}
  if(!body||typeof body.message!=='string'||!body.message.trim()||body.message.length>2000)
    return failure('INVALID_MESSAGE','Diz uma frase com até 2000 caracteres.',400);
  if(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(body.message))
    return failure('SECRET_IN_MESSAGE','A mensagem parece conter uma chave API. Introduz a chave apenas em OPENAI_API_KEY no painel do servidor.',400);
  if(typeof env.OPENAI_API_KEY!=='string'||!env.OPENAI_API_KEY.trim())
    return failure('OPENAI_NOT_CONFIGURED','A ligação da Noa à OpenAI ainda precisa de concluir a configuração segura da chave da API.',503);
  const history=(Array.isArray(body.history)?body.history:[]).slice(-8)
    .filter(item=>item&&['user','assistant'].includes(item.role)&&typeof item.content==='string'&&item.content.trim())
    .map(item=>({role:item.role,content:item.content.slice(0,2000)}));
  const room=ROOM_NAMES.has(body.room)?body.room:'Sala';
  let upstream;
  try{
    upstream=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{authorization:'Bearer '+env.OPENAI_API_KEY,'content-type':'application/json'},
      body:JSON.stringify({
        model:env.OPENAI_MODEL||'gpt-4.1-mini',
        instructions:PERSONA+' O ambiente atual da aplicação é: '+room+'.',
        input:[...history,{role:'user',content:body.message.trim()}],
        max_output_tokens:400,
        store:false
      }),
      signal:AbortSignal.timeout(30000)
    });
  }catch(error){
    return failure('UPSTREAM_UNAVAILABLE',error.name==='TimeoutError'?'A resposta demorou demasiado. Tenta novamente.':'Não foi possível contactar a OpenAI. Tenta novamente.',504);
  }
  if(!upstream.ok){
    if(upstream.status===401||upstream.status===403)return failure('OPENAI_ACCESS','A chave da OpenAI precisa de ser verificada nas definições do servidor.',502);
    if(upstream.status===429)return failure('OPENAI_LIMIT','A OpenAI atingiu um limite de utilização ou de saldo. É necessário verificar a conta da API.',429);
    return failure('OPENAI_ERROR','A OpenAI não conseguiu responder agora. Tenta novamente.',502);
  }
  let data;
  try{data=await upstream.json();}catch{return failure('INVALID_UPSTREAM_RESPONSE','Não foi possível ler a resposta da Noa.',502);}
  const reply=extractReply(data);
  if(!reply)return failure('EMPTY_REPLY','A Noa não recebeu uma resposta completa. Tenta novamente.',502);
  return json({reply:reply.slice(0,6000)});
}

export function createHandler(assets={}){
  const decoded=new Map();
  const usage=new Map();
  return {
    async fetch(request,env={}){
      const path=new URL(request.url).pathname;
      if(path==='/api/noa/session'){
        if(request.method!=='GET')return failure('METHOD_NOT_ALLOWED','Método não permitido.',405);
        const userId=request.headers.get('oai-authenticated-user-id');
        if(!userId)return failure('SIGN_IN_REQUIRED','Abre a aplicação com a tua conta do ChatGPT.',401);
        return json({userId,configured:typeof env.OPENAI_API_KEY==='string'&&Boolean(env.OPENAI_API_KEY.trim())});
      }
      if(path==='/api/noa/status'){
        if(request.method!=='GET')return failure('METHOD_NOT_ALLOWED','Método não permitido.',405);
        return json({configured:typeof env.OPENAI_API_KEY==='string'&&Boolean(env.OPENAI_API_KEY.trim())});
      }
      if(path==='/api/noa'){
        if(request.method!=='POST')return failure('METHOD_NOT_ALLOWED','Método não permitido.',405);
        const userId=request.headers.get('oai-authenticated-user-id');
        if(userId&&env.OPENAI_API_KEY){
          const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
          let current=usage.get(userId);
          if(!current||current.day!==day)current={day,total:0,recent:[]};
          current.recent=current.recent.filter(time=>now-time<60000);
          if(current.total>=100||current.recent.length>=5)return failure('USAGE_LIMIT','Limite de utilização atingido. Aguarda antes de voltar a enviar.',429);
          current.total++;current.recent.push(now);usage.set(userId,current);
        }
        return answerNoa(request,env);
      }
      if(!['GET','HEAD'].includes(request.method))return new Response('Método não permitido',{status:405});
      const key=path==='/'?'/index.html':path;
      const asset=assets[key];
      if(!asset)return new Response('Não encontrado',{status:404});
      const headers={
        'content-type':asset.type,
        'cache-control':asset.type.startsWith('image/')?'private, max-age=3600':'no-cache',
        etag:asset.etag,
        'x-content-type-options':'nosniff',
        'permissions-policy':'microphone=(self)'
      };
      if(request.headers.get('if-none-match')===asset.etag)return new Response(null,{status:304,headers});
      if(request.method==='HEAD')return new Response(null,{headers});
      if(!decoded.has(key)){
        const binary=atob(asset.data),bytes=new Uint8Array(binary.length);
        for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        decoded.set(key,bytes);
      }
      return new Response(decoded.get(key),{headers});
    }
  };
}


import {createServer} from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const digest=value=>createHash('sha256').update(value).digest('hex');
const compare=(a,b)=>timingSafeEqual(Buffer.from(digest(a),'hex'),Buffer.from(digest(b),'hex'));
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const error=(code,message,status)=>reply({error:{code,message}},status);

export function createBackend(env=process.env){
  const sessions=new Map(),attempts=new Map(),usage=new Map();
  const handler=createHandler();
  const allowedOrigin=env.ALLOWED_ORIGIN||'';
  const configured=typeof env.NOA_ACCESS_PASSWORD==='string'&&env.NOA_ACCESS_PASSWORD.length>=16;
  async function handle(request,clientIp='local'){
    const url=new URL(request.url),origin=request.headers.get('origin');
    if(origin&&origin!==allowedOrigin)return error('FORBIDDEN','Origem não autorizada.',403);
    let response;
    if(request.method==='OPTIONS'){
      response=new Response(null,{status:204});
    }else if(url.pathname==='/health'&&request.method==='GET'){
      response=reply({ok:true,configured:Boolean(env.OPENAI_API_KEY?.trim())&&configured});
    }else if(url.pathname==='/api/login'&&request.method==='POST'){
      if(!configured)return error('AUTH_NOT_CONFIGURED','O servidor precisa de configurar NOA_ACCESS_PASSWORD com pelo menos 16 caracteres.',503);
      const now=Date.now();
      let attempt=attempts.get(clientIp);
      if(!attempt||now-attempt.since>900000)attempt={since:now,count:0};
      if(attempt.count>=5)return error('LOGIN_LIMIT','Demasiadas tentativas. Aguarda 15 minutos.',429);
      attempt.count++;attempts.set(clientIp,attempt);
      let data;try{data=await request.json();}catch{return error('INVALID_MESSAGE','Pedido inválido.',400);}
      if(!data||typeof data.password!=='string'||!compare(data.password,env.NOA_ACCESS_PASSWORD))return error('SIGN_IN_REQUIRED','Palavra-passe incorreta.',401);
      attempts.delete(clientIp);
      const token=randomBytes(32).toString('base64url'),expiresAt=now+3600000;
      sessions.set(digest(token),{userId:'owner',expiresAt});
      // A chave da OpenAI nunca é devolvida. Este token é apenas de sessão da app.
      response=reply({token,expiresAt,userId:'owner'});
    }else{
      const token=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';
      const session=sessions.get(digest(token));
      if(!session||session.expiresAt<=Date.now()){
        sessions.delete(digest(token));
        return withCors(error('LOGIN_REQUIRED','Introduz a palavra-passe da tua aplicação.',401),origin);
      }
      if(url.pathname==='/api/noa/session'&&request.method==='GET'){
        response=reply({userId:session.userId,configured:Boolean(env.OPENAI_API_KEY?.trim())});
      }else if(url.pathname==='/api/logout'&&request.method==='POST'){
        sessions.delete(digest(token));response=reply({ok:true});
      }else if(url.pathname==='/api/noa'&&request.method==='POST'){
        const now=Date.now(),today=new Date(now).toISOString().slice(0,10);
        let user=usage.get(session.userId);
        if(!user||user.day!==today)user={day:today,total:0,recent:[]};
        user.recent=user.recent.filter(t=>now-t<60000);
        if(user.total>=100||user.recent.length>=5)return withCors(error('USAGE_LIMIT','Limite atingido: até 5 pedidos por minuto e 100 por dia. Tenta mais tarde.',429),origin);
        // Reserva antes do pedido para evitar ultrapassagem por envios simultâneos.
        user.total++;user.recent.push(now);usage.set(session.userId,user);
        const headers=new Headers(request.headers);
        headers.delete('origin');headers.delete('authorization');
        headers.set('oai-authenticated-user-id',session.userId);
        response=await handler.fetch(new Request(request,{headers}),env);
      }else response=error('NOT_FOUND','Não encontrado.',404);
    }
    return withCors(response,origin);
  }
  function withCors(response,origin){
    const headers=new Headers(response.headers);
    headers.set('x-content-type-options','nosniff');headers.set('cache-control','no-store');
    if(origin===allowedOrigin){
      headers.set('access-control-allow-origin',allowedOrigin);headers.set('vary','Origin');
      headers.set('access-control-allow-methods','GET,POST,OPTIONS');headers.set('access-control-allow-headers','Authorization,Content-Type');
    }
    return new Response(response.body,{status:response.status,headers});
  }
  return {fetch:async(request,ip)=>{
    const now=Date.now();
    for(const [key,value] of sessions)if(value.expiresAt<=now)sessions.delete(key);
    try{return withCors(await handle(request,ip),request.headers.get('origin'));}catch{return withCors(error('SERVER_ERROR','O servidor não conseguiu concluir o pedido.',500),request.headers.get('origin'));}
  }};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const backend=createBackend();
  createServer(async(req,res)=>{
    try{
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>24000){res.writeHead(413);res.end('Pedido demasiado grande');return;}chunks.push(chunk);}
      const request=new Request('http://backend.local'+req.url,{
        method:req.method,headers:req.headers,
        body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)
      });
      const response=await backend.fetch(request,req.socket.remoteAddress||'unknown');
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch{
      if(!res.headersSent)res.writeHead(400,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({error:{code:'INVALID_REQUEST',message:'Pedido inválido.'}}));
    }
  }).listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Backend Noa de Bolso iniciado. Segredos não são registados.'));
}
