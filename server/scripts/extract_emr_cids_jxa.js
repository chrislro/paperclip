#!/usr/bin/env osascript -l JavaScript

var chrome = Application('Google Chrome');
chrome.includeStandardAdditions = true;

function findGhospTab() {
    var windows = chrome.windows();
    for (var i = 0; i < windows.length; i++) {
        var tabs = windows[i].tabs();
        for (var j = 0; j < tabs.length; j++) {
            var url = tabs[j].url();
            if (url && url.indexOf('g-hosp.com.br') !== -1) {
                return tabs[j];
            }
        }
    }
    return null;
}

var tab = findGhospTab();
if (!tab) {
    console.log('ERROR: No G-Hosp tab found. Make sure you are logged into G-Hosp in Chrome.');
    // Try to activate Chrome so user can see
    chrome.activate();
    'ERROR: No G-Hosp tab found';
} else {
    var script = [
        "(function(){",
        "var codes={};",
        "var chars='abcdefghijklmnopqrstuvwxyz0123456789'.split('');",
        "for(var i=0;i<chars.length;i++){",
        "  try{",
        "    var x=new XMLHttpRequest();",
        "    x.open('GET','/acs/autocomplete_cid_descricao_favs?term='+encodeURIComponent(chars[i]),false);",
        "    x.setRequestHeader('X-Requested-With','XMLHttpRequest');",
        "    x.send();",
        "    if(x.status===200){",
        "      var data=JSON.parse(x.responseText);",
        "      for(var k=0;k<data.length;k++){",
        "        var item=data[k];",
        "        var code=String(item.value||item.id||item.code||'').trim();",
        "        var name=String(item.label||item.name||'').trim();",
        "        var m=name.match(/^[^-]+-\\s*(.+)$/);",
        "        if(m)name=m[1];",
        "        if(code)codes[code]=name;",
        "      }",
        "    }",
        "  }catch(e){console.warn(chars[i]+' failed: '+e.message);}",
        "}",
        "var out=Object.keys(codes).sort().map(function(c){return{code:c,name:codes[c]};});",
        "console.log('Total CIDs: '+out.length);",
        "var b=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});",
        "var a=document.createElement('a');",
        "a.href=URL.createObjectURL(b);",
        "a.download='emr_cids.json';",
        "a.click();",
        "return 'Extracted '+out.length+' CIDs';",
        "})()"
    ].join('');
    
    var result = tab.execute({javascript: script});
    console.log(result);
    
    // Also try to save to Desktop via AppleScript
    var app = Application.currentApplication();
    app.includeStandardAdditions = true;
    var desktopPath = app.pathTo('desktop').toString();
    
    result;
}
