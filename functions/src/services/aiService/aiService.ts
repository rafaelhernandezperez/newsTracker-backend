import axios from 'axios';

const HUGGING_FACE_CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = 'mistralai/Mixtral-8x7B-Instruct-v0.1:fastest';
const SENTIMENT_VALUES = ['POSITIVO', 'NEGATIVO', 'NEUTRO'] as const;

type Sentiment = typeof SENTIMENT_VALUES[number];

type HuggingFaceChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function getHuggingFaceToken(): string {
  const token = process.env.HF_TOKEN?.trim() || process.env.HUGGINGFACE_API_KEY?.trim();
  if (!token) {
    throw new Error('Missing HF_TOKEN or HUGGINGFACE_API_KEY environment variable');
  }

  return token;
}

async function runPrompt(prompt: string, maxTokens: number): Promise<string> {
  const response = await axios.post<HuggingFaceChatResponse>(
    HUGGING_FACE_CHAT_URL,
    {
      model: process.env.HF_MODEL?.trim() || DEFAULT_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${getHuggingFaceToken()}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const content = response.data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('Hugging Face returned an empty AI response');
  }

  return content;
}

export async function summarize(text: string): Promise<string> {
  return runPrompt(
    `Resume en una frase en español esta noticia financiera. Solo la frase, sin explicaciones: ${text}`,
    80
  );
}

export async function analyzeSentiment(text: string): Promise<Sentiment> {
  const result = (
    await runPrompt(
      `Responde SOLO con una palabra: POSITIVO, NEGATIVO o NEUTRO según el tono de esta noticia financiera: ${text}`,
      8
    )
  ).toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ]/g, '');

  if (SENTIMENT_VALUES.includes(result as Sentiment)) {
    return result as Sentiment;
  }

  return 'NEUTRO';
}
