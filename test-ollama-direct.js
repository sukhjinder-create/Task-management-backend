/**
 * Direct Ollama Test
 * Tests if Ollama is responding correctly
 */

import fetch from "node-fetch";

async function testOllama() {
  console.log("Testing Ollama connection...\n");

  try {
    // Test 1: Version check
    console.log("1. Checking Ollama version...");
    const versionRes = await fetch("http://localhost:11434/api/version");
    const version = await versionRes.json();
    console.log("✅ Ollama version:", version.version);
    console.log("");

    // Test 2: List models
    console.log("2. Checking available models...");
    const tagsRes = await fetch("http://localhost:11434/api/tags");
    const tags = await tagsRes.json();
    console.log("✅ Available models:", tags.models.map(m => m.name).join(", "));
    console.log("");

    // Test 3: Simple generation
    console.log("3. Testing text generation...");
    const genRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3:8b-instruct-q4_0",
        prompt: "Say 'Hello' in one word.",
        stream: false,
        options: {
          num_predict: 50,
          temperature: 0.4
        }
      })
    });

    console.log("Response status:", genRes.status);

    if (!genRes.ok) {
      const errorText = await genRes.text();
      console.error("❌ Ollama error:", errorText);
      return;
    }

    const result = await genRes.json();
    console.log("✅ Generated text:", result.response);
    console.log("");

    console.log("All tests passed! Ollama is working correctly.");

  } catch (error) {
    console.error("❌ Test failed:", error.message);
  }
}

testOllama();
