import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    fetchMaybeRequest,
    fetchVault,
    getApproveRequestInstruction,
    getCancelQueuedRedemptionRequestInstruction,
    getClaimInstruction,
    getCreateDepositRequestInstruction,
    getCreateRedeemRequestInstruction,
    getSkipCanceledQueueRequestInstruction,
    getUpdateVaultNavInstruction,
    RequestState,
    RequestType,
} from '@sendaifun/async-vault-client';
import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    fetchEncodedAccount,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    type Instruction,
    type KeyPairSigner,
    pipe,
    type ReadonlyUint8Array,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    writeKeyPairSigner,
} from '@solana/kit';
import {
    findAssociatedTokenPda as findSplAta,
    getCreateAssociatedTokenIdempotentInstruction as getCreateSplAtaInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    fetchMint as fetchToken2022Mint,
    findAssociatedTokenPda as findToken2022Ata,
    getCreateAssociatedTokenIdempotentInstruction as getCreateToken2022AtaInstruction,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const PROGRAM_ADDRESS = address('14rwtLEnG2XCYSaNuA2Tv6xKzt88YcAtuiaxtD2usuzi');
const NAV = 1_000_000n;
const DEPOSIT_AMOUNT = 10_000_000n;
const CANCELED_REDEMPTION_SHARES = 2_000_000n;
const CLAIMED_REDEMPTION_SHARES = 4_000_000n;

type StepName =
    | 'approveDeposit'
    | 'cancelRedemption'
    | 'claimDeposit'
    | 'claimRedemption'
    | 'createCanceledRedemption'
    | 'createClaimedRedemption'
    | 'createDeposit'
    | 'initializeNav'
    | 'priceAndApproveRedemption'
    | 'setupAtas'
    | 'skipCanceledRedemption';

interface VaultManifest {
    assetMint: string;
    assetTokenProgram: string;
    authority: string;
    cluster: 'devnet';
    pendingVault: string;
    programAddress: string;
    reserve: string;
    shareMint: string;
    shareTokenProgram: string;
    vault: string;
}

interface TransactionRecord {
    explorer: string;
    signature: string;
    slot: number;
}

interface Snapshot {
    nav: string;
    navVersion: string;
    pendingAssetBalance: string;
    pendingAsyncRequests: number;
    reserveAssetBalance: string;
    shareSupply: string;
    totalAssetBalance: string;
    userAssetBalance: string;
    userShareBalance: string;
}

interface LifecycleManifest {
    accounts: {
        canceledRedemptionRequest: string;
        claimedRedemptionRequest: string;
        depositRequest: string;
        pendingVault: string;
        reserve: string;
        shareMint: string;
        userAssetAccount: string;
        userShareAccount: string;
        vault: string;
    };
    amounts: {
        canceledRedemptionShares: string;
        claimedRedemptionAssets: string;
        claimedRedemptionShares: string;
        depositAssets: string;
        nav: string;
    };
    cluster: 'devnet';
    completedAt?: string;
    duplicateClaim?: {
        error: string;
        explorer: string;
        rejected: true;
        signature: string;
    };
    programAddress: string;
    snapshots: Partial<Record<'afterCanceledRedemption' | 'afterDeposit' | 'afterRedemption' | 'starting', Snapshot>>;
    startedAt: string;
    status: 'completed' | 'running';
    steps: Partial<Record<StepName, TransactionRecord>>;
    version: 1;
}

function resolveConfigPath(value: string | undefined, fallback: string): string {
    const configured = value ?? fallback;
    return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
}

function websocketUrlFromHttp(rpcUrl: string): string {
    const parsed = new URL(rpcUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return parsed.toString();
}

async function loadKeyPairSigner(keypairPath: string): Promise<KeyPairSigner> {
    const parsed: unknown = JSON.parse(await readFile(keypairPath, 'utf8'));
    if (
        !Array.isArray(parsed) ||
        parsed.length !== 64 ||
        parsed.some(value => !Number.isInteger(value) || value < 0 || value > 255)
    ) {
        throw new Error(`Invalid Solana keypair at ${keypairPath}`);
    }
    return await createKeyPairSignerFromBytes(Uint8Array.from(parsed));
}

async function loadOrCreateSigner(keypairPath: string): Promise<KeyPairSigner> {
    try {
        return await loadKeyPairSigner(keypairPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await mkdir(dirname(keypairPath), { recursive: true });
    const signer = await generateKeyPairSigner(true);
    await writeKeyPairSigner(signer, keypairPath);
    return signer;
}

async function readJson<T>(filePath: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(filePath, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function writeLifecycleManifest(filePath: string, manifest: LifecycleManifest): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(manifest, null, 4)}\n`, { mode: 0o644 });
}

function readTokenAmount(data: ReadonlyUint8Array): bigint {
    if (data.length < 72) throw new Error(`Token account data is only ${data.length} bytes`);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

async function fetchTokenBalance(rpc: ReturnType<typeof createSolanaRpc>, tokenAccount: Address): Promise<bigint> {
    const account = await fetchEncodedAccount(rpc, tokenAccount, { commitment: 'finalized' });
    return account.exists ? readTokenAmount(account.data) : 0n;
}

function assertEqual(actual: bigint | number | string, expected: bigint | number | string, label: string): void {
    if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

function assertRequest(
    request: Awaited<ReturnType<typeof fetchMaybeRequest>>,
    expected: {
        amount: bigint;
        owner: Address;
        requestState: RequestState;
        requestType: RequestType;
        vault: Address;
    },
): asserts request is Awaited<ReturnType<typeof fetchMaybeRequest>> & { exists: true } {
    if (!request.exists) throw new Error(`Request ${request.address} does not exist`);
    assertEqual(request.data.vault, expected.vault, 'request vault');
    assertEqual(request.data.owner, expected.owner, 'request owner');
    assertEqual(request.data.requestType, expected.requestType, 'request type');
    assertEqual(request.data.requestState, expected.requestState, 'request state');
    assertEqual(request.data.amount, expected.amount, 'request amount');
}

async function main(): Promise<void> {
    const rpcUrl = process.env.DEVNET_RPC_URL ?? DEFAULT_RPC_URL;
    const rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(process.env.DEVNET_WS_URL ?? websocketUrlFromHttp(rpcUrl));
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    const programConfig = { programAddress: PROGRAM_ADDRESS } as const;

    const payerKeypairPath = resolveConfigPath(process.env.SOLANA_KEYPAIR, join(homedir(), '.config/solana/id.json'));
    const vaultManifestPath = resolveConfigPath(process.env.VAULT_MANIFEST, 'deployments/devnet/smoke-vault.json');
    const lifecycleManifestPath = resolveConfigPath(
        process.env.VAULT_LIFECYCLE_MANIFEST,
        'deployments/devnet/smoke-lifecycle.json',
    );
    const depositRequestKeypairPath = resolveConfigPath(
        process.env.VAULT_DEPOSIT_REQUEST_KEYPAIR,
        'keypairs/devnet-smoke-deposit-request.json',
    );
    const canceledRedemptionKeypairPath = resolveConfigPath(
        process.env.VAULT_CANCELED_REDEMPTION_REQUEST_KEYPAIR,
        'keypairs/devnet-smoke-canceled-redemption-request.json',
    );
    const claimedRedemptionKeypairPath = resolveConfigPath(
        process.env.VAULT_CLAIMED_REDEMPTION_REQUEST_KEYPAIR,
        'keypairs/devnet-smoke-claimed-redemption-request.json',
    );

    const genesisHash = await rpc.getGenesisHash().send();
    if (genesisHash !== DEVNET_GENESIS_HASH) {
        throw new Error(`Refusing to run: RPC genesis hash ${genesisHash} is not Solana devnet`);
    }

    const [payer, vaultManifest] = await Promise.all([
        loadKeyPairSigner(payerKeypairPath),
        readJson<VaultManifest>(vaultManifestPath),
    ]);
    if (!vaultManifest) throw new Error(`Missing vault manifest ${vaultManifestPath}`);
    if (vaultManifest.programAddress !== PROGRAM_ADDRESS || vaultManifest.cluster !== 'devnet') {
        throw new Error('Vault manifest does not describe the expected deployed devnet program');
    }
    if (vaultManifest.authority !== payer.address) {
        throw new Error(`Payer ${payer.address} is not vault authority ${vaultManifest.authority}`);
    }
    if (
        vaultManifest.assetTokenProgram !== TOKEN_PROGRAM_ADDRESS ||
        vaultManifest.shareTokenProgram !== TOKEN_2022_PROGRAM_ADDRESS
    ) {
        throw new Error('Smoke vault must use SPL Token assets and Token-2022 shares');
    }

    const assetMint = address(vaultManifest.assetMint);
    const shareMint = address(vaultManifest.shareMint);
    const vault = address(vaultManifest.vault);
    const reserve = address(vaultManifest.reserve);
    const pendingVault = address(vaultManifest.pendingVault);
    const [userAssetAccount] = await findSplAta({
        mint: assetMint,
        owner: payer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [userShareAccount] = await findToken2022Ata({
        mint: shareMint,
        owner: payer.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const [depositRequestSigner, canceledRedemptionSigner, claimedRedemptionSigner] = await Promise.all([
        loadOrCreateSigner(depositRequestKeypairPath),
        loadOrCreateSigner(canceledRedemptionKeypairPath),
        loadOrCreateSigner(claimedRedemptionKeypairPath),
    ]);

    let lifecycle = await readJson<LifecycleManifest>(lifecycleManifestPath);
    if (lifecycle) {
        const expectedAccounts = {
            canceledRedemptionRequest: canceledRedemptionSigner.address,
            claimedRedemptionRequest: claimedRedemptionSigner.address,
            depositRequest: depositRequestSigner.address,
            pendingVault,
            reserve,
            shareMint,
            userAssetAccount,
            userShareAccount,
            vault,
        };
        for (const [field, expected] of Object.entries(expectedAccounts)) {
            if (lifecycle.accounts[field as keyof typeof expectedAccounts] !== expected) {
                throw new Error(`Lifecycle manifest ${field} does not match the configured signer/vault`);
            }
        }
    }

    async function sendInstructions(label: string, instructions: Instruction[]): Promise<TransactionRecord> {
        const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            message => setTransactionMessageFeePayerSigner(payer, message),
            message => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
            message => appendTransactionMessageInstructions(instructions, message),
        );
        const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
        const signature = getSignatureFromTransaction(signedTransaction);
        assertIsTransactionWithBlockhashLifetime(signedTransaction);
        console.log(`${label}: sending ${signature}`);
        await sendAndConfirm(signedTransaction, { commitment: 'finalized' });
        const statuses = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
        const status = statuses.value[0];
        if (!status || status.err) throw new Error(`${label}: transaction was not finalized successfully`);
        return {
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
            signature,
            slot: Number(status.slot),
        };
    }

    async function snapshot(): Promise<Snapshot> {
        const [vaultAccount, shareMintAccount, userAsset, userShares, reserveAssets, pendingAssets] = await Promise.all(
            [
                fetchVault(rpc, vault, { commitment: 'finalized' }),
                fetchToken2022Mint(rpc, shareMint, { commitment: 'finalized' }),
                fetchTokenBalance(rpc, userAssetAccount),
                fetchTokenBalance(rpc, userShareAccount),
                fetchTokenBalance(rpc, reserve),
                fetchTokenBalance(rpc, pendingVault),
            ],
        );
        return {
            nav: vaultAccount.data.nav.toString(),
            navVersion: vaultAccount.data.navVersion.toString(),
            pendingAssetBalance: pendingAssets.toString(),
            pendingAsyncRequests: vaultAccount.data.pendingAsyncRequests,
            reserveAssetBalance: reserveAssets.toString(),
            shareSupply: shareMintAccount.data.supply.toString(),
            totalAssetBalance: vaultAccount.data.totalAssetBalance.toString(),
            userAssetBalance: userAsset.toString(),
            userShareBalance: userShares.toString(),
        };
    }

    async function recordStep(name: StepName, transaction: TransactionRecord): Promise<void> {
        if (!lifecycle) throw new Error('Lifecycle manifest was not initialized');
        lifecycle.steps[name] = transaction;
        await writeLifecycleManifest(lifecycleManifestPath, lifecycle);
    }

    const [assetAtaBefore, shareAtaBefore] = await Promise.all([
        fetchEncodedAccount(rpc, userAssetAccount, { commitment: 'finalized' }),
        fetchEncodedAccount(rpc, userShareAccount, { commitment: 'finalized' }),
    ]);
    if ((!assetAtaBefore.exists || !shareAtaBefore.exists) && !lifecycle?.steps.setupAtas) {
        const setupInstructions: Instruction[] = [];
        if (!assetAtaBefore.exists) {
            setupInstructions.push(
                getCreateSplAtaInstruction({
                    ata: userAssetAccount,
                    mint: assetMint,
                    owner: payer.address,
                    payer,
                    tokenProgram: TOKEN_PROGRAM_ADDRESS,
                }),
            );
        }
        if (!shareAtaBefore.exists) {
            setupInstructions.push(
                getCreateToken2022AtaInstruction({
                    ata: userShareAccount,
                    mint: shareMint,
                    owner: payer.address,
                    payer,
                    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                }),
            );
        }
        const setupTransaction = await sendInstructions('Create user token accounts', setupInstructions);
        if (!lifecycle) {
            const starting = await snapshot();
            lifecycle = createLifecycleManifest(starting);
        }
        await recordStep('setupAtas', setupTransaction);
    }

    const startingSnapshot = await snapshot();
    if (!lifecycle) {
        lifecycle = createLifecycleManifest(startingSnapshot);
        await writeLifecycleManifest(lifecycleManifestPath, lifecycle);
    }
    if (BigInt(lifecycle.snapshots.starting!.userAssetBalance) < DEPOSIT_AMOUNT) {
        throw new Error(
            `Wallet ${payer.address} needs at least 10 devnet USDC; current balance is ${
                BigInt(lifecycle.snapshots.starting!.userAssetBalance) / 1_000_000n
            } USDC`,
        );
    }

    if (lifecycle.status === 'completed') {
        verifyCompletedLifecycle(lifecycle, await snapshot());
        console.log(JSON.stringify(lifecycle, null, 2));
        return;
    }

    if (!lifecycle.steps.initializeNav) {
        const current = await fetchVault(rpc, vault, { commitment: 'finalized' });
        if (current.data.nav !== 0n || current.data.navVersion !== 0n || current.data.totalAssetBalance !== 0n) {
            throw new Error('Refusing to start lifecycle against a non-fresh vault accounting state');
        }
        await recordStep(
            'initializeNav',
            await sendInstructions('Initialize NAV', [
                getUpdateVaultNavInstruction({ authority: payer, updatedNav: NAV, vault }, programConfig),
            ]),
        );
    }

    if (!lifecycle.steps.createDeposit) {
        await recordStep(
            'createDeposit',
            await sendInstructions('Create 10 USDC deposit request', [
                getCreateDepositRequestInstruction(
                    {
                        args: { amount: DEPOSIT_AMOUNT, operator: null },
                        assetMint,
                        assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                        pendingVault,
                        request: depositRequestSigner,
                        shareMint,
                        user: payer,
                        userTokenAccount: userAssetAccount,
                        vault,
                    },
                    programConfig,
                ),
            ]),
        );
    }

    if (!lifecycle.steps.approveDeposit) {
        const request = await fetchMaybeRequest(rpc, depositRequestSigner.address, { commitment: 'finalized' });
        assertRequest(request, {
            amount: DEPOSIT_AMOUNT,
            owner: payer.address,
            requestState: RequestState.Pending,
            requestType: RequestType.Deposit,
            vault,
        });
        await recordStep(
            'approveDeposit',
            await sendInstructions('Approve deposit request', [
                getApproveRequestInstruction(
                    {
                        amount: request.data.amount,
                        assetMint,
                        assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                        authority: payer,
                        createdAt: request.data.createdAt,
                        navUpdateVersion: request.data.navUpdateVersion,
                        owner: request.data.owner,
                        pendingVault,
                        request: request.address,
                        requestType: request.data.requestType,
                        shareMint,
                        vault,
                        vaultTokenAccount: reserve,
                    },
                    programConfig,
                ),
            ]),
        );
    }

    if (!lifecycle.steps.claimDeposit) {
        const request = await fetchMaybeRequest(rpc, depositRequestSigner.address, { commitment: 'finalized' });
        assertRequest(request, {
            amount: DEPOSIT_AMOUNT,
            owner: payer.address,
            requestState: RequestState.Claimable,
            requestType: RequestType.Deposit,
            vault,
        });
        await recordStep(
            'claimDeposit',
            await sendInstructions('Claim deposit shares', [
                getClaimInstruction(
                    {
                        assetMint,
                        assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                        owner: payer.address,
                        request: request.address,
                        shareMint,
                        shareTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                        user: payer,
                        userShareAccount,
                        vault,
                    },
                    programConfig,
                ),
            ]),
        );
        const afterDeposit = await snapshot();
        assertSnapshot(afterDeposit, {
            nav: NAV,
            pendingAssetBalance: 0n,
            reserveAssetBalance: DEPOSIT_AMOUNT,
            shareSupply: DEPOSIT_AMOUNT,
            totalAssetBalance: DEPOSIT_AMOUNT,
            userAssetBalance: BigInt(lifecycle.snapshots.starting!.userAssetBalance) - DEPOSIT_AMOUNT,
            userShareBalance: DEPOSIT_AMOUNT,
        });
        lifecycle.snapshots.afterDeposit = afterDeposit;
        await writeLifecycleManifest(lifecycleManifestPath, lifecycle);
    }

    if (!lifecycle.steps.createCanceledRedemption) {
        await recordStep(
            'createCanceledRedemption',
            await sendInstructions('Create cancelable 2-share redemption request', [
                getCreateRedeemRequestInstruction(
                    {
                        args: { amount: CANCELED_REDEMPTION_SHARES, operator: null },
                        assetMint,
                        request: canceledRedemptionSigner,
                        shareMint,
                        shareTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                        user: payer,
                        userShareAccount,
                        vault,
                    },
                    programConfig,
                ),
            ]),
        );
    }

    if (!lifecycle.steps.cancelRedemption) {
        const request = await fetchMaybeRequest(rpc, canceledRedemptionSigner.address, { commitment: 'finalized' });
        assertRequest(request, {
            amount: CANCELED_REDEMPTION_SHARES,
            owner: payer.address,
            requestState: RequestState.Pending,
            requestType: RequestType.Redeem,
            vault,
        });
        await recordStep(
            'cancelRedemption',
            await sendInstructions('Cancel queued redemption', [
                getCancelQueuedRedemptionRequestInstruction(
                    {
                        assetMint,
                        request: request.address,
                        shareMint,
                        shareTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                        user: payer,
                        userShareAccount,
                        vault,
                    },
                    programConfig,
                ),
            ]),
        );
        const canceled = await fetchMaybeRequest(rpc, canceledRedemptionSigner.address, { commitment: 'finalized' });
        assertRequest(canceled, {
            amount: CANCELED_REDEMPTION_SHARES,
            owner: payer.address,
            requestState: RequestState.Canceled,
            requestType: RequestType.Redeem,
            vault,
        });
    }

    if (!lifecycle.steps.skipCanceledRedemption) {
        await recordStep(
            'skipCanceledRedemption',
            await sendInstructions('Advance FIFO past canceled redemption', [
                getSkipCanceledQueueRequestInstruction(
                    { owner: payer.address, request: canceledRedemptionSigner.address, vault },
                    programConfig,
                ),
            ]),
        );
        const canceled = await fetchMaybeRequest(rpc, canceledRedemptionSigner.address, { commitment: 'finalized' });
        if (canceled.exists) throw new Error('Canceled redemption tombstone was not closed');
        const afterCanceledRedemption = await snapshot();
        assertSnapshot(afterCanceledRedemption, {
            nav: NAV,
            pendingAssetBalance: 0n,
            reserveAssetBalance: DEPOSIT_AMOUNT,
            shareSupply: DEPOSIT_AMOUNT,
            totalAssetBalance: DEPOSIT_AMOUNT,
            userAssetBalance: BigInt(lifecycle.snapshots.starting!.userAssetBalance) - DEPOSIT_AMOUNT,
            userShareBalance: DEPOSIT_AMOUNT,
        });
        lifecycle.snapshots.afterCanceledRedemption = afterCanceledRedemption;
        await writeLifecycleManifest(lifecycleManifestPath, lifecycle);
    }

    if (!lifecycle.steps.createClaimedRedemption) {
        await recordStep(
            'createClaimedRedemption',
            await sendInstructions('Create final 4-share redemption request', [
                getCreateRedeemRequestInstruction(
                    {
                        args: { amount: CLAIMED_REDEMPTION_SHARES, operator: null },
                        assetMint,
                        request: claimedRedemptionSigner,
                        shareMint,
                        shareTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                        user: payer,
                        userShareAccount,
                        vault,
                    },
                    programConfig,
                ),
            ]),
        );
    }

    if (!lifecycle.steps.priceAndApproveRedemption) {
        const request = await fetchMaybeRequest(rpc, claimedRedemptionSigner.address, { commitment: 'finalized' });
        assertRequest(request, {
            amount: CLAIMED_REDEMPTION_SHARES,
            owner: payer.address,
            requestState: RequestState.Pending,
            requestType: RequestType.Redeem,
            vault,
        });
        await recordStep(
            'priceAndApproveRedemption',
            await sendInstructions('Atomically publish NAV and approve redemption', [
                getUpdateVaultNavInstruction({ authority: payer, updatedNav: NAV, vault }, programConfig),
                getApproveRequestInstruction(
                    {
                        amount: request.data.amount,
                        assetMint,
                        assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                        authority: payer,
                        createdAt: request.data.createdAt,
                        navUpdateVersion: request.data.navUpdateVersion,
                        owner: request.data.owner,
                        pendingVault,
                        request: request.address,
                        requestType: request.data.requestType,
                        shareMint,
                        vault,
                        vaultTokenAccount: reserve,
                    },
                    programConfig,
                ),
            ]),
        );
        const claimable = await fetchMaybeRequest(rpc, claimedRedemptionSigner.address, { commitment: 'finalized' });
        assertRequest(claimable, {
            amount: CLAIMED_REDEMPTION_SHARES,
            owner: payer.address,
            requestState: RequestState.Claimable,
            requestType: RequestType.Redeem,
            vault,
        });
        assertEqual(claimable.data.price, NAV, 'redemption price');
    }

    if (!lifecycle.steps.claimRedemption) {
        const request = await fetchMaybeRequest(rpc, claimedRedemptionSigner.address, { commitment: 'finalized' });
        assertRequest(request, {
            amount: CLAIMED_REDEMPTION_SHARES,
            owner: payer.address,
            requestState: RequestState.Claimable,
            requestType: RequestType.Redeem,
            vault,
        });
        await recordStep(
            'claimRedemption',
            await sendInstructions('Claim redeemed USDC', [
                getClaimInstruction(
                    {
                        assetMint,
                        assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                        owner: payer.address,
                        pendingVault,
                        request: request.address,
                        shareMint,
                        user: payer,
                        userAssetAccount,
                        vault,
                    },
                    programConfig,
                ),
            ]),
        );
        const closed = await fetchMaybeRequest(rpc, claimedRedemptionSigner.address, { commitment: 'finalized' });
        if (closed.exists) throw new Error('Claimed redemption request was not closed');
    }

    const afterRedemption = await snapshot();
    verifyCompletedLifecycle(lifecycle, afterRedemption);
    lifecycle.snapshots.afterRedemption = afterRedemption;

    if (!lifecycle.duplicateClaim) {
        lifecycle.duplicateClaim = await proveDuplicateClaimFails();
    }
    lifecycle.status = 'completed';
    lifecycle.completedAt = new Date().toISOString();
    await writeLifecycleManifest(lifecycleManifestPath, lifecycle);
    console.log(JSON.stringify(lifecycle, null, 2));

    function createLifecycleManifest(starting: Snapshot): LifecycleManifest {
        return {
            accounts: {
                canceledRedemptionRequest: canceledRedemptionSigner.address,
                claimedRedemptionRequest: claimedRedemptionSigner.address,
                depositRequest: depositRequestSigner.address,
                pendingVault,
                reserve,
                shareMint,
                userAssetAccount,
                userShareAccount,
                vault,
            },
            amounts: {
                canceledRedemptionShares: CANCELED_REDEMPTION_SHARES.toString(),
                claimedRedemptionAssets: CLAIMED_REDEMPTION_SHARES.toString(),
                claimedRedemptionShares: CLAIMED_REDEMPTION_SHARES.toString(),
                depositAssets: DEPOSIT_AMOUNT.toString(),
                nav: NAV.toString(),
            },
            cluster: 'devnet',
            programAddress: PROGRAM_ADDRESS,
            snapshots: { starting },
            startedAt: new Date().toISOString(),
            status: 'running',
            steps: {},
            version: 1,
        };
    }

    async function proveDuplicateClaimFails(): Promise<NonNullable<LifecycleManifest['duplicateClaim']>> {
        const instruction = getClaimInstruction(
            {
                assetMint,
                assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                owner: payer.address,
                pendingVault,
                request: claimedRedemptionSigner.address,
                shareMint,
                user: payer,
                userAssetAccount,
                vault,
            },
            programConfig,
        );
        const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
        const transactionMessage = pipe(
            createTransactionMessage({ version: 0 }),
            message => setTransactionMessageFeePayerSigner(payer, message),
            message => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
            message => appendTransactionMessageInstructions([instruction], message),
        );
        const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
        const signature = getSignatureFromTransaction(signedTransaction);
        assertIsTransactionWithBlockhashLifetime(signedTransaction);
        try {
            await sendAndConfirm(signedTransaction, { commitment: 'finalized', skipPreflight: true });
        } catch (error) {
            const statuses = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
            if (!statuses.value[0]?.err) throw error;
            return {
                error: String(error).slice(0, 1_000),
                explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
                rejected: true,
                signature,
            };
        }
        throw new Error('Duplicate redemption claim unexpectedly succeeded');
    }
}

function assertSnapshot(
    actual: Snapshot,
    expected: {
        nav: bigint;
        pendingAssetBalance: bigint;
        reserveAssetBalance: bigint;
        shareSupply: bigint;
        totalAssetBalance: bigint;
        userAssetBalance: bigint;
        userShareBalance: bigint;
    },
): void {
    assertEqual(BigInt(actual.nav), expected.nav, 'vault NAV');
    assertEqual(BigInt(actual.pendingAssetBalance), expected.pendingAssetBalance, 'pending asset balance');
    assertEqual(BigInt(actual.reserveAssetBalance), expected.reserveAssetBalance, 'reserve asset balance');
    assertEqual(BigInt(actual.shareSupply), expected.shareSupply, 'share supply');
    assertEqual(BigInt(actual.totalAssetBalance), expected.totalAssetBalance, 'total asset balance');
    assertEqual(BigInt(actual.userAssetBalance), expected.userAssetBalance, 'user asset balance');
    assertEqual(BigInt(actual.userShareBalance), expected.userShareBalance, 'user share balance');
}

function verifyCompletedLifecycle(lifecycle: LifecycleManifest, actual: Snapshot): void {
    const startingUserAssets = BigInt(lifecycle.snapshots.starting!.userAssetBalance);
    assertSnapshot(actual, {
        nav: NAV,
        pendingAssetBalance: 0n,
        reserveAssetBalance: DEPOSIT_AMOUNT - CLAIMED_REDEMPTION_SHARES,
        shareSupply: DEPOSIT_AMOUNT - CLAIMED_REDEMPTION_SHARES,
        totalAssetBalance: DEPOSIT_AMOUNT - CLAIMED_REDEMPTION_SHARES,
        userAssetBalance: startingUserAssets - DEPOSIT_AMOUNT + CLAIMED_REDEMPTION_SHARES,
        userShareBalance: DEPOSIT_AMOUNT - CLAIMED_REDEMPTION_SHARES,
    });
    if (actual.pendingAsyncRequests !== 0) {
        throw new Error(`Expected zero pending async requests, received ${actual.pendingAsyncRequests}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
