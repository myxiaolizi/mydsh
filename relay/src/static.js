// 内置的极简页面。刻意不引框架、不引 CDN：
//  - 这个服务本身不做前端构建，assets 越少越不容易在宝塔那种环境里出问题；
//  - 登录页属于「安全界面」，外链 CDN 等于把凭据页的完整性外包给第三方。
// 所有动态内容都经 escapeHtml 转义；CSP 在 server.js 统一注入。

import { escapeHtml } from './util.js';

const STYLE = `
:root{color-scheme:light dark;--bg:#0f1115;--fg:#e6e8ee;--muted:#8b93a7;--line:#252a36;--accent:#4c8dff;--danger:#ff5c5c;--ok:#31c48d;--card:#171a21}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--fg:#171a21;--muted:#5b6474;--line:#e2e5ee;--card:#fff}}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:880px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:28px 0 10px}
p{margin:8px 0}
.sub{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:16px 0}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input,select{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:9px 16px;border:0;border-radius:7px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.55;cursor:not-allowed}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grow{flex:1}
.msg{margin-top:12px;padding:9px 12px;border-radius:7px;font-size:13px;display:none}
.msg.show{display:block}
.msg.err{background:rgba(255,92,92,.12);color:var(--danger)}
.msg.ok{background:rgba(49,196,141,.12);color:var(--ok)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:12px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}
.tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;border:1px solid var(--line)}
.tag.on{color:var(--ok);border-color:rgba(49,196,141,.4)}
.tag.off{color:var(--muted)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
`;

function layout(title, body, opts = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · mydsh-relay</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
${body}
<footer>mydsh-relay · 把内网 DSH 通过隧道暴露到公网的中转服务</footer>
</div>${opts.script ? `<script>${opts.script}</script>` : ''}</body></html>`;
}

/* ------------------------------------------------------------------ 首页 */

export function homePage({ config, user, stats, devices }) {
  const origin = config.publicUrl || `${config.tls?.enabled ? 'https' : 'http'}://${config.domain}`;
  const deviceRows = devices && devices.length
    ? devices
        .map(
          (d) => `<tr>
  <td><code>${escapeHtml(d.id)}</code><div class="sub">${escapeHtml(d.name)}</div></td>
  <td>${d.online ? '<span class="tag on">在线</span>' : '<span class="tag off">离线</span>'}</td>
  <td>${d.channels}</td>
  <td>${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('zh-CN') : '—'}</td>
  <td><a href="/d/${encodeURIComponent(d.id)}/">打开</a></td>
</tr>`,
        )
        .join('')
    : '';

  const authArea = user
    ? `<div class="card">
  <div class="row">
    <div class="grow">
      <div>已登录：<strong>${escapeHtml(user.username)}</strong></div>
      <div class="sub">会话有效期 ${Math.round(config.auth.tokenTtlSec / 3600)} 小时</div>
    </div>
    <a href="/devices"><button type="button">管理设备</button></a>
    <button class="ghost" id="logout" type="button">退出</button>
  </div>
</div>`
    : `<div class="card">
  <div>还没有登录。${config.allowRegistration ? '可以注册一个新账号，' : '本服务已关闭自助注册，'}然后用账号注册你的内网设备。</div>
  <div class="row" style="margin-top:14px">
    <a href="/login"><button type="button">登录</button></a>
    ${config.allowRegistration ? '<a href="/register"><button class="ghost" type="button">注册</button></a>' : ''}
  </div>
</div>`;

  return layout(
    '首页',
    `<h1>mydsh-relay</h1>
<p class="sub">把内网的 DeepSeek Harness 通过反向隧道安全地暴露到公网。</p>
${authArea}
<h2>服务概览</h2>
<div class="card">
  <table>
    <tr><th>在线设备</th><th>活跃通道</th><th>挂起 HTTP</th><th>累计 WS 会话</th></tr>
    <tr>
      <td>${stats.devices}</td>
      <td>${stats.channels}</td>
      <td>${stats.httpPending}</td>
      <td>${stats.wsOpened}</td>
    </tr>
  </table>
</div>
${deviceRows ? `<h2>我的设备</h2><div class="card"><table>
<tr><th>设备</th><th>状态</th><th>通道</th><th>最后在线</th><th></th></tr>
${deviceRows}
</table></div>` : ''}
<h2>怎么用</h2>
<div class="card">
  <p class="sub">在 DSH 里安装 <code>dsh-mydsh</code> 插件，把中转地址填成 <code>${escapeHtml(origin)}</code>，
  再填入设备页给出的 <code>deviceId</code> 与 <code>deviceSecret</code>，插件就会主动连上本服务建立隧道。
  之后任何拿到访问链接的人都可以通过 <code>${escapeHtml(origin)}/d/&lt;设备 ID&gt;/</code> 访问那台机器上的 DSH。</p>
</div>`,
    {
      script: `document.getElementById('logout')?.addEventListener('click',async()=>{
  await fetch('/api/logout',{method:'POST',credentials:'same-origin'});
  location.href='/';
});`,
    },
  );
}

/* ------------------------------------------------------------ 登录 / 注册 */

function authPage({ mode, allowRegistration }) {
  const isLogin = mode === 'login';
  return layout(
    isLogin ? '登录' : '注册',
    `<h1>${isLogin ? '登录' : '注册'}</h1>
<p class="sub">${isLogin ? '登录后可管理你的设备与隧道。' : '密码至少 10 位，注册后不会自动登录。'}</p>
<div class="card">
  <form id="f" autocomplete="on">
    <label for="u">用户名</label>
    <input id="u" name="username" autocomplete="username" maxlength="32" required>
    <label for="p">密码</label>
    <input id="p" name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" maxlength="128" required>
    ${
      isLogin
        ? ''
        : `<label for="p2">确认密码</label>
    <input id="p2" name="password2" type="password" autocomplete="new-password" maxlength="128" required>
    <label for="invite">邀请码（若站点开启）</label>
    <input id="invite" name="inviteCode" maxlength="128" autocomplete="off">`
    }
    <div class="row" style="margin-top:16px">
      <button type="submit" id="submit">${isLogin ? '登录' : '注册'}</button>
      <a class="sub" href="${isLogin ? '/register' : '/login'}">${isLogin ? (allowRegistration ? '没有账号？注册' : '') : '已有账号？登录'}</a>
    </div>
  </form>
  <div class="msg" id="msg"></div>
</div>`,
    {
      script: `const f=document.getElementById('f'),msg=document.getElementById('msg'),btn=document.getElementById('submit');
const show=(t,ok)=>{msg.textContent=t;msg.className='msg show '+(ok?'ok':'err')};
f.addEventListener('submit',async(e)=>{
  e.preventDefault();btn.disabled=true;
  const body={username:document.getElementById('u').value,password:document.getElementById('p').value};
  ${
    isLogin
      ? ''
      : `if(document.getElementById('p2').value!==body.password){show('两次输入的密码不一致');btn.disabled=false;return}
  body.inviteCode=document.getElementById('invite').value;`
  }
  try{
    const r=await fetch('${isLogin ? '/api/login' : '/api/register'}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),credentials:'same-origin'});
    const j=await r.json().catch(()=>({message:'服务端返回了非 JSON 响应'}));
    if(!r.ok){show(j.message||('HTTP '+r.status));btn.disabled=false;return}
    ${
      isLogin
        ? `show('登录成功，正在跳转…',true);location.href='${'/devices'}';`
        : `show('注册成功，正在跳转登录…',true);setTimeout(()=>location.href='/login',700);`
    }
  }catch(err){show('网络错误：'+err.message);btn.disabled=false}
});`,
    },
  );
}

export const loginPage = (opts) => authPage({ ...opts, mode: 'login' });
export const registerPage = (opts) => authPage({ ...opts, mode: 'register' });

/* ---------------------------------------------------------------- 设备页 */

export function devicesPage({ user, devices, deviceLimit, origin }) {
  const rows = devices.length
    ? devices
        .map(
          (d) => `<tr data-id="${escapeHtml(d.id)}">
  <td><code>${escapeHtml(d.id)}</code><div class="sub">${escapeHtml(d.name)}</div></td>
  <td>${d.online ? '<span class="tag on">在线</span>' : '<span class="tag off">离线</span>'}</td>
  <td>${d.revoked ? '<span class="tag off">已吊销</span>' : '正常'}</td>
  <td>${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('zh-CN') : '—'}</td>
  <td>
    <div class="row">
      <button class="ghost" data-act="rename" type="button">改名</button>
      <button class="ghost" data-act="rotate" type="button">换密钥</button>
      <button class="ghost" data-act="delete" type="button">删除</button>
    </div>
  </td>
</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="sub">还没有设备，先在下面注册一个。</td></tr>';

  return layout(
    '设备',
    `<h1>设备管理</h1>
<p class="sub">每台设备代表一个内网 DSH 实例。deviceSecret 只在创建/轮换时显示一次，请立刻填入插件配置。</p>

<div class="card">
  <table>
    <tr><th>设备</th><th>隧道</th><th>凭据</th><th>最后在线</th><th>操作</th></tr>
    ${rows}
  </table>
</div>

<h2>注册新设备</h2>
<div class="card">
  <label for="name">设备名（便于自己辨认，可留空）</label>
  <input id="name" maxlength="48" placeholder="例如：家里的小主机">
  <div class="row" style="margin-top:14px">
    <button id="create" type="button">注册设备</button>
    <span class="sub">已用 ${devices.length} / ${deviceLimit ?? '不限'} 台</span>
  </div>
  <div class="msg" id="msg"></div>
  <div id="secretBox" style="display:none">
    <h2>凭据（只显示这一次）</h2>
    <pre id="secret"></pre>
    <div class="sub">关掉本页后无法再看到明文。丢了就点「换密钥」重新生成，旧密钥立即失效。</div>
  </div>
</div>

<h2>访问地址</h2>
<div class="card">
  <p class="sub">设备上线后，把下面形式的链接发给访客：</p>
  <pre>${escapeHtml(origin)}/d/&lt;设备 ID&gt;/</pre>
</div>`,
    {
      script: `const msg=document.getElementById('msg');
const show=(t,ok)=>{msg.textContent=t;msg.className='msg show '+(ok?'ok':'err')};
const token=()=>localStorage.getItem('mydsh.token')||'';
async function api(path,opts={}){
  opts.headers=Object.assign({'content-type':'application/json'},opts.headers||{});
  const r=await fetch(path,Object.assign({credentials:'same-origin'},opts));
  const j=await r.json().catch(()=>({message:'HTTP '+r.status}));
  if(!r.ok)throw new Error(j.message||('HTTP '+r.status));
  return j;
}
document.getElementById('create').addEventListener('click',async(e)=>{
  e.target.disabled=true;
  try{
    const j=await api('/api/devices',{method:'POST',body:JSON.stringify({name:document.getElementById('name').value})});
    document.getElementById('secret').textContent='deviceId:     '+j.device.id+'\\ndeviceSecret: '+j.deviceSecret;
    document.getElementById('secretBox').style.display='block';
    show('设备已创建，请复制上面的凭据。',true);
    setTimeout(()=>location.reload(),4000);
  }catch(err){show(err.message)}finally{e.target.disabled=false}
});
document.querySelectorAll('button[data-act]').forEach(b=>{
  b.addEventListener('click',async()=>{
    const id=b.closest('tr').dataset.id, act=b.dataset.act;
    try{
      if(act==='rename'){
        const name=prompt('新设备名（最多 48 字符）');if(name===null)return;
        await api('/api/devices/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({name})});
        location.reload();return;
      }
      if(act==='rotate'){
        if(!confirm('重新生成密钥后，使用旧密钥的插件会立刻掉线。继续？'))return;
        const j=await api('/api/devices/'+encodeURIComponent(id)+'/rotate',{method:'POST'});
        document.getElementById('secret').textContent='deviceId:     '+id+'\\ndeviceSecret: '+j.deviceSecret;
        document.getElementById('secretBox').style.display='block';
        show('密钥已轮换，请立刻更新插件配置。',true);return;
      }
      if(act==='delete'){
        if(!confirm('删除设备会同时吊销其凭据并断开隧道。继续？'))return;
        await api('/api/devices/'+encodeURIComponent(id),{method:'DELETE'});
        location.reload();return;
      }
    }catch(err){show(err.message)}
  });
});`,
    },
  );
}

/* ---------------------------------------------------------------- 错误页 */

const STATUS_TITLE = {
  400: '请求有误',
  401: '需要登录',
  403: '没有权限',
  404: '页面不存在',
  405: '方法不被允许',
  413: '请求体过大',
  429: '请求过于频繁',
  500: '服务端错误',
  502: '隧道异常',
  503: '设备离线',
  504: '设备响应超时',
};

export function errorPage({ status, code, message, deviceId, origin, hint }) {
  const title = STATUS_TITLE[status] || '出错了';
  const offline = code === 'EOFFLINE';
  return layout(
    `${status} ${title}`,
    `<h1>${status} · ${escapeHtml(title)}</h1>
<div class="card">
  <p>${escapeHtml(message || '发生了未知问题。')}</p>
  ${deviceId ? `<p class="sub">设备 ID：<code>${escapeHtml(deviceId)}</code></p>` : ''}
  ${
    offline
      ? `<h2>可能的原因</h2>
  <ul class="sub">
    <li>对方内网的 DSH 没有运行，或插件未启动。</li>
    <li>插件配置里的中转地址、deviceId 或 deviceSecret 不正确。</li>
    <li>对方的设备刚重启，隧道正在重连（通常 10 秒内恢复）。</li>
  </ul>
  <p class="sub">请让设备所有者在 <a href="${escapeHtml(origin)}/devices">设备页</a> 确认隧道状态为「在线」。</p>`
      : ''
  }
  ${hint ? `<p class="sub">${escapeHtml(hint)}</p>` : ''}
  <div class="row" style="margin-top:16px">
    <a href="/"><button class="ghost" type="button">返回首页</button></a>
    ${deviceId ? `<button type="button" onclick="location.reload()">重新加载</button>` : ''}
  </div>
</div>`,
  );
}
