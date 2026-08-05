# @sendaifun/async-vault-client

Generated TypeScript client for the SendAI deployment of the Solana Foundation Async Vault program.

## Deployment

- Cluster: Solana devnet
- Program: `14rwtLEnG2XCYSaNuA2Tv6xKzt88YcAtuiaxtD2usuzi`
- Program source commit: `de9c34aa41861f86c327a81ad96c70cbc6300b8c`

This package is a devnet prerelease. The program is not deployed to mainnet-beta.

## Install

```bash
pnpm add @sendaifun/async-vault-client@devnet
```

The client uses `@solana/kit` and exports typed account codecs and fetchers, instruction builders and parsers, PDA helpers, program errors, and vault request types.

```ts
import {
    ASYNC_VAULT_PROGRAM_ADDRESS,
    fetchVault,
    findVaultPda,
    getCreateRedeemRequestInstruction,
} from '@sendaifun/async-vault-client';
```

The client is generated from the repository's committed Anchor IDL. The raw IDL is not included in the npm package.

## Security

The upstream program was reviewed by Cantina at an earlier audited baseline. This deployed revision includes changes after that baseline and must not be described as fully covered by the original audit. Review the repository's audit status and deployment record before production use.

## License

MIT
