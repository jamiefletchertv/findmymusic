// Reads the text on a cover with a small vision model (Florence-2) running on the device.
import {
  Florence2ForConditionalGeneration, AutoProcessor, AutoTokenizer, RawImage,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

const MODEL = 'onnx-community/Florence-2-base-ft';
const TASK = '<OCR_WITH_REGION>';

let ready;
function load() {
  const files = {};
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.file?.endsWith('.onnx')) return;
    files[p.file] = p.loaded;
    const loaded = Object.values(files).reduce((a, b) => a + b, 0);
    postMessage({ type: 'progress', loaded });
  };
  ready ||= Promise.all([
    Florence2ForConditionalGeneration.from_pretrained(MODEL, { dtype: 'q8', progress_callback }),
    AutoProcessor.from_pretrained(MODEL),
    AutoTokenizer.from_pretrained(MODEL),
  ]).catch((err) => { ready = null; throw err; });
  return ready;
}

onmessage = async ({ data }) => {
  try {
    const [model, processor, tokenizer] = await load();
    postMessage({ type: 'reading' });
    const image = await RawImage.fromBlob(data.blob);
    const vision = await processor(image);
    const prompt = tokenizer(processor.construct_prompts(TASK));
    const ids = await model.generate({ ...prompt, ...vision, max_new_tokens: 128 });
    const raw = tokenizer.batch_decode(ids, { skip_special_tokens: false })[0];
    const out = processor.post_process_generation(raw, TASK, image.size)[TASK];
    // Each line of text with the height of its box, a stand-in for how prominent it is.
    const lines = out.labels.map((text, i) => {
      const q = out.quad_boxes[i];
      return { text: text.replace(/<\/?s>/g, '').trim(), height: Math.abs(q[7] - q[1]) };
    });
    postMessage({ type: 'done', id: data.id, lines });
  } catch (err) {
    postMessage({ type: 'error', id: data.id, message: String(err?.message || err) });
  }
};
