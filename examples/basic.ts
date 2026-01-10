/**
 * Basic example of using the Shielded Pool SDK
 * 
 * Run: ts-node examples/basic.ts
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ShieldedPoolClient, KeyManager } from '../src';

async function main() {
  // Setup connection (localhost or devnet)
  const connection = new Connection('http://localhost:8899', 'confirmed');
  
  // Your wallet for signing transactions
  const wallet = Keypair.generate();
  
  // Your shielded pool address (from program deployment)
  const poolAddress = new PublicKey('C58iVei3DXTL9BSKe5ZpQuJehqLJL1fQjejdnCAdWzV7');
  
  console.log('=== Shielded Pool SDK Example ===\n');
  
  // === 1. Create Client ===
  console.log('1. Creating client...');
  
  // Option A: Generate new keys
  const keys = KeyManager.generate();
  console.log('Generated new shielded address:', keys.getShieldedAddressString());
  
  // Option B: Restore from mnemonic (commented out)
  // const keys = KeyManager.fromMnemonic('your twelve word mnemonic here');
  
  // Initialize client (this will sync the Merkle tree)
  // const client = await ShieldedPoolClient.create(
  //   connection,
  //   wallet,
  //   poolAddress,
  //   keys
  // );
  
  // console.log('Client initialized!');
  // console.log('Shielded address:', await client.getShieldedAddress());
  
  // === 2. Deposit ===
  // console.log('\n2. Depositing 10 tokens...');
  // const depositTx = await client.deposit(10_000_000_000n);
  // console.log('Deposit tx:', depositTx);
  
  // === 3. Check Balance ===
  // console.log('\n3. Checking balance...');
  // const balance = await client.getBalance();
  // console.log(`Shielded balance: ${balance} (${Number(balance) / 1e9} tokens)`);
  
  // === 4. Private Transfer ===
  // console.log('\n4. Transferring 5 tokens to recipient...');
  // const recipientAddress = 'RecipientShieldedAddressHere...';
  // const transferTx = await client.transfer(5_000_000_000n, recipientAddress);
  // console.log('Transfer tx:', transferTx);
  
  // === 5. Withdraw ===
  // console.log('\n5. Withdrawing 3 tokens...');
  // const recipient = Keypair.generate().publicKey;
  // const withdrawTx = await client.withdraw(3_000_000_000n, recipient);
  // console.log('Withdraw tx:', withdrawTx);
  
  // === 6. Export Viewing Key (for auditing) ===
  // const viewingKey = client.exportViewingKey();
  // console.log('\nViewing key (share for auditing):', viewingKey);
  
  console.log('\n=== Example Complete ===');
  console.log('Note: Most code is commented out pending full SDK implementation');
}

main().catch(console.error);
