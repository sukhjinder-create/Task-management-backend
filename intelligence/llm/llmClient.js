import fetch from "node-fetch";

const PROVIDER = process.env.LLM_PROVIDER || "ollama"; // ollama | openai

export async function generateText({ prompt, signal }) {
  if (PROVIDER === "ollama") {
    return callOllama(prompt, signal);
  }

  if (PROVIDER === "openai") {
    return callOpenAI(prompt);
  }

  throw new Error("Unsupported LLM provider");
}

async function callOllama(prompt, signal) {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: "llama3:8b-instruct-q4_0",
        prompt,
        stream: false,
        options: {
  num_predict: 900,
  temperature: 0.4,
  top_k: 20,
  top_p: 0.9
}
      }),
    });

    // ✅ VERY IMPORTANT — detect HTTP failures
    if (!res.ok) {
      throw new Error(`Ollama HTTP error ${res.status}`);
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
