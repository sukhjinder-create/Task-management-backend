import fetch from "node-fetch";

async function test() {
  try {
    console.log("Testing Ollama connection...");

    const res = await fetch("http://localhost:11434/api/tags");

    const data = await res.json();

    console.log("✅ SUCCESS — Ollama responded:");
    console.log(data);

  } catch (err) {
    console.error("❌ FAILED — Node cannot reach Ollama:");
    console.error(err);
  }
}

test();
