// Invisible anchor ids inside task cards, so a Lavish comment can always be traced to its task.
//
// Lavish records a comment's position as a CSS selector built from the clicked element upward: at most 5 elements, and it
// stops early at the first element that has an id. A crew canvas sits more than 5 levels below the card's own id, so a
// comment on it used to carry no task at all. This stamps an id on any element that would otherwise be the 4th below
// the nearest id (`k_<owning anchor id>_<child index path from that anchor>`), so the walk always ends at an id that
// names its owner. The ids are derived from position, never from a counter, so a re-render gives the same ids and the
// morph leaves the nodes alone. Elements that already have an id keep it. `extractTarget` (target.ts) reads the stamps.

/** The owners an anchor can name: the same ids `extractTarget` understands (task card, steps, ask block, ask context). */
export const OWNER_ID = /^(?:t|s|a|x)-[A-Za-z0-9]/;
/** A stamp: `k_<owner>_<index>-<index>-…`. The path is after the last underscore. */
export const STAMP_ID = /^k_(.+)_([0-9]+(?:-[0-9]+)*)$/;
/** Lavish's walk stops at an id or after 5 elements, itself included: a stamp every 4th level keeps one within reach. */
export const STAMP_EVERY = 4;

/** Source of `window.__fdAnchor(root)`, inlined in the page script. Runs on any DOM-like tree (children, id, setAttribute). */
export const ANCHOR_JS = `function anchorIds(root){
  var OWN=${OWNER_ID.toString()},EVERY=${STAMP_EVERY};
  // foreign = n carries an id that is not an owner id (the deck's own cvd-<agent>, the canvas's cv-... ids): Lavish's walk
  // would stop there and learn nothing, so each child of such an element gets a stamp of its own
  function walk(n,owner,path,d,foreign){
    var kids=n.children;
    for(var i=0;kids&&i<kids.length;i++){
      var c=kids[i],tag=c.tagName,own=owner,p=path.concat(i),dd=d+1,fo=false;
      if(tag==="SCRIPT"||tag==="STYLE")continue;
      // a stamp from an earlier run counts as the one this run would place there, so running twice changes nothing
      if(c.id&&c.id.indexOf("k_")===0)dd=0;
      else if(c.id){dd=0;if(OWN.test(c.id)){own=c.id;p=[]}else fo=true}
      else if(owner&&(dd>=EVERY||foreign)){c.setAttribute("id","k_"+owner+"_"+p.join("-"));dd=0}
      walk(c,own,p,dd,fo)}}
  walk(root,null,[],0,false)}`;
