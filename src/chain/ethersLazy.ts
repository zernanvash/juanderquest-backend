// Plan 125c: the provider/contract/wallet parts of ethers are loaded on first use, so
// importing the app (every route test) doesn't pay for them. Sync helpers (address, hash,
// utils, abi) are imported from their lighter ethers subpaths at the call sites.
import type * as EthersContract from 'ethers/contract';
import type * as EthersProviders from 'ethers/providers';
import type * as EthersTransaction from 'ethers/transaction';
import type * as EthersWallet from 'ethers/wallet';

/* eslint-disable @typescript-eslint/no-require-imports */
export const ethersProviders = (): typeof EthersProviders => require('ethers/providers');
export const ethersContract = (): typeof EthersContract => require('ethers/contract');
export const ethersWallet = (): typeof EthersWallet => require('ethers/wallet');
export const ethersTransaction = (): typeof EthersTransaction => require('ethers/transaction');
/* eslint-enable @typescript-eslint/no-require-imports */
