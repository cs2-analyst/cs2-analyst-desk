import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayMapImages } from '../renderer/src/replay-map-images.ts';
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
function fakeImage(){const decoding=deferred();return {src:'',onload:null,onerror:null,decode:()=>decoding.promise,removeAttribute(){throw new Error('Detached image cleanup must use empty src in the bundled Electron');},decoding};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('finite map cache exposes only decoded resources and reuses the same image across floor/unknown changes',async()=>{
  const images=[];const cache=new ReplayMapImages([['default','main.png'],['lower','lower.png']],()=>{const i=fakeImage();images.push(i);return i;});
  assert.equal(cache.entries.size,2);assert.equal(cache.entries.get('lower').status,'loading');
  images[0].onload();assert.equal(cache.entries.get('default').status,'loading');
  images[0].decoding.resolve();await flush();assert.equal(cache.entries.get('default').status,'ready');
  for(const id of ['default',null,'lower','default'])if(id)assert.equal(cache.entries.get(id).image,images[id==='default'?0:1]);
  images[1].onerror();assert.equal(cache.entries.get('lower').status,'failed');
  assert.equal(cache.entries.get('default').status,'ready');cache.dispose();
});

test('session disposal releases image references and late decoding cannot revive the old cache',async()=>{
  const old=fakeImage(),cache=new ReplayMapImages([['default','old.png']],()=>old);
  const entry=cache.entries.get('default'),lateLoad=old.onload;lateLoad();cache.dispose();
  assert.equal(cache.entries.size,0);assert.equal(old.src,'');assert.equal(old.onload,null);assert.equal(old.onerror,null);
  old.decoding.resolve();await flush();assert.equal(entry.status,'loading');
  const next=new ReplayMapImages([['default','new.png']],fakeImage);
  assert.equal(next.entries.get('default').status,'loading');next.dispose();
});

test('decode failures keep an honest unavailable status',async()=>{
  const image=fakeImage(),cache=new ReplayMapImages([['default','bad.png']],()=>image);
  image.onload();image.decoding.reject(new Error('decode'));await flush();assert.equal(cache.entries.get('default').status,'failed');cache.dispose();
});
