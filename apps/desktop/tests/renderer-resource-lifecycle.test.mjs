import assert from 'node:assert/strict';
import test from 'node:test';
import { mountReplayEffectImages, releaseReplayCanvases } from '../renderer/src/replay-render-resources.ts';

test('retiring an effect-image owner releases native sources and late callbacks cannot publish into its replacement', () => {
  const oldImages = [], nextImages = [], published = [];
  const create = destination => () => {
    const image = { src: '', onload: null, onerror: null, removeAttribute() { throw new Error('Use empty src: removeAttribute retained wrappers in the bundled Electron diagnostic'); } };
    destination.push(image); return image;
  };
  const old = mountReplayEffectImages({ flash: 'old.svg', fire: 'old.png' }, (key, image) => published.push(['old', key, image.src]), create(oldImages));
  const lateLoad = oldImages[0].onload;
  oldImages[1].onload(); assert.deepEqual(published, [['old', 'fire', 'old.png']]);
  old(); old();
  for (const image of oldImages) {
    assert.equal(image.src, ''); assert.equal(image.onload, null); assert.equal(image.onerror, null);
  }
  const next = mountReplayEffectImages({ flash: 'next.svg' }, (key, image) => published.push(['next', key, image.src]), create(nextImages));
  lateLoad(); nextImages[0].onload();
  assert.deepEqual(published, [['old', 'fire', 'old.png'], ['next', 'flash', 'next.svg']]);
  assert.equal(nextImages[0].src, 'next.svg', 'Disposing the old owner does not detach active replacement resources');
  next(); assert.equal(nextImages[0].src, '');
});

test('canvas cleanup uses setup-owned nodes when live refs already point to a new session', () => {
  const old = { width: 1536, height: 1536 }, next = { width: 2048, height: 2048 };
  const liveRef = { current: old }, setupOwned = [liveRef.current, null];
  liveRef.current = next;
  releaseReplayCanvases(setupOwned);
  assert.deepEqual(old, { width: 1, height: 1 });
  assert.deepEqual(next, { width: 2048, height: 2048 });
});
