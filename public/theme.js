/* Tampa Bay Mahj — color themes (applied via CSS variable overrides on :root). */
window.TBM_THEMES = {
  classic: { name:'Classic Sage', dot:'#4C5B40', vars:{'--cream':'#F7F2E4','--cream-2':'#EFE7CC','--sage':'#4C5B40','--sage-soft':'#6B7A5C','--sage-dk':'#3B4832','--gold':'#C9A24B','--gold-soft':'#E3CD96','--gold-dk':'#8A6D14','--ink':'#2C3327','--ink-soft':'#5D6656','--tile':'#FBF8EF','--tile-edge':'#DED3B4'} },
  rose:    { name:'Charleston Rose', dot:'#8C4A5A', vars:{'--cream':'#F8EFEA','--cream-2':'#EFE0D8','--sage':'#8C4A5A','--sage-soft':'#A9707D','--sage-dk':'#6E3A47','--gold':'#C9A24B','--gold-soft':'#E7D3A0','--gold-dk':'#8A6D14','--ink':'#3A2A2E','--ink-soft':'#6E5A5F','--tile':'#FDF6F2','--tile-edge':'#E4D2C9'} },
  blue:    { name:'Savannah Blue', dot:'#2F5D62', vars:{'--cream':'#F1F2EC','--cream-2':'#E1E5DD','--sage':'#2F5D62','--sage-soft':'#5A8085','--sage-dk':'#234548','--gold':'#C9A24B','--gold-soft':'#E3CD96','--gold-dk':'#8A6D14','--ink':'#22302F','--ink-soft':'#516260','--tile':'#F9FAF5','--tile-edge':'#D3DAD2'} },
  palm:    { name:'Palm & Coral', dot:'#3E6B4A', vars:{'--cream':'#F4F3E7','--cream-2':'#E7E7CF','--sage':'#3E6B4A','--sage-soft':'#6B9173','--sage-dk':'#2C4E36','--gold':'#E07A5F','--gold-soft':'#F0B7A6','--gold-dk':'#B85C43','--ink':'#26332A','--ink-soft':'#546056','--tile':'#FBFBF2','--tile-edge':'#D6D9C2'} }
};
function tbmApplyTheme(id){var t=window.TBM_THEMES[id]||window.TBM_THEMES.classic;var r=document.documentElement;for(var v in t.vars)r.style.setProperty(v,t.vars[v]);}
window.tbmSetTheme=function(id){try{localStorage.setItem('tbm_theme',id);}catch(e){}tbmApplyTheme(id);};
window.tbmCurrentTheme=function(){try{return localStorage.getItem('tbm_theme')||'classic';}catch(e){return 'classic';}};
tbmApplyTheme(window.tbmCurrentTheme());

/* Accessibility pass — Holly's students skew older, so this is core audience.
   Darkens muted text one step and gives every control a visible focus ring. */
(function(){
  var css = document.createElement('style');
  css.textContent =
    ':root{--ink-soft:#5E6B52;--sage-soft:#5A6A4B}' +
    'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,' +
    'textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{' +
      'outline:3px solid #C9A24B;outline-offset:2px;border-radius:6px}' +
    '@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;' +
      'transition-duration:.01ms!important}}';
  document.head.appendChild(css);
})();
