// ai-platform/providers/bedrock.adapter.js
//
// AWS Bedrock. Bedrock's InvokeModel requires SigV4 request signing, which is
// heavier than the other REST adapters. It is intentionally left as an explicit,
// registered-but-unimplemented adapter for Phase 2 rather than a silent stub, so
// that routing a capability to Bedrock fails loudly and traceably instead of
// falling back to a wrong provider.

import { BaseAdapter } from "./base.adapter.js";

export class BedrockAdapter extends BaseAdapter {
  async generate() {
    const err = new Error(
      "AWS Bedrock adapter is registered but not yet implemented (SigV4 signing lands in Phase 2). " +
        "Route this capability to another provider until then."
    );
    err.code = "ADAPTER_NOT_IMPLEMENTED";
    throw err;
  }
}

export default new BedrockAdapter();
