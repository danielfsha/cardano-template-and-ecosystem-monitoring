import { MeshWallet, KoiosProvider, serializePlutusScript, Transaction } from '@meshsdk/core';
import { applyParamsToScript } from '@meshsdk/core-cst';
import { PlutusScript } from "@meshsdk/common";
import blueprint from '../../../onchain/aiken/plutus.json' with { type: 'json' };

export const koiosProvider = new KoiosProvider('preprod');

export async function getWallet(index: number) {
  const walletPath = `wallet_${index}.txt`;
  try {
    await Deno.stat(walletPath);
  } catch {
    throw new Error(
      `Wallet file ${walletPath} not found. Run 'prepare' first.`
    );
  }
  const mnemonic = (await Deno.readTextFile(walletPath)).split(' ');
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: koiosProvider,
    submitter: koiosProvider,
    key: {
      type: 'mnemonic',
      words: mnemonic,
    },
  });
  return wallet;
}

export async function getAllWallets() {
  const files = Deno.readDirSync('.');
  const walletFiles = [];
  for (const file of files) {
    if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
      walletFiles.push(file.name);
    }
  }
  walletFiles.sort();

  const wallets = [];
  for (const file of walletFiles) {
    const index = parseInt(file.match(/[0-9]+/)![0]);
    const wallet = await getWallet(index);
    wallets.push({ index, wallet });
  }
  return wallets;
}

export function stringToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256(input: string) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

export async function showAddresses() {
  const wallets = await getAllWallets();

  for (const { index, wallet } of wallets) {
    try {
      const address = await wallet.getChangeAddress();
      console.log(`Wallet ${index} address: ${address}`);
    } catch (e: any) {
      console.log(`Error showing wallet ${index}: ${e.message}`);
    }
  }
}

export async function checkBalances() {
  const wallets = await getAllWallets();

  for (const { index, wallet } of wallets) {
    try {
      const addr = await wallet.getChangeAddress();
      const utxos = await koiosProvider.fetchAddressUTxOs(addr);
      const balance = utxos.reduce(
        (acc, utxo) =>
          acc +
          BigInt(
            utxo.output.amount.find((a) => a.unit === 'lovelace')?.quantity ||
              '0'
          ),
        0n
      );
      console.log(`Wallet ${index} address: ${addr}`);
      console.log(
        `Balance: ${balance} lovelace (${Number(balance) / 1_000_000} ADA)`
      );
    } catch (e: any) {
      console.log(`Error checking wallet ${index}: ${e.message}`);
    }
  }
}

export async function listUtxos() {
  const wallets = await getAllWallets();
  for (const { index, wallet } of wallets) {
    try {
      const addr = await wallet.getChangeAddress();
      const utxos = await koiosProvider.fetchAddressUTxOs(addr);
      if (utxos.length > 0) {
        console.log(`Wallet ${index} UTxOs:`);
        utxos.forEach((u) => {
            console.log(` - TxHash: ${u.input.txHash} Index: ${u.input.outputIndex}`);
            console.log(`   Amount: ${JSON.stringify(u.output.amount)}`);
        });
      }
    } catch (e: any) {
      console.log(`Error listing UTxOs for wallet ${index}: ${e.message}`);
    }
  }
}

export async function transfer(
  fromIndex: number,
  toIndex: number,
  amountLovelace: string
) {
  const walletFrom = await getWallet(fromIndex);
  const addrFrom = await walletFrom.getChangeAddress();

  const walletTo = await getWallet(toIndex);
  const addrTo = await walletTo.getChangeAddress();

  console.log(
    `Sending ${amountLovelace} lovelace from Wallet ${fromIndex} (${addrFrom}) to Wallet ${toIndex} (${addrTo})...`
  );

  const tx = new Transaction({ initiator: walletFrom }).sendLovelace(
    addrTo,
    amountLovelace
  );

  try {
    const unsignedTx = await tx.build();
    const signedTx = await walletFrom.signTx(unsignedTx);
    const txHash = await walletFrom.submitTx(signedTx);
    console.log(`Transaction submitted: ${txHash}`);
  } catch (error) {
    console.error('Error while submitting transaction:', error);
  }
}

export async function prepare(amount: number) {
  const addresses = [];
  for (let i = 0; i < amount; i++) {
    const mnemonic = MeshWallet.brew() as string[];
    const wallet = new MeshWallet({
      networkId: 0,
      fetcher: koiosProvider,
      submitter: koiosProvider,
      key: {
        type: 'mnemonic',
        words: mnemonic,
      },
    });
    const address = await wallet.getChangeAddress();
    addresses.push(address);
    Deno.writeTextFileSync(`wallet_${i}.txt`, mnemonic.join(' '));
  }
  console.log(`Successfully prepared ${amount} wallet (seed phrases).`);
  console.log(
    `Make sure to send some tADA to the wallet ${addresses[0]} for fees and collateral.`
  );
}

export async function loadStore() {
  try {
    return JSON.parse(await Deno.readTextFile('store.json'));
  } catch {
    return [];
  }
}

export async function saveStore(data: any) {
  await Deno.writeTextFile('store.json', JSON.stringify(data, null, 2));
}

export async function setup(wallet: MeshWallet, params?: any[]) {
  let scriptCode = blueprint.validators[0].compiledCode;

  if (params) {
    scriptCode = applyParamsToScript(scriptCode, params);
  }

  const script: PlutusScript = {
    code: scriptCode,
    version: 'V3',
  };

  const scriptAddress = serializePlutusScript(script, undefined, 0).address;

  return {
    wallet,
    script,
    scriptAddress,
  };
}

