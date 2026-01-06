// crowdfund.ts

import { MeshWallet, Transaction, Data, deserializeDatum } from '@meshsdk/core';
import { deserializeAddress } from '@meshsdk/core-cst';
import { unixTimeToEnclosingSlot, SLOT_CONFIG_NETWORK } from '@meshsdk/common';

import {
  koiosProvider,
  getWallet,
  showAddresses,
  checkBalances,
  listUtxos,
  transfer,
  prepare,
  loadStore,
  saveStore,
  setup,
} from './lib/utils.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------- Datum helpers (Pairs<VerificationKeyHash, Int>) ----------------

// Aiken:
//   pub type CrowdfundDatum { wallets: Pairs<VerificationKeyHash, Int>, }
//
// Plutus representation:
//   Constr 0 [ Map (k: bytes, v: int) ]
//
// Mesh Data shape:
//   {
//     alternative: 0,
//     fields: [
//       {
//         map: [
//           { k: { bytes: "<pkh-hex>" }, v: { int: <bigint> } },
//           ...
//         ]
//       }
//     ]
//   }

type MeshData = Data;

// Encode Map<pkhHex, bigint> into CrowdfundDatum
function encodeCrowdfundDatum(wallets: Map<string, bigint>): MeshData {
  const mapEntries = Array.from(wallets.entries()).map(([k, v]) => ({
    k: { bytes: k },
    v: { int: v },
  }));

  return {
    alternative: 0,
    fields: [
      {
        map: mapEntries,
      } as unknown as Data,
    ],
  };
}

// Decode CrowdfundDatum (as Mesh Data) into Map<pkhHex, bigint>
function decodeCrowdfundDatum(plutusData: any): Map<string, bigint> {
  const wallets = new Map<string, bigint>();
  if (!plutusData) return wallets;

  const root = plutusData.value ?? plutusData;
  const fields = root.fields;
  if (!fields || !fields[0]) return wallets;

  const mapNode = fields[0].map;
  if (!mapNode) return wallets;

  for (const item of mapNode) {
    const k = item.k.bytes as string;
    const vRaw = item.v.int as string | number | bigint;
    const v = BigInt(vRaw);
    wallets.set(k, v);
  }

  return wallets;
}

// ---------------- Script UTxO polling ----------------

async function fetchScriptUTxO(
  scriptAddress: string,
  storeTxHash: string,
  timeout = 60_000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const scriptUtxos = await koiosProvider.fetchAddressUTxOs(scriptAddress);
    const utxo =
      scriptUtxos.find((u: any) => u.input.txHash === storeTxHash) ||
      scriptUtxos[0];
    if (utxo) return utxo;
    await sleep(5_000);
  }
  return null;
}

// ---------------- startCrowdfund ----------------

async function startCrowdfund(
  goal: number,
  deadlineSeconds: number,
  walletIndex = 0
) {
  const wallet = await getWallet(walletIndex);
  const address = await wallet.getChangeAddress();
  const beneficiaryPkh =
    deserializeAddress(address).asBase()?.getPaymentCredential().hash || '';

  const deadline = BigInt(Date.now() + deadlineSeconds * 1000);
  const goalLovelace = BigInt(goal);
  const params = [beneficiaryPkh, goalLovelace, deadline];

  const { scriptAddress } = await setup(wallet, params);
  const utxos = await koiosProvider.fetchAddressUTxOs(address);

  // Initial datum: CrowdfundDatum { wallets = {} }
  const emptyWallets = new Map<string, bigint>();
  const datum = {
    value: encodeCrowdfundDatum(emptyWallets),
    inline: true as const,
  };

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .setTxInputs(utxos)
    .sendLovelace(
      {
        address: scriptAddress,
        datum,
      },
      '2000000' // initial min ADA
    );

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);

    const store = await loadStore();
    store.push({
      txHash,
      goal: goalLovelace.toString(),
      deadline: deadline.toString(),
      beneficiaryPkh,
      scriptAddress,
    });
    await saveStore(store);

    console.log(`Successfully started crowdfund at ${scriptAddress}.
Goal: ${goal} lovelace
Deadline: ${new Date(Number(deadline)).toLocaleString()}
TxHash: https://preprod.cexplorer.io/tx/${txHash}`);
    console.log(
      `To donate: deno run -A crowdfund.ts donate ${txHash} <amount> <walletIndex>`
    );
  } catch (error) {
    console.error('Error while submitting transaction:', error);
  }
}

// ---------------- donate ----------------

async function donate(
  crowdfundTxHash: string,
  amount: number,
  walletIndex = 1
) {
  const store = await loadStore();
  const cf = store.find((c: any) => c.txHash === crowdfundTxHash);
  if (!cf) {
    console.error('Crowdfund not found in store.');
    return;
  }

  const params = [cf.beneficiaryPkh, BigInt(cf.goal), BigInt(cf.deadline)];
  const wallet = await getWallet(walletIndex);
  const { script, scriptAddress } = await setup(wallet, params);

  const donorAddress = await wallet.getChangeAddress();
  const donorPkh =
    deserializeAddress(donorAddress).asBase()?.getPaymentCredential().hash ||
    '';

  const utxo = await fetchScriptUTxO(scriptAddress, crowdfundTxHash);
  if (!utxo) {
    console.error('No script UTxO found after retries.');
    return;
  }

  console.log('Donate Parsing UTxO:', JSON.stringify(utxo, null, 2));

  let walletsMap = new Map<string, bigint>();
  try {
    let plutusData = utxo.output.plutusData;
    if (typeof plutusData === 'string') {
      plutusData = deserializeDatum(plutusData);
    }
    walletsMap = decodeCrowdfundDatum(plutusData);
  } catch (e) {
    console.warn('Failed to parse existing datum, starting with empty map.', e);
  }

  const currentDonation = walletsMap.get(donorPkh) ?? 0n;
  walletsMap.set(donorPkh, currentDonation + BigInt(amount));

  const newDatum = {
    value: encodeCrowdfundDatum(walletsMap),
    inline: true as const,
  };

  const redeemer = {
    alternative: 0, // DONATE
    fields: [],
  };

  const oldValue = BigInt(
    utxo.output.amount.find((a: any) => a.unit === 'lovelace')?.quantity || '0'
  );
  const newValue = oldValue + BigInt(amount);

  const walletUtxos = await koiosProvider.fetchAddressUTxOs(donorAddress);

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .setTxInputs(walletUtxos)
    .redeemValue({
      value: utxo,
      script,
      redeemer: { data: redeemer },
    })
    .sendLovelace(
      {
        address: scriptAddress,
        datum: newDatum,
      },
      newValue.toString()
    );

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Donated ${amount} lovelace. Tx: ${txHash}`);
  } catch (error) {
    console.error('Donation failed:', error);
  }
}

// ---------------- withdraw ----------------

async function withdraw(crowdfundTxHash: string, walletIndex = 0) {
  const store = await loadStore();
  const cf = store.find((c: any) => c.txHash === crowdfundTxHash);
  if (!cf) return console.error('Crowdfund not found');

  const params = [cf.beneficiaryPkh, BigInt(cf.goal), BigInt(cf.deadline)];
  const wallet = await getWallet(walletIndex);
  const { script, scriptAddress } = await setup(wallet, params);

  const now = Date.now();
  const deadlineMs = Number(cf.deadline);
  if (now < deadlineMs + 1000) {
    const waitTime = deadlineMs - now + 2000;
    console.log(
      `Waiting ${Math.ceil(waitTime / 1000)}s for deadline to pass...`
    );
    await sleep(waitTime);
  }

  const utxo = await fetchScriptUTxO(scriptAddress, crowdfundTxHash);
  if (!utxo) return console.error('No funds found after retries');

  const redeemer = {
    alternative: 1, // WITHDRAW
    fields: [],
  };

  const validRangeStart = unixTimeToEnclosingSlot(
    Number(cf.deadline) + 1000,
    SLOT_CONFIG_NETWORK.preprod
  );

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .redeemValue({
      value: utxo,
      script,
      redeemer: { data: redeemer },
    })
    .setTimeToStart(validRangeStart.toString())
    .setRequiredSigners([await wallet.getChangeAddress()]);

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Withdrawn successfully. Tx: ${txHash}`);
  } catch (e) {
    console.error('Withdraw failed:', e);
  }
}

// ---------------- reclaim ----------------

async function reclaim(crowdfundTxHash: string, walletIndex = 1) {
  const store = await loadStore();
  const cf = store.find((c: any) => c.txHash === crowdfundTxHash);
  if (!cf) return console.error('Crowdfund not found');

  const params = [cf.beneficiaryPkh, BigInt(cf.goal), BigInt(cf.deadline)];
  const wallet = await getWallet(walletIndex);
  const { script, scriptAddress } = await setup(wallet, params);

  const donorAddress = await wallet.getChangeAddress();
  const donorPkh =
    deserializeAddress(donorAddress).asBase()?.getPaymentCredential().hash ||
    '';

  const now = Date.now();
  const deadlineMs = Number(cf.deadline);
  if (now < deadlineMs + 1000) {
    const waitTime = deadlineMs - now + 2000;
    console.log(
      `Waiting ${Math.ceil(waitTime / 1000)}s for deadline to pass...`
    );
    await sleep(waitTime);
  }

  const utxo = await fetchScriptUTxO(scriptAddress, crowdfundTxHash);
  if (!utxo) return console.error('No funds found after retries');

  console.log('Reclaim UTxO:', JSON.stringify(utxo, null, 2));

  let walletsMap = new Map<string, bigint>();
  try {
    let plutusData = utxo.output.plutusData;
    if (typeof plutusData === 'string') {
      plutusData = deserializeDatum(plutusData);
    }
    walletsMap = decodeCrowdfundDatum(plutusData);
  } catch (e) {
    console.warn('Datum parse error', e);
  }

  if (!walletsMap.has(donorPkh)) {
    return console.error('Donor not found in datum');
  }

  const donationAmount = walletsMap.get(donorPkh)!;
  walletsMap.delete(donorPkh);

  const newDatum = {
    value: encodeCrowdfundDatum(walletsMap),
    inline: true as const,
  };

  const redeemer = {
    alternative: 2, // RECLAIM
    fields: [],
  };

  const validRangeStart = unixTimeToEnclosingSlot(
    Number(cf.deadline) + 1000,
    SLOT_CONFIG_NETWORK.preprod
  );

  const oldValue = BigInt(
    utxo.output.amount.find((a: any) => a.unit === 'lovelace')?.quantity || '0'
  );
  const remainingValue = oldValue - donationAmount;

  const tx = new Transaction({ initiator: wallet, fetcher: koiosProvider })
    .redeemValue({
      value: utxo,
      script,
      redeemer: { data: redeemer },
    })
    .setTimeToStart(validRangeStart.toString())
    .setRequiredSigners([donorAddress])
    .sendLovelace(
      {
        address: scriptAddress,
        datum: newDatum,
      },
      remainingValue.toString()
    );

  try {
    const unsignedTx = await tx.build();
    const signedTx = await wallet.signTx(unsignedTx);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Reclaimed ${donationAmount} lovelace. Tx: ${txHash}`);
  } catch (e) {
    console.error('Reclaim failed:', e);
  }
}

// ---------------- CLI wiring ----------------

const isPositiveNumber = (s: string) =>
  Number.isInteger(Number(s)) && Number(s) > 0;

if (Deno.args.length > 0) {
  const cmd = Deno.args[0];

  if (cmd === 'start') {
    if (
      Deno.args.length > 2 &&
      isPositiveNumber(Deno.args[1]) &&
      isPositiveNumber(Deno.args[2])
    ) {
      const goal = parseInt(Deno.args[1]);
      const deadline = parseInt(Deno.args[2]);
      const walletIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 0;
      await startCrowdfund(goal, deadline, walletIndex);
    } else {
      console.log(
        'Expected goal (lovelace) and deadline (seconds) as positive integers.'
      );
      console.log(
        'Usage: deno run -A crowdfund.ts start <goal> <deadline> [walletIndex]'
      );
    }
  } else if (cmd === 'donate') {
    if (
      Deno.args.length > 2 &&
      Deno.args[1].match(/^[0-9a-fA-F]{64}$/) &&
      isPositiveNumber(Deno.args[2])
    ) {
      const txHash = Deno.args[1];
      const amount = parseInt(Deno.args[2]);
      const walletIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1;
      await donate(txHash, amount, walletIndex);
    } else {
      console.log('Expected valid txHash and amount.');
      console.log(
        'Usage: deno run -A crowdfund.ts donate <txHash> <amount> [walletIndex]'
      );
    }
  } else if (cmd === 'withdraw') {
    if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      const txHash = Deno.args[1];
      const walletIndex = Deno.args.length > 2 ? parseInt(Deno.args[2]) : 0;
      await withdraw(txHash, walletIndex);
    } else {
      console.log('Expected valid txHash.');
      console.log(
        'Usage: deno run -A crowdfund.ts withdraw <txHash> [walletIndex]'
      );
    }
  } else if (cmd === 'reclaim') {
    if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      const txHash = Deno.args[1];
      const walletIndex = Deno.args.length > 2 ? parseInt(Deno.args[2]) : 1;
      await reclaim(txHash, walletIndex);
    } else {
      console.log('Expected valid txHash.');
      console.log(
        'Usage: deno run -A crowdfund.ts reclaim <txHash> [walletIndex]'
      );
    }
  } else if (cmd === 'prepare') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      const files = Deno.readDirSync('.');
      const seeds: string[] = [];
      for (const file of files) {
        if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
          seeds.push(file.name);
        }
      }

      if (seeds.length > 0) {
        console.log(
          'Seed phrases already exist. Remove them before preparing new ones.'
        );
      } else {
        await prepare(parseInt(Deno.args[1]));
      }
    } else {
      console.log(
        'Expected a positive number (of seed phrases to prepare) as the second argument.'
      );
      console.log('Example usage: deno run -A crowdfund.ts prepare 5');
    }
  } else if (cmd === 'show-addresses') {
    await showAddresses();
  } else if (cmd === 'balances') {
    await checkBalances();
  } else if (cmd === 'list-utxos') {
    await listUtxos();
  } else if (cmd === 'transfer') {
    if (Deno.args.length >= 4) {
      const from = parseInt(Deno.args[1]);
      const to = parseInt(Deno.args[2]);
      const amount = Deno.args[3];
      await transfer(from, to, amount);
    } else {
      console.log(
        'Usage: deno run -A crowdfund.ts transfer <fromIndex> <toIndex> <amountLovelace>'
      );
    }
  } else {
    console.log(
      'Invalid command. Usage: start, donate, withdraw, reclaim, prepare, show-addresses, balances, transfer'
    );
  }
} else {
  console.log(
    'Usage: start, donate, withdraw, reclaim, prepare, show-addresses, balances, transfer'
  );
}
