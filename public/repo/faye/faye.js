define([], function (){

var Faye = function(){
'use strict';var Faye={VERSION:'0.8.9',BAYEUX_VERSION:'1.0',ID_LENGTH:160,JSONP_CALLBACK:'jsonpcallback',CONNECTION_TYPES:['long-polling','cross-origin-long-polling','callback-polling','websocket','eventsource','in-process'],MANDATORY_CONNECTION_TYPES:['long-polling','callback-polling','in-process'],ENV:(typeof global==='undefined')?window:global,extend:function(a,b,d){if(!b)return a;for(var f in b){if(!b.hasOwnProperty(f))continue;if(a.hasOwnProperty(f)&&d===false)continue;if(a[f]!==b[f])a[f]=b[f]}return a},random:function(a){a=a||this.ID_LENGTH;if(a>32){var b=Math.ceil(a/32),d='';while(b--)d+=this.random(32);var f=d.split(''),g='';while(f.length>0)g+=f.pop();return g}var h=Math.pow(2,a)-1,i=h.toString(36).length,d=Math.floor(Math.random()*h).toString(36);while(d.length<i)d='0'+d;return d},clientIdFromMessages:function(a){var b=[].concat(a)[0];return b&&b.clientId},copyObject:function(a){var b,d,f;if(a instanceof Array){b=[];d=a.length;while(d--)b[d]=Faye.copyObject(a[d]);return b}else if(typeof a==='object'){b=(a===null)?null:{};for(f in a)b[f]=Faye.copyObject(a[f]);return b}else{return a}},commonElement:function(a,b){for(var d=0,f=a.length;d<f;d++){if(this.indexOf(b,a[d])!==-1)return a[d]}return null},indexOf:function(a,b){if(a.indexOf)return a.indexOf(b);for(var d=0,f=a.length;d<f;d++){if(a[d]===b)return d}return-1},map:function(a,b,d){if(a.map)return a.map(b,d);var f=[];if(a instanceof Array){for(var g=0,h=a.length;g<h;g++){f.push(b.call(d||null,a[g],g))}}else{for(var i in a){if(!a.hasOwnProperty(i))continue;f.push(b.call(d||null,i,a[i]))}}return f},filter:function(a,b,d){var f=[];for(var g=0,h=a.length;g<h;g++){if(b.call(d||null,a[g],g))f.push(a[g])}return f},asyncEach:function(a,b,d,f){var g=a.length,h=-1,i=0,k=false;var j=function(){i-=1;h+=1;if(h===g)return d&&d.call(f);b(a[h],n)};var m=function(){if(k)return;k=true;while(i>0)j();k=false};var n=function(){i+=1;m()};n()},toJSON:function(a){if(this.stringify)return this.stringify(a,function(key,value){return(this[key]instanceof Array)?this[key]:value});return JSON.stringify(a)},logger:function(a){if(typeof console!=='undefined')console.log(a)},timestamp:function(){var b=new Date(),d=b.getFullYear(),f=b.getMonth()+1,g=b.getDate(),h=b.getHours(),i=b.getMinutes(),k=b.getSeconds();var j=function(a){return a<10?'0'+a:String(a)};return j(d)+'-'+j(f)+'-'+j(g)+' '+j(h)+':'+j(i)+':'+j(k)}};if(typeof window!=='undefined')window.Faye=Faye;Faye.Class=function(a,b){if(typeof a!=='function'){b=a;a=Object}var d=function(){if(!this.initialize)return this;return this.initialize.apply(this,arguments)||this};var f=function(){};f.prototype=a.prototype;d.prototype=new f();Faye.extend(d.prototype,b);return d};Faye.Namespace=Faye.Class({initialize:function(){this._e={}},exists:function(a){return this._e.hasOwnProperty(a)},generate:function(){var a=Faye.random();while(this._e.hasOwnProperty(a))a=Faye.random();return this._e[a]=a},release:function(a){delete this._e[a]}});Faye.Error=Faye.Class({initialize:function(a,b,d){this.code=a;this.params=Array.prototype.slice.call(b);this.message=d},toString:function(){return this.code+':'+this.params.join(',')+':'+this.message}});Faye.Error.parse=function(a){a=a||'';if(!Faye.Grammar.ERROR.test(a))return new this(null,[],a);var b=a.split(':'),d=parseInt(b[0]),f=b[1].split(','),a=b[2];return new this(d,f,a)};Faye.Error.versionMismatch=function(){return new this(300,arguments,"Version mismatch").toString()};Faye.Error.conntypeMismatch=function(){return new this(301,arguments,"Connection types not supported").toString()};Faye.Error.extMismatch=function(){return new this(302,arguments,"Extension mismatch").toString()};Faye.Error.badRequest=function(){return new this(400,arguments,"Bad request").toString()};Faye.Error.clientUnknown=function(){return new this(401,arguments,"Unknown client").toString()};Faye.Error.parameterMissing=function(){return new this(402,arguments,"Missing required parameter").toString()};Faye.Error.channelForbidden=function(){return new this(403,arguments,"Forbidden channel").toString()};Faye.Error.channelUnknown=function(){return new this(404,arguments,"Unknown channel").toString()};Faye.Error.channelInvalid=function(){return new this(405,arguments,"Invalid channel").toString()};Faye.Error.extUnknown=function(){return new this(406,arguments,"Unknown extension").toString()};Faye.Error.publishFailed=function(){return new this(407,arguments,"Failed to publish").toString()};Faye.Error.serverError=function(){return new this(500,arguments,"Internal server error").toString()};Faye.Deferrable={callback:function(a,b){if(!a)return;if(this._v==='succeeded')return a.apply(b,this._j);this._k=this._k||[];this._k.push([a,b])},timeout:function(a,b){var d=this;var f=Faye.ENV.setTimeout(function(){d.setDeferredStatus('failed',b)},a*1000);this._w=f},errback:function(a,b){if(!a)return;if(this._v==='failed')return a.apply(b,this._j);this._l=this._l||[];this._l.push([a,b])},setDeferredStatus:function(){if(this._w)Faye.ENV.clearTimeout(this._w);var a=Array.prototype.slice.call(arguments),b=a.shift(),d;this._v=b;this._j=a;if(b==='succeeded')d=this._k;else if(b==='failed')d=this._l;if(!d)return;var f;while(f=d.shift())f[0].apply(f[1],this._j)}};Faye.Publisher={countListeners:function(a){if(!this._4||!this._4[a])return 0;return this._4[a].length},bind:function(a,b,d){this._4=this._4||{};var f=this._4[a]=this._4[a]||[];f.push([b,d])},unbind:function(a,b,d){if(!this._4||!this._4[a])return;if(!b){delete this._4[a];return}var f=this._4[a],g=f.length;while(g--){if(b!==f[g][0])continue;if(d&&f[g][1]!==d)continue;f.splice(g,1)}},trigger:function(){var a=Array.prototype.slice.call(arguments),b=a.shift();if(!this._4||!this._4[b])return;var d=this._4[b].slice(),f;for(var g=0,h=d.length;g<h;g++){f=d[g];f[0].apply(f[1],a)}}};Faye.Timeouts={addTimeout:function(a,b,d,f){this._6=this._6||{};if(this._6.hasOwnProperty(a))return;var g=this;this._6[a]=Faye.ENV.setTimeout(function(){delete g._6[a];d.call(f)},1000*b)},removeTimeout:function(a){this._6=this._6||{};var b=this._6[a];if(!b)return;clearTimeout(b);delete this._6[a]}};Faye.Logging={LOG_LEVELS:{error:3,warn:2,info:1,debug:0},logLevel:'error',log:function(a,b){if(!Faye.logger)return;var d=Faye.Logging.LOG_LEVELS;if(d[Faye.Logging.logLevel]>d[b])return;var a=Array.prototype.slice.apply(a),f=' ['+b.toUpperCase()+'] [Faye',g=this.className,h=a.shift().replace(/\?/g,function(){try{return Faye.toJSON(a.shift())}catch(e){return'[Object]'}});for(var i in Faye){if(g)continue;if(typeof Faye[i]!=='function')continue;if(this instanceof Faye[i])g=i}if(g)f+='.'+g;f+='] ';Faye.logger(Faye.timestamp()+f+h)}};(function(){for(var d in Faye.Logging.LOG_LEVELS)(function(a,b){Faye.Logging[a]=function(){this.log(arguments,a)}})(d,Faye.Logging.LOG_LEVELS[d])})();Faye.Grammar={LOWALPHA:/^[a-z]$/,UPALPHA:/^[A-Z]$/,ALPHA:/^([a-z]|[A-Z])$/,DIGIT:/^[0-9]$/,ALPHANUM:/^(([a-z]|[A-Z])|[0-9])$/,MARK:/^(\-|\_|\!|\~|\(|\)|\$|\@)$/,STRING:/^(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*$/,TOKEN:/^(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+$/,INTEGER:/^([0-9])+$/,CHANNEL_SEGMENT:/^(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+$/,CHANNEL_SEGMENTS:/^(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+(\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+)*$/,CHANNEL_NAME:/^\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+(\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+)*$/,WILD_CARD:/^\*{1,2}$/,CHANNEL_PATTERN:/^(\/(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)))+)*\/\*{1,2}$/,VERSION_ELEMENT:/^(([a-z]|[A-Z])|[0-9])(((([a-z]|[A-Z])|[0-9])|\-|\_))*$/,VERSION:/^([0-9])+(\.(([a-z]|[A-Z])|[0-9])(((([a-z]|[A-Z])|[0-9])|\-|\_))*)*$/,CLIENT_ID:/^((([a-z]|[A-Z])|[0-9]))+$/,ID:/^((([a-z]|[A-Z])|[0-9]))+$/,ERROR_MESSAGE:/^(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*$/,ERROR_ARGS:/^(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*(,(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*)*$/,ERROR_CODE:/^[0-9][0-9][0-9]$/,ERROR:/^([0-9][0-9][0-9]:(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*(,(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*)*:(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*|[0-9][0-9][0-9]::(((([a-z]|[A-Z])|[0-9])|(\-|\_|\!|\~|\(|\)|\$|\@)| |\/|\*|\.))*)$/};Faye.Extensible={addExtension:function(a){this._7=this._7||[];this._7.push(a);if(a.added)a.added(this)},removeExtension:function(a){if(!this._7)return;var b=this._7.length;while(b--){if(this._7[b]!==a)continue;this._7.splice(b,1);if(a.removed)a.removed(this)}},pipeThroughExtensions:function(d,f,g,h){this.debug('Passing through ? extensions: ?',d,f);if(!this._7)return g.call(h,f);var i=this._7.slice();var k=function(a){if(!a)return g.call(h,a);var b=i.shift();if(!b)return g.call(h,a);if(b[d])b[d](a,k);else k(a)};k(f)}};Faye.extend(Faye.Extensible,Faye.Logging);Faye.Channel=Faye.Class({initialize:function(a){this.id=this.name=a},push:function(a){this.trigger('message',a)},isUnused:function(){return this.countListeners('message')===0}});Faye.extend(Faye.Channel.prototype,Faye.Publisher);Faye.extend(Faye.Channel,{HANDSHAKE:'/meta/handshake',CONNECT:'/meta/connect',SUBSCRIBE:'/meta/subscribe',UNSUBSCRIBE:'/meta/unsubscribe',DISCONNECT:'/meta/disconnect',META:'meta',SERVICE:'service',expand:function(a){var b=this.parse(a),d=['/**',a];var f=b.slice();f[f.length-1]='*';d.push(this.unparse(f));for(var g=1,h=b.length;g<h;g++){f=b.slice(0,g);f.push('**');d.push(this.unparse(f))}return d},isValid:function(a){return Faye.Grammar.CHANNEL_NAME.test(a)||Faye.Grammar.CHANNEL_PATTERN.test(a)},parse:function(a){if(!this.isValid(a))return null;return a.split('/').slice(1)},unparse:function(a){return'/'+a.join('/')},isMeta:function(a){var b=this.parse(a);return b?(b[0]===this.META):null},isService:function(a){var b=this.parse(a);return b?(b[0]===this.SERVICE):null},isSubscribable:function(a){if(!this.isValid(a))return null;return!this.isMeta(a)&&!this.isService(a)},Set:Faye.Class({initialize:function(){this._2={}},getKeys:function(){var a=[];for(var b in this._2)a.push(b);return a},remove:function(a){delete this._2[a]},hasSubscription:function(a){return this._2.hasOwnProperty(a)},subscribe:function(a,b,d){if(!b)return;var f;for(var g=0,h=a.length;g<h;g++){f=a[g];var i=this._2[f]=this._2[f]||new Faye.Channel(f);i.bind('message',b,d)}},unsubscribe:function(a,b,d){var f=this._2[a];if(!f)return false;f.unbind('message',b,d);if(f.isUnused()){this.remove(a);return true}else{return false}},distributeMessage:function(a){var b=Faye.Channel.expand(a.channel);for(var d=0,f=b.length;d<f;d++){var g=this._2[b[d]];if(g)g.trigger('message',a.data)}}})});Faye.Publication=Faye.Class(Faye.Deferrable);Faye.Subscription=Faye.Class({initialize:function(a,b,d,f){this._8=a;this._2=b;this._m=d;this._n=f;this._x=false},cancel:function(){if(this._x)return;this._8.unsubscribe(this._2,this._m,this._n);this._x=true},unsubscribe:function(){this.cancel()}});Faye.extend(Faye.Subscription.prototype,Faye.Deferrable);Faye.Client=Faye.Class({UNCONNECTED:1,CONNECTING:2,CONNECTED:3,DISCONNECTED:4,HANDSHAKE:'handshake',RETRY:'retry',NONE:'none',CONNECTION_TIMEOUT:60.0,DEFAULT_RETRY:5.0,DEFAULT_ENDPOINT:'/bayeux',INTERVAL:0.0,initialize:function(a,b){this.info('New client created for ?',a);this._f=b||{};this.endpoint=a||this.DEFAULT_ENDPOINT;this.endpoints=this._f.endpoints||{};this.transports={};this._D=Faye.CookieJar&&new Faye.CookieJar();this._y={};this._o=[];this.retry=this._f.retry||this.DEFAULT_RETRY;this._1=this.UNCONNECTED;this._2=new Faye.Channel.Set();this._g=0;this._p={};this._9={reconnect:this.RETRY,interval:1000*(this._f.interval||this.INTERVAL),timeout:1000*(this._f.timeout||this.CONNECTION_TIMEOUT)};if(Faye.Event)Faye.Event.on(Faye.ENV,'beforeunload',function(){if(Faye.indexOf(this._o,'autodisconnect')<0)this.disconnect()},this)},disable:function(a){this._o.push(a)},setHeader:function(a,b){this._y[a]=b},getClientId:function(){return this._0},getState:function(){switch(this._1){case this.UNCONNECTED:return'UNCONNECTED';case this.CONNECTING:return'CONNECTING';case this.CONNECTED:return'CONNECTED';case this.DISCONNECTED:return'DISCONNECTED'}},handshake:function(b,d){if(this._9.reconnect===this.NONE)return;if(this._1!==this.UNCONNECTED)return;this._1=this.CONNECTING;var f=this;this.info('Initiating handshake with ?',this.endpoint);this._z(Faye.MANDATORY_CONNECTION_TYPES);this._a({channel:Faye.Channel.HANDSHAKE,version:Faye.BAYEUX_VERSION,supportedConnectionTypes:[this._5.connectionType]},function(a){if(a.successful){this._1=this.CONNECTED;this._0=a.clientId;this._z(a.supportedConnectionTypes);this.info('Handshake successful: ?',this._0);this.subscribe(this._2.getKeys(),true);if(b)b.call(d)}else{this.info('Handshake unsuccessful');Faye.ENV.setTimeout(function(){f.handshake(b,d)},this._9.interval);this._1=this.UNCONNECTED}},this)},connect:function(a,b){if(this._9.reconnect===this.NONE)return;if(this._1===this.DISCONNECTED)return;if(this._1===this.UNCONNECTED)return this.handshake(function(){this.connect(a,b)},this);this.callback(a,b);if(this._1!==this.CONNECTED)return;this.info('Calling deferred actions for ?',this._0);this.setDeferredStatus('succeeded');this.setDeferredStatus('deferred');if(this._q)return;this._q=true;this.info('Initiating connection for ?',this._0);this._a({channel:Faye.Channel.CONNECT,clientId:this._0,connectionType:this._5.connectionType},this._A,this)},disconnect:function(){if(this._1!==this.CONNECTED)return;this._1=this.DISCONNECTED;this.info('Disconnecting ?',this._0);this._a({channel:Faye.Channel.DISCONNECT,clientId:this._0},function(a){if(a.successful)this._5.close()},this);this.info('Clearing channel listeners for ?',this._0);this._2=new Faye.Channel.Set()},subscribe:function(d,f,g){if(d instanceof Array)return Faye.map(d,function(c){return this.subscribe(c,f,g)},this);var h=new Faye.Subscription(this,d,f,g),i=(f===true),k=this._2.hasSubscription(d);if(k&&!i){this._2.subscribe([d],f,g);h.setDeferredStatus('succeeded');return h}this.connect(function(){this.info('Client ? attempting to subscribe to ?',this._0,d);if(!i)this._2.subscribe([d],f,g);this._a({channel:Faye.Channel.SUBSCRIBE,clientId:this._0,subscription:d},function(a){if(!a.successful){h.setDeferredStatus('failed',Faye.Error.parse(a.error));return this._2.unsubscribe(d,f,g)}var b=[].concat(a.subscription);this.info('Subscription acknowledged for ? to ?',this._0,b);h.setDeferredStatus('succeeded')},this)},this);return h},unsubscribe:function(d,f,g){if(d instanceof Array)return Faye.map(d,function(c){return this.unsubscribe(c,f,g)},this);var h=this._2.unsubscribe(d,f,g);if(!h)return;this.connect(function(){this.info('Client ? attempting to unsubscribe from ?',this._0,d);this._a({channel:Faye.Channel.UNSUBSCRIBE,clientId:this._0,subscription:d},function(a){if(!a.successful)return;var b=[].concat(a.subscription);this.info('Unsubscription acknowledged for ? from ?',this._0,b)},this)},this)},publish:function(b,d){var f=new Faye.Publication();this.connect(function(){this.info('Client ? queueing published message to ?: ?',this._0,b,d);this._a({channel:b,data:d,clientId:this._0},function(a){if(a.successful)f.setDeferredStatus('succeeded');else f.setDeferredStatus('failed',Faye.Error.parse(a.error))},this)},this);return f},receiveMessage:function(d){this.pipeThroughExtensions('incoming',d,function(a){if(!a)return;if(a.advice)this._E(a.advice);this._F(a);if(a.successful===undefined)return;var b=this._p[a.id];if(!b)return;delete this._p[a.id];b[0].call(b[1],a)},this)},_z:function(b){Faye.Transport.get(this,b,this._o,function(a){this.debug('Selected ? transport for ?',a.connectionType,a.endpoint);if(a===this._5)return;if(this._5)this._5.close();this._5=a;this._5.cookies=this._D;this._5.headers=this._y;a.bind('down',function(){if(this._b!==undefined&&!this._b)return;this._b=false;this.trigger('transport:down')},this);a.bind('up',function(){if(this._b!==undefined&&this._b)return;this._b=true;this.trigger('transport:up')},this)},this)},_a:function(b,d,f){b.id=this._G();if(d)this._p[b.id]=[d,f];this.pipeThroughExtensions('outgoing',b,function(a){if(!a)return;this._5.send(a,this._9.timeout/1000)},this)},_G:function(){this._g+=1;if(this._g>=Math.pow(2,32))this._g=0;return this._g.toString(36)},_E:function(a){Faye.extend(this._9,a);if(this._9.reconnect===this.HANDSHAKE&&this._1!==this.DISCONNECTED){this._1=this.UNCONNECTED;this._0=null;this._A()}},_F:function(a){if(!a.channel||a.data===undefined)return;this.info('Client ? calling listeners for ? with ?',this._0,a.channel,a.data);this._2.distributeMessage(a)},_H:function(){if(!this._q)return;this._q=null;this.info('Closed connection for ?',this._0)},_A:function(){this._H();var a=this;Faye.ENV.setTimeout(function(){a.connect()},this._9.interval)}});Faye.extend(Faye.Client.prototype,Faye.Deferrable);Faye.extend(Faye.Client.prototype,Faye.Publisher);Faye.extend(Faye.Client.prototype,Faye.Logging);Faye.extend(Faye.Client.prototype,Faye.Extensible);Faye.Transport=Faye.extend(Faye.Class({MAX_DELAY:0.0,batching:true,initialize:function(a,b){this._8=a;this.endpoint=b;this._c=[]},close:function(){},send:function(a,b){this.debug('Client ? sending message to ?: ?',this._8._0,this.endpoint,a);if(!this.batching)return this.request([a],b);this._c.push(a);this._I=b;if(a.channel===Faye.Channel.HANDSHAKE)return this.addTimeout('publish',0.01,this.flush,this);if(a.channel===Faye.Channel.CONNECT)this._r=a;if(this.shouldFlush&&this.shouldFlush(this._c))return this.flush();this.addTimeout('publish',this.MAX_DELAY,this.flush,this)},flush:function(){this.removeTimeout('publish');if(this._c.length>1&&this._r)this._r.advice={timeout:0};this.request(this._c,this._I);this._r=null;this._c=[]},receive:function(a){this.debug('Client ? received from ?: ?',this._8._0,this.endpoint,a);for(var b=0,d=a.length;b<d;b++){this._8.receiveMessage(a[b])}},retry:function(a,b){var d=false,f=this._8.retry*1000,g=this;return function(){if(d)return;d=true;Faye.ENV.setTimeout(function(){g.request(a,b)},f)}}}),{MAX_URL_LENGTH:2048,get:function(k,j,m,n,o){var l=k.endpoint;Faye.asyncEach(this._B,function(d,f){var g=d[0],h=d[1],i=k.endpoints[g]||l;if(Faye.indexOf(m,g)>=0)return f();if(Faye.indexOf(j,g)<0){h.isUsable(k,i,function(){});return f()}h.isUsable(k,i,function(a){if(!a)return f();var b=h.hasOwnProperty('create')?h.create(k,i):new h(k,i);n.call(o,b)})},function(){throw new Error('Could not find a usable connection type for '+l);})},register:function(a,b){this._B.push([a,b]);b.prototype.connectionType=a},_B:[]});Faye.extend(Faye.Transport.prototype,Faye.Logging);Faye.extend(Faye.Transport.prototype,Faye.Publisher);Faye.extend(Faye.Transport.prototype,Faye.Timeouts);Faye.Event={_h:[],on:function(a,b,d,f){var g=function(){d.call(f)};if(a.addEventListener)a.addEventListener(b,g,false);else a.attachEvent('on'+b,g);this._h.push({_i:a,_s:b,_m:d,_n:f,_C:g})},detach:function(a,b,d,f){var g=this._h.length,h;while(g--){h=this._h[g];if((a&&a!==h._i)||(b&&b!==h._s)||(d&&d!==h._m)||(f&&f!==h._n))continue;if(h._i.removeEventListener)h._i.removeEventListener(h._s,h._C,false);else h._i.detachEvent('on'+h._s,h._C);this._h.splice(g,1);h=null}}};Faye.Event.on(Faye.ENV,'unload',Faye.Event.detach,Faye.Event);Faye.URI=Faye.extend(Faye.Class({queryString:function(){var a=[];for(var b in this.params){if(!this.params.hasOwnProperty(b))continue;a.push(encodeURIComponent(b)+'='+encodeURIComponent(this.params[b]))}return a.join('&')},isSameOrigin:function(){var a=Faye.URI.parse(Faye.ENV.location.href,false);var b=(a.hostname!==this.hostname)||(a.port!==this.port)||(a.protocol!==this.protocol);return!b},toURL:function(){var a=this.queryString();return this.protocol+'//'+this.hostname+(this.port?':'+this.port:'')+this.pathname+(a?'?'+a:'')+this.hash}}),{parse:function(g,h){if(typeof g!=='string')return g;var i=new this(),k;var j=function(b,d,f){g=g.replace(d,function(a){i[b]=a;return''});if(i[b]===undefined)i[b]=f?Faye.ENV.location[b]:''};j('protocol',/^https?\:/,true);j('host',/^\/\/[^\/]+/,true);if(!/^\//.test(g))g=Faye.ENV.location.pathname.replace(/[^\/]*$/,'')+g;j('pathname',/^\/[^\?#]*/);j('search',/^\?[^#]*/);j('hash',/^#.*/);if(/^\/\//.test(i.host)){i.host=i.host.substr(2);k=i.host.split(':');i.hostname=k[0];i.port=k[1]||''}else{i.hostname=Faye.ENV.location.hostname;i.port=Faye.ENV.location.port}if(h===false){i.params={}}else{var m=i.search.replace(/^\?/,''),n=m?m.split('&'):[],o=n.length,l={};while(o--){k=n[o].split('=');l[decodeURIComponent(k[0]||'')]=decodeURIComponent(k[1]||'')}if(typeof h==='object')Faye.extend(l,h);i.params=l}return i}});if(!this.JSON){JSON={}}(function(){function m(a){return a<10?'0'+a:a}if(typeof Date.prototype.toJSON!=='function'){Date.prototype.toJSON=function(a){return this.getUTCFullYear()+'-'+m(this.getUTCMonth()+1)+'-'+m(this.getUTCDate())+'T'+m(this.getUTCHours())+':'+m(this.getUTCMinutes())+':'+m(this.getUTCSeconds())+'Z'};String.prototype.toJSON=Number.prototype.toJSON=Boolean.prototype.toJSON=function(a){return this.valueOf()}}var n=/[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,o=/[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,l,q,t={'\b':'\\b','\t':'\\t','\n':'\\n','\f':'\\f','\r':'\\r','"':'\\"','\\':'\\\\'},p;function s(d){o.lastIndex=0;return o.test(d)?'"'+d.replace(o,function(a){var b=t[a];return typeof b==='string'?b:'\\u'+('0000'+a.charCodeAt(0).toString(16)).slice(-4)})+'"':'"'+d+'"'}function r(a,b){var d,f,g,h,i=l,k,j=b[a];if(j&&typeof j==='object'&&typeof j.toJSON==='function'){j=j.toJSON(a)}if(typeof p==='function'){j=p.call(b,a,j)}switch(typeof j){case'string':return s(j);case'number':return isFinite(j)?String(j):'null';case'boolean':case'null':return String(j);case'object':if(!j){return'null'}l+=q;k=[];if(Object.prototype.toString.apply(j)==='[object Array]'){h=j.length;for(d=0;d<h;d+=1){k[d]=r(d,j)||'null'}g=k.length===0?'[]':l?'[\n'+l+k.join(',\n'+l)+'\n'+i+']':'['+k.join(',')+']';l=i;return g}if(p&&typeof p==='object'){h=p.length;for(d=0;d<h;d+=1){f=p[d];if(typeof f==='string'){g=r(f,j);if(g){k.push(s(f)+(l?': ':':')+g)}}}}else{for(f in j){if(Object.hasOwnProperty.call(j,f)){g=r(f,j);if(g){k.push(s(f)+(l?': ':':')+g)}}}}g=k.length===0?'{}':l?'{\n'+l+k.join(',\n'+l)+'\n'+i+'}':'{'+k.join(',')+'}';l=i;return g}}Faye.stringify=function(a,b,d){var f;l='';q='';if(typeof d==='number'){for(f=0;f<d;f+=1){q+=' '}}else if(typeof d==='string'){q=d}p=b;if(b&&typeof b!=='function'&&(typeof b!=='object'||typeof b.length!=='number')){throw new Error('JSON.stringify');}return r('',{'':a})};if(typeof JSON.stringify!=='function'){JSON.stringify=Faye.stringify}if(typeof JSON.parse!=='function'){JSON.parse=function(h,i){var k;function j(a,b){var d,f,g=a[b];if(g&&typeof g==='object'){for(d in g){if(Object.hasOwnProperty.call(g,d)){f=j(g,d);if(f!==undefined){g[d]=f}else{delete g[d]}}}}return i.call(a,b,g)}n.lastIndex=0;if(n.test(h)){h=h.replace(n,function(a){return'\\u'+('0000'+a.charCodeAt(0).toString(16)).slice(-4)})}if(/^[\],:{}\s]*$/.test(h.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g,'@').replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,']').replace(/(?:^|:|,)(?:\s*\[)+/g,''))){k=eval('('+h+')');return typeof i==='function'?j({'':k},''):k}throw new SyntaxError('JSON.parse');}}}());Faye.Transport.WebSocket=Faye.extend(Faye.Class(Faye.Transport,{UNCONNECTED:1,CONNECTING:2,CONNECTED:3,batching:false,isUsable:function(a,b){this.callback(function(){a.call(b,true)});this.errback(function(){a.call(b,false)});this.connect()},request:function(b,d){if(b.length===0)return;this._d=this._d||{};for(var f=0,g=b.length;f<g;f++){this._d[b[f].id]=b[f]}this.callback(function(a){a.send(Faye.toJSON(b))});this.connect()},close:function(){if(!this._3)return;this._3.onclose=this._3.onerror=null;this._3.close();delete this._3;this.setDeferredStatus('deferred');this._1=this.UNCONNECTED},connect:function(){if(Faye.Transport.WebSocket._J)return;this._1=this._1||this.UNCONNECTED;if(this._1!==this.UNCONNECTED)return;this._1=this.CONNECTING;var g=Faye.Transport.WebSocket.getClass();if(!g)return this.setDeferredStatus('failed');this._3=new g(Faye.Transport.WebSocket.getSocketUrl(this.endpoint));var h=this;this._3.onopen=function(){h._1=h.CONNECTED;h._t=true;h.setDeferredStatus('succeeded',h._3);h.trigger('up')};this._3.onmessage=function(a){var b=JSON.parse(a.data);if(!b)return;b=[].concat(b);for(var d=0,f=b.length;d<f;d++){delete h._d[b[d].id]}h.receive(b)};this._3.onclose=this._3.onerror=function(){var a=(h._1===h.CONNECTED);h.setDeferredStatus('deferred');h._1=h.UNCONNECTED;h.close();if(a)return h.resend();if(!h._t)return h.setDeferredStatus('failed');var b=h._8.retry*1000;Faye.ENV.setTimeout(function(){h.connect()},b);h.trigger('down')}},resend:function(){if(!this._d)return;var d=Faye.map(this._d,function(a,b){return b});this.request(d)}}),{getSocketUrl:function(a){if(Faye.URI)a=Faye.URI.parse(a).toURL();return a.replace(/^http(s?):/ig,'ws$1:')},getClass:function(){return(Faye.WebSocket&&Faye.WebSocket.Client)||Faye.ENV.WebSocket||Faye.ENV.MozWebSocket},isUsable:function(a,b,d,f){this.create(a,b).isUsable(d,f)},create:function(a,b){var d=a.transports.websocket=a.transports.websocket||{};d[b]=d[b]||new this(a,b);return d[b]}});Faye.extend(Faye.Transport.WebSocket.prototype,Faye.Deferrable);Faye.Transport.register('websocket',Faye.Transport.WebSocket);if(Faye.Event)Faye.Event.on(Faye.ENV,'beforeunload',function(){Faye.Transport.WebSocket._J=true});Faye.Transport.EventSource=Faye.extend(Faye.Class(Faye.Transport,{initialize:function(b,d){Faye.Transport.prototype.initialize.call(this,b,d);if(!Faye.ENV.EventSource)return this.setDeferredStatus('failed');this._K=new Faye.Transport.XHR(b,d);var f=new EventSource(d+'/'+b.getClientId()),g=this;f.onopen=function(){g._t=true;g.setDeferredStatus('succeeded');g.trigger('up')};f.onerror=function(){if(g._t){g.trigger('down')}else{g.setDeferredStatus('failed');f.close()}};f.onmessage=function(a){g.receive(JSON.parse(a.data));g.trigger('up')};this._3=f},isUsable:function(a,b){this.callback(function(){a.call(b,true)});this.errback(function(){a.call(b,false)})},request:function(a,b){this._K.request(a,b)},close:function(){if(!this._3)return;this._3.onerror=null;this._3.close();delete this._3}}),{isUsable:function(b,d,f,g){var h=b.getClientId();if(!h)return f.call(g,false);Faye.Transport.XHR.isUsable(b,d,function(a){if(!a)return f.call(g,false);this.create(b,d).isUsable(f,g)},this)},create:function(a,b){var d=a.transports.eventsource=a.transports.eventsource||{},f=a.getClientId(),b=b+'/'+(f||'');d[b]=d[b]||new this(a,b);return d[b]}});Faye.extend(Faye.Transport.EventSource.prototype,Faye.Deferrable);Faye.Transport.register('eventsource',Faye.Transport.EventSource);Faye.Transport.XHR=Faye.extend(Faye.Class(Faye.Transport,{request:function(f,g){var h=this.retry(f,g),i=Faye.URI.parse(this.endpoint).pathname,k=this,j=Faye.ENV.ActiveXObject?new ActiveXObject("Microsoft.XMLHTTP"):new XMLHttpRequest();j.open('POST',i,true);j.setRequestHeader('Content-Type','application/json');j.setRequestHeader('Pragma','no-cache');j.setRequestHeader('X-Requested-With','XMLHttpRequest');var m=this.headers;for(var n in m){if(!m.hasOwnProperty(n))continue;j.setRequestHeader(n,m[n])}var o=function(){j.abort()};Faye.Event.on(Faye.ENV,'beforeunload',o);var l=function(){Faye.Event.detach(Faye.ENV,'beforeunload',o);j.onreadystatechange=function(){};j=null};j.onreadystatechange=function(){if(j.readyState!==4)return;var a=null,b=j.status,d=((b>=200&&b<300)||b===304||b===1223);if(!d){l();h();return k.trigger('down')}try{a=JSON.parse(j.responseText)}catch(e){}l();if(a){k.receive(a);k.trigger('up')}else{h();k.trigger('down')}};j.send(Faye.toJSON(f))}}),{isUsable:function(a,b,d,f){d.call(f,Faye.URI.parse(b).isSameOrigin())}});Faye.Transport.register('long-polling',Faye.Transport.XHR);Faye.Transport.CORS=Faye.extend(Faye.Class(Faye.Transport,{request:function(b,d){var f=Faye.ENV.XDomainRequest?XDomainRequest:XMLHttpRequest,g=new f(),h=this.retry(b,d),i=this;g.open('POST',this.endpoint,true);if(g.setRequestHeader)g.setRequestHeader('Pragma','no-cache');var k=function(){if(!g)return false;g.onload=g.onerror=g.ontimeout=g.onprogress=null;g=null;Faye.ENV.clearTimeout(m);return true};g.onload=function(){var a=null;try{a=JSON.parse(g.responseText)}catch(e){}k();if(a){i.receive(a);i.trigger('up')}else{h();i.trigger('down')}};var j=function(){k();h();i.trigger('down')};var m=Faye.ENV.setTimeout(j,1.5*1000*d);g.onerror=j;g.ontimeout=j;g.onprogress=function(){};g.send('message='+encodeURIComponent(Faye.toJSON(b)))}}),{isUsable:function(a,b,d,f){if(Faye.URI.parse(b).isSameOrigin())return d.call(f,false);if(Faye.ENV.XDomainRequest)return d.call(f,Faye.URI.parse(b).protocol===Faye.URI.parse(Faye.ENV.location).protocol);if(Faye.ENV.XMLHttpRequest){var g=new Faye.ENV.XMLHttpRequest();return d.call(f,g.withCredentials!==undefined)}return d.call(f,false)}});Faye.Transport.register('cross-origin-long-polling',Faye.Transport.CORS);Faye.Transport.JSONP=Faye.extend(Faye.Class(Faye.Transport,{shouldFlush:function(a){var b={message:Faye.toJSON(a),jsonp:'__jsonp'+Faye.Transport.JSONP._u+'__'};var d=Faye.URI.parse(this.endpoint,b).toURL();return d.length>=Faye.Transport.MAX_URL_LENGTH},request:function(b,d){var f={message:Faye.toJSON(b)},g=document.getElementsByTagName('head')[0],h=document.createElement('script'),i=Faye.Transport.JSONP.getCallbackName(),k=Faye.URI.parse(this.endpoint,f),j=this.retry(b,d),m=this;Faye.ENV[i]=function(a){o();m.receive(a);m.trigger('up')};var n=Faye.ENV.setTimeout(function(){o();j();m.trigger('down')},1.5*1000*d);var o=function(){if(!Faye.ENV[i])return false;Faye.ENV[i]=undefined;try{delete Faye.ENV[i]}catch(e){}Faye.ENV.clearTimeout(n);h.parentNode.removeChild(h);return true};k.params.jsonp=i;h.type='text/javascript';h.src=k.toURL();g.appendChild(h)}}),{_u:0,getCallbackName:function(){this._u+=1;return'__jsonp'+this._u+'__'},isUsable:function(a,b,d,f){d.call(f,true)}});Faye.Transport.register('callback-polling',Faye.Transport.JSONP);
//@ sourceMappingURL=faye-browser-min.js.map
 return Faye; }.call(window);
return Faye;
});