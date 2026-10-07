# @wysiwys/workflow

For Chainlink judges: [CRE integration, Confidential Workflow implementation, live evidence and developer feedback](../docs/chainlink/README.md).

The live review uses an authenticated HTTP trigger, three-provider Solana reads (QuickNode, Helius, Alchemy) with 2-of-3 source agreement per node, CRE consensus, deterministic decoding and policy evaluation, and a DON-signed report through the production Keystone forwarder. Live evaluation runs on DON nodes without a TEE. The Confidential Workflow path is implemented and locally simulated. Save simulation logs to `evidence/cre/`.

See the root AGENTS.md for guidelines.
