export async function getIntegrationAdapter(provider) {

  // ✅ normalize provider name
  const normalized = String(provider).toLowerCase();

  switch (normalized) {

    case "asana": {
      const mod = await import("../asana/asana.adapter.js");
      return mod.default;
    }

    case "youtrack": {
      const mod = await import("../youtrack/youtrack.adapter.js");
      return mod.default;
    }

    case "github": {
      const mod = await import("../github/github.adapter.js");
      return mod.default;
    }

    default:
      throw new Error(`Integration provider not found: ${provider}`);
  }
}