import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    fetchMaybeVault,
    findPendingVaultPda,
    findReservePda,
    findVaultPda,
    getCreateVaultInstructionAsync,
    getInitializeRedemptionQueueInstruction,
    getInitializeVaultInstruction,
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
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    writeKeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { fetchMint as fetchSplMint, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    extension,
    fetchMint as fetchToken2022Mint,
    getInitializeMint2Instruction,
    getInitializeNonTransferableMintInstruction,
    getMintSize,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_ASSET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PROGRAM_ADDRESS = address('14rwtLEnG2XCYSaNuA2Tv6xKzt88YcAtuiaxtD2usuzi');
const PROGRAM_SOURCE_COMMIT = 'de9c34aa41861f86c327a81ad96c70cbc6300b8c';
const SHARE_DECIMALS = 6;
const MINIMUM_PAYER_BALANCE_LAMPORTS = 20_000_000n;

interface SmokeVaultManifest {
    assetMint: string;
    assetTokenProgram: string;
    authority: string;
    cluster: 'devnet';
    createdAt: string;
    feeRecipient: string;
    initialized: true;
    pendingVault: string;
    programAddress: string;
    programSourceCommit: string;
    redemptionQueue: true;
    reserve: string;
    shareDecimals: number;
    shareMint: string;
    shareMintKeypairPath: string;
    shareMintNonTransferable: true;
    shareTokenProgram: string;
    slot: number;
    transaction: string;
    transactionExplorer: string;
    vault: string;
}

function resolveConfigPath(value: string | undefined, fallback: string): string {
    const configured = value ?? fallback;
    return isAbsolute(configured) ? configured : resolve(projectRoot, configured);
}

function manifestFileReference(filePath: string): string {
    const relativePath = relative(projectRoot, filePath);
    return relativePath.startsWith('..') ? filePath : relativePath;
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

async function loadOrCreateShareMintSigner(keypairPath: string): Promise<KeyPairSigner> {
    try {
        return await loadKeyPairSigner(keypairPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const signer = await generateKeyPairSigner(true);
    await writeKeyPairSigner(signer, keypairPath);
    return signer;
}

async function readExistingManifest(manifestPath: string): Promise<SmokeVaultManifest | null> {
    try {
        return JSON.parse(await readFile(manifestPath, 'utf8')) as SmokeVaultManifest;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function writeManifest(manifestPath: string, manifest: SmokeVaultManifest): Promise<void> {
    const existing = await readExistingManifest(manifestPath);
    if (existing && existing.shareMint !== manifest.shareMint) {
        throw new Error(
            `Refusing to overwrite ${manifestPath}: it records share mint ${existing.shareMint}, not ${manifest.shareMint}`,
        );
    }

    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, { mode: 0o644 });
}

function assertVaultMatches(
    vault: Awaited<ReturnType<typeof fetchMaybeVault>>,
    expected: {
        assetMint: Address;
        authority: Address;
        feeRecipient: Address;
        pendingVault: Address;
        reserve: Address;
        shareMint: Address;
    },
): asserts vault is Awaited<ReturnType<typeof fetchMaybeVault>> & { exists: true } {
    if (!vault.exists) throw new Error(`Vault account ${vault.address} was not created`);

    const mismatches = [
        ['asset mint', vault.data.assetMint, expected.assetMint],
        ['share mint', vault.data.shareMint, expected.shareMint],
        ['authority', vault.data.authority, expected.authority],
        ['fee recipient', vault.data.feeRecipient, expected.feeRecipient],
        ['reserve', vault.data.vaultTokenAccount, expected.reserve],
        ['pending vault', vault.data.pendingVault, expected.pendingVault],
    ].filter(([, actual, wanted]) => actual !== wanted);

    if (mismatches.length > 0) {
        throw new Error(`Vault verification failed: ${mismatches.map(([field]) => field).join(', ')} mismatch`);
    }
    if (!vault.data.initialized) throw new Error('Vault exists but is not initialized');
    if (vault.data.nav !== 0n || vault.data.navVersion !== 0n || vault.data.totalAssetBalance !== 0n) {
        throw new Error('Fresh vault has unexpected non-zero accounting state');
    }
}

function assertShareMintMatches(
    shareMintAccount: Awaited<ReturnType<typeof fetchToken2022Mint>>,
    vault: Address,
): void {
    const extensions =
        shareMintAccount.data.extensions.__option === 'Some' ? shareMintAccount.data.extensions.value : [];
    if (!extensions.some(item => item.__kind === 'NonTransferable')) {
        throw new Error('Share mint is missing the Token-2022 NonTransferable extension');
    }
    if (
        shareMintAccount.data.decimals !== SHARE_DECIMALS ||
        shareMintAccount.data.supply !== 0n ||
        shareMintAccount.data.mintAuthority.__option !== 'Some' ||
        shareMintAccount.data.mintAuthority.value !== vault
    ) {
        throw new Error('Share mint verification failed');
    }
}

async function main(): Promise<void> {
    const rpcUrl = process.env.DEVNET_RPC_URL ?? DEFAULT_RPC_URL;
    const websocketUrl = process.env.DEVNET_WS_URL ?? websocketUrlFromHttp(rpcUrl);
    const payerKeypairPath = resolveConfigPath(process.env.SOLANA_KEYPAIR, join(homedir(), '.config/solana/id.json'));
    const shareMintKeypairPath = resolveConfigPath(
        process.env.VAULT_SHARE_MINT_KEYPAIR,
        'keypairs/devnet-smoke-share-mint.json',
    );
    const manifestPath = resolveConfigPath(process.env.VAULT_MANIFEST, 'deployments/devnet/smoke-vault.json');
    const assetMint = address(process.env.VAULT_ASSET_MINT ?? DEFAULT_ASSET_MINT);

    const rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(websocketUrl);

    const genesisHash = await rpc.getGenesisHash().send();
    if (genesisHash !== DEVNET_GENESIS_HASH) {
        throw new Error(`Refusing to run: RPC genesis hash ${genesisHash} is not Solana devnet`);
    }

    const payer = await loadKeyPairSigner(payerKeypairPath);
    const feeRecipient = address(process.env.VAULT_FEE_RECIPIENT ?? payer.address);
    const payerBalance = await rpc.getBalance(payer.address, { commitment: 'finalized' }).send();
    if (payerBalance.value < MINIMUM_PAYER_BALANCE_LAMPORTS) {
        throw new Error(`Payer ${payer.address} has less than 0.02 SOL on devnet`);
    }

    const [programAccount, assetMintAccount] = await Promise.all([
        fetchEncodedAccount(rpc, PROGRAM_ADDRESS, { commitment: 'finalized' }),
        fetchSplMint(rpc, assetMint, { commitment: 'finalized' }),
    ]);
    if (!programAccount.exists || !programAccount.executable) {
        throw new Error(`Program ${PROGRAM_ADDRESS} is not executable on devnet`);
    }
    if (assetMintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS || assetMintAccount.data.decimals !== 6) {
        throw new Error(`Asset mint ${assetMint} must be a 6-decimal SPL Token mint`);
    }

    const shareMintSigner = await loadOrCreateShareMintSigner(shareMintKeypairPath);
    const shareMint = shareMintSigner.address;
    const programConfig = { programAddress: PROGRAM_ADDRESS } as const;
    const [[vault], [reserve], [pendingVault]] = await Promise.all([
        findVaultPda({ shareMint }, programConfig),
        findReservePda({ shareMint }, programConfig),
        findPendingVaultPda({ shareMint }, programConfig),
    ]);

    const expectedVault = { assetMint, authority: payer.address, feeRecipient, pendingVault, reserve, shareMint };
    const existingVault = await fetchMaybeVault(rpc, vault, { commitment: 'finalized' });
    const existingManifest = await readExistingManifest(manifestPath);

    if (existingVault.exists) {
        assertVaultMatches(existingVault, expectedVault);
        assertShareMintMatches(await fetchToken2022Mint(rpc, shareMint, { commitment: 'finalized' }), vault);
        if (!existingManifest || existingManifest.shareMint !== shareMint) {
            throw new Error(`Vault ${vault} already exists, but ${manifestPath} does not record it`);
        }
        console.log(JSON.stringify(existingManifest, null, 2));
        return;
    }

    const shareMintAccountBefore = await fetchEncodedAccount(rpc, shareMint, { commitment: 'finalized' });
    if (shareMintAccountBefore.exists) {
        throw new Error(
            `Share mint ${shareMint} exists but vault ${vault} does not; use a new share-mint keypair path`,
        );
    }

    const nonTransferableExtension = extension('NonTransferable', {});
    const shareMintSpace = BigInt(getMintSize([nonTransferableExtension]));
    const shareMintRent = await rpc.getMinimumBalanceForRentExemption(shareMintSpace).send();

    const instructions: Instruction[] = [
        getCreateAccountInstruction({
            lamports: shareMintRent,
            newAccount: shareMintSigner,
            payer,
            programAddress: TOKEN_2022_PROGRAM_ADDRESS,
            space: shareMintSpace,
        }),
        getInitializeNonTransferableMintInstruction({ mint: shareMint }),
        getInitializeMint2Instruction({
            decimals: SHARE_DECIMALS,
            freezeAuthority: null,
            mint: shareMint,
            mintAuthority: payer.address,
        }),
        await getCreateVaultInstructionAsync(
            {
                assetMint,
                assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
                authority: payer.address,
                feeRecipient,
                mintAuthority: payer,
                payer,
                pendingVault,
                reserve,
                shareMint,
                shareTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
                vault,
            },
            programConfig,
        ),
        getInitializeRedemptionQueueInstruction({ authority: payer, payer, vault }, programConfig),
        getInitializeVaultInstruction({ authority: payer, shareMint, vault }, programConfig),
    ];

    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'finalized' }).send();
    const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        message => setTransactionMessageFeePayerSigner(payer, message),
        message => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
        message => appendTransactionMessageInstructions(instructions, message),
    );
    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    const transaction = getSignatureFromTransaction(signedTransaction);
    assertIsTransactionWithBlockhashLifetime(signedTransaction);

    console.log(`Creating devnet vault ${vault} with share mint ${shareMint}...`);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    await sendAndConfirm(signedTransaction, { commitment: 'finalized' });

    const [createdVault, createdShareMint, signatureStatuses] = await Promise.all([
        fetchMaybeVault(rpc, vault, { commitment: 'finalized' }),
        fetchToken2022Mint(rpc, shareMint, { commitment: 'finalized' }),
        rpc.getSignatureStatuses([transaction], { searchTransactionHistory: true }).send(),
    ]);
    assertVaultMatches(createdVault, expectedVault);
    assertShareMintMatches(createdShareMint, vault);

    const slot = Number(signatureStatuses.value[0]?.slot ?? 0n);
    const manifest: SmokeVaultManifest = {
        assetMint,
        assetTokenProgram: TOKEN_PROGRAM_ADDRESS,
        authority: payer.address,
        cluster: 'devnet',
        createdAt: new Date().toISOString(),
        feeRecipient,
        initialized: true,
        pendingVault,
        programAddress: PROGRAM_ADDRESS,
        programSourceCommit: PROGRAM_SOURCE_COMMIT,
        redemptionQueue: true,
        reserve,
        shareDecimals: SHARE_DECIMALS,
        shareMint,
        shareMintKeypairPath: manifestFileReference(shareMintKeypairPath),
        shareMintNonTransferable: true,
        shareTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        slot,
        transaction,
        transactionExplorer: `https://explorer.solana.com/tx/${transaction}?cluster=devnet`,
        vault,
    };
    await writeManifest(manifestPath, manifest);

    console.log(JSON.stringify(manifest, null, 2));
    console.log(`Manifest written to ${manifestPath}`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
