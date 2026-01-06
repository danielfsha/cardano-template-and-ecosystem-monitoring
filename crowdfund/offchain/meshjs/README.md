# Crowdfund Off-chain (MeshJS)

This folder contains the off-chain implementation of the Crowdfund Contract using the MeshJS SDK.

## Prerequisites

- [Deno](https://deno.land/) installed.
- A Cardano wallet with some test ADA on the Preprod network.

## Setup

1.  **Prepare Wallets**: Generate seed phrases for testing.

    ```bash
    deno task prepare
    ```

    This will create `wallet_0.txt`, `wallet_1.txt`, etc.

2.  **Fund Wallets**: Send some tADA to the addresses generated.

    ```bash
    deno task show-addresses
    ```

    Fund at least:

    - `wallet_0`: Beneficiary (starts the crowdfund).
    - `wallet_1`: Donor (donates to the crowdfund).

3.  **Check Balances**:

    ```bash
    deno task balances
    ```

4.  **Transfer Funds**: If you need to transfer funds between wallets (e.g., for collateral):

    ```bash
    # Transfer 10 ADA from wallet 0 to wallet 1
    deno task transfer 0 1 10000000
    ```

## Usage

### 1. Start Crowdfund (Beneficiary)

Start a new crowdfund campaign with `wallet_0`.

```bash
# Goal: 10 ADA (10000000 lovelace), Deadline: 600 seconds from now
deno run -A crowdfund.ts start 10000000 600 0
```

- `10000000`: Goal amount in lovelace.
- `600`: Deadline in seconds from now.
- `0`: Wallet index to use (beneficiary).

The command will output the **Transaction Hash** (TxHash). **Save this hash** to interact with the campaign.

### 2. Donate (Donor)

Donate to the crowdfund using `wallet_1`.

```bash
deno run -A crowdfund.ts donate <TX_HASH> 5000000 1
```

- `<TX_HASH>`: The transaction hash returned from the `start` command.
- `5000000`: Amount to donate in lovelace (5 ADA).
- `1`: Wallet index to use (donor).

### 3. Withdraw (Beneficiary)

If the goal is reached and the deadline has passed, the beneficiary (`wallet_0`) can withdraw the funds.

```bash
deno run -A crowdfund.ts withdraw <TX_HASH> 0
```

- `<TX_HASH>`: The transaction hash of the crowdfund (or latest known state).
- `0`: Wallet index to use (beneficiary).

### 4. Reclaim (Donor)

If the goal was **not** reached and the deadline has passed, donors can reclaim their funds.

```bash
deno run -A crowdfund.ts reclaim <TX_HASH> 1
```

- `<TX_HASH>`: The transaction hash.
- `1`: Wallet index to use (donor).

## Scripts

- `crowdfund.ts`: Main CLI for Crowdfund operations.
- `lib/utils.ts`: Shared library for wallet management and provider connection.

## Tasks

defined in `deno.json`:

- `prepare`: Generate test wallets.
- `show-addresses`: Show wallet addresses.
- `balances`: Check wallet balances.
- `start`: Example command to start a campaign.
- `donate`: Example command instruction for donating.
- `withdraw`: Example command instruction for withdrawing.
- `reclaim`: Example command instruction for reclaiming.
- `transfer`: Example command instruction for transferring funds.
