# Devnet smoke vault

This harness creates the first live devnet vault against the deployed Suzi
Async Vault program. It intentionally lives outside `integration-tests`, which
remain deterministic LiteSVM tests.

The create transaction atomically:

1. creates a six-decimal Token-2022 share mint with the `NonTransferable`
   extension;
2. creates the vault, reserve, and pending-vault accounts for devnet USDC;
3. enables the redemption FIFO extension; and
4. finalizes vault initialization.

It verifies the resulting vault and share mint at `finalized` commitment and
writes only public addresses and transaction metadata to
`deployments/devnet/smoke-vault.json`. The resumable share-mint keypair is kept
under the gitignored `keypairs/` directory with mode `0600`.

Run from the repository root:

```bash
pnpm devnet:create-vault
```

Defaults:

- RPC: `https://api.devnet.solana.com` (guarded by the devnet genesis hash)
- payer/authority: `~/.config/solana/id.json`
- asset: Circle devnet USDC (`4zMMC9...ncDU`)
- share-mint keypair: `keypairs/devnet-smoke-share-mint.json`
- manifest: `deployments/devnet/smoke-vault.json`

Optional environment variables are `DEVNET_RPC_URL`, `DEVNET_WS_URL`,
`SOLANA_KEYPAIR`, `VAULT_ASSET_MINT`, `VAULT_FEE_RECIPIENT`,
`VAULT_SHARE_MINT_KEYPAIR`, and `VAULT_MANIFEST`.

Re-running with the same keypair is idempotent after a successful creation: the
harness verifies the existing vault and prints the existing manifest instead of
creating a second vault.
