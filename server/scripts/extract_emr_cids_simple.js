/* eslint-disable */
// Paste this ENTIRE block into Chrome DevTools Console and press Enter.
// No arrow functions, no template literals, no special chars.
(function(){
var codes={};
var chars='abcdefghijklmnopqrstuvwxyz0123456789'.split('');
var i=0;
function next(){
  if(i>=chars.length){
    var out=Object.keys(codes).sort().map(function(c){return{code:c,name:codes[c]};});
    console.log('Total: '+out.length);
    console.log(JSON.stringify(out,null,2));
    var b=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
    var a=document.createElement('a');
    a.href=URL.createObjectURL(b);
    a.download='emr_cids.json';
    a.click();
    return;
  }
  var c=chars[i++];
  fetch('/acs/autocomplete_cid_descricao_favs?term='+encodeURIComponent(c),{
    credentials:'same-origin',
    headers:{'X-Requested-With':'XMLHttpRequest'}
  }).then(function(r){return r.json();}).then(function(data){
    (data||[]).forEach(function(x){
      var code=String(x.value||x.id||x.code||'').trim();
      var name=String(x.label||x.name||'').trim();
      var m=name.match(/^[^-]+-\s*(.+)$/);
      if(m)name=m[1];
      if(code)codes[code]=name;
    });
    console.log(c+' -> '+(data||[]).length+' (total: '+Object.keys(codes).length+')');
    setTimeout(next,250);
  }).catch(function(e){
    console.warn(c+' failed: '+e.message);
    setTimeout(next,250);
  });
}
next();
})();
