export interface AIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface FIMRequest {
  prompt: string;
  suffix: string;
  maxTokens?: number;
}

export class AIClient {
  constructor(private config: AIConfig) {}

  async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<ChatResponse> {
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AI API error (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices[0]!.message.content,
      usage: data.usage,
    };
  }

  async fim(request: FIMRequest): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/fim/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        prompt: request.prompt,
        suffix: request.suffix,
        max_tokens: request.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AI FIM API error (${res.status}): ${err}`);
    }

    const data = await res.json() as {
      choices: { text: string }[];
    };

    return data.choices[0]!.text;
  }
}
