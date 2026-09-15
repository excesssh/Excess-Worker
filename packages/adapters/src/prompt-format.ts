/** Pinned single-turn prompt formats for the text adapter. The runtime runs llama-server with `--no-jinja` and sends the
 * rendered string to `/completion`, so the exact bytes a buyer's prompt becomes are fixed here and named by the capability's
 * `promptFormat`, not taken from a chat template embedded in a GGUF file. Each format transcribes the publisher's own chat
 * template for one user message with the generation prompt appended; the server adds BOS itself when the vocabulary asks for
 * it (`add_special`), so no format writes one. Changing a rendering means a new format id and so a new capability digest. */
export interface PromptFormat {
  readonly id:string;
  render(prompt:string):string;
  /** Text stop strings sent with each request. End-of-generation tokens stop the server natively. */
  readonly stop:readonly string[];
  /** Models that reason before answering: the rendered text (special tokens included) that opens the answer. Tokens up to
   * and including it are generated, metered and billed as output tokens, but their text never leaves the worker. */
  readonly answerMarker?:string;
}
const format=(value:PromptFormat):PromptFormat=>Object.freeze({...value,stop:Object.freeze([...value.stop])});
const HARMONY_SYSTEM="You are ChatGPT, a large language model trained by OpenAI.\nKnowledge cutoff: 2024-06\n\nReasoning: low\n\n"+
  "# Valid channels: analysis, commentary, final. Channel must be included for every message.";

export const PROMPT_FORMATS:Readonly<Record<string,PromptFormat>>=Object.freeze({
  // Qwen3 hybrid models with thinking switched off: the template's empty think block plus the /no_think soft switch.
  "qwen3-chatml-no-thinking-v1":format({id:"qwen3-chatml-no-thinking-v1",
    render:prompt=>`<|im_start|>user\n${prompt} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`,stop:["<|im_end|>","<|endoftext|>"]}),
  // Qwen3 Instruct-2507 and Qwen3-Coder: instruct-only ChatML without think tags.
  "qwen3-chatml-instruct-v1":format({id:"qwen3-chatml-instruct-v1",
    render:prompt=>`<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`,stop:["<|im_end|>","<|endoftext|>"]}),
  // OpenAI harmony (openai/gpt-oss chat_template.jinja) with low reasoning effort. The template's "Current date" line is
  // left out so the rendering does not change from day to day. The model writes its analysis channel first, then
  // "<|channel|>final<|message|>" and the answer, and ends with <|return|> (an end-of-generation token in llama.cpp).
  "gpt-oss-harmony-low-v1":format({id:"gpt-oss-harmony-low-v1",
    render:prompt=>`<|start|>system<|message|>${HARMONY_SYSTEM}<|end|><|start|>user<|message|>${prompt}<|end|><|start|>assistant`,
    stop:[],answerMarker:"<|channel|>final<|message|>"}),
  // Llama 3.1 and 3.3 Instruct: the template's default system header (knowledge cutoff and its fixed date string), the
  // trimmed user message and the assistant header.
  "llama3-chat-v1":format({id:"llama3-chat-v1",
    render:prompt=>"<|start_header_id|>system<|end_header_id|>\n\nCutting Knowledge Date: December 2023\nToday Date: 26 Jul 2024\n\n<|eot_id|>"+
      `<|start_header_id|>user<|end_header_id|>\n\n${prompt.trim()}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`,stop:["<|eot_id|>","<|eom_id|>"]}),
  // Phi-4 (14B): ChatML with <|im_sep|> and no newlines.
  "phi4-chatml-v1":format({id:"phi4-chatml-v1",render:prompt=>`<|im_start|>user<|im_sep|>${prompt}<|im_end|><|im_start|>assistant<|im_sep|>`,stop:["<|im_end|>"]}),
  // Phi-4-mini-instruct: <|user|> and <|assistant|> role tokens ending in <|end|>.
  "phi4-mini-chat-v1":format({id:"phi4-mini-chat-v1",render:prompt=>`<|user|>${prompt}<|end|><|assistant|>`,stop:["<|end|>","<|endoftext|>"]}),
});
