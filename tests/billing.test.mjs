import test from 'node:test';
import assert from 'node:assert/strict';
import { reservation } from '../src/billing.mjs';
import { imageToolOutputSize } from '../src/cost.mjs';

const standard = { tier: 1, active: true };
const opus = { tier: 3, active: true, usage: { percent: 50, isNegative: false } };
const enhancement = (parameters = {}, model = 'nai-diffusion-5-full') => ({
  model, action: 'img2img', input: 'edited sidebar prompt',
  parameters: { width: 832, height: 1216, steps: 28, n_samples: 1, image: 'base64', strength: 0.2, noise: 0, ...parameters },
});

test('普通倍率与 V5 Max 的计价和免费资格对齐前端增强报价', () => {
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
    for (const [parameters, prices] of [
      [{}, [6, 0]],
      [{ width: 1280, height: 1856 }, [14, 14]],
      [{ upscaled_enhance: true }, [18, 18]],
    ]) {
      const request = enhancement(parameters, model);
      assert.deepEqual([standard, opus].map(account => reservation('/ai/generate-image', request, account)), prices);
      assert.deepEqual([request.parameters.width, request.parameters.height],
        [parameters.width ?? 832, parameters.height ?? 1216]);
    }
  }
  assert.deepEqual(imageToolOutputSize({ model: 'nai-diffusion-5-full', width: 832, height: 1216,
    imageSource: { mode: 'img2img', upscaledEnhance: true } }), { width: 1467, height: 2144 });
});

test('高级增强按当前步数和 Strength 计价，Noise 不产生附加费用', () => {
  const request = enhancement({ upscaled_enhance: true, steps: 23 });
  assert.equal(reservation('/ai/generate-image', request, opus), 16);
  request.parameters.noise = 0.99;
  assert.equal(reservation('/ai/generate-image', request, opus), 16);
  request.parameters.strength = 0;
  assert.equal(reservation('/ai/generate-image', request, opus), 2);
  request.parameters.strength = 0.99;
  request.parameters.steps = 50;
  assert.throws(() => reservation('/ai/generate-image', request, opus), /140 Anlas/);
});

test('切换到 V4.5 的普通增强按当前模型与角色参考图收费', () => {
  const request = enhancement({ width: 1280, height: 1856, director_reference_images: ['reference'] }, 'nai-diffusion-4-5-full');
  assert.equal(reservation('/ai/generate-image', request, opus), 15);
  request.parameters.director_reference_images = [];
  assert.equal(reservation('/ai/generate-image', request, opus), 10);
});

test('Max 仅接受 V5 图生图的布尔标记，独立放大和无效噪声仍拒绝', () => {
  for (const upscaled_enhance of [1, 'true', null, {}, []]) {
    assert.throws(() => reservation('/ai/generate-image', enhancement({ upscaled_enhance }), opus), /布尔值/);
  }
  for (const model of ['nai-diffusion-3', 'nai-diffusion-4-5-full']) {
    assert.throws(() => reservation('/ai/generate-image', enhancement({ upscaled_enhance: true }, model), opus), /仅支持 V5 图生图/);
  }
  for (const action of ['generate', 'infill']) {
    const request = { ...enhancement({ upscaled_enhance: true, mask: 'mask', inpaintImg2ImgStrength: 0.2 }), action };
    assert.throws(() => reservation('/ai/generate-image', request, opus), /仅支持 V5 图生图/);
  }
  assert.throws(() => reservation('/ai/generate-image', enhancement({ upscaled_enhance: true, upscale: true }), opus), /独立放大/);
  for (const noise of [-0.01, 1.01, NaN, '0.2']) {
    assert.throws(() => reservation('/ai/generate-image', enhancement({ noise }), opus), /噪声无效/);
  }
  assert.equal(reservation('/ai/generate-image', enhancement({ upscaled_enhance: false }), opus), 0);
});
