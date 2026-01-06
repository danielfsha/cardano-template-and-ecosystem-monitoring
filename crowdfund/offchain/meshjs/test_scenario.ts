import { checkBalances } from './lib/utils.ts';

async function runScenario() {
  console.log('=== Starting Automated Test Scenario ===');
  console.log('Current Working Directory:', Deno.cwd());

  // 1. Check Balances
  console.log('\n--- Checking Balances ---');
  // We capture stdout to check for non-zero balances
  const pBal = new Deno.Command('deno', {
    args: ['run', '-A', 'crowdfund.ts', 'balances'],
    stdout: 'piped',
    stderr: 'piped',
  });
  const balOut = await pBal.output();
  const balStdout = new TextDecoder().decode(balOut.stdout);
  console.log(balStdout);

  const balancesMatch = [...balStdout.matchAll(/Balance: (\d+) lovelace/g)];
  const wallet0 = BigInt(balancesMatch[0]?.[1] || '0');
  const wallet1 = BigInt(balancesMatch[1]?.[1] || '0');

  if (wallet0 === 0n && wallet1 === 0n) {
    console.error(
      '!!! CRITICAL: Wallets 0 and 1 represent empty. Please fund at least Wallet 0. !!!'
    );
    console.error('See FUND_WALLETS.md');
    Deno.exit(1);
  }

  // Auto-fund Wallet 1 from Wallet 0 if needed
  if (wallet0 > 20_000_000n && wallet1 < 10_000_000n) {
    console.log('\n--- Auto-funding Wallet 1 from Wallet 0 ---');
    const pTransfer = new Deno.Command('deno', {
      args: ['run', '-A', 'crowdfund.ts', 'transfer', '0', '1', '50000000'], // 50 ADA
      stdout: 'piped',
      stderr: 'piped',
    });
    const tOut = await pTransfer.output();
    console.log(new TextDecoder().decode(tOut.stdout));

    console.log('Waiting 90s for transfer confirmation and indexing...');
    await new Promise((r) => setTimeout(r, 90000));

    // Verify Wallet 1 balance visibility
    console.log('Verifying Wallet 1 balance...');
    const pCheck = new Deno.Command('deno', {
      args: ['run', '-A', 'crowdfund.ts', 'balances'],
      stdout: 'piped',
      stderr: 'piped',
    });
    console.log(new TextDecoder().decode((await pCheck.output()).stdout));
  } else if (wallet0 > 100_000_000n) {
    // Ensure Collateral UTxO: Send 5 ADA from W0 to W1 regardless, to ensure W1 has at least 2 UTxOs
    console.log('\n--- Sending Collateral / Top-up to Wallet 1 ---');
    const pTransfer = new Deno.Command('deno', {
      args: ['run', '-A', 'crowdfund.ts', 'transfer', '0', '1', '5000000'], // 5 ADA
      stdout: 'piped',
      stderr: 'piped',
    });
    const tOut = await pTransfer.output();
    console.log(new TextDecoder().decode(tOut.stdout));
    console.log('Waiting 30s for collateral confirmation...');
    await new Promise((r) => setTimeout(r, 30000));
  }

  // 2. Start Crowdfund
  // Goal: 10 ADA, Deadline: 120s from now
  console.log('\n--- Starting Campaign ---');
  const p = new Deno.Command('deno', {
    args: ['run', '-A', 'crowdfund.ts', 'start', '10000000', '120', '0'],
    stdout: 'piped',
    stderr: 'piped',
  });

  const output = await p.output();
  const stdout = new TextDecoder().decode(output.stdout);
  console.log(stdout);

  const txHashMatch = stdout.match(/tx\/([a-f0-9]{64})/);
  if (!txHashMatch) {
    console.error('Failed to start crowdfund or parse TxHash.');
    Deno.exit(1);
  }
  const txHash = txHashMatch[1];
  console.log(`Campaign started with TxHash: ${txHash}`);

  // Wait for Block Confirmation
  console.log('Waiting 60s for block confirmation...');
  await new Promise((r) => setTimeout(r, 60000));

  // 3. Donate
  console.log('\n--- Donating 5 ADA ---');
  const d = new Deno.Command('deno', {
    args: ['run', '-A', 'crowdfund.ts', 'donate', txHash, '5000000', '1'],
    stdout: 'piped',
    stderr: 'piped',
  });
  const dOut = await d.output();
  console.log(new TextDecoder().decode(dOut.stdout));
  console.log(new TextDecoder().decode(dOut.stderr));

  // 4. Reclaim (since goal 10 ADA > 5 ADA donated, and we wait for deadline)
  // The script `withdraw` or `reclaim` handles waiting for deadline now.
  console.log('\n--- Attempting Reclaim (will wait for deadline) ---');
  const r = new Deno.Command('deno', {
    args: ['run', '-A', 'crowdfund.ts', 'reclaim', txHash, '1'],
    stdout: 'piped',
    stderr: 'piped',
  });

  // This might take ~90s if deadline was 120s and we spent ~30s so far.
  const rOut = await r.output();
  console.log(new TextDecoder().decode(rOut.stdout));
  console.error(new TextDecoder().decode(rOut.stderr));

  console.log('=== Test Scenario Completed ===');
}

runScenario();
