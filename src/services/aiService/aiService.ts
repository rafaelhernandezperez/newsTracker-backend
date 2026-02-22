//Ollama Model
// src/services/aiService.ts
import axios from 'axios';

const OLLAMA_URL = 'http://localhost:11434/api/generate';

export async function summarize(text: string): Promise<string> {
  const response = await axios.post(OLLAMA_URL, {
    model: 'mistral:7b-instruct',
    prompt: `[INST] Resume en una frase en español esta noticia financiera. Solo la frase, sin explicaciones: ${text} [/INST]`,
    stream: false,
  });
  return response.data.response.trim();
}

export async function analyzeSentiment(text: string): Promise<'POSITIVO' | 'NEGATIVO' | 'NEUTRO'> {
  const response = await axios.post(OLLAMA_URL, {
    model: 'mistral:7b-instruct',
    prompt: `[INST] Responde SOLO con una palabra: POSITIVO, NEGATIVO o NEUTRO según el tono de esta noticia financiera: ${text} [/INST]`,
    stream: false,
  });
  const result = response.data.response.trim().toUpperCase();
  if (['POSITIVO', 'NEGATIVO', 'NEUTRO'].includes(result)) return result as any;
  return 'NEUTRO';
}