import fetch from "node-fetch";

const PROVIDER = process.env.LLM_PROVIDER || "ollama"; // ollama | openai | grok | groq | huggingface

export async function generateText({ prompt, signal, maxTokens }) {
  if (PROVIDER === "ollama") {
    return callOllama(prompt, signal, maxTokens);
  }

  if (PROVIDER === "openai") {
    return callOpenAI(prompt);
  }

  if (PROVIDER === "grok") {
    return callGrok(prompt);
  }

  if (PROVIDER === "groq") {
    return callGroq(prompt);
  }

  if (PROVIDER === "huggingface") {
    return callHuggingFace(prompt);
  }

  throw new Error("Unsupported LLM provider");
}

async function callOllama(prompt, signal, maxTokens) {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || "llama3:8b-instruct-q4_0",
        prompt,
        stream: false,
        options: {
          num_predict: maxTokens || 900,
          temperature: 0.4,
          top_k: 20,
          top_p: 0.9,
        },
      }),
    });

    // ✅ VERY IMPORTANT — detect HTTP failures and capture error details
    if (!res.ok) {
      let errorDetail = "";
      try {
        const errorBody = await res.text();
        errorDetail = errorBody ? `: ${errorBody}` : "";
      } catch (e) {
        // Ignore error reading body
      }
      throw new Error(`Ollama HTTP error ${res.status}${errorDetail}`);
    }

    const data = await res.json();

    // ✅ safety check
    if (!data || !data.response) {
      throw new Error("Empty response from Ollama");
    }

    return data.response;

  } catch (err) {

    // ✅ AbortController timeout case
    if (err.name === "AbortError") {
      throw new Error("LLM timeout");
    }

    throw err;
  }
}

async function callOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGrok(prompt) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "grok-beta",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Grok API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.1-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callHuggingFace(prompt) {
  const model = process.env.HF_MODEL || "mistralai/Mixtral-8x7B-Instruct-v0.1";

  const res = await fetch(
    `https://api-inference.huggingface.co/models/${model}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 500,
          temperature: 0.4,
          top_p: 0.9,
        },
      }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HuggingFace API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data[0].generated_text : data.generated_text;
}
