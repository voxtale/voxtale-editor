// How long on-screen text must stay up to be read, and whether a placed card
// gets that long. Times from REDACTED CLAUDE.md (animation rules: reading
// time once the whole line is on screen), translated and kept as given.
// Code only, no model.

/** Seconds a viewer needs to read `text` once it is fully on screen. */
export function readSeconds(text:string):number {
  const words=text.trim().split(/\s+/).filter(Boolean);
  if(!words.length)return 0;
  // A number alone reads fast, but a key fact holds at least a second.
  if(words.length===1&&/^[~≈$€£+-]?\d[\d.,:%x×]*[kKmMbB%]?$/.test(words[0]!))return 1;
  if(words.length<=5)return Math.max(1,0.2*words.length);
  if(words.length<=8)return 2;
  // Past 8 words: our extension at the same rate a word.
  return 2+0.25*(words.length-8);
}

/**
 * A warning when a card is up for less than its words need, counting the
 * fades in and out (letters are not readable while they fade). Null when it
 * has time.
 */
export function readWarning(o:{label:string;text:string;start:number;end:number;fadeIn?:number;fadeOut?:number}):string|null {
  const need=readSeconds(o.text);
  const shown=o.end-o.start,readable=shown-(o.fadeIn??0)-(o.fadeOut??0);
  if(readable+1e-6>=need)return null;
  const n=o.text.trim().split(/\s+/).filter(Boolean).length;
  return `TOO SHORT TO READ: ${o.label} is readable ${Math.max(0,readable).toFixed(1)}s of ${shown.toFixed(1)}s on screen; ${n} word${n>1?'s':''} need about ${need.toFixed(1)}s. Give it more seconds, cut words, or start it a word earlier`;
}
