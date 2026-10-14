/* cup-translate · UI 重构原型 交互层（纯静态演示） */
const $=(s,r=document)=>r.querySelector(s);const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const I={
 search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
 sliders:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h12M20 17h0"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="17" r="2"/></svg>',
 translate:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M8.5 6c0 4-2 7-5 9"/><path d="M6 11c1.5 2.5 3.5 4 6 5"/><path d="m13 20 3.5-8 3.5 8"/><path d="M14.4 17.2h4.2"/></svg>',
 ocr:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><path d="M7.5 12h9"/></svg>',
 keyboard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6 13h.01M18 13h.01M9 16.5h6"/></svg>',
 puzzle:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5a2 2 0 0 1 4 0V5h2.5a1.5 1.5 0 0 1 1.5 1.5V9h1.5a2 2 0 0 1 0 4H18v2.5a1.5 1.5 0 0 1-1.5 1.5H14v1.5a2 2 0 0 1-4 0V17H7.5A1.5 1.5 0 0 1 6 15.5V13H4.5a2 2 0 0 1 0-4H6V6.5A1.5 1.5 0 0 1 7.5 5H10z"/></svg>',
 history:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V10H9"/><path d="M12 8v4.5l3 1.8"/></svg>',
 cloud:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18.5A4.5 4.5 0 0 1 6.3 9.6 6 6 0 0 1 18 9.7a4.4 4.4 0 0 1-.6 8.8"/></svg>',
 info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/></svg>',
 pip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/></svg>',
 close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
 pin:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.5h6l-.8 5.2 2.6 2.6H7.2l2.6-2.6z"/><path d="M12 11.3V20"/></svg>',
 copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M15 6.2V5.5A2.5 2.5 0 0 0 12.5 3H5.5A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15h.7"/></svg>',
 speaker:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.8 7a7 7 0 0 1 0 10"/></svg>',
 star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>',
 swap:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4 4 7.5 7.5 11"/><path d="M4 7.5h13"/><path d="M16.5 13 20 16.5 16.5 20"/><path d="M20 16.5H7"/></svg>',
 chev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
 grip:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
 settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.5 12a7.5 7.5 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2l-.4-2.6h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2z"/></svg>',
 alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16.2h.01"/></svg>',
 check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
 refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5.5V11h-5.5"/></svg>',
 trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/></svg>',
 plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
 moon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.2A8.5 8.5 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2z"/></svg>',
 sun:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/></svg>',
 monitor:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/></svg>'
};const svg=n=>I[n]||'';
const NAV=[['general','常规','sliders','1'],['translate','翻译','translate','2'],['recognize','识别','ocr','3'],['hotkey','快捷键','keyboard','4'],['service','服务与插件','puzzle','5'],['history','历史记录','history','6'],['backup','备份与同步','cloud','7'],['about','关于','info','8']];

function renderNav(key, focus){
  const el=$('#nav');
  el.innerHTML=NAV.map(function(x){const id=x[0],label=x[1],icon=x[2],n=x[3];
    return '<button class="nav-item'+(id===key?' on':'')+'" data-nav="'+id+'">'+I[icon]+'<span class="txt">'+label+'</span><span class="k">'+n+'</span></button>';}).join('');
  bindNav('#nav');
  $('#nav-di').innerHTML=NAV.map(function(x){return '<button class="nav-item'+(x[0]===key?' on':'')+'" data-nav="'+x[0]+'">'+I[x[2]]+'<span class="txt">'+x[1]+'</span></button>';}).join('');
  bindNav('#nav-di');
  $$('#nav .nav-item').forEach(function(b){ if(focus && b.dataset.nav===key) b.dataset.focus='1'; });
}
function bindNav(sel){$$(sel+' .nav-item').forEach(function(b){b.addEventListener('click',function(){
  closeDi(); renderNav(b.dataset.nav); renderMain(b.dataset.nav);});});}

function toggle(on){return '<span class="switch'+(on?' on':'')+'"></span>';}
function field(o){
  const meta='<div class="meta"><div class="label">'+o.label+'</div>'+(o.desc?'<div class="desc">'+o.desc+'</div>':'')+'</div>';
  return '<div class="field'+(o.type==='stacked'?' stacked':'')+'">'+meta+'<div class="ctrl">'+(o.control||'')+'</div></div>';
}
function input(v,cls){return '<input class="input '+(cls||'')+'" value="'+v+'">';}
function select(v,opts,cls){return '<select class="select '+(cls||'')+'">'+opts.map(function(o){return '<option'+(o===v?' selected':'')+'>'+o+'</option>';}).join('')+'</select>';}
function segmented(v,opts){return '<div class="segmented">'+opts.map(function(o){return '<button class="'+(o.t===v?'on':'')+'" data-seg>'+(o.i?I[o.i]:'')+o.t+'</button>';}).join('')+'</div>';}
function card(title,hint,body,tight){return '<section class="card"><div class="card-head"><h3>'+title+'</h3>'+(hint?'<span class="hint">'+hint+'</span>':'')+'</div><div class="card-body'+(tight?' tight':'')+'">'+body+'</div></section>';}
function kb(keys){return '<span class="kbd">'+keys.map(function(k){return '<kbd>'+k+'</kbd>';}).join('<span class="plus">+</span>')+'</span>';}
function recorder(keys,empty){return '<span class="recorder">'+(empty?'<span class="ph">未设置</span>':kb(keys))+'<button class="btn btn-sm btn-outline" data-rec>录制</button></span>';}
function svcRow(av,name,sub,chipCls,chipTxt,on,warn,drag){
  return '<div class="svc">'+(drag?'<span class="grip">'+I.grip+'</span>':'<span style="width:15px"></span>')+
   '<span class="av'+(warn?' n':'')+'">'+av+'</span>'+
   '<span class="nm"><span class="t">'+name+'<span class="chip '+chipCls+'">'+chipTxt+'</span></span><span class="s">'+sub+'</span></span>'+
   '<span class="acts"><button class="icon-btn" title="设置">'+I.settings+'</button><button class="icon-btn" title="移除">'+I.trash+'</button></span>'+
   toggle(on)+'</div>';
}
function hRow(s,t,l,time){return '<tr><td class="src">'+s+'</td><td class="tgt">'+t+'</td><td><span class="lang">'+l+'</span></td><td class="time">'+time+'</td></tr>';}
function cupSvg(s){return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 32 32" fill="none"><path d="M8 12h13v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6z" fill="#fff" fill-opacity=".95"/><path d="M21 14h3a3.5 3.5 0 0 1 0 7h-3" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M11.5 6.5v2.8M16 5.5v3.8M20.5 6.5v2.8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';}
const PAGES={
general:function(){return {title:'常规',sub:'启动方式、外观与网络',body:
 card('启动与运行','',
  field({label:'开机时自动启动',desc:'系统登录后在后台静默运行，托盘常驻',control:toggle(true)})+
  field({label:'启动时检查更新',desc:'有新版本时在侧栏底部提示',control:toggle(true)})+
  field({label:'本地服务端口',desc:'其他工具可通过 HTTP 调用翻译接口，修改后需重启',control:input('60828','w-sm mono')}))+
 card('外观','',
  field({label:'主题',control:segmented('跟随系统',[{t:'浅色',i:'sun'},{t:'深色',i:'moon'},{t:'跟随系统',i:'monitor'}])})+
  field({label:'界面语言',desc:'菜单、托盘与提示文案',control:select('简体中文',['简体中文','繁體中文','English','日本語','한국어','Deutsch'])})+
  field({label:'字体',control:select('系统默认',['系统默认','Inter','Noto Sans SC','思源黑体'])+select('系统默认',['系统默认','sans-serif'],'w-md')})+
  field({label:'字号',control:'<input type="range" min="12" max="24" value="16" class="range"><span class="mono-note">16px</span>'})+
  field({label:'窗口透明效果',desc:'Linux/Wayland 下可能影响渲染性能',control:toggle(true)}))+
 card('网络代理','仅在需要访问境外服务时开启',
  field({label:'使用代理',desc:'翻译、语音合成与更新检查会走此代理',control:toggle(true)})+
  field({label:'代理地址',control:input('127.0.0.1','w-md mono')+input('7890','w-sm mono')})+
  field({label:'认证',control:input('用户名','w-md')+input('密码','w-md')})+
  field({label:'不使用代理的地址',control:input('localhost,127.0.0.1','w-lg mono')}))+
 card('高级','',
  field({label:'开发模式',desc:'打开开发者工具、允许更多调试快捷键',control:toggle(false)})+
  field({label:'托盘单击行为',control:segmented('打开设置',[{t:'打开设置'},{t:'划词翻译'},{t:'截图识别'}])}))};},

translate:function(){return {title:'翻译',sub:'翻译窗口的行为与排版',body:
 card('语言','',
  field({label:'默认源语言',control:select('自动检测',['自动检测','简体中文','English','日本語','Deutsch'],'w-md')})+
  field({label:'默认目标语言',control:select('简体中文',['简体中文','繁體中文','English','日本語'],'w-md')})+
  field({label:'第二目标语言',desc:'按交换键时在目标语言与它之间切换',control:select('English',['English','日本語','Deutsch'],'w-md')})+
  field({label:'记住上次使用的语言',desc:'关闭后每次划词都回到默认语言',control:toggle(false)}))+
 card('翻译窗口','',
  field({label:'失焦自动关闭',desc:'划词弹出后点击窗口外立即关闭',control:toggle(true)})+
  field({label:'窗口置顶',control:toggle(false)})+
  field({label:'弹出位置',control:segmented('跟随鼠标',[{t:'跟随鼠标'},{t:'屏幕居中'},{t:'记住位置'}])})+
  field({label:'记住窗口尺寸',control:toggle(false)})+
  field({label:'隐藏语言选择条',desc:'仅显示译文，界面更精简',control:toggle(false)}))+
 card('输入与输出','',
  field({label:'增量翻译',desc:'输入过程中逐字触发翻译',control:toggle(false)})+
  field({label:'动态翻译',desc:'源文本变化后自动重新翻译',control:toggle(true)})+
  field({label:'自动删除换行',desc:'用于处理 PDF 复制出的硬换行',control:toggle(false)})+
  field({label:'翻译后自动复制',control:select('原文 + 译文',['禁用','原文','译文','原文 + 译文'],'w-md')}))};},

recognize:function(){return {title:'识别（OCR）',sub:'截图取词与图片识别',body:
 card('语言','',
  field({label:'识别语言',control:select('自动检测',['自动检测','简体中文 + English','日本語','한국어'],'w-md')})+
  field({label:'识别后自动翻译',desc:'识别完成立即送入翻译窗口',control:toggle(true)}))+
 card('引擎顺序','拖动调整优先级，越靠上越先使用',
  '<div class="stack-rows">'+
  svcRow('系','系统 OCR','操作系统内置，离线可用，速度快','chip-local','本地',true,false,true)+
  svcRow('Te','Tesseract','跨平台离线 OCR，已启用 5 种语言包','chip-local','本地',true,false,true)+
  '</div>',true)+
 card('截图','',
  field({label:'截图后自动识别',control:toggle(true)})+
  field({label:'保留截图历史',desc:'存放在本地缓存目录，不会上传',control:toggle(true)}))};},

hotkey:function(){return {title:'快捷键',sub:'点击「录制」后按下组合键，Esc 取消',body:
 card('全局快捷键','在所有应用中生效',
  field({label:'划词翻译',desc:'选中文字后按下，弹出翻译窗口',control:recorder(['Alt','D'])})+
  field({label:'输入翻译',desc:'打开翻译窗口并清空输入框',control:recorder(['Alt','Shift','D'])})+
  field({label:'截图识别',control:recorder(['Alt','Q'])})+
  field({label:'截图并翻译',control:recorder(null,true)}))+
 card('窗口内快捷键','',
  field({label:'强制翻译',control:kb(['Enter'])})+
  field({label:'交换语言',control:kb(['Ctrl','Shift','S'])})+
  field({label:'朗读译文',control:kb(['Ctrl','Shift','V'])})+
  field({label:'追加并复制',control:kb(['Ctrl','Shift','D'])}))+
 card('冲突检测','',
  '<div class="field"><div class="meta"><div class="label ok-line">'+I.check+'4 个全局快捷键均可用</div>'+
  '<div class="desc">快捷键被其他应用占用时，这里会给出具体冲突提示</div></div></div>')};},

service:function(){return {title:'服务与插件',sub:'翻译、语音合成、识别与生词本',body:
 '<div class="btn-group" style="margin-bottom:14px">'+
  '<button class="on">翻译引擎 <span class="tag">4</span></button><button>语音合成 <span class="tag">1</span></button>'+
  '<button>识别 <span class="tag">2</span></button><button>生词本 <span class="tag">0</span></button></div>'+
 card('翻译引擎','按顺序调用，拖动可调整；关闭的引擎不出现在翻译窗口',
  '<div class="stack-rows">'+
  svcRow('Ya','Yandex','免密钥 · 实测可用','chip-free','免费',true,false,true)+
  svcRow('G','Google','免密钥 · 支持自定义镜像地址','chip-free','免费',true,false,true)+
  svcRow('ct','CTranslate2 本地','离线模型 · 需下载约 300 MB','chip-local','本地',false,false,true)+
  svcRow('DL','DeepL','需要 API Key · 未配置','chip-key','需密钥',false,true,true)+
  '</div>',true)+
 card('已安装插件','',
  field({label:'翻译插件目录',desc:'把插件文件夹放入该目录后点击「重载」即可生效',
   control:'<code class="mono-note dim">~/.config/com.cup-translate.app/plugins/</code><button class="btn btn-ghost btn-sm">'+I.refresh+'重载</button>'}))};},

history:function(){return {title:'历史记录',sub:'共 1,284 条 · 全部保存在本地',body:
 '<div class="card" style="padding:6px 0">'+
 '<div style="display:flex;gap:8px;align-items:center;padding:10px 16px 12px">'+
  '<input class="input" placeholder="搜索原文或译文…" style="max-width:240px">'+
  '<select class="select w-md"><option>全部语言</option><option>英 → 中</option><option>中 → 英</option></select>'+
  '<div class="grow"></div><button class="btn btn-ghost btn-sm">导出</button>'+
  '<button class="btn btn-danger btn-sm">'+I.trash+'清空</button></div>'+
 '<table class="tbl"><thead><tr><th>原文</th><th>译文</th><th>语言</th><th>时间</th></tr></thead><tbody>'+
  hRow('The interface should feel quiet until the user needs it.','界面在用户需要它之前应当保持安静。','英 → 中','2 分钟前')+
  hRow('划词翻译，随叫随到。','Translate on selection, always within reach.','中 → 英','1 小时前')+
  hRow('Ein gutes Design ist so wenig Design wie möglich.','好的设计是尽可能少的设计。','德 → 中','昨天 21:04')+
  hRow('Talk is cheap. Show me the code.','废话少说，放码过来。','英 → 中','昨天 09:12')+
  hRow('Простота — высшая ступень искусства.','简约是艺术的最高境界。','俄 → 中','3 天前')+
  hRow('Il semble que la perfection soit atteinte non quand il n’y a plus rien à ajouter, mais quand il n’y a plus rien à retrancher.','完美不是无可附加，而是无可删减。','法 → 中','上周')+
 '</tbody></table>'+
 '<div class="pager"><span class="dim" style="font-size:12px">第 1–20 条，共 1,284 条</span>'+
 '<div class="btn-group"><button>上一页</button><button class="on">1</button><button>2</button><button>3</button><button>下一页</button></div></div></div>'};},

backup:function(){return {title:'备份与同步',sub:'把配置与生词本同步到云端或本地目录',body:
 card('备份内容','',
  field({label:'配置与偏好',desc:'包含快捷键、引擎配置与外观设置',control:toggle(true)})+
  field({label:'生词本',control:toggle(true)})+
  field({label:'历史记录',desc:'数据量较大，同步会更慢',control:toggle(false)})+
  field({label:'自动备份',control:select('每天',['关闭','每小时','每天','每周'],'w-sm')}))+
 card('存储位置','',
  field({label:'WebDAV',desc:'自建网盘 / Nextcloud',control:'<span class="chip chip-free"><span class="dot"></span>已连接</span><button class="btn btn-ghost btn-sm">配置</button>'})+
  field({label:'阿里云盘',desc:'需要授权登录',control:'<span class="chip chip-count">未配置</span><button class="btn btn-ghost btn-sm">配置</button>'})+
  field({label:'本地文件夹',control:'<button class="btn btn-ghost btn-sm">选择目录</button>'}))+
 card('最近一次备份','',
  '<div class="field"><div class="meta"><div class="label">今天 21:04 · 成功</div>'+
  '<div class="desc">上传 42 KB，包含 1284 条历史与 87 个生词</div></div>'+
  '<div class="ctrl"><button class="btn btn-ghost btn-sm">'+I.refresh+'立即备份</button>'+
  '<button class="btn btn-outline btn-sm">从备份恢复</button></div></div>')};},

about:function(){return {title:'关于',sub:'',body:
 '<div class="card"><div class="card-body" style="padding:26px 22px">'+
 '<div style="display:flex;gap:18px;align-items:center">'+
  '<div class="logo" style="width:64px;height:64px;border-radius:18px">'+cupSvg(34)+'</div>'+
  '<div><div style="font-size:19px;font-weight:650;letter-spacing:-.02em">cup-translate</div>'+
  '<div style="font-size:12.5px;color:var(--fg-3);margin-top:2px">版本 3.0.7 · GPL-3.0 · pot-desktop 社区续版</div>'+
  '<div style="display:flex;gap:8px;margin-top:12px">'+
   '<button class="btn btn-primary btn-sm">检查更新</button>'+
   '<button class="btn btn-outline btn-sm">打开配置目录</button>'+
   '<button class="btn btn-outline btn-sm">查看日志</button></div></div></div>'+
 '<div class="about-note">cup-translate 是已归档项目 pot-desktop 的社区续版，遵循 GPL-3.0 许可，<b>不是原创项目</b>。本页为 UI 重构原型（v2 设计语言），仅用于方案评审，未改动任何业务逻辑。</div>'+
 '</div></div>'};}
};

function renderMain(key){
  const p=PAGES[key]();
  $('#title').textContent=p.title;
  $('#sub').textContent=p.sub||'';
  $('#sub').style.display=p.sub?'':'none';
  $('#page').innerHTML=p.body;
  $('#page').scrollTop=0;
}
const POP={
idle:function(){return ''
 +'<div class="Source"><div class="det"><span class="lg">English</span><span class="auto">自动检测</span></div>'
 +'<p contenteditable="true">The interface should feel quiet until the user needs it.</p>'
 +'<div class="tools"><button class="icon-btn" title="朗读">'+I.speaker+'</button>'
 +'<button class="icon-btn" title="清空">'+I.trash+'</button><span class="spacer"></span><span class="charcount">58 字符</span></div></div>'
 +'<div class="Langbar"><button class="lang-pick">English'+I.chev+'</button>'
 +'<button class="swap" title="交换语言">'+I.swap+'</button>'
 +'<button class="lang-pick">简体中文'+I.chev+'</button><span class="spacer"></span>'
 +'<button class="btn btn-sm btn-tinted">'+I.translate+'翻译</button></div>'
 +'<div class="Result hero"><div class="Result-head"><span class="av">Ya</span><span class="nm">Yandex</span><span class="spacer"></span>'
 +'<button class="icon-btn" title="朗读">'+I.speaker+'</button><button class="icon-btn" title="复制">'+I.copy+'</button>'
 +'<button class="icon-btn" title="收藏到生词本">'+I.star+'</button></div>'
 +'<div class="Result-body"><div class="out">界面在用户需要它之前，应当保持安静。</div></div></div>'
 +'<div class="Result"><div class="Result-head"><span class="av g">G</span><span class="nm">Google</span><span class="spacer"></span>'
 +'<button class="icon-btn">'+I.speaker+'</button><button class="icon-btn">'+I.copy+'</button></div>'
 +'<div class="Result-body"><div class="out">界面应该保持安静，直到用户需要它。</div></div></div>'
 +'<div class="Result"><div class="Result-head"><span class="av">DL</span><span class="nm">DeepL</span><span class="spacer"></span>'
 +'<span class="chip chip-key">未配置，已跳过</span></div>'
 +'<div class="Result-body"><div class="out dim">该引擎需要 API Key，未发送请求。</div></div></div>';},
dict:function(){return ''
 +'<div class="Source"><div class="det"><span class="lg">English</span><span class="auto">自动检测</span></div>'
 +'<p contenteditable="true">quiet</p>'
 +'<div class="tools"><button class="icon-btn">'+I.speaker+'</button><span class="spacer"></span><span class="charcount">5 字符</span></div></div>'
 +'<div class="Langbar"><button class="lang-pick">English'+I.chev+'</button><button class="swap">'+I.swap+'</button>'
 +'<button class="lang-pick">简体中文'+I.chev+'</button><span class="spacer"></span>'
 +'<button class="btn btn-sm btn-tinted">'+I.translate+'翻译</button></div>'
 +'<div class="Result hero"><div class="Result-head"><span class="av">Ya</span><span class="nm">Yandex</span><span class="spacer"></span>'
 +'<button class="icon-btn">'+I.speaker+'</button><button class="icon-btn">'+I.copy+'</button><button class="icon-btn">'+I.star+'</button></div>'
 +'<div class="Result-body"><div class="out big">安静的；寂静的</div>'
 +'<div class="tags"><span class="tag pos">adj.</span><span class="tag">/ˈkwaɪt/</span>'
 +'<span class="tag">比较级 <b>quieter</b></span><span class="tag">最高级 <b>quietest</b></span></div></div></div>'
 +'<div class="Result"><div class="Result-head"><span class="av g">ct</span><span class="nm">CTranslate2 本地</span><span class="spacer"></span>'
 +'<span class="chip chip-local">本地 · 12 ms</span></div>'
 +'<div class="Result-body"><div class="out">安静；平静；使安静</div></div></div>';},
loading:function(){return ''
 +'<div class="Source"><div class="det"><span class="lg">English</span><span class="auto">自动检测</span></div>'
 +'<p contenteditable="true">Continuous integration should never block the release pipeline.</p>'
 +'<div class="tools"><span class="spacer"></span><span class="charcount">61 字符</span></div></div>'
 +'<div class="Langbar"><button class="lang-pick">English'+I.chev+'</button><button class="swap">'+I.swap+'</button>'
 +'<button class="lang-pick">简体中文'+I.chev+'</button><span class="spacer"></span><span class="chip chip-count">翻译中…</span></div>'
 +'<div class="Result hero"><div class="Result-head"><span class="av">Ya</span><span class="nm">Yandex</span></div>'
 +'<div class="Result-body"><div class="skel s1"></div><div class="skel s2"></div><div class="skel s3"></div></div></div>'
 +'<div class="Result"><div class="Result-head"><span class="av g">G</span><span class="nm">Google</span></div>'
 +'<div class="Result-body"><div class="skel s1"></div><div class="skel s2"></div></div></div>';},
error:function(){return ''
 +'<div class="Source"><div class="det"><span class="lg">English</span><span class="auto">自动检测</span></div>'
 +'<p contenteditable="true">Rate limit exceeded, please retry later.</p>'
 +'<div class="tools"><span class="spacer"></span><span class="charcount">37 字符</span></div></div>'
 +'<div class="Langbar"><button class="lang-pick">English'+I.chev+'</button><button class="swap">'+I.swap+'</button>'
 +'<button class="lang-pick">简体中文'+I.chev+'</button><span class="spacer"></span>'
 +'<button class="btn btn-sm btn-tinted">'+I.translate+'翻译</button></div>'
 +'<div class="Result"><div class="Result-head"><span class="av">Ya</span><span class="nm">Yandex</span><span class="spacer"></span>'
 +'<span class="chip chip-key">请求失败</span><button class="btn btn-sm btn-ghost">'+I.refresh+'重试</button></div>'
 +'<div class="Result-body"><div class="err-box">'+I.alert+'<span>429 Too Many Requests：该引擎限制了请求频率，请稍后再试，或临时启用其他引擎。</span></div></div></div>';}
};

function renderPop(state){
  $('#pop-body').innerHTML=POP[state]();
  $$('#pop-seg button').forEach(function(b){b.classList.toggle('on',b.dataset.st===state);});
  $$('#pop-body .icon-btn').forEach(function(b){b.addEventListener('click',function(){
    b.style.color='var(--brand-500)';setTimeout(function(){b.style.color='';},420);});});
}

function renderFrames(){
  const data=[['极简行','<b>English → 简体中文</b>\n界面在用户需要它之前，应当保持安静。\n<i>— Yandex · 142 ms</i>'],
   ['双引擎列','<i>[Yandex]</i> <b>界面在用户需要它之前，应当保持安静。</b>\n<i>[Google]</i> 界面应该保持安静，直到用户需要它。'],
   ['词典卡','quiet\n<b>/ˈkwaɪt/  adj. 安静的；寂静的</b>\n<i>— 本地词典</i>']];
  $('#frames').innerHTML=data.map(function(d){
    return '<div class="frame"><div class="cap">'+d[0]+'</div><pre>'+d[1]+'</pre></div>';}).join('');
}

function applyTheme(t){
  document.documentElement.dataset.theme=t;
  $$('[data-theme-btn]').forEach(function(b){b.classList.toggle('on',b.dataset.themeBtn===t);});
}
function closeDi(){$('#di').classList.add('hidden');}

function initEvents(){
  $('#tag-btn').addEventListener('click',function(e){e.stopPropagation();$('#di').classList.toggle('hidden');});
  document.addEventListener('click',function(e){
    if(!e.target.closest('#di')&&!e.target.closest('#tag-btn')) closeDi();
    const sw=e.target.closest('.switch'); if(sw) sw.classList.toggle('on');
    const sg=e.target.closest('.segmented button');
    if(sg){[].forEach.call(sg.parentElement.children,function(c2){c2.classList.remove('on');});sg.classList.add('on');}
    const bg=e.target.closest('.btn-group button');
    if(bg&&bg.parentElement.parentElement.classList.contains('pager')===false&&!bg.dataset.seg){
      /* 引擎/插件类型切换 */
      if(bg.parentElement.children.length<=4&&bg.textContent.indexOf('页')<0){
        [].forEach.call(bg.parentElement.children,function(c2){c2.classList.remove('on');});bg.classList.add('on');}
    }
    const rc=e.target.closest('[data-rec]');
    if(rc){const r=rc.closest('.recorder');r.classList.toggle('rec');
      if(r.classList.contains('rec')){rc.textContent='按下组合键…';}
      else{rc.textContent='录制';if(!r.querySelector('kbd')){r.insertAdjacentHTML('afterbegin','<span class="kbd"><kbd>Alt</kbd><span class="plus">+</span><kbd>X</kbd></span>');r.querySelector('.ph')&&r.querySelector('.ph').remove();}}}
    const nav=e.target.closest('[data-nav]');
    if(nav){closeDi();renderNav(nav.dataset.nav);renderMain(nav.dataset.nav);}
  });
  $$('#view-seg button').forEach(function(b){b.addEventListener('click',function(){
    const v=b.dataset.view;
    $$('#view-seg button').forEach(function(x){x.classList.toggle('on',x.dataset.view===v);});
    $('#stage').classList.toggle('hidden',v!=='settings');
    $('#stage-pop').classList.toggle('hidden',v!=='popup');});});
  $$('[data-theme-btn]').forEach(function(b){b.addEventListener('click',function(){applyTheme(b.dataset.themeBtn);});});
  $$('#pop-seg button').forEach(function(b){b.addEventListener('click',function(){renderPop(b.dataset.st);});});
}

applyTheme('light');
renderNav('general');
renderMain('general');
renderPop('idle');
renderFrames();
initEvents();
